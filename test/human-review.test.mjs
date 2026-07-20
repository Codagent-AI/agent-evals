import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HUMAN_REVIEW_SCHEMA_VERSION,
  checkReviewProvenance,
  createReviewState,
  firstUnanswered,
  recordResponse,
  runInterview,
  scoreHumanReview,
  validateResponse,
} from '../evals/agent-runner/and-scene/lib/human-review.mjs'
import { loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'

const { human } = await loadRubrics()
const rubric = human.rubric

const CANDIDATE = { candidate_identity: 'candidate-abc', run_id: 'run-1' }

function provenance() {
  return { candidate: CANDIDATE, rubric: { rubric_id: human.rubric_id, version: human.version, sha256: human.sha256 } }
}

function answers(ratings) {
  return ratings.map((rating, index) => ({
    id: rubric.questions[index].id,
    rating,
    rationale: rating <= 3 ? 'needs work' : '',
  }))
}

function fill(state, ratings) {
  return answers(ratings).reduce((current, response) => recordResponse(rubric, current, response), state)
}

// --- The versioned question set -------------------------------------------

test('the v1 rubric asks exactly the 13 versioned questions in order', () => {
  assert.equal(rubric.questions.length, 13)
  assert.deepEqual(rubric.questions.map(({ number }) => number), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  ])
  assert.match(rubric.questions[0].text, /^Rate step 1, "You have a topic\."/)
  assert.match(rubric.questions[8].text, /^Rate step 9, "You're looking at one\."/)
  assert.match(rubric.questions[9].text, /readability and visual hierarchy/)
  assert.match(rubric.questions[10].text, /navigation and interaction usability/)
  assert.match(rubric.questions[11].text, /responsive visual quality/)
  assert.match(rubric.questions[12].text, /overall cohesion and polish/)
})

test('question 1 asks about entrance rather than an incoming transition', () => {
  const first = rubric.questions[0]
  assert.match(first.text, /initial composition and entrance/)
  assert.doesNotMatch(first.text, /from the previous step/)
})

test('questions 2 through 9 ask about the transition from the previous step', () => {
  for (const question of rubric.questions.slice(1, 9)) {
    assert.match(question.text, /the transition into it from the previous step/, question.id)
  }
})

test('the four global dimensions follow the nine per-step questions', () => {
  assert.deepEqual(
    rubric.questions.map(({ dimension }) => dimension),
    [...Array(9).fill('per-step'), 'readability', 'navigation', 'responsive', 'cohesion'],
  )
})

test('every question shares the same five anchors', () => {
  assert.deepEqual(rubric.anchors.map(({ rating }) => rating), [1, 2, 3, 4, 5])
  assert.match(rubric.anchors[0].anchor, /^Unacceptable/)
  assert.match(rubric.anchors[4].anchor, /^Excellent/)
})

// --- Anchored response validation -----------------------------------------

test('a rating of 1, 2, or 3 with a rationale is accepted', () => {
  for (const rating of [1, 2, 3]) {
    assert.equal(validateResponse(rubric, { rating, rationale: 'clipped text' }).ok, true)
  }
})

test('a rating of 1, 2, or 3 without a rationale is rejected', () => {
  for (const rating of [1, 2, 3]) {
    const outcome = validateResponse(rubric, { rating, rationale: '   ' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /rationale/)
  }
})

test('a rating of 4 or 5 without a rationale is accepted', () => {
  for (const rating of [4, 5]) {
    assert.equal(validateResponse(rubric, { rating, rationale: '' }).ok, true)
  }
})

test('a rating outside the whole numbers 1 through 5 is rejected', () => {
  for (const rating of [0, 6, 3.5, Number.NaN, null, 'four']) {
    const outcome = validateResponse(rubric, { rating, rationale: 'because' })
    assert.equal(outcome.ok, false, JSON.stringify(rating))
    assert.match(outcome.error, /whole number/)
  }
})

// --- The 30-point calculation ---------------------------------------------

test('all fives earn the full 30 points across the five subtotals', () => {
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), Array(13).fill(5)))
  assert.equal(score.complete, true)
  assert.equal(score.total, 30)
  assert.deepEqual(score.subtotals.map(({ id, points }) => [id, points]), [
    ['per-step', 10], ['readability', 5], ['navigation', 4], ['responsive', 4], ['cohesion', 7],
  ])
})

