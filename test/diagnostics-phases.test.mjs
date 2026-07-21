// The two diagnostic phases end to end through the controller: Runner metrics
// ingestion, pricing, cost aggregation, machine timing, and the ambiguity
// ledger. None of them may move a point.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { findingId } from '../evals/agent-runner/and-scene/lib/ambiguity.mjs'
import { hashString, readJson, writeJsonAtomic } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { MODELS_DEV_URL } from '../evals/agent-runner/and-scene/lib/pricing.mjs'
import { WORKFLOW_RELATIVE_PATH } from '../evals/agent-runner/and-scene/lib/provenance.mjs'

const workflowYaml = `name: implement-change2
parameters:
  change_name:
    required: true
  skip_validator:
    default: false
steps:
  - id: plan
  - id: implement-tasks
  - id: simplify
`

const profileArgs = [
  '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
]

const CATALOG_BODY = JSON.stringify({
  anthropic: {
    id: 'anthropic',
    models: {
      opus: { id: 'opus', cost: { input: 15, output: 75 } },
      sonnet: { id: 'sonnet', cost: { input: 3, output: 15 } },
    },
  },
})

function attempt(overrides = {}) {
  return {
    record_id: 'implement-tasks#1',
    prefix: 'implement-tasks[0]/implement-single-task',
    id: 'generate-code',
    kind: 'step',
    type: 'agent',
    attempt: 1,
    iteration: null,
    outcome: 'success',
    agent_invoked: true,
    session_id: 'session-1',
    duration_ms: 1000,
    usage: {
      status: 'collected', cli: 'claude', provider: 'anthropic', model: 'sonnet',
      source: 'claude:result', completeness: 'complete',
      tokens: { input: 1_000_000, output: 100_000 },
      token_totals: { input: 1_000_000, output: 100_000, total: 1_100_000 },
    },
    estimated_api_cost_usd: null,
    ...overrides,
  }
}

function runMetrics(overrides = {}) {
  return {
    schema_version: 1,
    run_id: 'run-7',
    workflow: 'implement-change2',
    history_complete: true,
    sessions: [{ duration_ms: 120_000, status: 'closed' }],
    steps: [attempt()],
    totals: {
      active_duration_ms: 120_000,
      tokens: { input: 1_000_000, output: 100_000 },
      usage_coverage: 'complete',
      token_totals: { input: 1_000_000, output: 100_000, total: 1_100_000 },
      token_total_coverage: 'complete',
      estimated_api_cost_usd: null,
      cost_coverage: 'none',
    },
    ...overrides,
  }
}

