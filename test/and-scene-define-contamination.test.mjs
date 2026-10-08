import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectEvidence, loadEvidence } from '../evals/agent-runner/and-scene-define/lib/evidence.mjs'
import { reconcileConversation } from '../evals/agent-runner/and-scene-define/lib/reconciliation.mjs'
import { auditContamination, RESIDUAL_RISK } from '../evals/agent-runner/and-scene-define/lib/contamination.mjs'
import { readJson, SUITE_ROOT } from '../evals/agent-runner/and-scene-define/lib/files.mjs'
import { runPhases } from '../evals/agent-runner/and-scene-define/lib/phases.mjs'
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const user = text => ({ type: 'user', message: { role: 'user', content: text } })
const final = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }
const exchange = { step: 'define.proposal', step_id: 'proposal', attempt: 1, turn: 1, reply: 'Use a local app.', reply_type: 'text' }
const call = (name, input, output, id = 'c1') => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', name, input, id }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } },
]
async function fixture(t, { extra = [], conversation = [exchange], replies = [exchange], users = [exchange.reply], crosscheck = null, runPrefix = 'define-audit-' } = {}) {
  const runDir = await mkdtemp(join(tmpdir(), runPrefix)); t.after(() => rm(runDir, { recursive: true, force: true }))
  const runtime = join(runDir, 'sandbox/.runtime'); const runnerDir = join(runtime, 'agent-runner-projects/repo/runs/run')
  for (const dir of [runnerDir, join(runnerDir, 'external-user'), join(runnerDir, 'output'), join(runtime, 'claude/projects/repo'), join(runDir, 'collected')]) await mkdir(dir, { recursive: true })
  const put = (path, value) => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  await put(join(runDir, 'conversation.jsonl'), jsonl(conversation))
  await put(join(runDir, 'collected/proposal.md'), 'proposal')
  const steps = [{ id: 'proposal', prefix: 'define/proposal', agent_invoked: true, cli: 'claude', session_id: 'lead' }]
  if (crosscheck) steps.push({ id: 'crosscheck', kind: 'agent-call', prefix: 'define/proposal/child', agent_invoked: true, cli: crosscheck, session_id: 'child' })
  await put(join(runnerDir, 'run-metrics.json'), { steps })
  await put(join(runnerDir, 'state.json'), {})
  await put(join(runnerDir, 'audit.log'), 'now [define, proposal] step_start {"prompt":"initial","resolved_session_id":"lead"}\n')
  const records = replies.flatMap(r => [
    { type: 'request_written', identity: { step_key: 'define.proposal', attempt: r.attempt, turn: r.turn }, request: { ...r, session_id: 'lead', cli: 'claude' } },
    { type: 'reply_acted', identity: { step_key: 'define.proposal', attempt: r.attempt, turn: r.turn }, reply: { text: r.reply } },
  ])
  await put(join(runnerDir, 'external-user/exchanges.jsonl'), jsonl(records))
  await put(join(runtime, 'claude/projects/repo/lead.jsonl'), jsonl([user('initial'), final, ...users.flatMap(text => [user(text), final]), ...extra, final]))
  await put(join(runnerDir, 'output/define-proposal.attempt-1.turn-1.out'), jsonl([final, { type: 'result', subtype: 'success' }]))
  return { runDir, runtime, runnerDir, put }
}
async function retained(f) { await collectEvidence(f); return loadEvidence(f.runDir) }
const patterns = await readJson(join(SUITE_ROOT, 'contamination-patterns.json'))
test('INT-004 retains hashed evidence and audits native calls and output deterministically', async t => {
  const f = await fixture(t, { extra: [
    ...call('Bash', { command: 'cat ../../exchange/x.reply.json' }, 'ok'),
    ...call('Read', { path: 'notes.md' }, 'DESIGN_W=880', 'c2'),
  ] })
  const evidence = await retained(f)
  assert.equal(reconcileConversation(evidence).status, 'clean')
  const a = auditContamination({ ...evidence, patterns }); const b = auditContamination({ ...evidence, patterns })
  assert.equal(JSON.stringify(a), JSON.stringify(b)); assert.equal(a.evaluation_status, 'contaminated')
  assert.ok(a.matches.some(m => m.pattern === 'exchange-file' && m.session === 'lead' && m.tool_call === 'c1'))
  assert.ok(a.matches.some(m => m.pattern === 'reference-canvas-dimensions'))
  assert.equal('definition_verdict' in a, false); assert.equal(a.residual_risk, RESIDUAL_RISK)
  const manifest = await readJson(join(f.runDir, 'evidence-manifest.json'))
  for (const path of ['collected/proposal.md', 'conversation.jsonl', 'evidence/runner/state.json', 'evidence/runner/audit.log', 'evidence/runner/run-metrics.json', 'evidence/runner/external-user/exchanges.jsonl']) assert.ok(manifest.files.some(file => file.path === path && /^[a-f0-9]{64}$/.test(file.sha256)))
  await rm(f.runtime, { recursive: true }); assert.equal(reconcileConversation(await loadEvidence(f.runDir)).status, 'clean')
  await f.put(join(f.runDir, 'collected/proposal.md'), 'tampered'); await assert.rejects(loadEvidence(f.runDir), /hash/)
})
test('canaries exclude disclosed replies and artifact writes; locators still audit writes', async t => {
  const disclosed = { ...exchange, reply: 'Use DESIGN_W=880.' }
  const f = await fixture(t, { conversation: [disclosed], replies: [disclosed], users: [disclosed.reply], extra: [
    ...call('Read', { path: 'notes' }, 'DESIGN_W=880'),
    ...call('Write', { content: 'It starts with you, a topic, and mild overconfidence.' }, 'written', 'c2'),
  ] })
  const evidence = await retained(f); assert.equal(auditContamination({ ...evidence, patterns }).status, 'clean')
  evidence.transcripts[0].calls.push({ id: 'write-locator', name: 'Write', input: 'Codagent-AI/and-scene', output: '' })
  assert.equal(auditContamination({ ...evidence, patterns }).evaluation_status, 'contaminated')
})
for (const [name, options, record] of [
  ['altered Runner reply', { replies: [{ ...exchange, reply: 'altered' }] }, 'Runner'],
  ['missing native reply', { users: [] }, 'lead transcript'],
  ['extra native reply', { users: [exchange.reply, 'extra'] }, 'lead transcript'],
  ['extra Runner reply', { replies: [exchange, { ...exchange, turn: 2 }] }, 'Runner'],
  ['identical replies cannot share a user turn', { conversation: [exchange, { ...exchange, turn: 2 }], replies: [exchange, { ...exchange, turn: 2 }] }, 'lead transcript'],
]) test(`reconciliation rejects ${name}`, async t => {
  const evidence = await retained(await fixture(t, options))
  assert.throws(() => reconcileConversation(evidence), new RegExp(record))
})
test('reply with completion instruction reconciles one to one', async t => {
  assert.equal(reconcileConversation(await retained(await fixture(t, { users: [exchange.reply + '\nComplete with agent-runner step complete'] }))).status, 'clean')
})
test('missing and truncated evaluated transcripts fail, including crosscheck', async t => {
  const f = await fixture(t, { crosscheck: 'codex' }); await assert.rejects(collectEvidence(f), /child.*missing|missing.*child/)
  await f.put(join(f.runnerDir, 'run-metrics.json'), { steps: [{ id: 'proposal', agent_invoked: true, cli: 'claude', session_id: 'lead' }] })
  await f.put(join(f.runtime, 'claude/projects/repo/lead.jsonl'), jsonl([user('initial'), final, user('unfinished')]))
  await assert.rejects(collectEvidence(f), /truncated.*lead|lead.*truncated/)
})
test('Codex native and per-turn web search results are audited', async t => {
  const f = await fixture(t, { crosscheck: 'codex' }); const dir = join(f.runtime, 'codex/sessions/2026'); await mkdir(dir, { recursive: true })
  await f.put(join(dir, 'rollout-2026-child.jsonl'), jsonl([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } },
    { type: 'response_item', payload: { type: 'web_search_call', id: 'web', action: { query: 'a normal query' }, results: 'https://github.com/Codagent-AI/and-scene' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } },
  ]))
  await f.put(join(f.runnerDir, 'output/define_proposal_child.attempt-1.turn-1.out'), jsonl([
    { type: 'item.completed', item: { type: 'web_search', id: 'search', query: 'normal', results: 'DESIGN_W=880' } }, { type: 'turn.completed' },
  ]))
  const audit = auditContamination({ ...await retained(f), patterns })
  assert.ok(audit.matches.some(m => m.session === 'child' && m.tool_call === 'web'))
  assert.ok(audit.matches.some(m => m.pattern === 'reference-canvas-dimensions' && m.source.includes('output')))
})
for (const runPrefix of ['define-audit-', "define-audit-'\\\n\u0001-"]) test(`Cursor retains WAL content at exact path ${JSON.stringify(runPrefix)}`, async t => {
  const f = await fixture(t, { crosscheck: 'cursor', runPrefix }); const dir = join(f.runtime, 'cursor/chats/workspace/child'); await mkdir(dir, { recursive: true })
  const db = join(dir, 'store.db')
  execFileSync('python3', ['-c', `import sqlite3,os
import sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE blobs (id TEXT PRIMARY KEY,data BLOB)');c.commit()
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
for i,s in enumerate(${JSON.stringify([
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'cursor-call', toolName: 'Read', args: { path: 'hidden/reference/file' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'cursor-call', result: 'contents' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ].map(r => JSON.stringify(r)))}):c.execute('INSERT INTO blobs VALUES (?,?)',(str(i),s))
c.commit()
os._exit(0)`, db])
  const evidence = await retained(f)
  assert.ok(auditContamination({ ...evidence, patterns }).matches.some(m => m.session === 'child' && m.tool_call === 'cursor-call'))
  const snapshot = join(f.runDir, evidence.manifest.invocations.find(i => i.cli === 'cursor').transcript)
  assert.match(execFileSync('sqlite3', [snapshot, 'SELECT CAST(data AS TEXT) FROM blobs'], { encoding: 'utf8' }), /hidden\/reference/)
  await f.put(snapshot, 'stale snapshot')
  await collectEvidence(f)
  assert.match(execFileSync('sqlite3', [snapshot, 'SELECT CAST(data AS TEXT) FROM blobs'], { encoding: 'utf8' }), /hidden\/reference/)
  await rm(snapshot); await symlink(db, snapshot)
  await assert.rejects(collectEvidence(f), /symlink/)
  await rm(snapshot)
  await f.put(join(f.runnerDir, 'run-metrics.json'), { steps: [{ id: 'child', kind: 'agent-call', agent_invoked: true, cli: 'cursor', session_id: 'absent' }] })
  await assert.rejects(collectEvidence(f), /absent/)
})
test('escaping copied paths are rejected', async t => {
  const f = await fixture(t); await rm(join(f.runnerDir, 'state.json')); await symlink('/etc/hosts', join(f.runnerDir, 'state.json'))
  await assert.rejects(collectEvidence(f), /symlink/)
})
test('contaminated lifecycle stops before any later phase', async () => {
  const called = []; const phases = ['artifact-collection', 'conversation-reconciliation', 'contamination-audit', 'gates-and-judging', 'publication']
  const handlers = Object.fromEntries(phases.map(p => [p, async () => { called.push(p); return p === 'contamination-audit' ? { stop: true, outcome: { evaluation_status: 'contaminated' } } : null }]))
  const result = await runPhases({ phases, handlers }); assert.deepEqual(called, phases.slice(0, 3)); assert.equal(result.outcome.evaluation_status, 'contaminated')
})

