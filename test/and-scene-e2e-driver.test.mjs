import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, copyFile, readdir, stat, access } from 'node:fs/promises'
import { join } from 'node:path'
import { E2E, git, script, startingRepo, temp } from './and-scene-e2e-helpers.mjs'
import { filesUnder } from '../evals/agent-runner/and-scene-e2e/lib/files.mjs'

const URL_ = 'https://github.com/Codagent-AI/e2e-run-test.git'
async function harness(t) {
  const root = await temp(t, 'e2e-driver-')
  const input = join(root, 'input'); const stubs = join(root, 'stubs'); const art = join(root, 'artifacts'); const auth = join(root, 'auth'); const home = join(root, 'home'); const marks = join(root, 'marks')
  for (const dir of [input, stubs, art, auth, home, marks]) await mkdir(dir, { recursive: true })
  const { bundle } = await startingRepo(root)
  await copyFile(bundle, join(input, 'starting-repo.bundle'))
  await copyFile(join(E2E, 'sandbox-driver.sh'), join(input, 'sandbox-driver.sh'))
  await writeFile(join(input, 'runner-config.yaml'), 'profiles: {}\n'); await writeFile(join(input, 'runner-settings.yaml'), 'x: y\n')
  await script(join(input, 'prepare-agent-session-state.sh'), 'exit 0'); await script(join(input, 'bootstrap-agent-skills.sh'), 'echo "$@" > "$E2E_MARKS/adapters"')
  // gh records the token the wrapper hands it on every call.
  await script(join(stubs, 'gh'), 'echo "$GH_TOKEN" >> "$E2E_MARKS/gh-tokens"')
  await script(join(stubs, 'agent-runner'), `
echo "$@" > "$E2E_MARKS/argv"
env > "$E2E_MARKS/env"
gh probe
printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | sed -n 's/^password=//p' >> "$E2E_MARKS/cred-tokens"
if [[ -n "\${E2E_WAIT:-}" ]]; then
  touch "$E2E_MARKS/ready"; while [[ ! -e "$E2E_MARKS/replaced" ]]; do sleep 0.05; done
  gh probe
  printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | sed -n 's/^password=//p' >> "$E2E_MARKS/cred-tokens"
fi
git commit --allow-empty -q -m hook-probe || true
exit 0`)
  await writeFile(join(auth, 'token'), 'token-ONE')
  await writeFile(join(home, '.gitconfig'), `[core]\n  hooksPath = ${join(home, 'hooks')}\n[alias]\n  st = !touch ${join(marks, 'global-config-ran')}\n`)
  await script(join(home, 'hooks/post-commit'), `touch "${join(marks, 'global-hook-ran')}"`)
  const run = (mode, { runId = '', until = 'define', env = {} } = {}) => new Promise(resolve => {
    const child = spawn('bash', [join(input, 'sandbox-driver.sh'), art, '/skills', mode, runId, until, 'openspec:change', URL_, 'claude', 'codex'], {
      env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, E2E_MARKS: marks, E2E_TOKEN_FILE: join(auth, 'token'), E2E_BIN_DIR: join(root, 'bin'), GH_TOKEN: 'SENTINEL-GH', GITHUB_TOKEN: 'SENTINEL-GITHUB', GH_ENTERPRISE_TOKEN: 'SENTINEL-ENT', ...env } })
    let out = ''; child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
    child.on('exit', code => resolve({ code, out }))
    child.promise = null
  })
  return { root, input, art, auth, marks, run, repo: join(art, 'workspace/repo') }
}
const lines = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean)

test('INT-002 fresh mode wires the delivery remote, branch, argv and refreshable token', async t => {
  const h = await harness(t)
  const pending = h.run('fresh', { env: { E2E_WAIT: '1' } })
  for (let i = 0; i < 200; i++) { try { await access(join(h.marks, 'ready')); break } catch { await new Promise(r => setTimeout(r, 50)) } }
  await writeFile(join(h.auth, 'token.next'), 'token-TWO'); await import('node:fs/promises').then(fs => fs.rename(join(h.auth, 'token.next'), join(h.auth, 'token')))
  await writeFile(join(h.marks, 'replaced'), '')
  const { code, out } = await pending
  assert.equal(code, 0, out)
  assert.equal(git(h.repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'add-presentation-skill')
  assert.equal(git(h.repo, ['remote']), 'origin'); assert.equal(git(h.repo, ['remote', 'get-url', 'origin']), URL_)
  assert.equal(git(h.repo, ['rev-list', '--count', 'main']), '1')
  assert.equal((await readFile(join(h.marks, 'argv'), 'utf8')).trim(), 'run openspec:change --external-user ' + h.art + '/exchange --until define --param change_name=add-presentation-skill')
  // The wrapper and helper read the file on every call: the replacement value is seen after the swap.
  assert.deepEqual(await lines(join(h.marks, 'gh-tokens')), ['token-ONE', 'token-TWO'])
  assert.deepEqual(await lines(join(h.marks, 'cred-tokens')), ['token-ONE', 'token-TWO'])
  const env = await readFile(join(h.marks, 'env'), 'utf8')
  for (const sentinel of ['SENTINEL-GH', 'SENTINEL-GITHUB', 'SENTINEL-ENT']) assert.ok(!env.includes(sentinel), `${sentinel} reached the Runner`)
  assert.ok(!/^GH_CONFIG_DIR=/m.test(env)); assert.ok(!/^(GH|GITHUB)_TOKEN=/m.test(env))
  // No token value is written by the driver; the live token file is the only holder.
  for (const file of await filesUnder(h.art)) { const text = await readFile(file, 'utf8').catch(() => ''); assert.ok(!/token-(ONE|TWO)/.test(text), file) }
  assert.ok(!/token-(ONE|TWO)/.test(out))
  // C-5: global git config and hooks never run; the repository credential helper is local.
  await assert.rejects(access(join(h.marks, 'global-hook-ran'))); await assert.rejects(access(join(h.marks, 'global-config-ran')))
  assert.match(git(h.repo, ['config', '--local', 'credential.helper']), /git-credential-e2e$/)
  assert.equal(git(h.repo, ['config', '--local', 'core.hooksPath']), '/dev/null')
})

test('INT-002 resume mode passes the phase cap and never the external-user flag', async t => {
  const h = await harness(t)
  assert.equal((await h.run('fresh')).code, 0)
  for (const until of ['define', 'implement']) {
    const { code, out } = await h.run('resume', { runId: 'run-123', until })
    assert.equal(code, 0, out)
    assert.equal((await readFile(join(h.marks, 'argv'), 'utf8')).trim(), `--resume run-123 --until ${until}`)
  }
})

test('INT-002 invalid modes are refused before the Runner starts', async t => {
  const h = await harness(t)
  assert.equal((await h.run('resume', { runId: '', until: 'implement' })).code, 2)
  assert.equal((await h.run('resume', { runId: 'run-1', until: 'accept' })).code, 2)
  await assert.rejects(access(join(h.marks, 'argv')))
})