async function environment({ metrics = runMetrics(), sessionFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-diagnostics-'))
  const agentRunnerDir = join(root, 'agent-runner')
  await mkdir(join(agentRunnerDir, 'workflows/openspec'), { recursive: true })
  await writeFile(join(agentRunnerDir, WORKFLOW_RELATIVE_PATH), workflowYaml)

  const sessionDir = join(root, 'sessions/run-7')
  await mkdir(sessionDir, { recursive: true })
  if (metrics !== null) {
    await writeFile(join(sessionDir, 'run-metrics.json'), JSON.stringify(metrics, null, 2))
  }
  for (const [relative, text] of Object.entries(sessionFiles)) {
    await mkdir(join(sessionDir, relative, '..'), { recursive: true })
    await writeFile(join(sessionDir, relative), text)
  }

  const invocations = []
  const exec = (command, args) => {
    invocations.push([command, ...args])
    if (command === 'git') {
      const verb = args.join(' ')
      if (verb.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true\n' }
      if (verb.includes('remote get-url origin')) {
        return { status: 0, stdout: 'https://github.com/Codagent-AI/and-scene.git\n' }
      }
      if (verb.includes('merge-base --is-ancestor')) return { status: 0, stdout: '' }
      if (verb.includes('status --porcelain')) return { status: 0, stdout: '' }
      if (verb.includes('rev-parse')) return { status: 0, stdout: `${'a'.repeat(40)}\n` }
    }
    if (command === 'agent-runner' && args[0] === '--version') {
      return { status: 0, stdout: 'agent-runner 2.4.0\n' }
    }
    return { status: 0, stdout: '' }
  }

  const home = join(root, 'container-home')
  await mkdir(home, { recursive: true })
  const runDir = join(root, 'run-1')
  const source = join(runDir, '.runtime/candidate-worktree/src/index.ts')
  await mkdir(join(source, '..'), { recursive: true })
  await writeFile(source, 'export const fixture = true\n')
  return { root, agentRunnerDir, exec, invocations, home, sessionDir, runDir }
}

function catalogFetch(body = CATALOG_BODY) {
  return async () => ({ ok: true, status: 200, text: async () => body })
}

async function evaluate(context, overrides = {}) {
  return runEvaluation({
    argv: [
      '--run-dir', context.runDir,
      '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene',
      '--skip-validator',
      ...profileArgs,
    ],
    exec: context.exec,
    isProcessAlive: () => false,
    home: context.home,
    readRunnerState: () => ({
      run_id: 'run-7',
      session_dir: context.sessionDir,
      last_step: 'simplify',
      step_completed: true,
    }),
    observedSteps: () => ['plan', 'implement-tasks', 'simplify'],
    pricingFetch: catalogFetch(),
    ...overrides,
  })
}

test('matching Runner metrics are ingested with their source hash preserved', async () => {
  const context = await environment()

  const result = await evaluate(context)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.implementation_metrics.state, 'ingested')
  assert.equal(record.implementation_metrics.attempt_count, 1)
  assert.equal(
    record.implementation_metrics.source.sha256,
    hashString(JSON.stringify(runMetrics(), null, 2)),
  )
  const phase = await readJson(join(context.runDir, 'phases/metrics-pricing.json'))
  assert.equal(phase.metrics.attempts.length, 1)
  assert.equal(record.role_configuration.roles.implementor.attempts.length, 1)
  assert.equal(
    record.role_configuration.roles.implementor.attempts[0].observed.model,
    'sonnet',
  )
})

test('metrics naming another run are rejected and never reconstructed', async () => {
  const context = await environment({ metrics: runMetrics({ run_id: 'run-other' }) })

  const result = await evaluate(context)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.implementation_metrics.state, 'rejected')
  assert.equal(record.implementation_metrics.attempt_count, 0)
  assert.equal(record.cost.total.state, 'unavailable')
  assert.match(record.implementation_metrics.reason, /run-other/)
})

test('an attempt priced from models.dev reports its rates and catalog hash', async () => {
  const context = await environment()

  const result = await evaluate(context)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.cost.total.state, 'available')
  assert.equal(record.cost.total.estimated_api_cost_usd, 3 + 1.5)
  assert.equal(record.cost.rows[0].model, 'sonnet')
  assert.equal(record.cost.rows[0].verification, 'verified')
  assert.equal(record.pricing.catalog.url, MODELS_DEV_URL)
  assert.equal(record.pricing.catalog.sha256, hashString(CATALOG_BODY))
})

test('an unpriceable attempt leaves the total unavailable with a known subtotal', async () => {
  const context = await environment({
    metrics: runMetrics({
      steps: [
        attempt({ record_id: 'a1', estimated_api_cost_usd: 2 }),
        attempt({ record_id: 'a2', usage: { ...attempt().usage, model: 'unknown-model' } }),
      ],
    }),
  })

  const result = await evaluate(context, { judgeInvoke: async () => JSON.stringify({ found: false }) })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.cost.total.state, 'unavailable')
  assert.equal(record.cost.total.estimated_api_cost_usd, null)
  assert.equal(record.cost.total.known_cost_subtotal_usd, 2)
  assert.deepEqual(record.cost.total.unresolved_attempts, ['a2'])
})

test('cost is reported without changing the product score or verdict', async () => {
  const cheap = await environment()
  const expensive = await environment({
    metrics: runMetrics({
      steps: [attempt({
        usage: {
          ...attempt().usage,
          tokens: { input: 50_000_000, output: 5_000_000 },
          token_totals: { input: 50_000_000, output: 5_000_000, total: 55_000_000 },
        },
      })],
    }),
  })

  const first = await evaluate(cheap)
  const second = await evaluate(expensive)

  assert.equal(first.exitCode, 0)
  assert.equal(second.exitCode, 0)
  const a = await readJson(join(cheap.runDir, 'result.json'))
  const b = await readJson(join(expensive.runDir, 'result.json'))
  assert.notEqual(a.cost.total.estimated_api_cost_usd, b.cost.total.estimated_api_cost_usd)
  assert.deepEqual(a.score, b.score)
  assert.equal(a.product_verdict, b.product_verdict)
  assert.equal(a.automated_subtotal, b.automated_subtotal)
})