test('all threes earn exactly the 15-point floor', () => {
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), Array(13).fill(3)))
  assert.equal(score.total, 15)
  assert.equal(score.gate_passed, true)
})

test('each rating maps to its earned fraction without intermediate rounding', () => {
  const ratings = [5, 4, 3, 2, 5, 4, 3, 2, 5, 4, 2, 5, 3]
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), ratings))
  const perStep = ratings.slice(0, 9).reduce((sum, rating) => sum + (rating - 1) / 4, 0) / 9 * 10
  const globals = [[9, 5], [10, 4], [11, 4], [12, 7]]
    .reduce((sum, [index, points]) => sum + (ratings[index] - 1) / 4 * points, 0)
  assert.ok(Math.abs(score.total - (perStep + globals)) < 1e-9)
  assert.equal(score.total, score.subtotals.reduce((sum, { points }) => sum + points, 0))
})

test('the component gate fails below the 15-point floor', () => {
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), Array(13).fill(2)))
  assert.ok(score.total < 15)
  assert.equal(score.gate_passed, false)
  assert.ok(score.gate_failures.some(({ rule }) => rule === 'human-floor'))
})

test('any rating of 1 fails the component gate regardless of the total', () => {
  const ratings = Array(13).fill(5)
  ratings[3] = 1
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), ratings))
  assert.ok(score.total >= 15)
  assert.equal(score.gate_passed, false)
  assert.ok(score.gate_failures.some(({ rule }) => rule === 'human-rating-one'))
})

test('an incomplete review has no score and no gate result', () => {
  const state = fill(createReviewState(provenance()), Array(13).fill(5))
  state.responses.pop()
  const score = scoreHumanReview(rubric, state)
  assert.equal(score.complete, false)
  assert.equal(score.total, null)
  assert.equal(score.gate_passed, null)
})

// --- Durable progress, resume, and provenance -----------------------------

test('resume continues at the first unanswered question', () => {
  let state = createReviewState(provenance())
  assert.equal(firstUnanswered(rubric, state).number, 1)
  state = fill(state, [5, 4, 5])
  assert.equal(firstUnanswered(rubric, state).number, 4)
})

test('a replacement response replaces in place rather than appending', () => {
  let state = fill(createReviewState(provenance()), Array(13).fill(5))
  state = recordResponse(rubric, state, { id: 'step-4', rating: 2, rationale: 'overlapping labels' })
  assert.equal(state.responses.length, 13)
  const replaced = state.responses.find(({ id }) => id === 'step-4')
  assert.equal(replaced.rating, 2)
  assert.equal(scoreHumanReview(rubric, state).total < 30, true)
})

test('a saved review for a different candidate is refused', () => {
  const state = createReviewState(provenance())
  const mismatches = checkReviewProvenance(state, {
    candidate: { candidate_identity: 'candidate-other', run_id: 'run-1' },
    rubric: provenance().rubric,
  })
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].field, 'candidate_identity')
})

test('a saved review for a different human rubric is refused', () => {
  const state = createReviewState(provenance())
  const mismatches = checkReviewProvenance(state, {
    candidate: CANDIDATE,
    rubric: { ...provenance().rubric, sha256: 'f'.repeat(64) },
  })
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].field, 'rubric_sha256')
})

test('matching provenance reuses the saved responses', () => {
  const state = fill(createReviewState(provenance()), [5, 5])
  assert.deepEqual(checkReviewProvenance(state, provenance()), [])
})

// --- The interview ---------------------------------------------------------

function scriptedIo(inputs) {
  const written = []
  const remaining = [...inputs]
  return {
    written,
    io: {
      write: (line) => { written.push(line) },
      ask: () => {
        if (remaining.length === 0) throw new Error('the interview asked for more input than the script provides')
        return remaining.shift()
      },
    },
  }
}

function interviewInputs({ ratings, ready = 'yes', tail = ['confirm'] }) {
  return [ready, ...ratings.flatMap((rating) => [String(rating), rating <= 3 ? 'needs work' : '']), ...tail]
}

