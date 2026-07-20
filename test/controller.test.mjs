import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { loadCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
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
  - id: review-assumptions
  - id: simplify
  - id: run-validator
  - id: verify-validator
  - id: acceptance-test
`

const profileArgs = [
  '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
]

async function environment({ workflow = workflowYaml, dirty = '', commit = 'a'.repeat(40) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-controller-'))
  const agentRunnerDir = join(root, 'agent-runner')
  if (workflow !== null) {
    await mkdir(join(agentRunnerDir, 'workflows/openspec'), { recursive: true })
    await writeFile(join(agentRunnerDir, WORKFLOW_RELATIVE_PATH), workflow)
  } else {
    await mkdir(agentRunnerDir, { recursive: true })
  }

  const invocations = []
  const exec = (command, args) => {
    invocations.push([command, ...args])
    if (command === 'git') {
      const verb = args.join(' ')
      if (verb.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true\n' }
      if (verb.includes('status --porcelain')) return { status: 0, stdout: dirty }
      if (verb.includes('rev-parse HEAD')) return { status: 0, stdout: `${commit}\n` }
    }
    if (command === 'agent-runner' && args[0] === '--version') {
      return { status: 0, stdout: 'agent-runner 2.4.0\n' }
    }
    return { status: 0, stdout: '' }
  }

  const home = join(root, 'container-home')
  await mkdir(home, { recursive: true })

  return { root, agentRunnerDir, exec, invocations, home, runDir: join(root, 'run-1') }
}

function runnerInvocations(invocations) {
  return invocations.filter(([command, first]) => command === 'agent-runner' && first !== '--version')
}

// A fresh run has no persisted Agent Runner state until the workflow has been
// launched; only afterwards does state.json exist.
function statefulReader(context, lastStep) {
  return () => (
    runnerInvocations(context.invocations).length === 0
      ? null
      : { run_id: 'run-7', session_dir: '/sessions/run-7', status: 'completed', last_step: lastStep }
  )
}

async function evaluate(context, extraArgs = [], overrides = {}) {
  const { lastStep = 'simplify', observedSteps, ...rest } = overrides
  const steps = observedSteps ?? ['plan', 'implement-tasks', 'review-assumptions', 'simplify']
  return runEvaluation({
    argv: [
      '--run-dir', context.runDir,
      '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene',
      ...extraArgs,
    ],
    exec: context.exec,
    isProcessAlive: () => false,
    home: context.home,
    readRunnerState: statefulReader(context, lastStep),
    observedSteps: () => steps,
    ...rest,
  })
}

test('--skip-validator passes skip_validator=true and stops after simplify', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--skip-validator', ...profileArgs])

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const [invocation] = runnerInvocations(context.invocations)
  assert.ok(invocation.includes('skip_validator=true'), invocation.join(' '))
  assert.ok(invocation.includes('change_name=create-and-scene'), invocation.join(' '))
  assert.equal(invocation[invocation.indexOf('--until') + 1], 'simplify')
})

test('the default path passes skip_validator=false and stops after verify-validator', async () => {
  const context = await environment()

  const result = await evaluate(context, profileArgs, {
    lastStep: 'verify-validator',
    observedSteps: ['plan', 'simplify', 'run-validator', 'verify-validator'],
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const [invocation] = runnerInvocations(context.invocations)
  assert.ok(invocation.includes('skip_validator=false'), invocation.join(' '))
  assert.equal(invocation[invocation.indexOf('--until') + 1], 'verify-validator')
})

test('a missing lead profile is rejected before Agent Runner is invoked', async () => {
  const context = await environment()

  const result = await evaluate(context, [
    '--skip-validator',
    '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  ])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context.invocations), [])
  assert.match(JSON.stringify(result.errors), /lead/)
})

test('an invalid implementor setting names the role and field without starting a workflow', async () => {
  const context = await environment()

  const result = await evaluate(context, [
    '--skip-validator',
    '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
    '--implementor-cli', 'claude', '--implementor-model', 'opus-9', '--implementor-effort', 'medium',
  ])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context.invocations), [])
  assert.match(JSON.stringify(result.errors), /implementor.*model/)
})

test('a dirty Agent Runner checkout stops before Agent Runner execution', async () => {
  const context = await environment({ dirty: ' M workflows/openspec/implement-change2.yaml\n' })

  const result = await evaluate(context, ['--skip-validator', ...profileArgs])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context.invocations), [])
  assert.match(JSON.stringify(result.errors), /dirty|uncommitted/i)
})

test('a workflow lacking skip_validator fails before Agent Runner execution', async () => {
  const context = await environment({ workflow: 'parameters:\n  change_name:\n    required: true\nsteps:\n  - id: simplify\n' })

  const result = await evaluate(context, ['--skip-validator', ...profileArgs])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context.invocations), [])
  assert.match(JSON.stringify(result.errors), /skip_validator/)
})

test('a missing workflow stops before Agent Runner execution', async () => {
  const context = await environment({ workflow: null })

  const result = await evaluate(context, ['--skip-validator', ...profileArgs])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context.invocations), [])
})

test('a reference baseline needs no role profiles and never invokes Agent Runner', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--skip-validator', '--reference-baseline'])

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(runnerInvocations(context.invocations), [])
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.role_configuration.roles.lead.configured, 'not-applicable')
})

test('the eval-scoped config is written where Agent Runner discovers project config', async () => {
  const context = await environment()

  await evaluate(context, ['--skip-validator', ...profileArgs])

  // Agent Runner layers global then project config, discovering the project
  // layer at <cwd>/.agent-runner/config.yaml.
  const config = await readFile(
    join(context.runDir, '.runtime/candidate-worktree/.agent-runner/config.yaml'),
    'utf8',
  )
  assert.match(config, /active_profile: eval/)
  assert.match(config, /planner:/)
  assert.match(config, /implementor:/)
  assert.match(config, /model: opus/)
  assert.match(config, /model: sonnet/)
})

test('Agent Runner runs in the candidate worktree so it reads the eval config', async () => {
  const context = await environment()
  const spawns = []

  await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', ...profileArgs,
    ],
    exec: (command, args, options) => {
      spawns.push({ command, args, cwd: options?.cwd })
      return context.exec(command, args)
    },
    isProcessAlive: () => false,
    home: context.home,
    readRunnerState: statefulReader(context, 'simplify'),
    observedSteps: () => ['plan', 'simplify'],
  })

  const started = spawns.find(({ command, args }) => command === 'agent-runner' && args[0] === 'run')
  assert.ok(started, JSON.stringify(spawns))
  assert.equal(started.cwd, join(context.runDir, '.runtime/candidate-worktree'))
})

test('a resumed Agent Runner run uses the same candidate worktree', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])
  const spawns = []

  await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', '--resume', ...profileArgs,
    ],
    exec: (command, args, options) => {
      spawns.push({ command, args, cwd: options?.cwd })
      return context.exec(command, args)
    },
    isProcessAlive: () => false,
    home: context.home,
    readRunnerState: () => ({ run_id: 'run-7', status: 'failed', last_step: 'implement-tasks' }),
    observedSteps: () => ['plan'],
  })

  const resumed = spawns.find(({ command, args }) => command === 'agent-runner' && args[0] === '--resume')
  assert.ok(resumed, JSON.stringify(spawns))
  assert.equal(resumed.cwd, join(context.runDir, '.runtime/candidate-worktree'))
})

test('an unrecorded run persisted by Agent Runner is adopted instead of duplicated', async () => {
  const context = await environment()
  let calls = 0

  const result = await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', ...profileArgs,
    ],
    exec: context.exec,
    isProcessAlive: () => false,
    home: context.home,
    // No checkpointed identity, but Agent Runner already persisted a run: the
    // previous process was interrupted mid-flight.
    readRunnerState: () => {
      calls += 1
      return { run_id: 'run-9', session_dir: '/sessions/run-9', status: 'failed', last_step: 'implement-tasks' }
    },
    observedSteps: () => ['plan', 'simplify'],
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const invocations = runnerInvocations(context.invocations)
  assert.equal(invocations.length, 1, JSON.stringify(invocations))
  assert.deepEqual(invocations[0], ['agent-runner', '--resume', 'run-9'])
  assert.ok(calls > 0)
})

test('no credential material is persisted into the run directory', async () => {
  const context = await environment()

  await evaluate(context, ['--skip-validator', ...profileArgs])

  const found = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push(path)
    }
  }
  await walk(context.runDir)
  for (const path of found) {
    assert.ok(!/auth\.json|credentials|\.netrc|token/i.test(path), `credential-like artifact: ${path}`)
  }
})

test('the Agent Runner run identity is durably recorded as soon as it is available', async () => {
  const context = await environment()

  await evaluate(context, ['--skip-validator', ...profileArgs])

  const checkpoint = await loadCheckpoint(join(context.runDir, 'checkpoint.json'))
  assert.equal(checkpoint.agent_runner.run_id, 'run-7')
  assert.equal(checkpoint.agent_runner.session_dir, '/sessions/run-7')
})

test('resume with an active run waits and does not launch a second workflow', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])
  const before = runnerInvocations(context.invocations).length

  const waits = []
  await evaluate(context, ['--skip-validator', ...profileArgs, '--resume'], {
    isProcessAlive: () => true,
    readRunnerState: () => ({ run_id: 'run-7', session_dir: '/sessions/run-7', status: 'running', lock: { pid: 99, run_id: 'run-7' } }),
    waitForRun: (runId) => { waits.push(runId) },
  })

  assert.deepEqual(waits, ['run-7'])
  assert.equal(runnerInvocations(context.invocations).length, before)
})

test('resume with a completed run continues without invoking Agent Runner again', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])
  const before = runnerInvocations(context.invocations).length

  const result = await evaluate(context, ['--skip-validator', ...profileArgs, '--resume'])

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.equal(runnerInvocations(context.invocations).length, before)
})

test('resume with an inactive unfinished run resumes that exact run identifier', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])
  const before = runnerInvocations(context.invocations).length

  await evaluate(context, ['--skip-validator', ...profileArgs, '--resume'], {
    readRunnerState: () => ({ run_id: 'run-7', session_dir: '/sessions/run-7', status: 'failed', last_step: 'implement-tasks' }),
  })

  const added = runnerInvocations(context.invocations).slice(before)
  assert.equal(added.length, 1)
  assert.deepEqual(added[0], ['agent-runner', '--resume', 'run-7'])
})

test('resume that cannot verify the recorded run reports a workflow error', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])
  const before = runnerInvocations(context.invocations).length

  const result = await evaluate(context, ['--skip-validator', ...profileArgs, '--resume'], {
    readRunnerState: () => null,
  })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(runnerInvocations(context.invocations).length, before)
})

test('resume that changes a role profile is rejected and identifies the mismatch', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])

  const result = await evaluate(context, [
    '--skip-validator', '--resume',
    '--lead-cli', 'claude', '--lead-model', 'sonnet', '--lead-effort', 'high',
    '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  ])

  assert.equal(result.exitCode, 2)
  assert.match(JSON.stringify(result.errors), /lead.*model/)
})

test('resume with changed Agent Runner provenance reports a resume-provenance error', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])

  const moved = { ...context, exec: (await environment({ commit: 'b'.repeat(40) })).exec }
  const result = await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', '--resume', ...profileArgs,
    ],
    exec: moved.exec,
    isProcessAlive: () => false,
    home: context.home,
    readRunnerState: () => ({ run_id: 'run-7', status: 'completed', last_step: 'simplify' }),
  })

  assert.equal(result.exitCode, 2)
  assert.match(JSON.stringify(result.errors), /resume-provenance|commit/i)
})

test('a step observed beyond the configured boundary is a workflow-boundary failure', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--skip-validator', ...profileArgs], {
    observedSteps: ['plan', 'simplify', 'run-validator'],
  })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.match(result.outcome.failure.reason, /run-validator/)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.unexpected_step, 'run-validator')
})

test('result.json records status, verdict, provenance, and boundaries', async () => {
  const context = await environment()

  await evaluate(context, ['--skip-validator', ...profileArgs])

  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.evaluation_status, 'pending-human-review')
  assert.equal(written.product_verdict, 'unavailable')
  assert.equal(written.label, 'PENDING HUMAN REVIEW')
  assert.equal(written.workflow.configured_stop_step, 'simplify')
  assert.equal(written.workflow.last_observed_step, 'simplify')
  assert.equal(written.workflow.run_id, 'run-7')
  assert.deepEqual(written.workflow.arguments, ['change_name=create-and-scene', 'skip_validator=true'])
  assert.equal(written.workflow.provenance.commit, 'a'.repeat(40))
  assert.equal(written.workflow.provenance.workflow_relative_path, WORKFLOW_RELATIVE_PATH)
  assert.equal(written.role_configuration.roles.lead.configured.model, 'opus')
})

test('completed eval phases are reused on resume while Agent Runner is re-verified', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])

  const result = await evaluate(context, ['--skip-validator', ...profileArgs, '--resume'])

  assert.ok(result.reused.includes('product-judging'), JSON.stringify(result.reused))
  assert.ok(result.reused.includes('verification'), JSON.stringify(result.reused))
  assert.ok(!result.reused.includes('agent-runner'), JSON.stringify(result.reused))
  assert.ok(result.completed.includes('agent-runner'), JSON.stringify(result.completed))
})

test('phase completion is recorded durably in the checkpoint', async () => {
  const context = await environment()

  await evaluate(context, ['--skip-validator', ...profileArgs])

  const checkpoint = await loadCheckpoint(join(context.runDir, 'checkpoint.json'))
  assert.equal(checkpoint.phases['product-judging'].state, 'complete')
  assert.equal(typeof checkpoint.phases['product-judging'].completed_at, 'string')
})

test('a capabilities file that cannot be read is a clean argument failure', async () => {
  const context = await environment()

  const result = await evaluate(context, [
    '--skip-validator', ...profileArgs, '--capabilities', '/nonexistent/capabilities.json',
  ])

  assert.equal(result.exitCode, 2)
  assert.match(JSON.stringify(result.errors), /capabilit/i)
})

test('the run store is linked into an explicitly supplied home only', async () => {
  const context = await environment()
  const home = context.home

  await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', ...profileArgs,
    ],
    exec: context.exec,
    isProcessAlive: () => false,
    home,
    readRunnerState: statefulReader(context, 'simplify'),
    observedSteps: () => ['plan', 'simplify'],
  })

  // Agent Runner resolves its run store from $HOME, so the persistent run
  // directory store is linked there.
  assert.equal(
    await readlink(join(home, '.agent-runner/projects')),
    join(context.runDir, '.runtime/agent-runner-projects'),
  )
})

test('Agent Runner is spawned with the same home the controller reads from', async () => {
  const context = await environment()
  const spawns = []

  await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', ...profileArgs,
    ],
    exec: (command, args, options) => {
      spawns.push({ command, args, env: options?.env })
      return context.exec(command, args)
    },
    isProcessAlive: () => false,
    home: context.home,
    readRunnerState: statefulReader(context, 'simplify'),
    observedSteps: () => ['plan', 'simplify'],
  })

  const started = spawns.find(({ command, args }) => command === 'agent-runner' && args[0] === 'run')
  assert.ok(started, JSON.stringify(spawns.map((s) => s.command)))
  assert.equal(started.env.HOME, context.home)
})

test('an unresolvable home is rejected before Agent Runner runs', async () => {
  const context = await environment()

  const result = await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', ...profileArgs,
    ],
    exec: context.exec,
    isProcessAlive: () => false,
    home: null,
  })

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context.invocations), [])
  assert.match(JSON.stringify(result.errors), /home/i)
})

test('a reference baseline needs no home because it never spawns Agent Runner', async () => {
  const context = await environment()

  const result = await runEvaluation({
    argv: [
      '--run-dir', context.runDir, '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene', '--skip-validator', '--reference-baseline',
    ],
    exec: context.exec,
    isProcessAlive: () => false,
    home: null,
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
})

test('the run directory is reopened rather than recreated on resume', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])
  const first = await loadCheckpoint(join(context.runDir, 'checkpoint.json'))

  await evaluate(context, ['--skip-validator', ...profileArgs, '--resume'])
  const second = await loadCheckpoint(join(context.runDir, 'checkpoint.json'))

  assert.equal(second.run_id, first.run_id)
  assert.deepEqual(second.identity, first.identity)
})

test('a changed score-affecting checkpoint identity is rejected on resume', async () => {
  const context = await environment()
  await evaluate(context, ['--skip-validator', ...profileArgs])

  const result = await evaluate(context, ['--skip-validator', ...profileArgs, '--resume', '--change-name', 'other-change'])

  assert.equal(result.exitCode, 2)
  assert.match(JSON.stringify(result.errors), /workflow_arguments|provenance/i)
})
