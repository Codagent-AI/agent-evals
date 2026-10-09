// Rubric ownership and provenance.
//
// The suite, not an evaluator, owns criterion identifiers, evaluator
// assignment, point allocation, hard gates, and thresholds. This module loads
// those policies, validates them, and records the version and content hash that
// every result must cite, so a rubric edit is always visible in the record and
// always invalidates a resumed run.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashString } from './persistence.mjs'

const SUITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export const AUTOMATED_RUBRIC_PATH = join(SUITE_DIR, 'automated-rubric.json')
export const HUMAN_RUBRIC_PATH = join(SUITE_DIR, 'human-rubric.json')

export const EVALUATORS = ['deterministic-browser', 'llm-source-review', 'llm-evidence-review']
export const JUDGE_JOBS = [
  'demo-integration',
  'scene-kit',
  'presentation-skill',
  'verification-tooling',
  'engineering-quality',
  'testing-evidence',
  'assumption-handling',
]

export const WORKFLOW_QUALITY_CRITERION_IDS = Object.freeze({
  'testing-evidence': [
    'testing-evidence-traceable-coverage',
    'testing-evidence-usable-proof',
    'testing-evidence-final-revision-applicability',
    'testing-evidence-complete-honest-record',
  ],
  'assumption-handling': [
    'assumption-consequential-ambiguities-surfaced',
    'assumption-repository-facts-distinguished',
    'assumption-decisions-and-escalations-proportionate',
    'assumption-final-handoff-preserves-decisions',
  ],
})

// Engineering quality beyond the spec (issue #77) is fixed input to the
// classification check, like the workflow-quality criteria: every one of these
// is eval-owned, belongs to the engineering-quality component, and is never a
// legacy criterion. The two input-hygiene probes are browser-owned; the rest
// belong to the focused engineering-quality judge. Membership is fixed per
// subcomponent because the engineering-quality spec groups them that way.
export const ENGINEERING_QUALITY_SUBCOMPONENT_CRITERIA = Object.freeze({
  'engineering-input-hygiene': [
    'input-modifier-keys-pass-through',
    'input-swipe-from-control-ignored',
  ],
  'engineering-verification-tooling-robustness': [
    'engineering-preview-terminated-on-every-exit',
    'engineering-preview-readiness-bounded',
    'engineering-bootstrap-scripts-generic',
    'engineering-inspect-fails-loudly',
    'engineering-checks-read-rendered-page',
    'engineering-diagnostics-cover-presentation',
  ],
  'engineering-skill-instructions-and-templates': [
    'engineering-templates-build-at-destination',
    'engineering-skill-description-triggers',
    'engineering-skill-out-of-scope-redirects',
    'engineering-skill-completion-report',
  ],
  'engineering-presentation-code-and-tests': [
    'engineering-presentation-css-scoped',
    'engineering-typed-kit-primitives',
    'engineering-tests-wait-on-state',
    'engineering-tests-isolate-resources',
  ],
})

export const ENGINEERING_QUALITY_CRITERION_IDS = Object.freeze({
  'deterministic-browser': ENGINEERING_QUALITY_SUBCOMPONENT_CRITERIA['engineering-input-hygiene'],
  'engineering-quality': Object.entries(ENGINEERING_QUALITY_SUBCOMPONENT_CRITERIA)
    .filter(([id]) => id !== 'engineering-input-hygiene')
    .flatMap(([, criteria]) => criteria),
})

// Importance tiers, from most to least important. A component weights each
// tier it uses; within it, every criterion of one tier earns the same points.
export const TIERS = ['critical', 'major', 'minor']
// A zero-point gate input is listed and observed like any criterion, so its
// browser observation, fallback judge, and second opinion keep working, but it
// earns no points: it exists only to feed a hard gate.
export const GATE_INPUT_TIER = 'gate-input'
// The only gate inputs: verification-sample-outline is derived from them.
export const OUTLINE_GATE_INPUTS = Object.freeze(['demo-route-and-registration', 'demo-nine-step-content-and-order'])
const MAX_TIER_WEIGHT = 2
// Weights are sixteenths of a point, so every sum is exact in binary floating point.
const WEIGHT_UNIT = 16

