// E2E-003 support: the read-only retained-ruling check runs the overrule check
// against a retained calibration record's own decider ruling, with canned
// invokers here and about one Opus call by hand.
import { makeTempDir } from './temp-dir.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { buildRubric } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { SUITE_ROOT } from '../evals/agent-runner/and-scene-define/lib/files.mjs'
import { main, RETAINED_RULING_HELP } from '../evals/agent-runner/and-scene-define/scripts/check-retained-ruling.mjs'

const inventory = JSON.parse(await readFile(join(SUITE_ROOT, 'hidden/inventory.json'), 'utf8'))
const item = inventory.items.find(x => x.class === 'mandatory')
const subset = { ...inventory, items: [item] }
const PROPOSAL = 'A render pass fails and names the step.\nA missing sample fails with a message.\n'
const span = { path: 'proposal.md', start_line: 1, end_line: 2, gate: null, exchange: null }
const vote = (verdict, family, panel_index) => ({ id: item.id, verdict, rationale: `seat ${verdict}`, evidence: ['inspected'], citations: [span], subject_id: null, added_scope: [], family, model: family === 'claude' ? 'claude-sonnet' : 'gpt', effort: 'high', panel_index })
const sha = text => createHash('sha256').update(text).digest('hex')

// A retained r7-shaped repeat: Claude met, both Codex judges partial, decider met.
async function retainedRun(t, { protocol = 'cross-family-panel-v1' } = {}) {
  const root = await makeTempDir(join(tmpdir(), 'retained-ruling-')); t.after(() => rm(root, { recursive: true, force: true }))
  const suiteRoot = join(root, 'suite')
  await mkdir(join(suiteRoot, 'hidden/reference'), { recursive: true })
  await writeFile(join(suiteRoot, 'hidden/inventory.json'), JSON.stringify(subset))
  await writeFile(join(suiteRoot, 'rubric.json'), JSON.stringify(buildRubric(subset)))
  await writeFile(join(suiteRoot, 'hidden/reference/proposal.md'), 'reference\n')
  await writeFile(join(suiteRoot, 'hidden/simulated-user-policy.md'), 'policy\n')
  const runDir = join(root, 'inputs/restructured-degraded-quality/repeat-2')
  for (const dir of ['collected', 'phases', 'judges']) await mkdir(join(runDir, dir), { recursive: true })
  await writeFile(join(runDir, 'collected/proposal.md'), PROPOSAL)
  await writeFile(join(runDir, 'phases/collection.json'), JSON.stringify({ files: [{ path: 'proposal.md', sha256: sha(PROPOSAL) }] }))
  await writeFile(join(runDir, 'conversation.jsonl'), '')
  await writeFile(join(runDir, 'judges/gates.json'), JSON.stringify({ gates: [] }))
  const votes = [vote('met', 'claude', 0), vote('partial', 'codex', 1), vote('partial', 'codex', 2)]
  const ruling = { id: item.id, verdict: 'met', rationale: 'The render pass failing names the step, which commits to the outcome.', evidence: ['proposal.md:1-2'], citations: [span], subject_id: null, added_scope: [] }
  const record = { protocol, job: `coverage:${item.area}`, criteria: [item.id], verdicts: ['met', 'partial', 'missing'], order: ['met', 'partial', 'missing'], ok: true,
    fallback_ids: [], votes, checks: [], rulings: [ruling], results: [{ id: item.id, verdict: 'met', basis: 'decider-met' }] }
  const recordPath = join(runDir, `judges/coverage-${item.area}.json`)
  await writeFile(recordPath, JSON.stringify(record, null, 2))
  return { root, suiteRoot, runDir, recordPath, ruling }
}

async function snapshot(dir) {
  const entries = []
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { entries.push([relative(dir, path), 'dir']); await walk(path) }
      else { const info = await stat(path); entries.push([relative(dir, path), sha(await readFile(path)), info.mtimeMs]) }
    }
  }
  await walk(dir)
  return entries.sort((a, b) => a[0].localeCompare(b[0]))
}

function cannedDecider(classification, seen) {
  return { family: 'claude', model: 'claude-opus-5-5', effort: 'high', invoke: async req => {
    seen.push(req)
    if (!req.audit_stage) throw new Error('the retained-ruling check makes no decider ruling')
    return JSON.stringify({ results: req.criteria.map(id => ({ id, classification, rationale: classification === 'confirmed' ? 'The lines commit to the outcome.' : 'Naming the failing step does not commit to an overall pass/fail outcome.', evidence: ['proposal.md:1-2'], citations: [], marker: '' })) })
  } }
}

