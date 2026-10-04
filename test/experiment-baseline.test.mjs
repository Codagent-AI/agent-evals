import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as baseline from '../evals/agent-runner/and-scene/lib/experiment-baseline.mjs'
import { runExperimentsCommand, parseArgs } from '../evals/agent-runner/and-scene/experiments.mjs'

const suite = resolve('evals/agent-runner/and-scene')
const at = '2026-10-05T12:00:00.000Z'
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && !Array.isArray(value) && typeof value === 'object' && target[key] && typeof target[key] === 'object') merge(target[key], value)
    else target[key] = value
  }
  return target
}
function makeResult(patch = {}) {
  return merge({
    schema_version: 8, run_id: 'rep-1', run_kind: 'candidate', mode: 'agent-runner',
    workflow: { provenance: { commit: 'runner-a' }, agent_skills_provenance: { commit: 'skills-a' }, workflow: 'implement-change', workflow_path: 'workflow.yaml', task_level_compliance: 'required', final_validator: 'required', skip_validator: 'false', events: [] },
    candidate_source: { fixture_commit: 'fixture-a' },
    role_configuration: { roles: { implementor: { configured: { cli: 'codex', model: 'model-a', effort: 'high', agent: 'implementor' }, attempts: [{ observed: { model: 'model-a' } }] } } },
    rubrics: { automated: { rubric_id: 'auto', version: '1', sha256: 'hash-a' }, human: { rubric_id: 'human', version: '1', sha256: 'hash-h' } },
    automated_subtotal: { points: 50, possible: 70, complete: true }, score: { gates_passed: true, gates: [{ id: 'build', verdict: 'pass' }] },
    evaluation_status: 'complete', product_verdict: 'pass', official_score: 70,
    human_review: { complete: true, score: { total: 20, possible: 30 }, rubric: { rubric_id: 'human', version: '1', sha256: 'hash-h' }, completed_at: at },
    cost: { usage: { complete: true, token_totals: { input: 60, output: 40, total: 100 }, tokens: { input: 60, output: 40 } }, rows: [{ provider: 'openai', token_totals: { input: 60, output: 40, total: 100 } }], total: { state: 'estimated', complete: true, estimated_api_cost_usd: 2, known_cost_subtotal_usd: 2 } },
    implementation_metrics: { active_duration_ms: 60000 }, failure: null, failed_phase: null, product_failure: null,
  }, patch)
}
function extracted(patch = {}, addedBy = 'set') {
  return baseline.extractRepetition(makeResult(patch), { directory: `/tmp/${patch.run_id ?? 'rep-1'}`, addedAt: at, addedBy })
}
function entries(...patches) { return patches.map(p => extracted(p)) }
function set(record, list, extra = {}) { return baseline.applySet(record, list, { source: 'manual', reason: 'test', now: at, ...extra }) }
function add(record, item, extra = {}) { return baseline.applyAddRep(record, item, { now: at, ...extra }) }
function refusal(output, code) { assert.ok(output.refusals?.some(r => r.code === code), JSON.stringify(output)) }

test('extracts mapped fields, provider sums, and rescore lineage', () => {
  const { entry, refusals, reviewSnapshot } = extracted({ workflow: { events: [{ event: 'imported-completed-run', source_run_id: 'original' }] }, implementation_metrics: { active_duration_ms: null }, cost: { rows: [
    { provider: 'openai', token_totals: { input: 2, output: 3, total: 5 } }, { provider: 'openai', token_totals: { input: 4, output: 1, total: 5 } },
    { provider: 'anthropic', token_totals: { input: 1, output: 1, total: 2 } }, { provider: null, token_totals: { input: 2, output: 0, total: 2 } },
  ] } })
  assert.deepEqual(refusals, [])
  assert.equal(entry.rescored_from, 'original')
  assert.equal(entry.active_duration_ms, null)
  assert.deepEqual(entry.tokens.by_provider.openai, { input: 6, output: 4, total: 10 })
  assert.equal(entry.tokens.by_provider.unknown.total, 2)
  assert.equal(entry.tokens.by_provider.anthropic.total, 2)
  assert.equal(entry.roles.implementor.configured.model, 'model-a')
  assert.deepEqual(entry.roles.implementor.observed_models, ['model-a'])
  assert.equal(entry.automated_score.points, 50)
  assert.equal(entry.gates.verdicts[0].verdict, 'pass')
  assert.equal(reviewSnapshot.points, 20)
})

