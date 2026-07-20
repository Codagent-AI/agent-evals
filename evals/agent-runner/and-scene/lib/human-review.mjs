// The literal human review: question set, anchored responses, and the 30-point
// calculation.
//
// The rubric owns the questions, anchors, and point allocation; this module owns
// the review *state* — what has been answered, whether the saved answers still
// belong to the candidate and rubric being reviewed, and what they score. The
// interview itself talks to an injected `io`, so the whole 13-question flow,
// including rejection, resume, and revision, runs noninteractively in a test.
//
// Nothing here rounds an intermediate value and nothing here scores a partial
// review: an unfinished review has no total and no gate result, so an
// interrupted reviewer never becomes a product failure.

export const HUMAN_REVIEW_SCHEMA_VERSION = 1

const AFFIRMATIVE = new Set(['y', 'yes', 'ready', 'ok'])

export function questionById(rubric, id) {
  return rubric.questions.find((question) => question.id === id) ?? null
}

export function validateResponse(rubric, { rating, rationale }) {
  const { min, max } = rubric.rating_scale
  if (!Number.isInteger(rating) || rating < min || rating > max) {
    return { ok: false, error: `A rating must be a whole number from ${min} through ${max}.` }
  }
  if (rating <= rubric.rationale_required_at_or_below && String(rationale ?? '').trim().length === 0) {
    return {
      ok: false,
      error: `A rating of ${rubric.rationale_required_at_or_below} or lower requires a rationale.`,
    }
  }
  return { ok: true, error: null }
}

export function createReviewState({ candidate, rubric }) {
  return {
    schema_version: HUMAN_REVIEW_SCHEMA_VERSION,
    candidate: { ...candidate },
    rubric: { ...rubric },
    readiness_confirmed: false,
    responses: [],
    score: null,
    complete: false,
    completed_at: null,
  }
}

// A saved review is only reusable for the same candidate revision and the same
// human rubric bytes. Anything else would silently blend two different reviews.
export function checkReviewProvenance(state, { candidate, rubric }) {
  const pairs = [
    ['candidate_identity', state.candidate?.candidate_identity, candidate?.candidate_identity],
    ['rubric_id', state.rubric?.rubric_id, rubric?.rubric_id],
    ['rubric_version', state.rubric?.version, rubric?.version],
    ['rubric_sha256', state.rubric?.sha256, rubric?.sha256],
  ]
  return pairs.flatMap(([field, recorded, current]) => (
    recorded === current ? [] : [{ field, recorded: recorded ?? null, current: current ?? null }]
  ))
}

export function recordResponse(rubric, state, { id, rating, rationale }) {
  const question = questionById(rubric, id)
  if (!question) throw new Error(`unknown human-review question: ${id}`)
  const stored = {
    id: question.id,
    number: question.number,
    dimension: question.dimension,
    question_text: question.text,
    rating,
    rationale: String(rationale ?? '').trim(),
  }
  const responses = [...state.responses]
  const existing = responses.findIndex((response) => response.id === id)
  if (existing === -1) responses.push(stored)
  else responses[existing] = stored
  // Order by the rubric so a revised or out-of-order answer still reads as the
  // versioned sequence.
  responses.sort((a, b) => a.number - b.number)
  return { ...state, responses }
}

export function firstUnanswered(rubric, state) {
  const answered = new Set(state.responses.map(({ id }) => id))
  return rubric.questions.find((question) => !answered.has(question.id)) ?? null
}

function dimensionRatings(rubric, responses) {
  const byId = new Map(responses.map((response) => [response.id, response]))
  return rubric.dimensions.map((dimension) => ({
    dimension,
    ratings: rubric.questions
      .filter((question) => question.dimension === dimension.id)
      .map((question) => byId.get(question.id)?.rating ?? null),
  }))
}

// Every subtotal is a multiple of 1/(4 * questionCount), so the whole
// calculation is carried over one integer denominator and divided exactly once.
// Summing the fractions directly would leave an all-fives review just short of
// its 30 points.
function subtotalNumerator({ dimension, ratings }, scale) {
  const span = scale.max - scale.min
  const earned = ratings.reduce((sum, rating) => sum + (rating - scale.min), 0)
  return { numerator: earned * dimension.points, denominator: span * ratings.length }
}

export function scoreHumanReview(rubric, state) {
  const responses = state.responses ?? []
  const grouped = dimensionRatings(rubric, responses)
  const complete = responses.length === rubric.question_count
    && grouped.every(({ ratings }) => ratings.every((rating) => Number.isInteger(rating)))

  if (!complete) {
    return {
      complete: false,
      subtotals: grouped.map(({ dimension }) => ({
        id: dimension.id, title: dimension.title, points: null, points_possible: dimension.points,
      })),
      total: null,
      possible: rubric.points,
      floor: rubric.floor,
      lowest_rating: responses.length > 0 ? Math.min(...responses.map(({ rating }) => rating)) : null,
      gate_passed: null,
      gate_failures: [],
    }
  }

  const fractions = grouped.map((group) => ({ group, ...subtotalNumerator(group, rubric.rating_scale) }))
  const denominator = fractions.reduce((product, { denominator: value }) => lcm(product, value), 1)
  const subtotals = fractions.map(({ group, numerator, denominator: own }) => ({
    id: group.dimension.id,
    title: group.dimension.title,
    points: numerator * (denominator / own) / denominator,
    points_possible: group.dimension.points,
    ratings: group.ratings,
  }))
  const total = fractions.reduce(
    (sum, { numerator, denominator: own }) => sum + numerator * (denominator / own),
    0,
  ) / denominator

  const lowest = Math.min(...responses.map(({ rating }) => rating))
  const failures = []
  if (total < rubric.floor) {
    failures.push({ rule: 'human-floor', value: total, required: rubric.floor })
  }
  if (lowest < rubric.min_individual_rating) {
    failures.push({ rule: 'human-rating-one', value: lowest, required: rubric.min_individual_rating })
  }

  return {
    complete: true,
    subtotals,
    total,
    possible: rubric.points,
    floor: rubric.floor,
    lowest_rating: lowest,
    gate_passed: failures.length === 0,
    gate_failures: failures,
  }
}