const COMPONENT_POLICY = [
  ['demo-technical-quality', 20, 12.5],
  ['scene-kit-correctness', 20, 12.5],
  ['presentation-skill-correctness', 7, null],
  ['verification-tool-correctness', 7, null],
  ['engineering-quality', 8, null],
  ['testing-evidence-quality', 4, null],
  ['assumption-handling-quality', 4, null],
]

// The 68 criterion identifiers the legacy rubric scored. The revised rubric
// must classify every one of them exactly once, so this list is the fixed
// input to that completeness check rather than something derived from the
// rubric it validates.
export const LEGACY_CRITERION_IDS = [
  'scene-step-narration-and-identity',
  'scene-order-derived-numbering',
  'scene-typed-payload-boundary',
  'entity-persisting-morph',
  'entity-newcomer-after-settle',
  'entity-departing-exit',
  'grouped-scene-updates-in-place',
  'grouped-continuing-entities-not-newcomers',
  'grouped-intentional-composition',
  'style-kit-hooks',
  'style-unstyled-kit-output',
  'style-framework-optional',
  'style-coordinate-heavy-diagrams',
  'attribution-default-link',
  'attribution-styling-hook',
  'attribution-top-left-opt-in',
  'mode-present-title-focused',
  'mode-browse-reading-focused',
  'mode-toggle-preserves-position',
  'navigation-keyboard',
  'navigation-touch-swipe',
  'navigation-direct-jump',
  'navigation-active-state',
  'navigation-controls-keep-keys',
  'navigation-clamp-start',
  'navigation-clamp-end',
  'canvas-uniform-scaling',
  'canvas-default-dimensions',
  'skill-missing-details-one-at-a-time',
  'skill-partial-detail-proceeds',
  'skill-complete-prompt-proceeds',
  'skill-optional-ascii-mockup',
  'skill-empty-directory-scaffold',
  'skill-already-scaffolded',
  'skill-partial-scaffold',
  'skill-scaffold-style-neutral',
  'skill-template-path-resolution',
  'skill-monorepo-target',
  'skill-standalone-target',
  'skill-nonempty-confirmation',
  'skill-new-presentation-routed',
  'skill-presentation-owns-style',
  'skill-existing-presentations-preserved',
  'skill-modify-ambiguous-target',
  'skill-scoped-modification',
  'skill-checks-run-before-done',
  'skill-failures-fixed-before-success',
  'quality-builds-clean',
  'quality-renders-without-errors',
  'quality-captions-and-navigation',
  'quality-visual-composition-inspected',
  'quality-project-local-screenshot-helper',
  'quality-visual-warnings-reviewed',
  'quality-active-chrome-and-attribution-local',
  'verification-build-whole-app',
  'verification-sample-outline',
  'verification-missing-sample-fails',
  'verification-every-produced-step-renders',
  'verification-ipv4-loopback',
  'verification-console-page-error-fails',
  'verification-step-error-fails',
  'verification-clear-outcome',
  'visual-helper-captures-steps',
  'visual-helper-settled-screenshots',
  'visual-helper-overlap-warning',
  'visual-helper-allow-overlap',
  'visual-helper-active-state-warning',
  'visual-helper-attribution-warning',
]

// A criterion's points are its component's weight for its tier, whatever its
// subcomponent; a gate input earns none. An untiered criterion has no weight,
// which validation rejects.
export function criterionWeight(component, subcomponent, id) {
  const tier = subcomponent.tiers?.[id] ?? null
  if (tier === GATE_INPUT_TIER) return 0
  return component.tier_weights?.[tier] ?? null
}

// Flatten the rubric into one row per listed criterion, including the
// zero-point gate inputs, with the tier that sets its points.
export function rubricCriteria(rubric) {
  const rows = []
  for (const component of rubric.components ?? []) {
    for (const subcomponent of component.subcomponents ?? []) {
      for (const id of subcomponent.criteria ?? []) {
        rows.push({
          id,
          component: component.id,
          subcomponent: subcomponent.id,
          evaluator: subcomponent.evaluator,
          job: subcomponent.job ?? null,
          tier: subcomponent.tiers?.[id] ?? null,
          subcomponent_points: subcomponent.points,
          criterion_points: criterionWeight(component, subcomponent, id),
        })
      }
    }
  }
  return rows
}

