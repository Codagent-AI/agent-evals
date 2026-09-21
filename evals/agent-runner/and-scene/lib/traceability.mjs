// Offline verification for rubric requirements that originate in the pinned fixture.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function sourceEntries(source) {
  return Array.isArray(source?.sources) ? source.sources : [source]
}

function sourceError(id, source) {
  if (!source || typeof source !== 'object') return `criterion ${id} requires a source`
  if (source.owner === 'eval') return typeof source.reason === 'string' && source.reason.trim()
    ? null : `criterion ${id} eval-owned source requires a reason`
  if (source.owner !== 'fixture') return `criterion ${id} source has unknown owner`
  const citations = sourceEntries(source)
  if (citations.length === 0 || citations.some((citation) => !citation || typeof citation.document !== 'string' || typeof citation.heading !== 'string' || typeof citation.quote !== 'string' || !citation.document.trim() || !citation.heading.trim() || !citation.quote.trim())) {
    return `criterion ${id} fixture source requires document, heading, and quote`
  }
  return null
}

export function validateTraceability({ rubric, fixture, fixtureRef }) {
  const errors = []
  if (fixture.fixture_ref !== fixtureRef) errors.push('fixture snapshot ref differs from FIXTURE_REF; refresh the snapshot')
  const files = new Map((fixture.files ?? []).map((file) => [file.path, file]))
  for (const file of files.values()) {
    if (file.blob && file.content != null && gitBlobId(file.content) !== file.blob) errors.push(`fixture snapshot document ${file.path} does not match recorded blob`)
  }
  const ids = [
    ...(rubric.components ?? []).flatMap((component) => component.subcomponents ?? []).flatMap((subcomponent) => subcomponent.criteria ?? []),
    ...(rubric.gates ?? []).map(({ id }) => id),
  ]
  const sources = rubric.criterion_sources ?? {}
  for (const id of ids) {
    const source = sources[id]
    const structural = sourceError(id, source)
    if (structural) { errors.push(structural); continue }
    if (source.owner !== 'fixture') continue
    for (const citation of sourceEntries(source)) {
      const file = files.get(citation.document)
      if (!file) { errors.push(`criterion ${id} citation document ${citation.document} is not in the fixture snapshot`); continue }
      const section = sectionForHeading(file.content ?? '', citation.heading)
      if (section == null) { errors.push(`criterion ${id} citation heading ${citation.heading} does not exist`); continue }
      if (!normalizeTraceabilityText(section).includes(normalizeTraceabilityText(citation.quote))) {
        errors.push(`criterion ${id} citation quote does not match ${citation.heading}: ${citation.quote}`)
      }
    }
  }
  const evalOwned = new Set((rubric.eval_owned_values ?? [])
    .filter(({ value, reason }) => typeof value === 'string' && value && typeof reason === 'string' && reason.trim())
    .map(({ value }) => normalizeTraceabilityText(value)))
  const isCited = (id, value) => {
    const normalized = normalizeTraceabilityText(value).replace(/\s+/g, '')
    return sourceEntries(sources[id])
      .filter((citation) => sources[id]?.owner === 'fixture')
      .map((citation) => sectionForHeading(files.get(citation.document)?.content ?? '', citation.heading) ?? '')
      .map(normalizeTraceabilityText)
      .some((section) => section.replace(/\s+/g, '').includes(normalized))
  }
  for (const component of rubric.components ?? []) for (const subcomponent of component.subcomponents ?? []) {
    const citedSections = (subcomponent.criteria ?? []).map((id) => sources[id])
      .filter((source) => source?.owner === 'fixture')
      .flatMap(sourceEntries)
      .map((citation) => sectionForHeading(files.get(citation.document)?.content ?? '', citation.heading) ?? '')
      .map(normalizeTraceabilityText)
    const texts = subcomponent.review_guidance ?? []
    for (const value of valuesIn(texts.join('\n'))) {
      const normalized = normalizeTraceabilityText(value).replace(/\s+/g, '')
      const found = citedSections.some((section) => section.replace(/\s+/g, '').includes(normalized))
      if (!found && !evalOwned.has(normalizeTraceabilityText(value))) errors.push(`subcomponent ${subcomponent.id} has uncited concrete value ${value}`)
    }
  }
  for (const [id, fallback] of Object.entries(rubric.fallbacks ?? {})) {
    for (const value of valuesIn([fallback.requirement, ...(fallback.guidance ?? [])].join('\n'))) {
      if (!isCited(id, value) && !evalOwned.has(normalizeTraceabilityText(value))) errors.push(`fallback ${id} has uncited concrete value ${value}`)
    }
  }
  for (const gate of rubric.gates ?? []) for (const value of valuesIn(gate.requirement)) {
    if (!isCited(gate.id, value) && !evalOwned.has(normalizeTraceabilityText(value))) errors.push(`gate ${gate.id} has uncited concrete value ${value}`)
  }
  return errors
}

export async function loadFixtureSnapshot(snapshotDir = SNAPSHOT_DIR) {
  const snapshot = JSON.parse(await readFile(join(snapshotDir, 'snapshot.json'), 'utf8'))
  snapshot.files = await Promise.all(snapshot.files.map(async (file) => ({
    ...file, content: await readFile(join(snapshotDir, file.path), 'utf8'),
  })))
  return snapshot
}
