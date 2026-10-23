import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { git, temp } from './and-scene-e2e-helpers.mjs'
import { evaluateProduct, fileUnits, ProductHarnessError } from '../evals/agent-runner/and-scene-e2e/lib/product-evaluation.mjs'
import { NotEvaluableError, resolveBuildPlan } from '../evals/agent-runner/and-scene-e2e/lib/build-plan.mjs'
import { containerArgs } from '../evals/agent-runner/and-scene-e2e/lib/container.mjs'
import { loadProductInputs, EVIDENCE_JOBS, criteriaForJob } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'
import { PRODUCT_JUDGE_PROFILE } from '../evals/agent-runner/and-scene/lib/judge-profile.mjs'
import { createProductionDeps } from '../evals/agent-runner/and-scene-e2e/lib/production-deps.mjs'
import { serveOutput } from '../evals/agent-runner/and-scene-e2e/lib/serve.mjs'
import { scoreProduct, evaluateGates } from '../evals/agent-runner/and-scene-e2e/lib/scoring.mjs'

const inputs = await loadProductInputs()
const BRANCH = 'add-presentation-skill'
const viteManifest = extra => JSON.stringify({ name: 'app', devDependencies: { vite: '^5' }, scripts: { build: 'vite build' }, ...extra })
// Real git: the delivered bundle holds main and the candidate branch.
async function deliver(t, files) {
  const root = await temp(t, 'e2e-product-')
  const repo = join(root, 'repo'); await mkdir(repo, { recursive: true })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo])
  await writeFile(join(repo, 'README.md'), 'start\n'); git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'start'])
  git(repo, ['checkout', '--quiet', '-b', BRANCH])
  for (const [path, text] of Object.entries(files)) { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), text) }
  git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'work'])
  const runDir = join(root, 'run'); await mkdir(join(runDir, 'source'), { recursive: true }); await mkdir(join(runDir, 'collected'), { recursive: true })
  git(repo, ['bundle', 'create', join(runDir, 'source/candidate.bundle'), 'main', BRANCH])
  await writeFile(join(runDir, 'collected/proposal.md'), '# the candidate proposal\n')
  await mkdir(join(runDir, 'evidence/final/acceptance'), { recursive: true }); await writeFile(join(runDir, 'evidence/final/acceptance/000-final-handoff'), 'handoff text')
  return { root, runDir, commit: git(repo, ['rev-parse', 'HEAD']), bundlePath: join(runDir, 'source/candidate.bundle'), collectedDir: join(runDir, 'collected') }
}
const acceptance = { delivered_commit: 'x', artifacts: [{ role: 'final-handoff', file: 'evidence/final/acceptance/000-final-handoff', sha256: 'h' }], missing_roles: [], findings: [] }
// The fake container: records every spec; `build` writes the output directory into the mounted copy.
function containerHarness({ output = 'dist', failBuild = false } = {}) {
  const specs = []
  const run = (spec, meta) => {
    specs.push({ ...spec, label: meta.label })
    if (meta.label === 'build') {
      if (failBuild) throw new Error('rollup failed')
      const dir = join(spec.mounts[0].source, spec.workdir.replace(/^\/work\/?/, ''), output)
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.html'), '<html><body>built</body></html>')
    }
    return { stdout: '' }
  }
  return { specs, run }
}
function judges({ fail = [], seen = [] } = {}) {
  const out = []
  const invoke = async request => {
    if (request.audit_stage) return JSON.stringify({ results: request.criteria.map(id => ({ id, classification: 'confirmed', rationale: 'resolves the claim', evidence: ['closed-world source packet'] })) })
    seen.push(request.job)
    if (fail.includes(request.job)) throw Object.assign(new Error('judge unavailable'), { retryable: false })
    const evidenceJob = EVIDENCE_JOBS.includes(request.job)
    return JSON.stringify({ results: request.criteria.map(id => ({ id, verdict: 'pass', rationale: `meets ${id}`, evidence: ['saw it'], citations: [evidenceJob ? 'acceptance/readiness.json' : 'src/main.ts'] })) })
  }
  return { invoke, seen, panel: PRODUCT_JUDGE_PROFILE.panel.map(member => ({ ...member, invoke })), decider: { ...PRODUCT_JUDGE_PROFILE.decider, invoke } }
}
// Browser judges pass everything with a replay the fake driver reproduces.
function browserDeps(extra = {}) {
  const calls = { browserJobs: 0 }
  const invoke = async request => {
    calls.browserJobs++
    return JSON.stringify({ results: request.criteria.map(id => ({ id, verdict: 'pass', rationale: 'works', evidence: ['saw it'], replay: { actions: [{ type: 'navigate', path: '/' }], expect: { type: 'text-present', text: 'built' } } })) })
  }
  const createDriver = async () => ({ replayGeneric: async () => ({ states: [{ dom: 'a', screenshot: 'a', probes: [] }], final: { dom: 'a', screenshot: 'a', text: 'built', probes: [] }, marks: {}, product_failure: null }), close: async () => {} })
  return { calls, browserInvoke: invoke, browserPanel: PRODUCT_JUDGE_PROFILE.panel.map(member => ({ ...member })), browserDecider: { ...PRODUCT_JUDGE_PROFILE.decider }, createDriver, ...extra }
}
async function evaluate(t, files, { containerOptions, judgeOptions, deps = {}, evidenceFile = null, runDirOverride = null, unit } = {}) {
  const world = runDirOverride ?? await deliver(t, files)
  if (evidenceFile) await writeFile(join(world.runDir, 'evidence/final/acceptance/000-final-handoff'), evidenceFile)
  const container = containerHarness(containerOptions); const j = judges(judgeOptions); const b = browserDeps()
  const served = []
  const serve = async options => { const server = await serveOutput(options); served.push({ root: options.root, root_body: await (await fetch(server.url)).text(), nested_body: await (await fetch(`${server.url}/some/nested/path`)).text() }); return server }
  const run = async () => {
    const result = await evaluateProduct({ runDir: world.runDir, rubric: inputs.rubric, inventory: inputs.inventory, bundlePath: world.bundlePath, commit: world.commit, collectedDir: world.collectedDir, acceptance,
      deps: { containerRun: container.run, panel: j.panel, decider: j.decider, invoke: j.invoke, ...b, serve, verifierJudge: async () => ({ found: true, command: ['npm', 'run', 'verify'], rationale: 'package script' }), ...deps }, unit })
    return result
  }
  return { world, container, judges: j, browser: b, served, run }
}
const ROOT_APP = { 'package.json': viteManifest(), 'package-lock.json': '{}', 'index.html': '<html></html>', 'src/main.ts': 'export const x = 1\n' }