// The tier rules of the product-quality spec: a strictly decreasing ladder of
// positive sixteenths no greater than 2, a tier for every listed criterion, and
// declared points that are exactly the sum of the criteria's weights.
function tierErrors(component) {
  const errors = []
  const weights = component.tier_weights
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    return [`component ${component.id} requires tier_weights`]
  }
  for (const [tier, weight] of Object.entries(weights)) {
    if (!TIERS.includes(tier)) {
      errors.push(`component ${component.id} has unknown tier weight ${tier}`)
    } else if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      errors.push(`component ${component.id} tier weight ${tier} ${weight} must be a positive number`)
    } else if (weight > MAX_TIER_WEIGHT) {
      errors.push(`component ${component.id} tier weight ${tier} ${weight} exceeds ${MAX_TIER_WEIGHT}`)
    } else if (!Number.isInteger(weight * WEIGHT_UNIT)) {
      errors.push(`component ${component.id} tier weight ${tier} ${weight} is not a multiple of 1/${WEIGHT_UNIT}`)
    }
  }
  const ladder = TIERS.filter((tier) => tier in weights).map((tier) => weights[tier])
  if (ladder.some((weight, index) => index > 0 && !(weight < ladder[index - 1]))) {
    errors.push(`component ${component.id} tier weights must decrease strictly from critical to minor`)
  }
  for (const subcomponent of component.subcomponents ?? []) {
    const tiers = subcomponent.tiers
    if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) {
      errors.push(`subcomponent ${subcomponent.id} requires tiers`)
      continue
    }
    const criteria = subcomponent.criteria ?? []
    for (const id of Object.keys(tiers)) {
      if (!criteria.includes(id)) errors.push(`subcomponent ${subcomponent.id} tiers unknown criterion ${id}`)
    }
    let sum = 0
    for (const id of criteria) {
      const tier = tiers[id]
      if (tier === undefined) {
        errors.push(`criterion ${id} has no tier`)
      } else if (tier === GATE_INPUT_TIER) {
        if (!OUTLINE_GATE_INPUTS.includes(id)) errors.push(`criterion ${id} cannot be a gate-input`)
      } else if (!TIERS.includes(tier)) {
        errors.push(`criterion ${id} has unknown tier ${tier}`)
      } else if (!(tier in weights)) {
        errors.push(`criterion ${id} tier ${tier} has no weight in component ${component.id}`)
      } else {
        sum += weights[tier]
      }
      if (OUTLINE_GATE_INPUTS.includes(id) && tier !== GATE_INPUT_TIER) {
        errors.push(`outline input ${id} must be a gate-input`)
      }
    }
    if (subcomponent.points !== sum) {
      errors.push(`subcomponent ${subcomponent.id} points ${subcomponent.points} are not the sum of its criterion weights ${sum}`)
    }
  }
  return errors
}

// Every criterion and gate must say where its requirement comes from. A
// fixture-owned source may carry one citation inline or several under `sources`.
export function requirementSourceIds(rubric) {
  return [...rubricCriteria(rubric).map(({ id }) => id), ...(rubric.gates ?? []).map(({ id }) => id)]
}

export function sourceEntries(source) {
  return Array.isArray(source?.sources) ? source.sources : [source]
}

const filled = (value) => typeof value === 'string' && value.trim().length > 0

export function sourceError(id, source) {
  if (!source || typeof source !== 'object') return `criterion ${id} requires a source`
  if (source.owner === 'eval') {
    return filled(source.reason) ? null : `criterion ${id} eval-owned source requires a reason`
  }
  if (source.owner !== 'fixture') return `criterion ${id} source has unknown owner`
  const citations = sourceEntries(source)
  const complete = citations.length > 0 && citations.every((citation) => (
    filled(citation?.document) && filled(citation?.heading) && filled(citation?.quote)
  ))
  return complete ? null : `criterion ${id} fixture source requires document, heading, and quote`
}