test('median ordering and summary completeness', () => {
  const reps = entries({ run_id: 'b', automated_subtotal: { points: 50 } }, { run_id: 'a', automated_subtotal: { points: 50 } }, { run_id: 'c', automated_subtotal: { points: 54 } }).map(x => x.entry)
  assert.equal(baseline.selectMedian(reps), 'b')
  assert.equal(baseline.selectMedian(reps.slice(0, 2)), 'a')
  const summary = baseline.summarize(reps)
  assert.equal(summary.automated_points.mean, 154 / 3)
  assert.equal(summary.automated_points.stddev, Math.sqrt(((50 - 154 / 3) ** 2 * 2 + (54 - 154 / 3) ** 2) / 2))
  assert.equal(baseline.summarize(reps.slice(0, 1)).automated_points.stddev, null)
  const unscored = extracted({ run_id: 'unscored', automated_subtotal: null, product_failure: { reason: 'verification' }, official_score: null, human_review: null }).entry
  assert.equal(unscored.automated_score.points, null)
  assert.equal(baseline.selectMedian([unscored, ...reps.slice(0, 2)]), 'a')
  assert.deepEqual(baseline.summarize([unscored, ...reps]).automated_points, { complete: false, missing_run_ids: ['unscored'] })
  reps[1].cost.complete = false
  assert.deepEqual(baseline.summarize(reps).estimated_cost_usd, { complete: false, missing_run_ids: ['a'] })
})

test('admission, identity, lineage and human review', () => {
  const original = extracted()
  const initial = set(baseline.emptyRecord(), [original]).record
  assert.equal(initial.current.median_rep, 'rep-1')
  assert.equal(initial.current.human_review.official_score, 70)
  for (const patch of [{ schema_version: 7 }, { run_kind: 'reference' }, { failure: { reason: 'quota' } }, { automated_subtotal: { complete: false } }, { workflow: { provenance: { commit: null } } }]) {
    assert.ok(extracted(patch).refusals.length)
  }
  const different = extracted({ run_id: 'rep-2', role_configuration: { roles: { implementor: { configured: { model: 'model-b' } } } } })
  refusal(add(initial, different), 'identity-mismatch')
  const waived = add(initial, different, { allowMismatch: 'alias' }).record
  assert.deepEqual(waived.current.reps[1].mismatch, { fields: ['roles.implementor.configured.model'], reason: 'alias' })
  assert.equal(waived.current.identity.roles.implementor.configured.model, 'model-a')
  refusal(add(initial, extracted({ run_id: 'rep-2', workflow: { provenance: { commit: 'runner-b' } } }), { allowMismatch: 'drift' }), 'runner-commit-mismatch')
  assert.equal(add(initial, extracted({ run_id: 'rep-2', role_configuration: { roles: { implementor: { attempts: [{ observed: { model: 'observed-b' } }] } } } })).record.current.reps[1].mismatch, null)
  refusal(add(initial, original), 'duplicate-run')
  const rescore = extracted({ run_id: 'rescore', workflow: { events: [{ event: 'imported-completed-run', source_run_id: 'rep-1' }] } })
  for (const pair of [[original, rescore], [rescore, original]]) refusal(set(baseline.emptyRecord(), pair), 'duplicate-run')
  refusal(add(initial, rescore), 'duplicate-run')
  refusal(add(set(baseline.emptyRecord(), [rescore]).record, original), 'duplicate-run')
  refusal(set(baseline.emptyRecord(), [extracted({ human_review: null, official_score: null })]), 'median-not-reviewed')
  for (const phase of ['verification', 'candidate-server']) {
    const unscored = extracted({ run_id: phase, automated_subtotal: null, product_failure: { reason: phase }, official_score: null, human_review: null })
    assert.equal(unscored.refusals.length, 0)
    refusal(set(baseline.emptyRecord(), [unscored]), 'median-not-reviewed')
  }
})

