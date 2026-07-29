import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

const script = resolve('evals/agent-runner/and-scene/bootstrap-agent-skills.sh')

async function fixture({
  missingSkill = null,
  pluginSource = './',
  codexSkills = './skills/',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-skills-bootstrap-'))
  const source = join(root, 'agent-skills')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.log')
  const workflow = join(root, 'workflow.yaml')
  await mkdir(bin, { recursive: true })
  for (const skill of ['call-agent', 'prepare-acceptance', 'implement-with-tdd', 'push-pr']) {
    if (skill === missingSkill) continue
    await mkdir(join(source, 'skills', skill), { recursive: true })
    await writeFile(join(source, 'skills', skill, 'SKILL.md'), `# ${skill}\n`)
  }
  await mkdir(join(source, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(source, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'codagent',
      plugins: [{ name: 'codagent', source: pluginSource }],
    }),
  )
  await mkdir(join(source, '.codex-plugin'), { recursive: true })
  await writeFile(
    join(source, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codagent', skills: codexSkills }),
  )
  await writeFile(workflow, [
    'prompt: |',
    '  Use codagent:call-agent and codagent:prepare-acceptance.',
    '  Fix defects with codagent:implement-with-tdd and codagent:push-pr.',
  ].join('\n'))
  for (const cli of ['claude', 'codex']) {
    const path = join(bin, cli)
    await writeFile(path, `#!/usr/bin/env bash\nprintf '%s %s\\n' '${cli}' \"$*\" >> \"$CALLS_LOG\"\n`)
    await chmod(path, 0o755)
  }
  return { root, source, bin, calls, workflow }
}

function run(context, adapters) {
  return spawnSync('bash', [script, context.source, context.workflow, ...adapters], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${context.bin}:${process.env.PATH}`,
      CALLS_LOG: context.calls,
    },
  })
}

test('installs the pinned Codagent plugin once for every selected CLI', async () => {
  const context = await fixture()

  const result = run(context, ['claude', 'codex', 'claude'])

  assert.equal(result.status, 0, result.stderr)
  const calls = (await readFile(context.calls, 'utf8')).trim().split('\n')
  assert.deepEqual(calls, [
    'claude plugin marketplace remove codagent',
    `claude plugin marketplace add ${context.source}`,
    'claude plugin install codagent@codagent',
    'claude plugin list',
    `codex plugin marketplace add ${context.source} --json`,
    'codex plugin add codagent@codagent --json',
    'codex plugin list',
  ])
})

test('fails before launching an agent when the pinned source lacks a workflow-required skill', async () => {
  const context = await fixture({ missingSkill: 'prepare-acceptance' })

  const result = run(context, ['claude'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing required Codagent skill: prepare-acceptance/)
  await assert.rejects(readFile(context.calls, 'utf8'), { code: 'ENOENT' })
})

test('validates every skill when one workflow line names more than one', async () => {
  const context = await fixture({ missingSkill: 'call-agent' })

  const result = run(context, ['claude'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing required Codagent skill: call-agent/)
  await assert.rejects(readFile(context.calls, 'utf8'), { code: 'ENOENT' })
})

test('rejects unsupported adapters instead of silently leaving them without skills', async () => {
  const context = await fixture()

  const result = run(context, ['cursor'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsupported agent adapter for Codagent skills: cursor/)
})

test('fails before installation when the marketplace does not export the local Codagent plugin', async () => {
  const context = await fixture({ pluginSource: './packages/codagent' })

  const result = run(context, ['claude'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Codagent marketplace plugin must resolve to the pinned source root/)
  await assert.rejects(readFile(context.calls, 'utf8'), { code: 'ENOENT' })
})

test('fails before Codex installation when its plugin manifest does not export the skills root', async () => {
  const context = await fixture({ codexSkills: './bundled-skills/' })

  const result = run(context, ['codex'])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Codex Codagent plugin must export the pinned skills root/)
  await assert.rejects(readFile(context.calls, 'utf8'), { code: 'ENOENT' })
})
