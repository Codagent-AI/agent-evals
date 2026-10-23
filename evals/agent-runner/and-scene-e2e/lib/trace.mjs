// The non-scoring requirement trace: per graded hidden requirement, whether the agent asked, whether the
// collected definition covers it, and whether the delivered product delivers it.
import { graded } from './product-rubric.mjs'
export const OUTCOMES = ['delivered', 'partially-delivered', 'not-discovered', 'discovered-not-defined', 'defined-not-delivered', 'not-graded-in-product', 'delivery-unavailable']
const covered = verdict => verdict === 'met' || verdict === 'partial'
// product: the product score ({components}) or null when no product was delivered or scored.
export function buildTrace({ inventory, rubric, asked, coverage, product, gates = [] }) {
  const askedBy = new Map(asked.map(entry => [entry.id, entry]))
  const coverageBy = new Map(coverage.map(entry => [entry.id, entry]))
  const verdictOf = new Map()
  if (product) for (const component of product.components) for (const subcomponent of component.subcomponents) for (const criterion of subcomponent.criteria) verdictOf.set(criterion.id, criterion.verdict)
  // A gate that cites an item grades it like a criterion: it passes or it does not.
  if (product) for (const gate of rubric.gates ?? []) { const outcome = gates.find(entry => entry.id === gate.id); if (outcome) verdictOf.set(gate.id, outcome.passed ? 'pass' : 'fail') }
  const mapped = new Map()
  for (const [criterion, source] of Object.entries(rubric.criterion_sources)) for (const item of source.inventory ?? []) mapped.set(item, [...(mapped.get(item) ?? []), criterion])
  for (const gate of rubric.gates ?? []) for (const item of gate.inventory) mapped.set(item, [...(mapped.get(item) ?? []), gate.id])
  const itemsOfCriterion = new Map()
  for (const [item, criteria] of mapped) for (const criterion of criteria) itemsOfCriterion.set(criterion, [...(itemsOfCriterion.get(criterion) ?? []), item])
  const items = inventory.items.filter(graded).map(item => {
    const decision = askedBy.get(item.id); const cover = coverageBy.get(item.id)
    const criteria = mapped.get(item.id) ?? []
    const observed = criteria.map(id => verdictOf.get(id)).filter(Boolean)
    // Delivery follows the mapped criteria alone, never a further judgment; an empty mapping is never a vacuous pass.
    const delivery = !product ? 'unavailable' : !criteria.length ? 'not-graded' : !observed.length ? 'unavailable' : observed.every(verdict => verdict === 'pass') && observed.length === criteria.length ? 'delivered' : observed.some(verdict => verdict === 'pass') ? 'partly-delivered' : 'not-delivered'
    const verdict = cover?.verdict ?? 'missing'
    let outcome
    if (!covered(verdict)) outcome = decision?.asked ? 'discovered-not-defined' : 'not-discovered'
    else if (delivery === 'unavailable') outcome = 'delivery-unavailable'
    else if (delivery === 'not-graded') outcome = 'not-graded-in-product'
    else outcome = { delivered: 'delivered', 'partly-delivered': 'partially-delivered', 'not-delivered': 'defined-not-delivered' }[delivery]
    const shared = criteria.filter(id => itemsOfCriterion.get(id).length > 1).map(id => ({ criterion: id, shared_with: itemsOfCriterion.get(id).filter(other => other !== item.id) }))
    return { id: item.id, class: item.class, title: item.title, asked: Boolean(decision?.asked), exchange_citations: decision?.asked ? decision.citations ?? [] : [], coverage_verdict: verdict, product_delivery: delivery, mapped_criteria: criteria, shared_criteria: shared, outcome }
  })
  const counts = Object.fromEntries(OUTCOMES.map(outcome => [outcome, items.filter(item => item.outcome === outcome).length]))
  return { scoring: false, counts, items }
}
