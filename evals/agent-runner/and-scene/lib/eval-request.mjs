import { hashJson } from './persistence.mjs'

const invalid = message => ({ refusals: [{ code: 'eval-block-invalid', message }] })
export function extractEvalBlock(body) {
  const matches = [...body.replace(/\r\n/g, '\n').matchAll(/```eval[ \t]*\n([\s\S]*?)\n```/g)]
  if (matches.length !== 1) return { refusals: [{ code: matches.length ? 'eval-block-ambiguous' : 'eval-block-missing', message: `Expected one eval block; found ${matches.length}` }] }
  return { text: matches[0][1] }
}

// Scan strings before comments so # inside either string form remains literal.
function uncomment(line) {
  let quote = null, escaped = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === '"' && !escaped && c === '\\') { escaped = true; continue }
    if (quote && c === quote && !escaped) quote = null
    else if (!quote && (c === '"' || c === "'")) quote = c
    else if (!quote && c === '#') return line.slice(0, i)
    escaped = false
  }
  return line
}
function basicString(raw) {
  if (!/^"(?:[^"\\\x00-\x08\x0a-\x1f\x7f]|\\(?:["\\btnfr]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"$/.test(raw)) throw Error('Invalid basic string')
  return raw.slice(1, -1).replace(/\\(["\\btnfr]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g, (_, escape) => {
    if (escape[0] === 'u' || escape[0] === 'U') {
      const code = parseInt(escape.slice(1), 16)
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw Error('Invalid Unicode scalar')
      return String.fromCodePoint(code)
    }
    return { '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' }[escape]
  })
}
export function parseTomlSubset(text) {
  const settings = {}
  for (const [index, raw] of text.split('\n').entries()) {
    const line = uncomment(raw).trim()
    if (!line) continue
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    try {
      if (!match) throw Error('Expected flat key = value')
      const [, key, value] = match
      if (Object.hasOwn(settings, key)) throw Error(`Duplicate key ${key}`)
      let parsed
      if (value.startsWith('"')) parsed = basicString(value)
      else if (/^'[^'\x00-\x08\x0a-\x1f\x7f]*'$/.test(value)) parsed = value.slice(1, -1)
      else if (value === 'true' || value === 'false') parsed = value === 'true'
      else if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(value)) {
        parsed = Number(value.replaceAll('_', ''))
        if (!Number.isSafeInteger(parsed)) throw Error('Integer outside supported range')
      } else throw Error('Unsupported value')
      Object.defineProperty(settings, key, { value: parsed, enumerable: true, configurable: true })
    } catch (cause) { return invalid(`Line ${index + 1}: ${cause.message}`) }
  }
  return { settings }
}
export const REQUEST_ROLES = ['lead', 'crosscheck', 'implementor', 'tester']
export function requestHash(settings) { return hashJson(settings) }
export function validateRequest(doc) {
  const refs = ['agent_runner_ref', 'agent_skills_ref', 'fixture_ref']
  for (const [key, value] of Object.entries(doc)) {
    if (refs.includes(key)) {
      if (typeof value !== 'string' || !value.trim()) return invalid(`${key}: expected non-empty string`)
    } else if (REQUEST_ROLES.includes(key)) {
      if (typeof value !== 'string' || value.split(':').length !== 3 || value.split(':').some(x => !x.trim())) return invalid(`${key}: expected cli:model:effort`)
    } else if (key === 'skip_validator') {
      if (typeof value !== 'boolean') return invalid(`${key}: expected boolean`)
    } else if (key === 'repetitions') {
      if (!Number.isSafeInteger(value) || value <= 0) return invalid(`${key}: expected positive integer`)
    } else return invalid(`Unsupported key ${key}`)
  }
  return { settings: doc, hash: requestHash(doc) }
}
