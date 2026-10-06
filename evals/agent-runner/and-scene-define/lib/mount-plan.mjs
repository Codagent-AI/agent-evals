import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
const canonical = path => { try { return realpathSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error; return resolve(path) } }
// Parse Bash printf %q output without evaluating any command or expansion.
export function shellWords(line) {
  const words = []; let word = ''; let quote = null; let active = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (!quote && /\s/.test(c)) { if (active) words.push(word); word = ''; active = false; continue }
    active = true
    if (!quote && c === '$' && line[i + 1] === "'") { quote = 'ansi'; i++; continue }
    if (c === '\\' && quote !== "'") {
      const next = line[++i]; if (next === undefined) throw new Error('malformed mount plan quoting')
      word += quote === 'ansi' ? ({ n: '\n', r: '\r', t: '\t' }[next] ?? next) : next; continue
    }
    if (c === "'" || c === '"') {
      if (!quote) { quote = c; continue }
      if (quote === c || (quote === 'ansi' && c === "'")) { quote = null; continue }
    }
    word += c
  }
  if (quote) throw new Error('unterminated mount plan quoting')
  if (active) words.push(word)
  return words
}
const ENV_ALLOWLIST = new Set(['CI', 'HOME', 'AGENT_RUNNER_SOURCE_COMMIT', 'AGENT_RUNNER_SOURCE_DIRTY', 'AGENT_RUNNER_DEV_AUDIT', 'AGENT_RUNNER_AUDIT_SMOKE'])
export function verifyMountPlan(text, { inputDir, artifactDir, skillsDir, runnerDir, credentialFiles = [] }) {
  const allowed = new Map([[canonical(inputDir), { target: '/eval-input', ro: true }], [canonical(artifactDir), { target: '/artifacts', ro: false }], [canonical(skillsDir), { target: '/agent-skills', ro: true }], ...credentialFiles.map(path => [canonical(path), { target: `/host-home/${path.includes('/.claude/') ? 'claude/.credentials.json' : path.includes('/.cursor/') ? 'cursor/auth.json' : 'codex/auth.json'}`, ro: true }])])
  const containers = []
  for (const line of text.split('\n')) {
    const argv = shellWords(line)
    if (argv[0] !== 'docker') continue
    if (argv[1] === 'build') {
      if (canonical(argv.at(-1)) !== canonical(runnerDir)) throw new Error(`mount plan: unexpected build context ${argv.at(-1)}`)
      if (argv.includes('--secret') || argv.includes('--build-arg') || argv.some(arg => arg.startsWith('--build-context'))) throw new Error('mount plan: unexpected build input')
      continue
    }
    if (argv[1] !== 'run') continue
    const mounts = []; const env = []
    // Stop parsing at the image: embedded shell scripts are single inert words.
    for (let i = 2; i < argv.length; i++) {
      const flag = argv[i]
      if (!flag.startsWith('-')) break
      if (['--rm', '--init', '--read-only'].includes(flag) || flag.startsWith('--shm-size=')) continue
      if (['-w', '--workdir', '--user'].includes(flag)) { i++; continue }
      if (flag === '-e' || flag === '--env' || flag.startsWith('--env=')) {
        const value = flag.startsWith('--env=') ? flag.slice(6) : argv[++i]
        const name = value?.split('=')[0]
        if (!ENV_ALLOWLIST.has(name)) throw new Error(`mount plan: forbidden environment ${name}`)
        env.push(value); continue
      }
      if (flag === '-v' || flag === '--volume' || flag.startsWith('--volume=')) {
        const value = flag.startsWith('--volume=') ? flag.slice(9) : argv[++i]
        const [source, target, mode = 'rw'] = value.split(':')
        mounts.push({ source, target, ro: mode === 'ro', type: source.startsWith('/') ? 'bind' : 'volume' }); continue
      }
      if (flag === '--mount' || flag.startsWith('--mount=')) {
        const value = flag === '--mount' ? argv[++i] : flag.slice(8)
        const fields = Object.fromEntries(value.split(',').map(part => { const split = part.indexOf('='); return split < 0 ? [part, true] : [part.slice(0, split), part.slice(split + 1)] }))
        mounts.push({ type: fields.type, source: fields.source ?? fields.src, target: fields.target ?? fields.dst ?? fields.destination, ro: fields.readonly === true || fields.readonly === 'true' || fields.ro === true }); continue
      }
      throw new Error(`mount plan: unexpected docker option ${flag}`)
    }
    const build = mounts.some(mount => mount.target === '/agent-runner-source')
    const seen = new Set()
    for (const mount of mounts) {
      if (seen.has(mount.target)) throw new Error(`mount plan: duplicate target ${mount.target}`)
      seen.add(mount.target)
      if (mount.type === 'volume' && mount.target === '/workspace/bin' && mount.source && !mount.source.includes('/')) continue
      if (build) {
        if (canonical(mount.source) !== canonical(runnerDir) || mount.target !== '/agent-runner-source' || !mount.ro) throw new Error(`mount plan: unexpected build mount ${mount.source}`)
      } else {
        const expected = allowed.get(canonical(mount.source))
        if (!expected || expected.target !== mount.target) throw new Error(`mount plan: unexpected mount ${mount.source} at ${mount.target}`)
        if (mount.ro !== expected.ro) throw new Error(`mount plan: ${mount.source} must be ${expected.ro ? 'read-only' : 'read-write'}`)
      }
    }
    if (!build) for (const [source, expected] of allowed) if (!mounts.some(mount => canonical(mount.source) === source && mount.target === expected.target)) throw new Error(`mount plan: missing mount ${source}`)
    containers.push({ kind: build ? 'build' : 'command', mounts, env })
  }
  if (containers.filter(container => container.kind === 'command').length !== 1) throw new Error('mount plan: expected exactly one command container')
  return containers
}