test('history, anchor freeze, divergence, and validation', () => {
  const first = set(baseline.emptyRecord(), [extracted()]).record
  const anchored = baseline.applyAnchor(first, { reason: 'freeze', now: at }).record
  const added = add(anchored, extracted({ run_id: 'rep-2', automated_subtotal: { points: 45 } })).record
  assert.equal(added.current.human_review.is_current_median, false)
  assert.deepEqual(added.anchor, anchored.anchor)
  refusal(baseline.applyAnchor(added, { reason: 'again', now: at }), 'median-not-reviewed')
  assert.match(baseline.formatShow(added), /not the human-reviewed repetition/)
  const replaced = set(anchored, [extracted({ run_id: 'new' })], { source: 'profile-change', reason: 'new profile' }).record
  assert.equal(replaced.anchor, null)
  assert.deepEqual(replaced.history.map(x => x.kind), ['current', 'anchor'])
  for (const bad of [
    { ...first, current: {} },
    { ...first, current: { ...first.current, median_rep: 'missing' } },
    { ...first, current: { ...first.current, human_review: { ...first.current.human_review, run_id: 'missing' } } },
    { ...first, current: { ...first.current, reps: [first.current.reps[0], first.current.reps[0]] } },
    { ...first, history: [{ kind: 'bad', replaced_at: at, replacement_reason: 'x', record: first.current }] },
  ]) assert.throws(() => baseline.validateRecord(bad))
})

async function temp() { return mkdtemp(join(tmpdir(), 'experiment-baseline-')) }
async function resultDir(root, result) { const dir = join(root, result.run_id); await mkdir(dir); await writeFile(join(dir, 'result.json'), JSON.stringify(result)); return dir }
function capture() { const lines = []; return { lines, stdout: s => lines.push(s) } }

test('command persistence is atomic and show is read-only', async () => {
  const root = await temp(), record = join(root, 'nested', 'baseline.json')
  const dir = await resultDir(root, makeResult())
  const defaultPath = join(suite, 'experiments', 'baseline.json')
  const defaultBefore = await readFile(defaultPath).catch(() => null)
  const out = capture()
  assert.equal((await runExperimentsCommand({ argv: ['baseline', 'set', dir, '--source', 'manual', '--reason', 'first', '--record', record], now: () => new Date(at), stdout: out.stdout })).exitCode, 0)
  const before = await readFile(record, 'utf8')
  assert.ok(before.endsWith('\n'))
  assert.match(before, /\n  "schema_version"/)
  const mtime = (await stat(record)).mtimeMs
  assert.equal((await runExperimentsCommand({ argv: ['baseline', 'show', '--record', record], stdout: out.stdout })).exitCode, 0)
  assert.equal((await stat(record)).mtimeMs, mtime)
  const bad = await resultDir(root, makeResult({ run_id: 'bad', schema_version: 7 }))
  assert.equal((await runExperimentsCommand({ argv: ['baseline', 'set', dir, bad, '--source', 'manual', '--reason', 'bad', '--record', record] })).exitCode, 1)
  assert.equal(await readFile(record, 'utf8'), before)
  assert.equal((await runExperimentsCommand({ argv: ['baseline', 'set', dir, '--source', 'manual', '--reason', 'x', '--record', record], write: async (path, value, { onStage }) => { const staged = join(root, 'nested', '.injected.tmp'); onStage(staged); await writeFile(staged, 'partial'); throw Error('write failed') } })).exitCode, 2)
  assert.ok(!(await readdir(join(root, 'nested'))).some(x => x.endsWith('.tmp')))
  assert.equal(await readFile(record, 'utf8'), before)
  for (const invalid of ['{', JSON.stringify({ schema_version: 1, current: {}, anchor: null, history: [] }), JSON.stringify({ ...JSON.parse(before), current: { ...JSON.parse(before).current, median_rep: 'absent' } })]) {
    await writeFile(record, invalid)
    for (const command of [['show'], ['set', dir, '--source', 'manual', '--reason', 'x']]) {
      assert.equal((await runExperimentsCommand({ argv: ['baseline', ...command, '--record', record] })).exitCode, 2)
      assert.equal(await readFile(record, 'utf8'), invalid)
    }
  }
  assert.deepEqual(await readFile(defaultPath).catch(() => null), defaultBefore)
})

