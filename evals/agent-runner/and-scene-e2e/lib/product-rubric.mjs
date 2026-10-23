// The from-prompt product rubric: validation against the hidden inventory, and requirement documents built
// per inventory item (never per reference section) for judges.
import { join } from 'node:path'
import { SUITE_ROOT, DEFINE_ROOT, readJson } from './files.mjs'
// Same normalization and-scene's traceability rules use, kept local so this suite does not import and-scene's rubric code.
const normalizeTraceabilityText = value => String(value).normalize('NFKC').replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/\s+/g, ' ').trim().toLowerCase()

export const EVALUATORS = ['browser-judge', 'llm-source-review', 'llm-evidence-review']
export const JUDGE_JOBS = ['demo-integration', 'scene-kit', 'presentation-skill', 'verification-tooling', 'engineering-quality', 'testing-evidence', 'assumption-handling']
export const EVIDENCE_JOBS = ['testing-evidence', 'assumption-handling']
export const TIERS = ['critical', 'major', 'minor']
export const GATE_INPUT_TIER = 'gate-input'
export const COMPONENT_POLICY = [['demo-technical-quality', 20], ['scene-kit-correctness', 20], ['presentation-skill-correctness', 7], ['verification-tool-correctness', 7], ['engineering-quality', 8], ['testing-evidence-quality', 4], ['assumption-handling-quality', 4]]
export const GATE_IDS = ['gate-build-whole-app', 'gate-sample-reachable', 'gate-every-step-renders', 'gate-verifier-clear-outcome']
export const SCOPE_ITEMS = ['INV-105', 'INV-106', 'INV-107', 'INV-108']
export const AND_SCENE_REQUIREMENT_LIMIT = 40_000
const MAX_TIER_WEIGHT = 2
const WEIGHT_UNIT = 16
const FORBIDDEN_FIELDS = ['pass_threshold', 'automated_pass_threshold', 'floor']
export const graded = item => item.class === 'mandatory' || item.class === 'acceptable-alternative'