test('the interview waits for readiness before asking question 1', async () => {
  const { io, written } = scriptedIo(interviewInputs({ ratings: Array(13).fill(5) }))
  const saved = []
  const result = await runInterview({
    rubric,
    state: createReviewState(provenance()),
    candidateUrl: 'http://127.0.0.1:4173/',
    io,
    persist: async (state) => { saved.push(state) },
  })

  assert.equal(result.confirmed, true)
  const transcript = written.join('\n')
  assert.ok(transcript.indexOf('http://127.0.0.1:4173/') < transcript.indexOf(rubric.questions[0].text))
  assert.equal(saved.length, 14)
})

test('readiness confirmation records no rating', async () => {
  const { io } = scriptedIo(interviewInputs({ ratings: Array(13).fill(4), ready: 'y' }))
  const result = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  assert.equal(result.state.responses.length, 13)
  assert.equal(result.state.readiness_confirmed, true)
})

test('an invalid response repeats the same question without advancing', async () => {
  const { io, written } = scriptedIo([
    'yes',
    '9', 'out of range',
    '2', '',
    '2', 'labels overlap',
    ...Array(12).fill(0).flatMap(() => ['5', '']),
    'confirm',
  ])
  const result = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  const asked = written.filter((line) => line.startsWith('\nQuestion 1 of')).length
  assert.equal(asked, 3)
  assert.equal(result.state.responses[0].rating, 2)
  assert.equal(result.state.responses[0].rationale, 'labels overlap')
})

test('the summary shows every rating, subtotal, total, and gate before confirmation', async () => {
  const { io, written } = scriptedIo(interviewInputs({ ratings: Array(13).fill(5) }))
  await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  const transcript = written.join('\n')
  assert.match(transcript, /30(\.0+)? \/ 30/)
  assert.match(transcript, /Overall cohesion and polish/)
  assert.match(transcript, /human-review component gate: pass/i)
})

test('the reviewer can revise an answer and see the recalculated summary', async () => {
  const { io, written } = scriptedIo(interviewInputs({
    ratings: Array(13).fill(5),
    tail: ['revise', '4', '2', 'the transition stutters', 'confirm'],
  }))
  const persisted = []
  const result = await runInterview({
    rubric,
    state: createReviewState(provenance()),
    candidateUrl: 'http://x/',
    io,
    persist: async (state) => { persisted.push(structuredClone(state)) },
  })

  assert.equal(result.confirmed, true)
  assert.equal(result.state.responses.find(({ id }) => id === 'step-4').rating, 2)
  assert.equal(result.score.total < 30, true)
  // The revision is saved before the recalculated summary asks for confirmation.
  assert.equal(persisted.length, 15)
  const totals = written.join('\n').match(/\/ 30/g)
  assert.equal(totals.length, 2)
})

test('an unconfirmed interview leaves the review unfinished', async () => {
  const { io } = scriptedIo(interviewInputs({ ratings: Array(13).fill(5), tail: ['quit'] }))
  const result = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  assert.equal(result.confirmed, false)
  assert.equal(result.state.complete, false)
})

test('a confirmed review records the full finalized artifact', async () => {
  const { io } = scriptedIo(interviewInputs({ ratings: Array(13).fill(4) }))
  const { state } = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })

  assert.equal(state.schema_version, HUMAN_REVIEW_SCHEMA_VERSION)
  assert.equal(state.complete, true)
  assert.equal(state.candidate.candidate_identity, 'candidate-abc')
  assert.equal(state.rubric.sha256, human.sha256)
  assert.equal(state.rubric.version, human.version)
  assert.equal(state.responses.length, 13)
  for (const response of state.responses) {
    assert.equal(typeof response.question_text, 'string')
    assert.ok(response.question_text.length > 0)
  }
  assert.equal(state.score.total, 22.5)
  assert.equal(state.score.gate_passed, true)
  assert.equal(state.score.subtotals.length, 5)
})

test('a closed input stream interrupts the review without discarding saved answers', async () => {
  const { io } = scriptedIo(['yes', '5', '', '4', ''])
  const persisted = []

  const result = await runInterview({
    rubric,
    state: createReviewState(provenance()),
    candidateUrl: 'http://x/',
    io: { ...io, ask: () => { try { return io.ask() } catch { return null } } },
    persist: async (state) => { persisted.push(state) },
  })

  assert.equal(result.confirmed, false)
  assert.equal(result.interrupted, true)
  assert.equal(result.state.complete, false)
  assert.equal(result.state.responses.length, 2)
  assert.equal(persisted.length, 2)
})