test('published results map without changing their bytes', async () => {
  const ids = ['aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1', '3938f16c-81f7-4334-9bbd-ad215d88f112-rep-1', '19b861fd-0efc-4476-bcc1-b73ef46e86f2-rep-1']
  for (const id of ids) {
    const bytes = await readFile(join(suite, 'results', id, 'result.json'))
    const hash = createHash('sha256').update(bytes).digest('hex')
    const result = JSON.parse(bytes)
    const { entry, refusals } = baseline.extractRepetition(result, { directory: id, addedAt: at, addedBy: 'set' })
    assert.deepEqual(refusals, [])
    assert.equal(entry.run_id, result.run_id)
    if (id === ids[0]) {
      assert.equal(entry.runner_commit, 'aed680076ecb35a1871c20306f3872e3cd915e8f')
      assert.equal(entry.skills_commit, 'aae772244c80f8a0b9b4e128ac816db2bbad28f4')
      assert.equal(entry.fixture_commit, '892dfbcf3762bc95cdbae6f05b18cc2b168a5fab')
      assert.equal(entry.roles.lead.configured.model, 'claude-sonnet-5-5')
      assert.equal(entry.rubrics.automated.sha256, '291738a326b479387b0114aafad134f6d15953869d16f856a50a074f3c960891')
      assert.equal(entry.automated_score.points, 56.56071428571428)
      assert.equal(entry.outcome.human_review_complete, true)
      assert.equal(Object.values(entry.tokens.by_provider).reduce((sum, x) => sum + x.total, 0), 28996374)
    }
    if (id === ids[1]) { assert.ok(entry.tokens.by_provider.unknown); assert.equal(entry.outcome.human_review_complete, false) }
    if (id === ids[2]) { assert.ok(entry.product_failure ?? entry.failure.product_failure); assert.equal(entry.tokens.complete, false); assert.equal(entry.active_duration_ms, null) }
    assert.equal(createHash('sha256').update(await readFile(join(suite, 'results', id, 'result.json'))).digest('hex'), hash)
  }
})