test('INT-009 a root-layout candidate is built, served from its own output and scored out of 70 automated points', async t => {
  const e = await evaluate(t, ROOT_APP)
  const result = await e.run()
  assert.equal(result.build.ok, true); assert.equal(result.build.output, 'dist')
  assert.equal(result.score.automated_points, 70); assert.equal(result.score.automated_score, 70); assert.equal(result.score.complete, true)
  assert.equal(result.score.components.length, 7); assert.equal(result.score.rubric_version, inputs.rubric.version); assert.equal(result.score.provisional, true)
  for (const component of result.score.components) for (const subcomponent of component.subcomponents) for (const criterion of subcomponent.criteria) assert.ok(criterion.verdict, criterion.id)
  assert.ok(result.score.components.every(component => component.subcomponents.every(subcomponent => subcomponent.criteria.every(criterion => 'rationale' in criterion && 'citations' in criterion))))
  for (const field of ['verdict', 'passed', 'pass']) assert.ok(!(field in result.score), `score must not carry ${field}`)
  assert.deepEqual(result.gates.map(gate => gate.id), inputs.rubric.gates.map(gate => gate.id)); assert.ok(result.gates.every(gate => gate.passed))
  assert.equal(e.served.length, 1); assert.match(e.served[0].root_body, /built/); assert.match(e.served[0].nested_body, /built/, 'single-page fallback serves the output index')
  // Candidate commands ran only in containers over the worktree copy, with no credentials or host environment.
  for (const spec of e.container.specs) {
    assert.equal(spec.mounts.length, 1); assert.equal(spec.mounts[0].target, '/work'); assert.ok(!('env' in spec)); assert.equal(spec.network, spec.label === 'install' ? 'bridge' : 'none')
    const args = containerArgs(spec).join(' ')
    assert.ok(!/(GH_|GITHUB|TOKEN|\.claude|\.codex|credentials)/i.test(args), args)
    // The image's own npm cache belongs to another user, so npm must cache in the container's throwaway home.
    assert.match(args, /-e npm_config_cache=\/tmp\/container-home\//)
  }
  assert.deepEqual(e.container.specs.map(spec => spec.label).slice(0, 2), ['install', 'build'])
  assert.deepEqual(e.container.specs[0].command, ['npm', 'ci'])
  // C-10: the verifier command the source judge named runs in the same isolated container, and its outcome is kept.
  const verifier = e.container.specs.find(spec => spec.label === 'verifier')
  assert.deepEqual(verifier.command, ['npm', 'run', 'verify']); assert.equal(verifier.network, 'none'); assert.equal(verifier.mounts.length, 1); assert.equal(result.verifier.clear, true); assert.equal(result.verifier.exit_code, 0)
  assert.deepEqual(result.verifier.command, ['npm', 'run', 'verify'])
})

test('INT-009 a workspace-subdirectory candidate with its own build script and output directory is built and served from there', async t => {
  const files = { 'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }), 'pnpm-lock.yaml': 'lock', 'apps/web/package.json': viteManifest({ name: 'web' }), 'apps/web/index.html': '<html></html>', 'src/main.ts': 'x\n', 'apps/web/src/main.ts': 'y\n' }
  const e = await evaluate(t, files, { containerOptions: { output: 'out' } })
  const result = await e.run()
  assert.equal(result.build_plan.application_root, 'apps/web'); assert.equal(result.build_plan.package_manager, 'pnpm'); assert.deepEqual(result.build_plan.install, ['pnpm', 'install', '--frozen-lockfile'])
  assert.equal(result.build.output, 'apps/web/out'); assert.equal(result.score.automated_score, 70)
  assert.equal(e.container.specs.find(spec => spec.label === 'build').workdir, '/work/apps/web')
})

test('INT-009 an unresolvable build plan is a resumable not-evaluable failure with no jobs run', async t => {
  const e = await evaluate(t, { 'README.md': 'nothing buildable\n', 'src/main.ts': 'x\n' })
  await assert.rejects(e.run(), error => error instanceof NotEvaluableError && error.resumable === true && /not evaluable/.test(error.message))
  assert.equal(e.judges.seen.length, 0); assert.equal(e.browser.calls.browserJobs, 0)
  const ambiguous = await evaluate(t, { 'package.json': JSON.stringify({ workspaces: ['a', 'b'] }), 'a/package.json': viteManifest(), 'b/package.json': viteManifest() })
  await assert.rejects(ambiguous.run(), /more than one application/)
  assert.deepEqual(await resolveBuildPlan({ worktree: join(e.world.root, 'repo') }).catch(error => error.code), 'product-not-evaluable')
})

test('INT-009 a build script not named build, and an index.html the build overwrites in place, are still found', async t => {
  const files = { ...ROOT_APP, 'package.json': viteManifest({ scripts: { 'build:app': 'vite build', test: 'node --test' } }), 'dist/index.html': '<html>stale</html>' }
  const e = await evaluate(t, files)
  const result = await e.run()
  assert.deepEqual(result.build_plan.build, ['npm', 'run', 'build:app']); assert.equal(result.build.output, 'dist'); assert.equal(result.build_plan.output, 'dist')
  assert.equal(result.build.ok, true); assert.equal(result.score.automated_score, 70)
})

test('INT-009 a reused build or neutral unit is trusted only while its recorded output and files still match', async t => {
  const world = await deliver(t, ROOT_APP)
  const first = await evaluate(t, ROOT_APP, { runDirOverride: world }); await first.run()
  const second = await evaluate(t, ROOT_APP, { runDirOverride: world }); await second.run()
  assert.ok(!second.container.specs.some(spec => spec.label === 'build'), 'an intact build is reused')
  // The recorded value no longer matches its own hash.
  const unitPath = join(world.runDir, 'phases/product/build.json')
  const unit = JSON.parse(await readFile(unitPath, 'utf8')); unit.value.output = 'elsewhere'; await writeFile(unitPath, JSON.stringify(unit))
  const third = await evaluate(t, ROOT_APP, { runDirOverride: world }); await third.run()
  assert.ok(third.container.specs.some(spec => spec.label === 'build'), 'a tampered record forces a rebuild')
  // The built files are gone.
  const builtDir = join(world.runDir, '.product/build', JSON.parse(await readFile(unitPath, 'utf8')).value.output)
  await readFile(join(builtDir, 'index.html'))
  await rm(builtDir, { recursive: true, force: true })
  const fourth = await evaluate(t, ROOT_APP, { runDirOverride: world }); await fourth.run()
  assert.ok(fourth.container.specs.some(spec => spec.label === 'build'), 'a missing output forces a rebuild')
})

test('INT-009 a failed browser judging, or an unusable verifier answer, is never cached', async t => {
  const world = await deliver(t, ROOT_APP)
  let failures = 1
  const flaky = await evaluate(t, ROOT_APP, { runDirOverride: world, deps: { browserInvoke: async () => { if (failures-- > 0) throw Object.assign(new Error('browser judge crashed'), { retryable: false }); throw new Error('unreachable') } } })
  await assert.rejects(flaky.run(), error => error.resumable === true)
  const retried = await evaluate(t, ROOT_APP, { runDirOverride: world })
  const result = await retried.run()
  assert.ok(retried.browser.calls.browserJobs > 0, 'the failed browser jobs ran again')
  assert.equal(result.score.automated_score, 70)
  const verifierWorld = await deliver(t, ROOT_APP)
  const bad = await evaluate(t, ROOT_APP, { runDirOverride: verifierWorld, deps: { verifierJudge: async () => ({ found: true, rationale: 'no command' }) } })
  await assert.rejects(bad.run(), /verifier judge/)
  const good = await evaluate(t, ROOT_APP, { runDirOverride: verifierWorld })
  assert.equal((await good.run()).verifier.clear, true)
})

test('INT-009 the verifier judge receives the delivered files it must read, bounded', async t => {
  const root = await temp(t, 'e2e-verifier-'); const worktree = join(root, 'wt'); await mkdir(join(worktree, 'scripts'), { recursive: true })
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { verify: 'node scripts/check.mjs' } })); await writeFile(join(worktree, 'scripts/check.mjs'), 'x'.repeat(50_000))
  let prompt
  const judges = { profile: PRODUCT_JUDGE_PROFILE, panel: [], decider: {}, invoke: async request => { prompt = request.prompt; return JSON.stringify({ found: true, command: ['npm', 'run', 'verify'], rationale: 'script' }) } }
  const deps = createProductionDeps({ runDir: root, judges })
  await deps.verifierJudge({ worktree, plan: { application_root: '.' }, neutral: { source_paths: ['package.json', 'scripts/check.mjs', 'src/other.ts'] } })
  assert.match(prompt, /"verify":"node scripts\/check\.mjs"/, 'package.json contents travel in the prompt')
  assert.ok(prompt.length < 80_000, 'the contents are bounded'); assert.ok(!/src\/other\.ts/.test(prompt))
})