test('machine timing reports implementation and automated phase durations', async () => {
  const context = await environment()

  const result = await evaluate(context)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.timing.implementation.active_ms, 120_000)
  assert.ok(record.timing.total_active_machine_ms >= 120_000)
  assert.ok(record.timing.phases.some((entry) => entry.phase === 'metrics-pricing'))
  assert.equal(record.timing.excludes_human_review, true)
  assert.equal(record.timing.human_review_duration_ms, undefined)
})

test('a resumed run adds its active time to the earlier sessions', async () => {
  const context = await environment()

  await evaluate(context)
  const first = await readJson(join(context.runDir, 'result.json'))
  // Re-run the diagnostic phases in a second session, as resume does.
  const checkpointPath = join(context.runDir, 'checkpoint.json')
  const checkpoint = await readJson(checkpointPath)
  delete checkpoint.phases['metrics-pricing']
  await writeJsonAtomic(checkpointPath, checkpoint)
  const resumed = await evaluate(context)

  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.errors))
  const second = await readJson(join(context.runDir, 'result.json'))
  const before = first.timing.phases.find((entry) => entry.phase === 'metrics-pricing')
  const after = second.timing.phases.find((entry) => entry.phase === 'metrics-pricing')
  // The earlier session's measured work survives; only the interruption gap is
  // absent, because no interval ever represented it.
  assert.equal(after.interval_count, before.interval_count + 1)
  assert.ok(after.active_ms > before.active_ms)
  assert.equal(second.timing.implementation.active_ms, 120_000)
  // Each execution session is distinguishable, so the total is visibly a sum of
  // recorded machine sessions rather than one uninterrupted stretch.
  assert.equal(first.timing.sessions.length, 1)
  assert.equal(second.timing.sessions.length, 2)
})

test('a resume that reuses every phase keeps the recorded diagnostics in the result', async () => {
  const context = await environment({
    sessionFiles: { 'assumptions.md': 'caption overflow' },
  })
  const reported = {
    origin: { run_id: 'run-7', step: 'implement-tasks', agent_role: 'task-implementor', task: null },
    source: 'reported',
    concern: 'caption overflow behavior is undefined',
    evidence: ['assumptions.md'],
    handling: 'truncated',
    consequence: 'clipped captions',
    classification: 'genuine-specification-gap',
    rationale: 'the fixture never states it',
    resolution: 'unresolved',
  }

  await evaluate(context, {
    judgeInvoke: async (request) => (
      request.job === 'ambiguity-diagnostics'
        ? JSON.stringify({ coverage: 'complete', findings: [reported], proposals: [] })
        : JSON.stringify({ found: false })
    ),
  })
  const first = await readJson(join(context.runDir, 'result.json'))
  // Every phase is checkpointed complete, so the resume recomputes nothing. The
  // rewritten result must still carry what the earlier session established.
  const resumed = await evaluate(context)

  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.errors))
  const second = await readJson(join(context.runDir, 'result.json'))
  assert.equal(second.implementation_metrics.state, 'ingested')
  assert.deepEqual(second.cost.total, first.cost.total)
  assert.equal(second.ambiguity.finding_count, 1)
  assert.deepEqual(second.score, first.score)
})

test('the eval-owned judge usage is reported but never priced', async () => {
  const context = await environment()

  const result = await evaluate(context)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.cost.eval_owned.priced, false)
  assert.equal(record.cost.eval_owned.included_in_implementation_total, false)
})

