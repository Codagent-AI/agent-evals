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

export const EVALUATORS = ['deterministic-browser', 'llm-source-review']
export const JUDGE_JOBS = ['demo-integration', 'scene-kit', 'presentation-skill', 'verification-tooling']

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

// Flatten the rubric into one row per scored criterion. Points are carried at
// the subcomponent level because a row's points are divided equally among its
// criteria and the scorer must not round the intermediate share.
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
          subcomponent_points: subcomponent.points,
          criterion_points: subcomponent.points / subcomponent.criteria.length,
        })
      }
    }
  }
  return rows
}

export function criteriaForJob(rubric, job) {
  return rubricCriteria(rubric).filter((row) => row.job === job).map(({ id }) => id)
}

export function deterministicCriteria(rubric) {
  return rubricCriteria(rubric)
    .filter(({ evaluator }) => evaluator === 'deterministic-browser')
    .map(({ id }) => id)
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
      if (subcomponent.evaluator === 'llm-source-review' && !JUDGE_JOBS.includes(subcomponent.job)) {
        errors.push(`subcomponent ${subcomponent.id} has unknown judge job ${subcomponent.job}`)
      }
      if (!Array.isArray(subcomponent.criteria) || subcomponent.criteria.length === 0) {
        errors.push(`subcomponent ${subcomponent.id} requires criteria`)
      }
    }
  }
  if (automated !== rubric.automated_points) {
    errors.push(`component points sum to ${automated}, expected automated_points ${rubric.automated_points}`)
  }
  if (rubric.automated_points + rubric.human_points !== rubric.total_points) {
    errors.push('automated_points plus human_points must equal total_points')
  }

  const rows = rubricCriteria(rubric)
  const seen = new Set()
  for (const { id } of rows) {
    if (seen.has(id)) errors.push(`duplicate criterion ${id}`)
    seen.add(id)
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
  const removedIds = new Set((rubric.removed ?? []).map(({ id }) => id))
  for (const id of LEGACY_CRITERION_IDS) {
    const dispositions = [seen.has(id), gates.has(id), removedIds.has(id)].filter(Boolean).length
    if (dispositions !== 1) errors.push(`legacy criterion ${id} has ${dispositions} dispositions, expected 1`)
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