test('INT-009 a build failure zeroes browser criteria with no fallback, fails the gates and skips human review', async t => {
  const e = await evaluate(t, ROOT_APP, { containerOptions: { failBuild: true } })
  const result = await e.run()
  assert.equal(result.build.ok, false); assert.match(result.build.reason, /build command failed/)
  const browser = new Set(inputs.rubric.components.flatMap(c => c.subcomponents.filter(s => s.evaluator === 'browser-judge').flatMap(s => s.criteria)))
  for (const component of result.score.components) for (const subcomponent of component.subcomponents) for (const criterion of subcomponent.criteria) {
    if (browser.has(criterion.id)) { assert.equal(criterion.verdict, 'fail'); assert.equal(criterion.basis, 'build-failed'); assert.equal(criterion.earned, 0) }
    else assert.equal(criterion.verdict, 'pass', criterion.id)
  }
  assert.equal(e.browser.calls.browserJobs, 0, 'no browser judge ran')
  assert.ok(e.judges.seen.length > 0, 'source and evidence jobs still ran')
  const byId = Object.fromEntries(result.gates.map(gate => [gate.id, gate]))
  assert.equal(byId['gate-build-whole-app'].passed, false); assert.equal(byId['gate-sample-reachable'].passed, false); assert.equal(byId['gate-every-step-renders'].passed, false)
  assert.match(byId['gate-sample-reachable'].reason, /the build failed/)
  assert.equal(result.human_review.eligible, false); assert.match(result.human_review.reason, /could not be built/)
  assert.deepEqual(result.not_located, [])
})