// Criteria whose identifiers alone do not tell a judge what to look for. The
// judge sees each definition beside its identifier, so it cannot substitute
// its own reading, such as coverage of a fixed test-plan inventory.
const DEFINED_CRITERIA_JOBS = ['testing-evidence']

function definitionErrors(subcomponent) {
  const definitions = subcomponent.criterion_definitions
  if (definitions === undefined) return []
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    return [`subcomponent ${subcomponent.id} criterion_definitions must be an object`]
  }
  const errors = []
  const criteria = subcomponent.criteria ?? []
  for (const [id, text] of Object.entries(definitions)) {
    if (!criteria.includes(id)) errors.push(`subcomponent ${subcomponent.id} defines unknown criterion ${id}`)
    else if (!filled(text)) errors.push(`criterion ${id} definition must be non-empty text`)
  }
  for (const id of criteria) {
    if (!(id in definitions)) errors.push(`subcomponent ${subcomponent.id} does not define criterion ${id}`)
  }
  return errors
}

export function criteriaForJob(rubric, job) {
  return rubricCriteria(rubric).filter((row) => row.job === job).map(({ id }) => id)
}

export function deterministicCriteria(rubric) {
  return rubricCriteria(rubric)
    .filter(({ evaluator }) => evaluator === 'deterministic-browser')
    .map(({ id }) => id)
}

export function componentApplicable(component, mode) {
  return mode !== 'reference-baseline' || component.reference_applicable !== false
}