test('CLI operator journey', async () => {
  const root = await temp(), record = join(root, 'record.json'), script = join(suite, 'experiments.mjs')
  const run = (...args) => spawnSync(process.execPath, [script, 'baseline', ...args, '--record', record], { encoding: 'utf8' })
  const dirs = []
  for (const [id, points, reviewed] of [['r1', 49.81, false], ['r2', 56.29, true], ['r3', 56.81, false], ['control', 45, false]]) dirs.push(await resultDir(root, makeResult({ run_id: id, automated_subtotal: { points }, official_score: reviewed ? 70 : null, human_review: reviewed ? makeResult().human_review : null })))
  const initial = run('set', ...dirs.slice(0, 3), '--source', 'profile-change', '--reason', 'seed')
  assert.equal(initial.status, 0)
  assert.match(initial.stdout, /median r2/)
  let saved = JSON.parse(await readFile(record))
  assert.equal(saved.current.median_rep, 'r2')
  assert.equal(saved.current.human_review.is_current_median, true)
  assert.equal(run('anchor', '--from-current', '--reason', 'first anchor').status, 0)
  saved = JSON.parse(await readFile(record))
  const frozen = saved.anchor
  assert.deepEqual(Object.fromEntries(Object.entries(frozen).filter(([key]) => !['anchored_at', 'anchor_reason'].includes(key))), saved.current)
  assert.equal(run('add-rep', dirs[3]).status, 0)
  saved = JSON.parse(await readFile(record))
  assert.equal(saved.current.reps.length, 4)
  assert.equal(saved.current.median_rep, 'r1')
  assert.equal(saved.current.human_review.run_id, 'r2')
  assert.equal(saved.current.human_review.is_current_median, false)
  assert.deepEqual(saved.anchor, frozen)
  const shown = run('show')
  assert.equal(shown.status, 0)
  for (const id of ['r1', 'r2', 'r3', 'control']) assert.match(shown.stdout, new RegExp(id))
  assert.match(shown.stdout, /not the human-reviewed repetition/)
  assert.match(shown.stdout, /Anchor: set/)
  const beforeRefusals = await readFile(record, 'utf8')
  const diverged = run('anchor', '--from-current', '--reason', 'drift')
  assert.equal(diverged.status, 1)
  assert.match(diverged.stderr, /median-not-reviewed.*r1.*r2/)
  const rescore = await resultDir(root, makeResult({ run_id: 'rescore', workflow: { events: [{ event: 'imported-completed-run', source_run_id: 'r1' }] } }))
  const duplicate = run('add-rep', rescore)
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /duplicate-run.*rescore.*r1.*set/)
  const other = await resultDir(root, makeResult({ run_id: 'other', workflow: { provenance: { commit: 'runner-b' } } }))
  const mismatch = run('add-rep', other, '--allow-mismatch', 'drift')
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, /runner-commit-mismatch/)
  for (const args of [['promote'], ['set', dirs[0], '--source', 'experiment', '--reason', 'bad']]) {
    const usage = run(...args)
    assert.equal(usage.status, 2)
    assert.match(usage.stdout, /Usage:/)
  }
  assert.equal(await readFile(record, 'utf8'), beforeRefusals)
  assert.equal(run('set', ...dirs.slice(0, 3), '--source', 'profile-change', '--reason', 'new profile').status, 0)
  saved = JSON.parse(await readFile(record))
  assert.equal(saved.anchor, null)
  assert.deepEqual(saved.history.map(x => x.kind), ['current', 'anchor'])
  assert.ok(saved.history.every(x => x.replacement_reason === 'new profile'))
  assert.equal(run('--help').status, 0)
})

test('incomplete metrics and missing provider rows stay explicit', () => {
  const reps = entries(
    { run_id: 'one', cost: { rows: [{ provider: 'openai', token_totals: { input: 60, output: 40, total: 100 } }] } },
    { run_id: 'two', cost: { rows: [{ provider: 'anthropic', token_totals: { input: 30, output: 70, total: 100 } }] } },
  ).map(x => x.entry)
  const summary = baseline.summarize(reps)
  assert.equal(summary.tokens_by_provider.providers.openai.mean, 50)
  assert.equal(summary.tokens_by_provider.providers.anthropic.mean, 50)
  assert.equal(summary.tokens_total.stddev, 0)
  reps[1].tokens.complete = false
  assert.deepEqual(baseline.summarize(reps).tokens_by_provider, { complete: false, missing_run_ids: ['two'] })
  reps[1].active_duration_ms = null
  assert.deepEqual(baseline.summarize(reps).active_duration_ms, { complete: false, missing_run_ids: ['two'] })
})

test('set reports every bad directory and preserves the first readable identity', async () => {
  const root = await temp(), record = join(root, 'record.json')
  const later = await resultDir(root, makeResult({ run_id: 'later', role_configuration: { roles: { implementor: { configured: { model: 'model-b' } } } } }))
  const first = await resultDir(root, makeResult({ run_id: 'first' }))
  const missing = join(root, 'missing')
  const outcome = await runExperimentsCommand({ argv: ['baseline', 'set', missing, first, later, '--source', 'manual', '--reason', 'test', '--record', record] })
  assert.equal(outcome.exitCode, 1)
  assert.deepEqual(outcome.errors.map(x => x.code), ['missing-result', 'identity-mismatch'])
  assert.equal(outcome.errors[0].directory, missing)
  assert.equal(outcome.errors[1].directory, later)
  assert.match(outcome.errors[1].message, /model-a.*model-b/)
  await assert.rejects(readFile(record))
})