test('INT-009 a failing gate leaves the score unchanged', async t => {
  const first = await (await evaluate(t, ROOT_APP)).run()
  const second = await (await evaluate(t, ROOT_APP, { deps: { verifierJudge: async () => ({ found: false, rationale: 'no verify script anywhere' }) } })).run()
  assert.equal(first.score.automated_score, second.score.automated_score)
  assert.equal(first.gates.find(gate => gate.id === 'gate-verifier-clear-outcome').passed, true)
  const failed = second.gates.find(gate => gate.id === 'gate-verifier-clear-outcome')
  assert.equal(failed.passed, false); assert.match(failed.reason, /no verify script/)
  const unusable = await evaluate(t, ROOT_APP, { deps: { verifierJudge: async () => null } })
  await assert.rejects(unusable.run(), error => error instanceof ProductHarnessError && /verifier judge/.test(error.message))
})

test('INT-009 judge exhaustion is a resumable harness failure; resume reuses the finished jobs and reruns only the unfinished one', async t => {
  const world = await deliver(t, ROOT_APP)
  const broken = await evaluate(t, ROOT_APP, { runDirOverride: world, judgeOptions: { fail: ['scene-kit'] } })
  await assert.rejects(broken.run(), error => error instanceof ProductHarnessError && error.resumable === true && /scene-kit/.test(error.message))
  const finished = new Set(broken.judges.seen); assert.ok(finished.has('presentation-skill') && finished.has('scene-kit'))
  const resumed = await evaluate(t, ROOT_APP, { runDirOverride: world })
  const result = await resumed.run()
  assert.equal(result.score.complete, true)
  assert.deepEqual([...new Set(resumed.judges.seen)], ['scene-kit'], 'only the unfinished job was judged again')
  assert.deepEqual(resumed.container.specs.map(spec => spec.label), ['verifier'], 'the completed build was reused; only the not-yet-run verifier executed')
})