export function validateAutomatedRubric(rubric) {
  const errors = []
  if (typeof rubric?.rubric_id !== 'string' || typeof rubric?.version !== 'string') {
    errors.push('automated rubric requires a string rubric_id and version')
    return errors
  }
  if (!Array.isArray(rubric.components) || rubric.components.length === 0) {
    errors.push('automated rubric requires components')
    return errors
  }

  let automated = 0
  for (const component of rubric.components) {
    if (!Array.isArray(component.subcomponents) || component.subcomponents.length === 0) {
      errors.push(`component ${component.id} requires subcomponents`)
      continue
    }
    const subtotal = component.subcomponents.reduce((sum, { points }) => sum + (points ?? 0), 0)
    if (subtotal !== component.points) {
      errors.push(`component ${component.id} subcomponent points sum to ${subtotal}, expected ${component.points}`)
    }
    automated += component.points
    for (const subcomponent of component.subcomponents) {
      if (!EVALUATORS.includes(subcomponent.evaluator)) {
        errors.push(`subcomponent ${subcomponent.id} has unknown evaluator ${subcomponent.evaluator}`)
      }
      if (subcomponent.evaluator?.startsWith('llm-') && !JUDGE_JOBS.includes(subcomponent.job)) {
        errors.push(`subcomponent ${subcomponent.id} has unknown judge job ${subcomponent.job}`)
      }
      if (!Array.isArray(subcomponent.criteria) || subcomponent.criteria.length === 0) {
        errors.push(`subcomponent ${subcomponent.id} requires criteria`)
      }
      errors.push(...definitionErrors(subcomponent))
    }
    errors.push(...tierErrors(component))
  }
  if (automated !== rubric.automated_points) {
    errors.push(`component points sum to ${automated}, expected automated_points ${rubric.automated_points}`)
  }
  if (rubric.automated_points + rubric.human_points !== rubric.total_points) {
    errors.push('automated_points plus human_points must equal total_points')
  }
  const minimumViableAutomatedScore = rubric.pass_threshold - rubric.human_points
  if (rubric.automated_pass_threshold !== minimumViableAutomatedScore) {
    errors.push(
      `automated_pass_threshold must be ${minimumViableAutomatedScore}, the minimum score that can reach pass_threshold with maximum human points`,
    )
  }
  const componentPolicy = rubric.components.map(({ id, points, floor = null }) => [id, points, floor])
  if (JSON.stringify(componentPolicy) !== JSON.stringify(COMPONENT_POLICY)) {
    errors.push('components must use the approved 20/20/7/7/8/4/4 allocation and floors')
  }
  const referencePoints = rubric.components
    .filter((component) => componentApplicable(component, 'reference-baseline'))
    .reduce((sum, { points }) => sum + points, 0)
  if (referencePoints !== 62) errors.push(`reference automated points sum to ${referencePoints}, expected 62`)

  const rows = rubricCriteria(rubric)
  const seen = new Set()
  for (const { id } of rows) {
    if (seen.has(id)) errors.push(`duplicate criterion ${id}`)
    seen.add(id)
  }
  for (const id of requirementSourceIds(rubric)) {
    const error = sourceError(id, rubric.criterion_sources?.[id])
    if (error) errors.push(error)
  }
  const deterministic = new Set(rows.filter(({ evaluator }) => evaluator === 'deterministic-browser').map(({ id }) => id))
  for (const id of deterministic) {
    if (!rubric.fallbacks?.[id]) errors.push(`deterministic-browser criterion ${id} requires a fallback`)
  }
  for (const [id, fallback] of Object.entries(rubric.fallbacks ?? {})) {
    if (!deterministic.has(id)) errors.push(`fallback ${id} must name a deterministic-browser criterion`)
    if (!JUDGE_JOBS.includes(fallback?.job)) errors.push(`fallback ${id} has unknown judge job ${fallback?.job}`)
    if (typeof fallback?.requirement !== 'string' || fallback.requirement.trim().length === 0) {
      errors.push(`fallback ${id} requires a requirement`)
    }
  }
  // A gate must never also award points, or one baseline outcome would be
  // counted twice.
  for (const gate of rubric.gates ?? []) {
    if (seen.has(gate.id)) errors.push(`gate ${gate.id} is also a scored criterion`)
  }
  for (const removed of rubric.removed ?? []) {
    if (seen.has(removed.id)) errors.push(`removed criterion ${removed.id} is also scored`)
    if (typeof removed.reason !== 'string' || removed.reason.length === 0) {
      errors.push(`removed criterion ${removed.id} requires a reason`)
    }
  }

  // Every legacy criterion must be scored, gated, or explicitly removed.
  const gates = new Set((rubric.gates ?? []).map(({ id }) => id))
  const replacedIds = new Set((rubric.replaced ?? []).map(({ id }) => id))
  const removedIds = new Set((rubric.removed ?? []).map(({ id }) => id))
  if (gates.size !== 4) errors.push(`rubric requires exactly 4 hard gates, found ${gates.size}`)
  if (replacedIds.size !== 2) errors.push(`rubric requires exactly 2 replaced criteria, found ${replacedIds.size}`)
  if (removedIds.size !== 3) errors.push(`rubric requires exactly 3 removed criteria, found ${removedIds.size}`)
  for (const id of LEGACY_CRITERION_IDS) {
    const dispositions = [seen.has(id), gates.has(id), replacedIds.has(id), removedIds.has(id)].filter(Boolean).length
    if (dispositions !== 1) errors.push(`legacy criterion ${id} has ${dispositions} dispositions, expected 1`)
  }
  const legacyScored = LEGACY_CRITERION_IDS.filter((id) => seen.has(id)).length
  if (legacyScored !== 59) errors.push(`rubric directly scores ${legacyScored} legacy criteria, expected 59`)
  for (const replaced of rubric.replaced ?? []) {
    if (seen.has(replaced.id)) errors.push(`replaced criterion ${replaced.id} is also scored`)
    if (typeof replaced.reason !== 'string' || replaced.reason.length === 0) {
      errors.push(`replaced criterion ${replaced.id} requires a reason`)
    }
  }
  for (const [job, expected] of Object.entries(WORKFLOW_QUALITY_CRITERION_IDS)) {
    const actual = criteriaForJob(rubric, job)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${job} must own exactly its four approved workflow-quality criteria`)
    }
  }
  const engineeringRows = rows.filter(({ component }) => component === 'engineering-quality')
  const engineeringOwners = (evaluatorOrJob) => engineeringRows
    .filter(({ evaluator, job }) => (job ?? evaluator) === evaluatorOrJob)
    .map(({ id }) => id)
  if (
    JSON.stringify(engineeringOwners('deterministic-browser')) !== JSON.stringify(ENGINEERING_QUALITY_CRITERION_IDS['deterministic-browser'])
    || JSON.stringify(engineeringOwners('engineering-quality')) !== JSON.stringify(ENGINEERING_QUALITY_CRITERION_IDS['engineering-quality'])
    || JSON.stringify(criteriaForJob(rubric, 'engineering-quality')) !== JSON.stringify(ENGINEERING_QUALITY_CRITERION_IDS['engineering-quality'])
    || engineeringRows.length !== Object.values(ENGINEERING_QUALITY_CRITERION_IDS).flat().length
  ) {
    errors.push('engineering-quality must own exactly its approved criteria')
  }
  const engineeringSubcomponents = rubric.components
    .filter(({ id }) => id === 'engineering-quality')
    .flatMap(({ subcomponents = [] }) => subcomponents)
  const approvedSubcomponents = Object.keys(ENGINEERING_QUALITY_SUBCOMPONENT_CRITERIA)
  if (JSON.stringify(engineeringSubcomponents.map(({ id }) => id)) !== JSON.stringify(approvedSubcomponents)) {
    errors.push(`engineering-quality must have exactly its approved subcomponents ${approvedSubcomponents.join(', ')}`)
  }
  for (const subcomponent of engineeringSubcomponents) {
    const approved = ENGINEERING_QUALITY_SUBCOMPONENT_CRITERIA[subcomponent.id]
    if (approved && JSON.stringify(subcomponent.criteria) !== JSON.stringify(approved)) {
      errors.push(`subcomponent ${subcomponent.id} must own exactly its approved engineering-quality criteria`)
    }
  }
  // Judges and second-opinion verifiers read an eval-owned reason as the
  // criterion's requirement, so none of these may trace to the fixture.
  for (const id of Object.values(ENGINEERING_QUALITY_CRITERION_IDS).flat()) {
    if (rubric.criterion_sources?.[id] && rubric.criterion_sources[id].owner !== 'eval') {
      errors.push(`criterion ${id} must be eval-owned`)
    }
  }
  for (const job of DEFINED_CRITERIA_JOBS) {
    for (const subcomponent of rubric.components.flatMap(({ subcomponents = [] }) => subcomponents)) {
      if (subcomponent.job === job && subcomponent.criterion_definitions === undefined) {
        errors.push(`subcomponent ${subcomponent.id} must define every ${job} criterion for its judge`)
      }
    }
  }
  return errors
}

export function validateHumanRubric(rubric) {
  const errors = []
  if (typeof rubric?.rubric_id !== 'string' || typeof rubric?.version !== 'string') {
    errors.push('human rubric requires a string rubric_id and version')
    return errors
  }
  if (!Number.isFinite(rubric.points) || rubric.points <= 0) errors.push('human rubric requires positive points')
  if (!Number.isFinite(rubric.floor) || rubric.floor < 0) errors.push('human rubric requires a floor')
  if (!Number.isInteger(rubric.question_count) || rubric.question_count <= 0) {
    errors.push('human rubric requires a positive question_count')
  }
  const scale = rubric.rating_scale
  if (!Number.isInteger(scale?.min) || !Number.isInteger(scale?.max) || scale.min >= scale.max) {
    errors.push('human rubric requires an integer rating_scale with min < max')
  }
  if (!Number.isInteger(rubric.min_individual_rating)) {
    errors.push('human rubric requires an integer min_individual_rating')
  }

  // The question set, its anchors, and the dimension weights are what the
  // reviewer is actually asked and what their answers are worth, so they are
  // validated here rather than trusted by the interview.
  const dimensions = Array.isArray(rubric.dimensions) ? rubric.dimensions : []
  const questions = Array.isArray(rubric.questions) ? rubric.questions : []
  const dimensionPoints = dimensions.reduce((sum, { points }) => sum + (points ?? 0), 0)
  if (dimensions.length === 0) errors.push('human rubric requires dimensions')
  else if (dimensionPoints !== rubric.points) {
    errors.push(`human rubric dimension points sum to ${dimensionPoints}, expected points ${rubric.points}`)
  }

  if (questions.length !== rubric.question_count) {
    errors.push(`human rubric declares question_count ${rubric.question_count} but defines ${questions.length} questions`)
  }
  const numbers = questions.map(({ number }) => number)
  if (numbers.some((number, index) => number !== index + 1)) {
    errors.push(`human rubric questions must be numbered 1 through ${questions.length} in order`)
  }
  const ids = new Set()
  const known = new Set(dimensions.map(({ id }) => id))
  const covered = new Set()
  const scaleRatings = scale && Number.isInteger(scale.min) && Number.isInteger(scale.max)
    ? Array.from({ length: scale.max - scale.min + 1 }, (_, index) => scale.min + index)
    : []
  for (const question of questions) {
    if (typeof question.id !== 'string' || question.id.length === 0) {
      errors.push('every human rubric question requires an id')
      continue
    }
    if (ids.has(question.id)) errors.push(`duplicate human rubric question ${question.id}`)
    ids.add(question.id)
    if (typeof question.text !== 'string' || question.text.trim().length === 0) {
      errors.push(`human rubric question ${question.id} requires text`)
    }
    if (!known.has(question.dimension)) {
      errors.push(`human rubric question ${question.id} has unknown dimension ${question.dimension}`)
    }
    const ratingOptions = Array.isArray(question.rating_options) ? question.rating_options : []
    const optionRatings = ratingOptions.map(({ rating }) => rating)
    if (
      optionRatings.length !== scaleRatings.length
      || scaleRatings.some((rating, index) => optionRatings[index] !== rating)
    ) {
      errors.push(
        `human rubric question ${question.id} requires one rating option for each rating ${scale?.min} through ${scale?.max}`,
      )
    } else {
      for (const { rating, label, description } of ratingOptions) {
        if (typeof label !== 'string' || label.trim().length === 0) {
          errors.push(`human rubric question ${question.id} rating option ${rating} requires a label`)
        }
        if (typeof description !== 'string' || description.trim().length === 0) {
          errors.push(`human rubric question ${question.id} rating option ${rating} requires a description`)
        }
      }
    }
    covered.add(question.dimension)
  }
  // An uncovered dimension would silently withhold its points from every
  // possible review.
  for (const { id } of dimensions) {
    if (!covered.has(id)) errors.push(`human rubric dimension ${id} has no questions`)
  }

  if (scale && Number.isInteger(scale.min) && Number.isInteger(scale.max)) {
    const ratings = scaleRatings
    const anchored = (rubric.anchors ?? []).map(({ rating }) => rating)
    if (anchored.length !== ratings.length || ratings.some((rating, index) => anchored[index] !== rating)) {
      errors.push(`human rubric requires one anchor for each of the ratings ${scale.min} through ${scale.max}`)
    }
    for (const { rating, anchor } of rubric.anchors ?? []) {
      if (typeof anchor !== 'string' || anchor.trim().length === 0) {
        errors.push(`human rubric anchor ${rating} requires text`)
      }
    }
  }

  if (!Number.isInteger(rubric.rationale_required_at_or_below)) {
    errors.push('human rubric requires an integer rationale_required_at_or_below')
  }
  return errors
}

async function loadRubric(path, validate) {
  const raw = await readFile(path)
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`)
  }
  const errors = validate(parsed)
  if (errors.length > 0) throw new Error(`${path} is invalid: ${errors.join('; ')}`)
  return {
    rubric_id: parsed.rubric_id,
    version: parsed.version,
    // Hash the exact bytes on disk so provenance covers formatting as well as
    // values; a resumed run must reject any edit at all.
    sha256: hashString(raw),
    path,
    rubric: parsed,
  }
}

export async function loadRubrics({
  automatedPath = AUTOMATED_RUBRIC_PATH,
  humanPath = HUMAN_RUBRIC_PATH,
} = {}) {
  const automated = await loadRubric(automatedPath, validateAutomatedRubric)
  const human = await loadRubric(humanPath, validateHumanRubric)
  if (automated.rubric_id === human.rubric_id) {
    throw new Error('the automated and human rubrics must have distinct rubric_id values')
  }
  return { automated, human }
}

// The compact provenance block recorded in every result and checkpoint.
export function rubricProvenance({ automated, human }) {
  return {
    automated: { rubric_id: automated.rubric_id, version: automated.version, sha256: automated.sha256 },
    human: { rubric_id: human.rubric_id, version: human.version, sha256: human.sha256 },
  }
}