export function rubricRows(rubric) {
  return rubric.components.flatMap(component => component.subcomponents.flatMap(subcomponent => subcomponent.criteria.map(id => ({
    id, component: component.id, subcomponent: subcomponent.id, evaluator: subcomponent.evaluator, job: subcomponent.job ?? null,
    tier: subcomponent.tiers?.[id] ?? null, points: subcomponent.tiers?.[id] === GATE_INPUT_TIER ? 0 : component.tier_weights?.[subcomponent.tiers?.[id]] ?? null }))))
}
export function criteriaForJob(rubric, job) {
  return rubric.components.flatMap(component => component.subcomponents.filter(subcomponent => subcomponent.job === job).flatMap(subcomponent => subcomponent.criteria))
}
export function browserCriteria(rubric) { return rubricRows(rubric).filter(row => row.evaluator === 'browser-judge').map(row => row.id) }
function valuesIn(text) {
  const values = new Set()
  for (const match of String(text).matchAll(/\b\d+\s*[×x]\s*\d+\b/gi)) values.add(match[0])
  for (const match of String(text).matchAll(/\b\d+(?:\.\d+)?\s*(?:px|ms|s|%)\b/gi)) values.add(match[0])
  for (const match of String(text).matchAll(/\b(?:data|aria)-[\w-]+\b/gi)) values.add(match[0])
  return [...values]
}
const compact = text => normalizeTraceabilityText(text).replace(/\s+/g, '')
// Requirement text for one inventory item: statement, intent and the quote of each source only.
export function requirementDocument(item) {
  return [`# ${item.id} (${item.class}): ${item.title}`, `Statement: ${item.statement}`,
    ...(item.class === 'acceptable-alternative' ? [`Intent: ${item.intent}`, 'The intent takes precedence over any mechanism the quotes below describe: a different design that meets the intent satisfies this requirement.'] : []),
    ...item.sources.map(source => `Quote (${source.heading}): ${source.quote}`)].join('\n')
}
export function criterionRequirement(rubric, inventory, id) {
  const gate = rubric.gates?.find(entry => entry.id === id)
  const source = rubric.criterion_sources?.[id] ?? (gate ? { owner: 'fixture', inventory: gate.inventory } : null)
  if (!source) return null
  if (source.owner === 'eval') return `Requirement (eval-owned): ${source.reason}`
  const byId = new Map(inventory.items.map(item => [item.id, item]))
  return source.inventory.map(itemId => requirementDocument(byId.get(itemId))).join('\n\n')
}
export function validateProductRubric(rubric, inventory, { preferenceValues = [] } = {}) {
  const errors = []
  const items = new Map(inventory.items.map(item => [item.id, item]))
  if (typeof rubric?.rubric_id !== 'string' || typeof rubric?.version !== 'string') return ['product rubric requires a string rubric_id and version']
  if (typeof rubric.provisional !== 'boolean') errors.push('rubric must declare provisional')
  if (rubric.inventory_version !== inventory.inventory_version) errors.push(`rubric inventory version ${rubric.inventory_version} differs from the pinned inventory ${inventory.inventory_version}`)
  if (!rubric.calibration || typeof rubric.calibration !== 'object') errors.push('rubric must record its calibration evidence')
  for (const field of FORBIDDEN_FIELDS) if (field in rubric) errors.push(`rubric must not declare ${field}`)
  for (const component of rubric.components ?? []) if ('floor' in component) errors.push(`component ${component.id} must not declare a floor`)
  if (rubric.total_points !== 100 || rubric.automated_points !== 70 || rubric.human_points !== 30) errors.push('rubric must award 70 automated and 30 human points of 100')
  const policy = (rubric.components ?? []).map(({ id, points }) => [id, points])
  if (JSON.stringify(policy) !== JSON.stringify(COMPONENT_POLICY)) errors.push('components must use the 20/20/7/7/8/4/4 allocation')
  const limit = rubric.limits?.max_requirement_chars
  if (!Number.isInteger(limit) || limit < 1 || limit >= AND_SCENE_REQUIREMENT_LIMIT) errors.push(`limits.max_requirement_chars must be below ${AND_SCENE_REQUIREMENT_LIMIT}`)
  for (const key of ['calibration_tolerance', 'spread_limit', 'flip_rate_limit']) if (typeof rubric.limits?.[key] !== 'number') errors.push(`limits.${key} must be declared`)
  const gateInputs = new Set((rubric.gates ?? []).flatMap(gate => gate.inputs ?? []))
  let sum = 0
  for (const component of rubric.components ?? []) {
    const weights = component.tier_weights
    if (!weights || typeof weights !== 'object') { errors.push(`component ${component.id} requires tier_weights`); continue }
    for (const [tier, weight] of Object.entries(weights)) {
      if (!TIERS.includes(tier)) errors.push(`component ${component.id} has unknown tier weight ${tier}`)
      else if (typeof weight !== 'number' || weight <= 0) errors.push(`component ${component.id} tier weight ${tier} must be positive`)
      else if (weight > MAX_TIER_WEIGHT) errors.push(`component ${component.id} tier weight ${tier} ${weight} exceeds ${MAX_TIER_WEIGHT}`)
      else if (!Number.isInteger(weight * WEIGHT_UNIT)) errors.push(`component ${component.id} tier weight ${tier} is not a multiple of 1/${WEIGHT_UNIT}`)
    }
    const ladder = TIERS.filter(tier => tier in weights).map(tier => weights[tier])
    if (ladder.some((weight, index) => index > 0 && !(weight < ladder[index - 1]))) errors.push(`component ${component.id} tier weights must decrease strictly from critical to minor`)
    let subtotal = 0
    for (const subcomponent of component.subcomponents ?? []) {
      if (!EVALUATORS.includes(subcomponent.evaluator)) errors.push(`subcomponent ${subcomponent.id} has unknown evaluator ${subcomponent.evaluator}`)
      if (subcomponent.evaluator?.startsWith('llm-') && !JUDGE_JOBS.includes(subcomponent.job)) errors.push(`subcomponent ${subcomponent.id} has unknown judge job ${subcomponent.job}`)
      if (subcomponent.evaluator === 'llm-evidence-review' && !EVIDENCE_JOBS.includes(subcomponent.job)) errors.push(`subcomponent ${subcomponent.id} evidence review needs an evidence job`)
      let criteriaSum = 0
      for (const id of subcomponent.criteria ?? []) {
        const tier = subcomponent.tiers?.[id]
        if (tier === undefined) errors.push(`criterion ${id} has no tier`)
        else if (tier === GATE_INPUT_TIER) { if (!gateInputs.has(id)) errors.push(`criterion ${id} cannot be a gate-input: no gate names it`) }
        else if (!TIERS.includes(tier)) errors.push(`criterion ${id} has unknown tier ${tier}`)
        else if (!(tier in weights)) errors.push(`criterion ${id} tier ${tier} has no weight in component ${component.id}`)
        else criteriaSum += weights[tier]
      }
      if (subcomponent.points !== criteriaSum) errors.push(`subcomponent ${subcomponent.id} points ${subcomponent.points} are not the sum of its criterion weights ${criteriaSum}`)
      subtotal += subcomponent.points ?? 0
    }
    if (subtotal !== component.points) errors.push(`component ${component.id} subcomponent points sum to ${subtotal}, expected ${component.points}`)
    sum += component.points
  }
  if (sum !== rubric.automated_points) errors.push(`component points sum to ${sum}, expected ${rubric.automated_points}`)
  const rows = rubricRows(rubric)
  const seen = new Set()
  for (const row of rows) { if (seen.has(row.id)) errors.push(`duplicate criterion ${row.id}`); seen.add(row.id) }
  const cited = new Set()
  const sources = rubric.criterion_sources ?? {}
  const subjects = [...rows.map(row => ({ id: row.id, kind: 'criterion' })), ...(rubric.gates ?? []).map(gate => ({ id: gate.id, kind: 'gate' }))]
  for (const { id, kind } of subjects) {
    const source = kind === 'gate' ? { owner: 'fixture', inventory: rubric.gates.find(gate => gate.id === id).inventory } : sources[id]
    if (!source) { errors.push(`${kind} ${id} has no requirement source`); continue }
    if (source.owner === 'fixture') {
      if (!Array.isArray(source.inventory) || !source.inventory.length) { errors.push(`fixture-owned ${kind} ${id} cites no inventory item`); continue }
      for (const itemId of source.inventory) {
        const item = items.get(itemId)
        if (!item) errors.push(`${kind} ${id} cites unknown inventory item ${itemId}`)
        else if (!graded(item)) errors.push(`${kind} ${id} cites preference item ${itemId}`)
        else cited.add(itemId)
      }
      if (limit) {
        const text = source.inventory.map(itemId => items.get(itemId)).filter(Boolean).map(requirementDocument).join('\n\n')
        if (text.length > limit) errors.push(`${kind} ${id} requirement text is ${text.length} characters, over the ${limit} limit`)
      }
    } else if (source.owner === 'eval' && kind === 'criterion') {
      if (typeof source.reason !== 'string' || !source.reason.trim()) errors.push(`eval-owned criterion ${id} requires a reason`)
      if (!Array.isArray(source.presumes)) errors.push(`eval-owned criterion ${id} must list the inventory items it presumes`)
      for (const itemId of source.presumes ?? []) {
        const item = items.get(itemId)
        if (!item) errors.push(`eval-owned criterion ${id} presumes unknown inventory item ${itemId}`)
        else if (item.class === 'preference') errors.push(`eval-owned criterion ${id} presumes preference item ${itemId}`)
      }
      if ((source.inventory ?? []).length) errors.push(`eval-owned criterion ${id} must cite no inventory item`)
    } else errors.push(`${kind} ${id} has an invalid requirement source`)
  }
  if ((rubric.gates ?? []).map(gate => gate.id).join() !== GATE_IDS.join()) errors.push(`rubric must declare exactly the gates ${GATE_IDS.join(', ')}`)
  const scope = sources['demo-scope-discipline']
  if (!scope || scope.owner !== 'fixture' || !SCOPE_ITEMS.every(itemId => scope.inventory.includes(itemId))) errors.push(`the scope-discipline criterion must cite ${SCOPE_ITEMS.join(', ')}`)
  const exclusions = rubric.exclusions ?? []
  const excluded = new Set()
  for (const entry of exclusions) {
    const item = items.get(entry.id)
    if (!item) errors.push(`exclusion ${entry.id} is not in the inventory`)
    else if (!graded(item)) errors.push(`exclusion ${entry.id} is a preference item`)
    if (!entry.reason?.trim()) errors.push(`exclusion ${entry.id} requires a reason`)
    if (!entry.approved_by?.trim()) errors.push(`exclusion ${entry.id} requires approved_by`)
    if (excluded.has(entry.id)) errors.push(`exclusion ${entry.id} is listed twice`)
    excluded.add(entry.id)
  }
  for (const item of inventory.items.filter(graded)) {
    if (!cited.has(item.id) && !excluded.has(item.id)) errors.push(`${item.class} item ${item.id} is cited by no criterion or gate and is not excluded`)
  }
  // Browser criteria need a source-review fallback; fallbacks name only browser criteria.
  const browser = new Set(browserCriteria(rubric))
  for (const id of browser) {
    const fallback = rubric.fallbacks?.[id]
    if (!fallback) errors.push(`browser-judge criterion ${id} requires a fallback`)
    else if (!JUDGE_JOBS.includes(fallback.job) || EVIDENCE_JOBS.includes(fallback.job)) errors.push(`fallback ${id} must name a source-review job, not ${fallback.job}`)
    else if (typeof fallback.requirement !== 'string' || !fallback.requirement.trim()) errors.push(`fallback ${id} requires a requirement`)
  }
  for (const id of Object.keys(rubric.fallbacks ?? {})) if (!browser.has(id)) errors.push(`fallback ${id} must name a browser-judge criterion`)
  // Wording: no preference value unless a cited graded item's quote also contains it; traceability of concrete values.
  const evalOwned = new Set((rubric.eval_owned_values ?? []).filter(entry => entry.value && entry.reason?.trim()).map(entry => compact(entry.value)))
  const quotesOf = ids => ids.flatMap(id => (sources[id]?.inventory ?? rubric.gates?.find(gate => gate.id === id)?.inventory ?? [])).map(itemId => items.get(itemId)).filter(Boolean).flatMap(item => [item.statement, ...item.sources.map(source => source.quote)]).map(compact)
  const checkText = (label, text, ids) => {
    const quotes = quotesOf(ids)
    for (const value of preferenceValues) if (normalizeTraceabilityText(text).includes(normalizeTraceabilityText(value)) && !quotes.some(quote => quote.includes(compact(value)))) errors.push(`${label} contains the preference value ${value}`)
    for (const value of valuesIn(text)) if (!quotes.some(quote => quote.includes(compact(value))) && !evalOwned.has(compact(value))) errors.push(`${label} has uncited concrete value ${value}`)
  }
  for (const component of rubric.components ?? []) for (const subcomponent of component.subcomponents ?? []) {
    for (const id of subcomponent.criteria ?? []) if (sources[id]?.owner === 'fixture') checkText(`criterion ${id} id`, id, [id])
    checkText(`subcomponent ${subcomponent.id} guidance`, (subcomponent.review_guidance ?? []).join('\n'), subcomponent.criteria ?? [])
    for (const [id, definition] of Object.entries(subcomponent.criterion_definitions ?? {})) checkText(`criterion ${id} definition`, definition, [id])
  }
  for (const [id, fallback] of Object.entries(rubric.fallbacks ?? {})) checkText(`fallback ${id}`, [fallback.requirement, ...(fallback.guidance ?? [])].join('\n'), [id])
  for (const gate of rubric.gates ?? []) checkText(`gate ${gate.id}`, gate.requirement, [gate.id])
  for (const [id, source] of Object.entries(sources)) if (source.owner === 'eval') checkText(`eval-owned criterion ${id} reason`, source.reason, source.presumes ?? [])
  return errors
}
export async function loadProductInputs({ suiteRoot = SUITE_ROOT, defineRoot = DEFINE_ROOT } = {}) {
  const rubric = await readJson(join(suiteRoot, 'product-rubric.json'))
  const inventory = await readJson(join(defineRoot, 'hidden/inventory.json'))
  const preferences = await readJson(join(suiteRoot, 'preference-values.json'))
  return { rubric, inventory, preferenceValues: preferences.values, preferences }
}
// Every preference value must occur in some preference item's quote; otherwise the list is not grounded in the inventory.
export function checkPreferenceValues({ values, inventory }) {
  const quotes = inventory.items.filter(item => item.class === 'preference').flatMap(item => [item.statement, ...item.sources.map(source => source.quote)]).join('\n')
  return values.filter(value => !quotes.includes(value)).map(value => `preference value ${value} occurs in no preference item's quote`)
}
export async function checkProductInputs(options = {}) {
  const { rubric, inventory, preferenceValues } = await loadProductInputs(options)
  return [...validateProductRubric(rubric, inventory, { preferenceValues }), ...checkPreferenceValues({ values: preferenceValues, inventory })]
}