for (const cli of ['claude', 'codex']) test(`recorded ${cli} requirements-discovery baseline is clean`, async t => {
  const { cp } = await import('node:fs/promises')
  const root = new URL(`./fixtures/and-scene-define-clean/${cli}/`, import.meta.url)
  const f = await fixture(t)
  for (const [source, target] of [['conversation.jsonl', join(f.runDir, 'conversation.jsonl')], ['run-metrics.json', join(f.runnerDir, 'run-metrics.json')], ['exchanges.jsonl', join(f.runnerDir, 'external-user/exchanges.jsonl')], ['audit.log', join(f.runnerDir, 'audit.log')]]) await cp(new URL(source, root), target)
  const dir = join(f.runtime, cli === 'claude' ? 'claude/projects/baseline' : 'codex/sessions/baseline'); await mkdir(dir, { recursive: true })
  await cp(new URL('transcript.jsonl', root), join(dir, cli === 'claude' ? 'clean-claude.jsonl' : 'rollout-baseline-clean-codex.jsonl'))
  await rm(join(f.runnerDir, 'output/define-proposal.attempt-1.turn-1.out'))
  await f.put(join(f.runnerDir, 'output/_proposal_.attempt-1.turn-1.out'), jsonl([{ type: 'turn.completed' }]))
  const evidence = await retained(f)
  assert.equal(reconcileConversation(evidence).status, 'clean')
  const audit = auditContamination({ ...evidence, patterns })
  assert.deepEqual(audit.matches, [], JSON.stringify(audit.matches)); assert.equal(audit.residual_risk, RESIDUAL_RISK)
})