test('an ambiguity ledger is written durably and referenced from the result', async () => {
  const context = await environment({
    sessionFiles: { 'session-reports/02-scene-kit.md': '## Assumption Audit\n- caption overflow' },
  })
  const reported = {
    origin: { run_id: 'run-7', step: 'implement-tasks', agent_role: 'task-implementor', task: '02-scene-kit' },
    source: 'reported',
    concern: 'caption overflow behavior is undefined',
    evidence: ['session-reports/02-scene-kit.md'],
    handling: 'truncated with an ellipsis',
    consequence: 'long captions are clipped',
    classification: 'genuine-specification-gap',
    rationale: 'no fixture requirement covers overflow',
    resolution: 'unresolved',
  }

  const result = await evaluate(context, {
    judgeInvoke: async (request) => (
      request.job === 'ambiguity-diagnostics'
        ? JSON.stringify({ coverage: 'complete', findings: [reported], proposals: [] })
        : JSON.stringify({ found: false })
    ),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const ledger = await readJson(join(context.runDir, 'ambiguity-ledger.json'))
  assert.equal(ledger.findings.length, 1)
  assert.equal(ledger.findings[0].id, findingId(reported))
  assert.equal(ledger.coverage.state, 'complete')

  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.ambiguity.artifact, 'ambiguity-ledger.json')
  assert.equal(record.ambiguity.finding_count, 1)
  assert.equal(record.ambiguity.coverage.state, 'complete')
  assert.equal(record.ambiguity.scoring_effect, 'none')
})

test('missing ambiguity artifacts mark coverage incomplete rather than clean', async () => {
  const context = await environment()

  const result = await evaluate(context, { judgeInvoke: async () => JSON.stringify({ found: false }) })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const ledger = await readJson(join(context.runDir, 'ambiguity-ledger.json'))
  assert.equal(ledger.coverage.state, 'incomplete')
  assert.equal(ledger.coverage.findings_observed, false)
  assert.deepEqual(ledger.findings, [])
})

test('ambiguity findings change no points, gate, or verdict', async () => {
  const context = await environment({
    sessionFiles: { 'assumptions.md': 'assumed a nine step demo' },
  })
  const damaging = {
    origin: { run_id: 'run-7', step: 'implement-tasks', agent_role: 'task-implementor', task: null },
    source: 'judge-discovered',
    concern: 'the implementor assumed a step count the spec never fixes',
    evidence: ['src/demo/steps.tsx'],
    handling: 'hard-coded nine steps',
    consequence: 'the delivered demo fails a product criterion',
    classification: 'incorrect-assumption',
    rationale: 'the browser evaluation shows the mismatch',
    resolution: 'unresolved',
  }

  const withFindings = await evaluate(context, {
    judgeInvoke: async (request) => (
      request.job === 'ambiguity-diagnostics'
        ? JSON.stringify({ coverage: 'complete', findings: [damaging], proposals: [] })
        : JSON.stringify({ found: false })
    ),
  })
  const clean = await environment()
  const withoutFindings = await evaluate(clean, { judgeInvoke: async () => JSON.stringify({ found: false }) })

  assert.equal(withFindings.exitCode, 0)
  const a = await readJson(join(context.runDir, 'result.json'))
  const b = await readJson(join(clean.runDir, 'result.json'))
  assert.equal(a.ambiguity.finding_count, 1)
  assert.equal(b.ambiguity.finding_count, 0)
  assert.deepEqual(a.score, b.score)
  assert.equal(a.automated_subtotal, b.automated_subtotal)
  assert.equal(a.product_verdict, b.product_verdict)
  assert.equal(withoutFindings.exitCode, 0)
})

test('an unapproved fixture proposal is recorded and the pinned fixture is untouched', async () => {
  const context = await environment({ sessionFiles: { 'assumptions.md': 'caption overflow' } })
  const reported = {
    origin: { run_id: 'run-7', step: 'implement-tasks', agent_role: 'task-implementor', task: null },
    source: 'reported',
    concern: 'caption overflow behavior is undefined',
    evidence: ['assumptions.md'],
    handling: 'truncated',
    consequence: 'clipped captions',
    classification: 'genuine-specification-gap',
    rationale: 'the fixture never states it',
    resolution: 'unresolved',
  }

  const result = await evaluate(context, {
    judgeInvoke: async (request) => (
      request.job === 'ambiguity-diagnostics'
        ? JSON.stringify({
          coverage: 'complete',
          findings: [reported],
          proposals: [{
            finding_id: findingId(reported),
            fixture_target: 'specs/presentation/spec.md#captions',
            observed_problem: 'overflow undefined',
            proposed_clarification: 'state wrap or truncate',
            evidence: ['assumptions.md'],
          }],
        })
        : JSON.stringify({ found: false })
    ),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const ledger = await readJson(join(context.runDir, 'ambiguity-ledger.json'))
  assert.equal(ledger.fixture_improvement_proposals.length, 1)
  assert.equal(ledger.fixture_improvement_proposals[0].approved, false)
  assert.equal(ledger.fixture_mutated, false)
})

test('a resumed run preserves prior ledger findings instead of duplicating them', async () => {
  const context = await environment({ sessionFiles: { 'assumptions.md': 'caption overflow' } })
  const reported = {
    origin: { run_id: 'run-7', step: 'implement-tasks', agent_role: 'task-implementor', task: null },
    source: 'reported',
    concern: 'caption overflow behavior is undefined',
    evidence: ['assumptions.md'],
    handling: 'truncated',
    consequence: 'clipped captions',
    classification: 'genuine-specification-gap',
    rationale: 'the fixture never states it',
    resolution: 'unresolved',
  }
  const judge = async (request) => (
    request.job === 'ambiguity-diagnostics'
      ? JSON.stringify({ coverage: 'complete', findings: [reported], proposals: [] })
      : JSON.stringify({ found: false })
  )

  await evaluate(context, { judgeInvoke: judge })
  // Force the diagnostics phase to run again by clearing its checkpoint entry.
  const checkpointPath = join(context.runDir, 'checkpoint.json')
  const checkpoint = await readJson(checkpointPath)
  delete checkpoint.phases['ambiguity-diagnostics']
  await writeJsonAtomic(checkpointPath, checkpoint)
  const resumed = await evaluate(context, { judgeInvoke: judge })

  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.errors))
  const ledger = await readJson(join(context.runDir, 'ambiguity-ledger.json'))
  assert.equal(ledger.findings.length, 1)
  assert.equal(ledger.findings[0].id, findingId(reported))
})

test('the pricing and ambiguity jobs reuse the recorded judge authority', async () => {
  const context = await environment({
    metrics: runMetrics({ steps: [attempt({ usage: { ...attempt().usage, model: 'unknown-model' } })] }),
    sessionFiles: { 'assumptions.md': 'x' },
  })
  const seen = []

  const result = await evaluate(context, {
    judgeInvoke: async (request) => {
      seen.push(request)
      return JSON.stringify({ found: false, coverage: 'complete', findings: [] })
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const jobs = seen.filter((request) => ['pricing-lookup', 'ambiguity-diagnostics'].includes(request.job))
  assert.equal(jobs.length, 2)
  for (const request of jobs) {
    assert.equal(request.authority.cli, 'codex')
    assert.equal(request.authority.model, 'codex-default')
    assert.equal(request.scoring_effect, 'none')
  }
})

test('no catalog is fetched when no attempt needs one', async () => {
  const context = await environment({
    metrics: runMetrics({
      steps: [attempt({ estimated_api_cost_usd: 2 })],
    }),
  })
  let fetched = 0

  const result = await evaluate(context, {
    pricingFetch: async () => { fetched += 1; return { ok: true, status: 200, text: async () => CATALOG_BODY } },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  // Every attempt already had a reported cost, so reaching the network would
  // have been a side effect with nothing to show for it.
  assert.equal(fetched, 0)
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.cost.total.estimated_api_cost_usd, 2)
  assert.equal(record.pricing.catalog.state, 'not-required')
})

test('rejected metrics never reach for a pricing catalog', async () => {
  const context = await environment({ metrics: runMetrics({ run_id: 'run-other' }) })
  let fetched = 0

  await evaluate(context, {
    pricingFetch: async () => { fetched += 1; return { ok: true, status: 200, text: async () => CATALOG_BODY } },
  })

  assert.equal(fetched, 0)
})

test('an unreachable pricing catalog leaves the run successful and the cost incomplete', async () => {
  const context = await environment()

  const result = await evaluate(context, {
    pricingFetch: async () => { throw new Error('offline') },
    judgeInvoke: async () => JSON.stringify({ found: false }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const record = await readJson(join(context.runDir, 'result.json'))
  assert.equal(record.pricing.catalog.state, 'unavailable')
  assert.equal(record.cost.total.state, 'unavailable')
  assert.match(record.pricing.catalog.reason, /offline/)
})