test('a v1 retained INV-093 ruling with an unconfirmed check prints the two-seat partial and writes nothing', async t => {
  const f = await retainedRun(t)
  const before = await snapshot(f.root)
  const seen = []; const lines = []
  const outcome = await main(['--record', f.recordPath, '--criterion', item.id, '--suite-root', f.suiteRoot], { decider: cannedDecider('contradicted', seen), log: line => lines.push(line) })
  assert.deepEqual(await snapshot(f.root), before)
  assert.equal(outcome.exitCode, 0)
  assert.equal(seen.length, 1)
  const [check] = seen
  assert.equal(check.audit_stage, 'overrule-check'); assert.deepEqual(check.criteria, [item.id])
  assert.deepEqual(check.authority, { cli: 'claude', model: 'claude-opus-5-5', effort: 'high' })
  // The check judges the recorded ruling itself: its verdict, stated reason and citations.
  const packet = JSON.parse(check.prompt.split('# BEGIN UNTRUSTED RULING\n')[1].split('\n# END UNTRUSTED RULING')[0])
  assert.equal(packet.verdict, 'met'); assert.equal(packet.overruled_verdict, 'partial')
  assert.equal(packet.rationale, f.ruling.rationale); assert.deepEqual(packet.citations, [span])
  assert.ok(check.prompt.includes('1: A render pass fails and names the step.'))
  const text = lines.join('\n')
  assert.match(text, /protocol: cross-family-panel-v1/)
  assert.match(text, /votes: claude met, codex partial, codex partial/)
  assert.match(text, /recorded ruling: met/)
  assert.match(text, /overrule check: contradicted/)
  assert.match(text, /v2 settlement: partial \(majority-partial\)/)
  assert.equal(outcome.result.basis, 'majority-partial'); assert.equal(outcome.result.check.classification, 'contradicted')
})

test('a confirmed check prints the overrule standing', async t => {
  const f = await retainedRun(t)
  const before = await snapshot(f.root)
  const lines = []
  const outcome = await main(['--record', f.recordPath, '--criterion', item.id, '--suite-root', f.suiteRoot], { decider: cannedDecider('confirmed', []), log: line => lines.push(line) })
  assert.deepEqual(await snapshot(f.root), before)
  assert.match(lines.join('\n'), /overrule check: confirmed/)
  assert.match(lines.join('\n'), /v2 settlement: met \(decider-met\)/)
  assert.equal(outcome.result.basis, 'decider-met')
})

test('an insufficient check also leaves the two-seat verdict, and any record protocol is read', async t => {
  const f = await retainedRun(t, { protocol: 'cross-family-panel-v2' })
  const lines = []
  const outcome = await main(['--record', f.recordPath, '--criterion', item.id, '--suite-root', f.suiteRoot, '--json'], { decider: cannedDecider('insufficient', []), log: line => lines.push(line) })
  const printed = JSON.parse(lines.join('\n'))
  assert.equal(printed.basis, 'majority-partial'); assert.equal(printed.check.classification, 'insufficient')
  assert.equal(printed.recorded_protocol, 'cross-family-panel-v2'); assert.equal(outcome.exitCode, 0)
})

test('the script refuses unknown criteria and usage errors without a model call', async t => {
  const f = await retainedRun(t)
  const seen = []; const lines = []
  await assert.rejects(main(['--record', f.recordPath, '--criterion', 'INV-999', '--suite-root', f.suiteRoot], { decider: cannedDecider('confirmed', seen), log: line => lines.push(line) }), /no decider ruling for INV-999/)
  const usage = await main(['--record', f.recordPath], { decider: cannedDecider('confirmed', seen), log: line => lines.push(line) })
  assert.equal(usage.exitCode, 2)
  assert.equal(seen.length, 0)
  assert.match(RETAINED_RULING_HELP, /--record/); assert.match(RETAINED_RULING_HELP, /--criterion/)
})

test('the script refuses a scratch directory inside the record run directory without a model call', async t => {
  const f = await retainedRun(t)
  const seen = []; const lines = []
  for (const scratch of [f.runDir, join(f.runDir, 'judges/decider-logs')]) {
    const outcome = await main(['--record', f.recordPath, '--criterion', 'INV-093', '--suite-root', f.suiteRoot, '--scratch-dir', scratch],
      { decider: cannedDecider('confirmed', seen), log: line => lines.push(line) })
    assert.equal(outcome.exitCode, 2)
  }
  assert.equal(seen.length, 0)
  assert.match(lines.join('\n'), /--scratch-dir must lie outside the record's run directory/)
})