test('reconciliation follows host reply order and audited initial/resume prompts', async t => {
  const second = { ...exchange, attempt: 2, turn: 1, reply: 'Keep it offline.' }
  const f = await fixture(t, { conversation: [exchange, second], replies: [exchange, second], users: [exchange.reply, 'resumed step prompt', second.reply] })
  await f.put(join(f.runnerDir, 'audit.log'), [
    'now [define, proposal] step_start {"prompt":"initial","resolved_session_id":"lead"}',
    'now [define, proposal] external_user_reply {"step_key":"define.proposal","attempt":1,"turn":1,"type":"text"}',
    'now [define, proposal] step_start {"prompt":"resumed step prompt","resolved_session_id":"lead"}',
    'now [define, proposal] external_user_reply {"step_key":"define.proposal","attempt":2,"turn":1,"type":"text"}',
  ].join('\n') + '\n')
  const evidence = await retained(f); assert.equal(reconcileConversation(evidence).status, 'clean')
  evidence.conversation.reverse()
  assert.throws(() => reconcileConversation(evidence), /order|lead transcript/)
})
test('incomplete Cursor tool records fail closed', async t => {
  const f = await fixture(t, { crosscheck: 'cursor' }); const dir = join(f.runtime, 'cursor/chats/workspace/child'); await mkdir(dir, { recursive: true })
  const db = join(dir, 'store.db')
  execFileSync('sqlite3', [db, `CREATE TABLE blobs(id TEXT,data BLOB); INSERT INTO blobs VALUES('one','{"role":"assistant","content":[{"type":"text","text":"done"}]}');`])
  await assert.rejects(collectEvidence(f), /incomplete.*cursor:child/)
})

