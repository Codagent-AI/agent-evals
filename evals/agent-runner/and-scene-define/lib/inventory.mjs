import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { SUITE_ROOT, readJson, sha256, contained, filesUnder } from './files.mjs'
import { FIXTURE } from './fixture.mjs'
import { checkVersions } from './versions.mjs'
const CLASSES = ['mandatory', 'acceptable-alternative', 'preference']
const KINDS = ['behavior', 'constraint', 'value', 'scope-inclusion', 'scope-exclusion', 'decision']
const nonempty = value => typeof value === 'string' && value.trim().length > 0

// Include subheadings in a section, stopping at the next heading of equal or higher level.
export function sections(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)]
  return headings.map((match, index) => {
    const end = headings.slice(index + 1).find(next => next[1].length <= match[1].length)?.index ?? markdown.length
    return { heading: match[2], level: match[1].length, text: markdown.slice(match.index + match[0].length, end) }
  })
}
const key = entry => JSON.stringify([entry.document, entry.requirement, entry.scenario ?? null])

export async function checkInventory({ suiteRoot = SUITE_ROOT, hiddenDir = join(suiteRoot, 'hidden'), inventory, reference, referenceDir = join(hiddenDir, 'reference'), citationDir = join(hiddenDir, 'citation-supplements'), refresh = false } = {}) {
  inventory ??= await readJson(join(hiddenDir, 'inventory.json'))
  reference ??= await readJson(join(hiddenDir, 'reference.json'))
  const errors = []
  if (!Number.isInteger(inventory.inventory_version) || inventory.inventory_version < 1) errors.push('inventory version must be a positive integer')
  if (JSON.stringify(inventory.source) !== JSON.stringify({ repository: reference.repository, commit: reference.commit, change: reference.change })) errors.push('inventory source pin differs from reference pin')
  if (reference.repository !== FIXTURE.repository || reference.change !== FIXTURE.change || reference.commit !== FIXTURE.commit) errors.push('reference does not match the suite fixture pin')
  for (const name of ['starting_prompt', 'items', 'brief']) {
    if (!inventory.inputs?.[name]?.path || !/^[a-f0-9]{64}$/.test(inventory.inputs[name].sha256 ?? '')) errors.push(`missing pinned input: ${name}`)
  }
  if (inventory.inputs?.labels?.length !== 2 || new Set((inventory.inputs?.labels ?? []).map(input => input.labeller)).size !== 2) errors.push('two distinct pinned labeller inputs required')
  const inputRecords = Object.values(inventory.inputs ?? {}).flat()
  for (const input of inputRecords) {
    try {
      if (sha256(await readFile(contained(hiddenDir, input.path))) !== input.sha256) errors.push(`input hash mismatch: ${input.path}`)
    } catch (error) { errors.push(`input ${input.path}: ${error.message}`) }
  }
  const documents = new Map()
  async function loadDocuments(root, pins) {
    for (const file of await filesUnder(root)) {
      const path = relative(root, file).split('\\').join('/')
      const content = await readFile(file)
      documents.set(path, sections(content.toString('utf8')))
      if (!refresh) {
        const pin = pins.find(entry => entry.path === path)
        if (!pin || pin.sha256 !== sha256(content)) errors.push(`snapshot hash mismatch: ${path}`)
      }
    }
    if (!refresh) for (const entry of pins) if (!documents.has(entry.path)) errors.push(`snapshot file missing: ${entry.path}`)
  }
  await loadDocuments(referenceDir, reference.files)
  if (reference.citation_files?.length) await loadDocuments(citationDir, reference.citation_files)
  const ids = new Set()
  const counts = Object.fromEntries(CLASSES.map(name => [name, 0]))
  const labelSets = new Map()
  for (const input of inventory.inputs.labels ?? []) {
    try {
      const data = await readJson(contained(hiddenDir, input.path))
      if (data.labeller !== input.labeller || data.model !== input.model || data.brief_version !== inventory.inputs.brief?.version) errors.push(`labels ${input.path}: labeller, model, or brief version differs from pin`)
      labelSets.set(input.labeller, data)
    }
    catch (error) { errors.push(`labels ${input.path}: ${error.message}`) }
  }
  const modelFamily = model => /^claude/i.test(model) ? 'anthropic' : /^(?:gpt|codex|o\d)/i.test(model) ? 'openai' : model?.split('-')[0]
  if (new Set([...labelSets.values()].map(data => modelFamily(data.model))).size !== 2) errors.push('independent labels must name different model families')
  const itemizedInput = inventory.inputs.items
  let originals
  if (itemizedInput) {
    try { originals = await readJson(contained(hiddenDir, itemizedInput.path)) }
    catch (error) { errors.push(`items: ${error.message}`) }
  }
  if (originals && JSON.stringify(originals.source) !== JSON.stringify(inventory.source)) errors.push('itemized source differs from inventory pin')
  if (originals && originals.items.length !== inventory.items.length) errors.push('inventory item set differs from itemized inputs')
  for (const item of inventory.items) {
    const prefix = item.id ?? 'unnamed item'
    if (!nonempty(item.id) || ids.has(item.id)) errors.push(`${prefix}: missing or duplicate stable id`)
    ids.add(item.id)
    for (const field of ['area', 'title', 'statement']) if (!nonempty(item[field])) errors.push(`${prefix}: missing ${field}`)
    if (!KINDS.includes(item.kind)) errors.push(`${prefix}: invalid kind`)
    if (!CLASSES.includes(item.class)) errors.push(`${prefix}: exactly one final class required`)
    else counts[item.class]++
    if (item.class === 'acceptable-alternative') {
      if (!nonempty(item.intent) || !nonempty(item.intent_source)) errors.push(`${prefix}: acceptable-alternative requires intent and intent_source`)
    } else if (item.intent != null || item.intent_source != null) errors.push(`${prefix}: intent only belongs to acceptable-alternative`)
    if (!Array.isArray(item.sources) || !item.sources.length) errors.push(`${prefix}: source quote required`)
    for (const source of item.sources ?? []) {
      const matches = documents.get(source.document)?.filter(section => section.heading === source.heading) ?? []
      if (!nonempty(source.quote) || !matches.some(section => section.text.includes(source.quote))) errors.push(`${prefix}: stale quote in ${source.document} under ${source.heading}; needs relabelling`)
    }
    const labels = Object.entries(item.labels ?? {})
    if (labels.length !== 2 || labels.some(([, label]) => !CLASSES.includes(label.class) || !['high', 'medium', 'low'].includes(label.confidence))) errors.push(`${prefix}: two valid independent labels required`)
    const disagreement = new Set(labels.map(([, label]) => label.class)).size > 1
    if (disagreement && (item.resolution !== 'reconciled' || !nonempty(item.reconciliation_reason) || !CLASSES.includes(item.class))) errors.push(`${prefix}: unresolved disagreement requires final class and reason`)
    if (!disagreement && (item.resolution !== 'agreed' || labels.some(([, label]) => label.class !== item.class))) errors.push(`${prefix}: agreed labels must match final class`)
    for (const [labeller, data] of labelSets) {
      const label = data.labels.find(entry => entry.id === item.id)
      if (!label || label.class !== item.labels?.[labeller]?.class || label.confidence !== item.labels?.[labeller]?.confidence) errors.push(`${prefix}: ${labeller} label differs from independent input`)
      if (item.intent_source === labeller && item.intent !== label?.intent) errors.push(`${prefix}: intent differs from ${labeller} input`)
    }
    if (labelSets.size && item.class === 'acceptable-alternative' && !labelSets.has(item.intent_source)) errors.push(`${prefix}: unknown intent source`)
    if (originals) {
      const original = originals.items.find(entry => entry.id === item.id)
      if (!original || Object.keys(original).some(field => JSON.stringify(original[field]) !== JSON.stringify(item[field]))) errors.push(`${prefix}: item differs from itemized input`)
    }
  }
  for (const name of CLASSES) if (inventory.counts?.[name] !== counts[name]) errors.push(`count mismatch: ${name}`)
  const mapped = new Set()
  for (const entry of inventory.coverage) {
    if (!entry.items?.length) errors.push(`empty coverage: ${entry.document} ${entry.scenario ?? entry.requirement}`)
    for (const id of entry.items ?? []) if (!ids.has(id)) errors.push(`coverage names missing item ${id}`)
    if (entry.items?.length && entry.items.every(id => ids.has(id))) mapped.add(key(entry))
  }
  for (const entry of inventory.excluded) if (!nonempty(entry.reason)) errors.push(`exclusion without reason: ${entry.document} ${entry.heading ?? entry.scenario ?? entry.requirement}`)
  for (const [document, entries] of documents) {
    if (!/\/specs\/.+\/spec\.md$/.test(document)) continue
    let requirement
    for (const section of entries) {
      if (section.heading.startsWith('Requirement: ')) requirement = section.heading
      else if (!section.heading.startsWith('Scenario: ')) continue
      const scenario = section.heading.startsWith('Scenario: ') ? section.heading : null
      const excluded = inventory.excluded.some(entry => entry.document === document && nonempty(entry.reason) &&
        (entry.heading === (scenario ?? requirement) || (entry.requirement === requirement && (entry.scenario ?? null) === scenario)))
      if (!mapped.has(key({ document, requirement, scenario })) && !excluded) errors.push(`unmapped: ${document} ${requirement}${scenario ? ` / ${scenario}` : ''}`)
    }
  }
  return errors
}

export async function assertPinnedInventory({ suiteRoot = SUITE_ROOT } = {}) {
  const errors = [...await checkInventory({ suiteRoot }), ...await checkVersions({ suiteRoot })]
  if (errors.length) throw new Error(`stale or unpinned inventory:\n${errors.join('\n')}`)
  return readJson(join(suiteRoot, 'hidden/inventory.json'))
}