test('INT-009 a packet overflow marks only that component incomplete and scores the others', async t => {
  const e = await evaluate(t, ROOT_APP, { evidenceFile: 'x'.repeat(450_000) })
  const result = await e.run()
  const incomplete = result.score.components.filter(component => !component.complete)
  assert.deepEqual(incomplete.map(component => component.id), ['testing-evidence-quality', 'assumption-handling-quality'])
  assert.match(incomplete[0].incomplete_reason, /overflowed/)
  assert.equal(result.score.automated_score, null); assert.equal(result.score.complete, false)
  assert.equal(result.score.complete_components_score, 62)
})

test('INT-009 the automated score arithmetic: tier weights, gate inputs earn nothing, an unobserved criterion makes its component incomplete', () => {
  const verdicts = {}
  for (const row of inputs.rubric.components.flatMap(c => c.subcomponents.flatMap(s => s.criteria))) verdicts[row] = { verdict: 'pass' }
  assert.equal(scoreProduct({ rubric: inputs.rubric, verdicts }).automated_score, 70)
  verdicts['navigation-keyboard'] = { verdict: 'fail' }
  assert.equal(scoreProduct({ rubric: inputs.rubric, verdicts }).automated_score, 70 - inputs.rubric.components[1].tier_weights.critical)
  delete verdicts['navigation-touch-swipe']
  const partial = scoreProduct({ rubric: inputs.rubric, verdicts })
  assert.equal(partial.automated_score, null); assert.deepEqual(partial.incomplete_components.map(entry => entry.id), ['scene-kit-correctness'])
  assert.deepEqual(evaluateGates({ rubric: inputs.rubric, verdicts: {}, build: { ok: true }, verifier: { found: false } }).map(gate => gate.passed), [true, false, false, false])
})