test('a step without simulated replies still reconciles its audited initial turn', async t => {
  const f = await fixture(t, { conversation: [], replies: [], users: [] })
  await f.put(join(f.runtime, 'claude/projects/repo/lead.jsonl'), jsonl([user("Let's start the proposal step"), final]))
  assert.equal(reconcileConversation(await retained(f)).status, 'clean')
})

test('real responder text and semantic reply types reconcile and exclude disclosed canaries', async t => {
  const f = await fixture(t, { replies: [{ ...exchange, reply: 'Use DESIGN_W=880.' }], users: ['Use DESIGN_W=880.'] })
  const { reply, ...identity } = exchange
  await f.put(join(f.runDir, 'conversation.jsonl'), jsonl([{ ...identity, text: 'Use DESIGN_W=880.', reply_type: 'answer' }]))
  const evidence = await retained(f)
  assert.equal(reconcileConversation(evidence).status, 'clean')
  evidence.transcripts[0].calls.push({ id: 'read', name: 'Read', input: 'file', output: 'DESIGN_W=880' })
  assert.deepEqual(auditContamination({ ...evidence, patterns }).matches, [])
})

test('Codex native web_search events retain their input and results', async () => {
  const { parseTranscript } = await import('../evals/agent-runner/and-scene-define/lib/transcripts.mjs')
  const transcript = parseTranscript([
    { type: 'event_msg', payload: { type: 'web_search', id: 'search-event', query: 'ordinary', results: 'DESIGN_W=880' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ], { cli: 'codex', session: 'native' })
  const audit = auditContamination({ transcripts: [{ ...transcript, session_id: 'native', source: 'native.jsonl' }], conversation: [], patterns })
  assert.ok(audit.matches.some(m => m.tool_call === 'search-event' && m.field === 'output'))
})

test('literal and multiline regex audit excerpts locate the matching text with compiled flags', async () => {
  const { compilePatterns } = await import('../evals/agent-runner/and-scene-define/lib/canary.mjs')
  const data = { version: 1, patterns: [
    { id: 'literal', kind: 'locator', type: 'literal', value: 'Hidden/Reference/' },
    { id: 'multiline', kind: 'locator', type: 'regex', value: '^HIDDEN/REFERENCE/FILE$' },
  ] }
  const text = 'ordinary line\n'.repeat(30) + 'hidden/reference/file\nordinary ending'
  for (const pattern of compilePatterns(data)) {
    assert.equal(pattern.matches(text), true)
    const offset = pattern.type === 'literal' ? text.toLowerCase().indexOf(pattern.value.toLowerCase()) : text.search(new RegExp(pattern.value, 'im'))
    assert.equal(offset, text.indexOf('hidden/reference/file'))
  }
  const audit = auditContamination({ transcripts: [{ session_id: 's', source: 's.jsonl', calls: [{ id: 'read', name: 'Read', input: '', output: text }] }], conversation: [], patterns: data })
  assert.equal(audit.matches.length, 2)
  for (const match of audit.matches) assert.match(match.excerpt, /hidden\/reference\/file/)
})

import { cursorRecords } from '../evals/agent-runner/and-scene-define/lib/transcripts.mjs'
test('manifest-backed Cursor reader ignores unlisted WAL evidence and never writes SQLite sidecars', async t => {
  const root = await mkdtemp(join(tmpdir(), 'define-immutable-')); t.after(() => rm(root, { recursive: true, force: true }))
  const db = join(root, 'snapshot #?%.db')
  execFileSync('python3', ['-c', `import sqlite3, os, sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE blobs(data BLOB)')
c.execute('INSERT INTO blobs VALUES (?)', ('{"source":"manifest"}',))
c.commit()
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
c.execute('INSERT INTO blobs VALUES (?)', ('{"source":"unlisted-wal"}',))
c.commit()
os._exit(0)`, db])
  assert.deepEqual(cursorRecords(db, { immutable: true }), [{ source: 'manifest' }])
})
