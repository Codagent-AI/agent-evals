// Reference-baseline comparison.
//
// A baseline is only useful as a comparison when it answers the same questions:
// the same automated and human rubrics, at the same versions, with the same
// bytes. Anything else would present two different measurements as a delta, so
// this module refuses the comparison and says why instead.
//
// A reference baseline has no Agent Runner behind it, so its roles, cost, and
// timing are *not applicable*. They are reported as such and never subtracted
// from the candidate's as if they were zero.

export const BASELINE_NOT_APPLICABLE = ['agent_roles', 'implementation_cost', 'implementation_timing']
export const SHARED_COMPONENT_IDS = [
  'demo-technical-quality',
  'scene-kit-correctness',
  'presentation-skill-correctness',
  'verification-tool-correctness',
]
export const SHARED_SCORE_DENOMINATOR = 92

function refuse(reason) {
  return {
    comparable: false,
    reason,
    baseline_run_id: null,
    denominator: null,
    totals: null,
    components: [],
    subcomponents: [],
    gates: [],
    human_review: null,
    implementation_cost: null,
    not_applicable: BASELINE_NOT_APPLICABLE,
  }
}

function rubricMismatch(candidate, baseline) {
  for (const [kind, label] of [['automated', 'automated'], ['human', 'human']]) {
    const left = candidate?.rubrics?.[kind]
    const right = baseline?.rubrics?.[kind]
    if (left?.rubric_id !== right?.rubric_id) {
      return `${label} rubric identifier differs: candidate ${left?.rubric_id ?? 'unknown'}, baseline ${right?.rubric_id ?? 'unknown'}`
    }
    if (left?.version !== right?.version) {
      return `${label} rubric version differs: candidate ${left?.version ?? 'unknown'}, baseline ${right?.version ?? 'unknown'}`
    }
    if (left?.sha256 !== right?.sha256) {
      return `${label} rubric hash differs between the candidate and the baseline`
    }
  }
  return null
}

function sharedComponentsOf(result) {
  const indexed = new Map((result?.score?.components ?? []).map((component) => [component.id, component]))
  return SHARED_COMPONENT_IDS.map((id) => indexed.get(id)).filter(Boolean)
}

function subcomponentsOf(result) {
  return sharedComponentsOf(result).flatMap((component) => component.subcomponents ?? [])
}

function pair(left, right) {
  const delta = Number.isFinite(left) && Number.isFinite(right)
    ? Math.round((right - left) * 1e12) / 1e12
    : null
  return { baseline: left ?? null, candidate: right ?? null, delta }
}

function align(baselineRows, candidateRows) {
  const indexed = new Map(candidateRows.map((row) => [row.id, row]))
  return baselineRows
    .filter((row) => indexed.has(row.id))
    .map((row) => {
      const candidate = indexed.get(row.id)
      return {
        id: row.id,
        title: row.title ?? candidate.title ?? null,
        points_possible: row.points_possible ?? candidate.points_possible ?? null,
        ...pair(row.points_awarded, candidate.points_awarded),
      }
    })
}

export function compareToBaseline({ candidate, baseline }) {
  if (!baseline) return refuse('no reference baseline was provided')

  const mismatch = rubricMismatch(candidate, baseline)
  if (mismatch) return refuse(mismatch)

  for (const [label, result] of [['baseline', baseline], ['candidate', candidate]]) {
    if (!Number.isFinite(result?.official_score)) {
      return refuse(`the ${label} has no official score to compare`)
    }
    const components = sharedComponentsOf(result)
    if (components.length !== SHARED_COMPONENT_IDS.length
      || components.some(({ applicable, points_awarded }) => applicable === false || !Number.isFinite(points_awarded))) {
      return refuse(`the ${label} does not have complete shared component scores`)
    }
    const human = result?.score?.human_review
    const humanPoints = human?.points_awarded ?? human?.points
    if (!Number.isFinite(humanPoints)) return refuse(`the ${label} has no complete shared human review`)
  }

  const baselineShared = sharedComponentsOf(baseline)
  const candidateShared = sharedComponentsOf(candidate)
  const humanPoints = (result) => (
    result?.score?.human_review?.points_awarded ?? result?.score?.human_review?.points
  )
  const sharedTotal = (result) => (
    sharedComponentsOf(result).reduce((sum, { points_awarded: points }) => sum + points, 0)
      + humanPoints(result)
  )

  return {
    comparable: true,
    reason: null,
    baseline_run_id: baseline.run_id ?? null,
    baseline_mode: baseline.mode ?? null,
    denominator: SHARED_SCORE_DENOMINATOR,
    totals: pair(sharedTotal(baseline), sharedTotal(candidate)),
    components: align(baselineShared, candidateShared),
    subcomponents: align(subcomponentsOf(baseline), subcomponentsOf(candidate)),
    gates: (baseline.score?.gates ?? []).flatMap((gate) => {
      const match = (candidate.score?.gates ?? []).find(({ id }) => id === gate.id)
      if (!match) return []
      return [{
        id: gate.id,
        baseline: gate.verdict ?? null,
        candidate: match.verdict ?? null,
        changed: gate.verdict !== match.verdict,
      }]
    }),
    human_review: pair(humanPoints(baseline), humanPoints(candidate)),
    // The baseline side stays null and the delta stays null: a reference
    // baseline that never ran Agent Runner did not cost zero dollars.
    implementation_cost: pair(
      baseline.cost?.implementation?.total_usd ?? null,
      candidate.cost?.implementation?.total_usd ?? null,
    ),
    not_applicable: BASELINE_NOT_APPLICABLE,
  }
}
