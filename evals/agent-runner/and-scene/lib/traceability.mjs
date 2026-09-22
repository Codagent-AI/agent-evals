// Offline verification for rubric requirements that originate in the pinned fixture.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson } from './persistence.mjs'
import { requirementSourceIds, sourceEntries, sourceError } from './rubric.mjs'

const SUITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const SNAPSHOT_DIR = join(SUITE_DIR, 'fixture-snapshot')

export function normalizeTraceabilityText(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/×/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function gitBlobId(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}

function sectionForHeading(content, heading) {
  const lines = content.split(/\r?\n/)
  const wanted = normalizeTraceabilityText(heading)
  const start = lines.findIndex((line) => normalizeTraceabilityText(line.replace(/^#+\s*/, '')) === wanted)
  if (start < 0) return null
  const level = (lines[start].match(/^(#+)\s/)?.[1].length) ?? 6
  const end = lines.findIndex((line, index) => index > start && (line.match(/^(#+)\s/)?.[1].length ?? 7) <= level)
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

function valuesIn(text) {
  const values = new Set()
  for (const match of String(text).matchAll(/\b\d+\s*[×x]\s*\d+\b/gi)) values.add(match[0])
  for (const match of String(text).matchAll(/\b\d+(?:\.\d+)?\s*(?:px|ms|s|%)\b/gi)) values.add(match[0])
  for (const match of String(text).matchAll(/\b(?:data|aria)-[\w-]+\b/gi)) values.add(match[0])
  for (const match of String(text).matchAll(/`([.#][^`\s]+)`/g)) values.add(match[1])
  return [...values]
}

// Whitespace is dropped as well, so `880 × 380` in the fixture accounts for
// `880×380` in guidance.
function compact(text) {
  return normalizeTraceabilityText(text).replace(/\s+/g, '')
}

export function validateTraceability({ rubric, fixture, fixtureRef }) {
  const errors = []
  if (fixture.fixture_ref !== fixtureRef) {
    errors.push('fixture snapshot ref differs from FIXTURE_REF; refresh the snapshot')
  }
  const files = new Map((fixture.files ?? []).map((file) => [file.path, file]))
  for (const file of files.values()) {
    if (file.blob && file.content != null && gitBlobId(file.content) !== file.blob) {
      errors.push(`fixture snapshot document ${file.path} does not match recorded blob`)
    }
  }

  const sources = rubric.criterion_sources ?? {}
  const sectionOf = (citation) => (
    sectionForHeading(files.get(citation.document)?.content ?? '', citation.heading)
  )
  for (const id of requirementSourceIds(rubric)) {
    const source = sources[id]
    const structural = sourceError(id, source)
    if (structural) {
      errors.push(structural)
      continue
    }
    if (source.owner !== 'fixture') continue
    for (const citation of sourceEntries(source)) {
      if (!files.has(citation.document)) {
        errors.push(`criterion ${id} citation document ${citation.document} is not in the fixture snapshot`)
        continue
      }
      const section = sectionOf(citation)
      if (section == null) {
        errors.push(`criterion ${id} citation heading ${citation.heading} does not exist`)
      } else if (!normalizeTraceabilityText(section).includes(normalizeTraceabilityText(citation.quote))) {
        errors.push(`criterion ${id} citation quote does not match ${citation.heading}: ${citation.quote}`)
      }
    }
  }

  // A concrete value is accounted for when the fixture text cited by one of the
  // criteria it applies to contains it, or when the rubric declares it eval-owned.
  const evalOwned = new Set((rubric.eval_owned_values ?? [])
    .filter(({ value, reason }) => typeof value === 'string' && value && typeof reason === 'string' && reason.trim())
    .map(({ value }) => normalizeTraceabilityText(value)))
  const citedSections = (ids) => ids
    .map((id) => sources[id])
    .filter((source) => source?.owner === 'fixture')
    .flatMap(sourceEntries)
    .map((citation) => compact(sectionOf(citation) ?? ''))
  const uncitedValues = (text, ids) => {
    const sections = citedSections(ids)
    return valuesIn(text).filter((value) => (
      !sections.some((section) => section.includes(compact(value)))
      && !evalOwned.has(normalizeTraceabilityText(value))
    ))
  }

  for (const component of rubric.components ?? []) {
    for (const subcomponent of component.subcomponents ?? []) {
      const guidance = (subcomponent.review_guidance ?? []).join('\n')
      for (const value of uncitedValues(guidance, subcomponent.criteria ?? [])) {
        errors.push(`subcomponent ${subcomponent.id} has uncited concrete value ${value}`)
      }
    }
  }
  for (const [id, fallback] of Object.entries(rubric.fallbacks ?? {})) {
    const text = [fallback.requirement, ...(fallback.guidance ?? [])].join('\n')
    for (const value of uncitedValues(text, [id])) {
      errors.push(`fallback ${id} has uncited concrete value ${value}`)
    }
  }
  for (const gate of rubric.gates ?? []) {
    for (const value of uncitedValues(gate.requirement, [gate.id])) {
      errors.push(`gate ${gate.id} has uncited concrete value ${value}`)
    }
  }
  return errors
}

export async function loadFixtureSnapshot(snapshotDir = SNAPSHOT_DIR) {
  const snapshot = await readJson(join(snapshotDir, 'snapshot.json'))
  snapshot.files = await Promise.all(snapshot.files.map(async (file) => ({
    ...file, content: await readFile(join(snapshotDir, file.path), 'utf8'),
  })))
  return snapshot
}