function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

function lcm(a, b) {
  return a / gcd(a, b) * b
}

function formatPoints(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function renderSummary(rubric, score, responses) {
  const lines = ['', 'Human review summary', '--------------------']
  for (const response of responses) {
    lines.push(`${response.number}. [${response.rating}/5] ${response.question_text}`)
    if (response.rationale) lines.push(`   rationale: ${response.rationale}`)
  }
  lines.push('')
  for (const subtotal of score.subtotals) {
    lines.push(`${subtotal.title}: ${formatPoints(subtotal.points)} / ${subtotal.points_possible}`)
  }
  lines.push(`Total: ${formatPoints(score.total)} / ${score.possible}`)
  lines.push(`Human-review component gate: ${score.gate_passed ? 'pass' : 'fail'}`)
  for (const failure of score.gate_failures) {
    lines.push(`  ${failure.rule}: ${formatPoints(failure.value)} (requires ${failure.required})`)
  }
  return lines.join('\n')
}

function anchorBlock(rubric) {
  return rubric.anchors.map(({ rating, anchor }) => `  ${rating} — ${anchor}`).join('\n')
}

// A closed input stream is an interruption, not an answer. It ends the review
// where it stands with every saved answer intact.
const INTERRUPTED = Symbol('interrupted')

async function askQuestion({ rubric, question, io }) {
  for (;;) {
    io.write(`\nQuestion ${question.number} of ${rubric.question_count}\n${question.text}`)
    io.write(anchorBlock(rubric))
    const raw = await io.ask(`Rating (${rubric.rating_scale.min}-${rubric.rating_scale.max}): `)
    if (raw === null || raw === undefined) return INTERRUPTED
    const rationale = await io.ask('Rationale (required for 3 or lower): ')
    if (rationale === null || rationale === undefined) return INTERRUPTED
    // Parse strictly: "4x" or "4.5" is a typo, not a rating.
    const trimmed = String(raw).trim()
    const rating = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
    const outcome = validateResponse(rubric, { rating, rationale })
    if (outcome.ok) return { id: question.id, rating, rationale }
    io.write(`Rejected: ${outcome.error}`)
  }
}

// Drive the whole review: readiness, the ordered questions, and the summary
// confirmation loop. `persist` is awaited after every accepted answer, so an
// interruption at any point loses at most the answer being typed.
export async function runInterview({ rubric, state, candidateUrl, io, persist }) {
  let current = state

  if (!current.readiness_confirmed) {
    io.write(`\nThe evaluated candidate is served at ${candidateUrl}`)
    io.write('Open it, look through the presentation, and confirm when you are ready to rate it.')
    for (;;) {
      const raw = await io.ask('Ready to begin? (yes) ')
      if (raw === null || raw === undefined) {
        return { confirmed: false, interrupted: true, state: current, score: scoreHumanReview(rubric, current) }
      }
      if (AFFIRMATIVE.has(String(raw).trim().toLowerCase())) break
      io.write('Answer yes when the candidate is open and you are ready. This answer is not scored.')
    }
    // Readiness is a handshake, never a rating: it is recorded but scores nothing.
    current = { ...current, readiness_confirmed: true }
  }

  for (;;) {
    const question = firstUnanswered(rubric, current)
    if (!question) break
    const response = await askQuestion({ rubric, question, io })
    if (response === INTERRUPTED) {
      return { confirmed: false, interrupted: true, state: current, score: scoreHumanReview(rubric, current) }
    }
    current = recordResponse(rubric, current, response)
    await persist(current)
  }

  for (;;) {
    const score = scoreHumanReview(rubric, current)
    io.write(renderSummary(rubric, score, current.responses))
    const raw = await io.ask('Confirm this review, revise an answer, or quit? (confirm/revise/quit) ')
    if (raw === null || raw === undefined) {
      return { confirmed: false, interrupted: true, state: current, score }
    }
    const answer = String(raw).trim().toLowerCase()

    if (answer === 'confirm') {
      current = {
        ...current,
        score,
        complete: true,
        completed_at: new Date().toISOString(),
      }
      await persist(current)
      return { confirmed: true, interrupted: false, state: current, score }
    }
    if (answer !== 'revise') {
      // Anything but an explicit confirmation leaves the review unfinished, and
      // the run stays pending human review.
      return { confirmed: false, interrupted: false, state: current, score }
    }

    const chosen = await io.ask(`Which question? (1-${rubric.question_count}) `)
    if (chosen === null || chosen === undefined) {
      return { confirmed: false, interrupted: true, state: current, score }
    }
    const question = rubric.questions.find(({ number }) => String(number) === String(chosen).trim())
    if (!question) {
      io.write(`Rejected: choose a question number from 1 through ${rubric.question_count}.`)
      continue
    }
    const response = await askQuestion({ rubric, question, io })
    if (response === INTERRUPTED) {
      return { confirmed: false, interrupted: true, state: current, score }
    }
    current = recordResponse(rubric, current, response)
    await persist(current)
  }
}