test('parseArgs and invalid records reject before mutation', async () => {
  for (const args of [
    ['baseline', 'promote'], ['baseline', 'set', 'dir', '--source', 'experiment', '--reason', 'x'],
    ['baseline', 'set', 'dir', '--source', 'manual'], ['baseline', 'anchor', '--reason', 'x'],
    ['baseline', 'add-rep', 'a', 'b'], ['baseline', 'show', '--mystery'],
  ]) assert.throws(() => parseArgs(args))
  const root = await temp(), record = join(root, 'record.json')
  await writeFile(record, 'null')
  const result = await runExperimentsCommand({ argv: ['baseline', 'show', '--record', record] })
  assert.equal(result.exitCode, 2)
  assert.match(result.errors[0].message, /record/)
  assert.equal(await readFile(record, 'utf8'), 'null')
})

test('show without a record and anchor replacement', () => {
  assert.match(baseline.formatShow(baseline.emptyRecord()), /No experiment baseline is set\./)
  const first = set(baseline.emptyRecord(), [extracted()]).record
  const frozen = baseline.applyAnchor(first, { reason: 'first', now: at }).record
  const replacement = baseline.applyAnchor(frozen, { reason: 'second', now: '2026-10-06T12:00:00.000Z' }).record
  assert.equal(replacement.history[0].kind, 'anchor')
  assert.equal(replacement.history[0].record.anchor_reason, 'first')
  assert.equal(replacement.history[0].replacement_reason, 'second')
  assert.equal(frozen.anchor.anchor_reason, 'first')
})


test('show reports malformed stored metrics as invalid record', async () => {
  const root = await temp(), record = join(root, 'record.json')
  const valid = set(baseline.emptyRecord(), [extracted()]).record
  for (const current of [
    { ...valid.current, summary: { ...valid.current.summary, active_duration_ms: undefined } },
    { ...valid.current, reps: [{ ...valid.current.reps[0], cost: undefined }] },
  ]) {
    const bytes = JSON.stringify({ ...valid, current })
    await writeFile(record, bytes)
    const outcome = await runExperimentsCommand({ argv: ['baseline', 'show', '--record', record] })
    assert.equal(outcome.exitCode, 2)
    assert.equal(outcome.errors[0].code, 'invalid-record')
    assert.equal(await readFile(record, 'utf8'), bytes)
  }
})

test('unexpected result read and apply errors keep exit code 2 with distinct codes', async () => {
  const root = await temp(), record = join(root, 'record.json')
  const directory = join(root, 'directory-result')
  await mkdir(join(directory, 'result.json'), { recursive: true })
  const readOutcome = await runExperimentsCommand({ argv: ['baseline', 'set', directory, '--source', 'manual', '--reason', 'test', '--record', record] })
  assert.equal(readOutcome.exitCode, 2)
  assert.equal(readOutcome.errors[0].code, 'io-error')
  const current = set(baseline.emptyRecord(), [extracted()]).record.current
  delete current.reps[0].tokens
  await writeFile(record, JSON.stringify({ schema_version: 1, current, anchor: null, history: [] }))
  const newDirectory = await resultDir(root, makeResult({ run_id: 'rep-2' }))
  const applyOutcome = await runExperimentsCommand({ argv: ['baseline', 'add-rep', newDirectory, '--record', record] })
  assert.equal(applyOutcome.exitCode, 2)
  assert.equal(applyOutcome.errors[0].code, 'internal-error')
  assert.match(applyOutcome.errors[0].message, /experiment-baseline/)
})