test('INT-009 after a not-evaluable failure the retained candidate is evaluated once the plan is supplied, reusing the completed work', async t => {
  const world = await deliver(t, { 'README.md': 'nothing buildable\n', 'src/main.ts': 'x\n' })
  const failing = await evaluate(t, {}, { runDirOverride: world })
  await assert.rejects(failing.run(), error => error instanceof NotEvaluableError)
  const corrected = await evaluate(t, {}, { runDirOverride: world })
  const result = await evaluateProduct({ runDir: world.runDir, rubric: inputs.rubric, inventory: inputs.inventory, bundlePath: world.bundlePath, commit: world.commit, collectedDir: world.collectedDir, acceptance,
    plan: { application_root: '.', install: ['npm', 'ci'], build: ['npm', 'run', 'build'], package_manager: 'npm' }, deps: { containerRun: corrected.container.run, panel: corrected.judges.panel, decider: corrected.judges.decider, invoke: corrected.judges.invoke, ...corrected.browser, serve: async () => ({ url: 'http://127.0.0.1:1', close: async () => {} }), verifierJudge: async () => ({ found: false, rationale: 'none' }) } })
  assert.equal(result.build.ok, true); assert.equal(result.score.automated_score, 70, 'a supplied plan bypasses resolution and the candidate is evaluated normally')
})

test('C-2 a symlink in the build output never serves a file outside it, directly or as the index fallback', async t => {
  const root = await temp(t, 'e2e-serve-'); const out = join(root, 'out'); await mkdir(out, { recursive: true })
  await writeFile(join(root, 'secret.txt'), 'secret'); await writeFile(join(out, 'index.html'), '<html>ok</html>')
  await symlink(join(root, 'secret.txt'), join(out, 'leak.txt')); await symlink(join(root, 'secret.txt'), join(out, 'linked.html'))
  const server = await serveOutput({ root: out })
  try {
    assert.equal((await fetch(`${server.url}/leak.txt`)).status, 403); assert.equal((await fetch(`${server.url}/linked.html`)).status, 403)
    assert.equal(await (await fetch(`${server.url}/anything/else`)).text(), '<html>ok</html>')
  } finally { await server.close() }
  await rm(join(out, 'index.html')); await symlink(join(root, 'secret.txt'), join(out, 'index.html'))
  const evil = await serveOutput({ root: out })
  try { assert.equal((await fetch(`${evil.url}/`)).status, 403); assert.equal((await fetch(`${evil.url}/missing`)).status, 403) } finally { await evil.close() }
})

test('INT-009 the result keeps every judge job\'s panel record, browser jobs included, and a non-scoring ambiguity ledger', async t => {
  const result = await (await evaluate(t, ROOT_APP)).run()
  assert.ok(Object.keys(result.panel_records).some(key => key.startsWith('browser:')), 'browser panel records are retained')
  assert.ok(Object.keys(result.panel_records).some(key => !key.startsWith('browser:')), 'source and evidence panel records are retained')
  assert.ok(Object.keys(result.judge_records).some(key => key.startsWith('browser:')))
  assert.ok('ambiguity_ledger' in result); assert.equal(result.score.automated_score, 70, 'diagnostics do not score')
})
