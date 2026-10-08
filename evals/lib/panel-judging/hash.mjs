import { createHash } from 'node:crypto'

export function hashString(value) {
  return createHash('sha256').update(value).digest('hex')
}

// Canonicalize before hashing so a checkpoint fingerprint depends on values,
// not on the key order a caller happened to build the object with.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function hashJson(value) {
  return hashString(JSON.stringify(canonicalize(value)))
}
