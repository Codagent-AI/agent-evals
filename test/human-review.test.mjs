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
  validateSavedReview,
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

test('the v2 rubric asks exactly seven whole-presentation visual questions in order', () => {
  assert.equal(rubric.version, '2.1.0')
  assert.equal(rubric.questions.length, 7)
  assert.deepEqual(rubric.questions.map(({ number }) => number), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(rubric.dimensions[0].title, 'Text appearance, hierarchy, and wording')
  assert.match(rubric.questions[0].text, /titles, captions, labels, and other content text look and read/i)
  assert.match(rubric.questions[0].text, /audience-ready rather than sounding like an internal annotation/i)
  assert.match(rubric.questions[0].text, /important content text is visibly present/i)
  assert.match(rubric.questions[0].text, /Do not judge navigation controls or presentation chrome here/i)
  assert.match(rubric.questions[1].text, /individual scene elements/i)
  assert.match(rubric.questions[1].text, /Do not judge their text, placement, movement, or navigation chrome here/i)
  assert.match(rubric.questions[2].text, /arranged relative to one another/i)
  assert.match(rubric.questions[3].text, /animations and scene changes/i)
  assert.match(rubric.questions[4].text, /visual identity/i)
  assert.match(rubric.questions[5].text, /controls and chrome/i)
  assert.match(rubric.questions[6].text, /wide and narrow viewport sizes/i)
})

test('each question defines its own five rating labels in scale order', () => {
  assert.deepEqual(
    rubric.questions.map(({ rating_options: options }) => options.map(({ label }) => label)),
    [
      ['Missing or unusable', 'Weak and confusing', 'Serviceable but flawed', 'Clear and polished', 'Exceptional text system'],
      ['Broken or crude', 'Weak and inconsistent', 'Serviceable but basic', 'Polished and coherent', 'Exceptional visual craft'],
      ['Broken composition', 'Poorly arranged', 'Workable but uneven', 'Strong composition', 'Masterful composition'],
      ['Broken or disorienting', 'Choppy or disconnected', 'Functional but uneven', 'Smooth and meaningful', 'Exceptional choreography'],
      ['Incoherent or unfinished', 'Weak or unappealing', 'Coherent but ordinary', 'Distinctive and polished', 'Exceptional and memorable'],
      ['Unusable or visually broken', 'Confusing and disconnected', 'Understandable but awkward', 'Clear and integrated', 'Effortless and elegant'],
      ['Broken at a supported size', 'Adapts poorly', 'Usable but compromised', 'Strong across sizes', 'Exceptionally responsive'],
    ],
  )
  for (const question of rubric.questions) {
    assert.deepEqual(question.rating_options.map(({ rating }) => rating), [1, 2, 3, 4, 5])
    assert.ok(question.rating_options.every(({ description }) => description.length > 0))
  }
})

test('each question isolates one explicit visual dimension', () => {
  assert.deepEqual(
    rubric.questions.map(({ dimension }) => dimension),
    [
      'text-appearance',
      'element-appearance',
      'composition',
      'motion',
      'visual-identity',
      'navigation-chrome',
      'responsive',
    ],
  )
  assert.ok(rubric.questions.every(({ text }) => !/^Rate step /i.test(text)))
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

test('all fives earn the full 30 points across the seven subtotals', () => {
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), Array(7).fill(5)))
  assert.equal(score.complete, true)
  assert.equal(score.total, 30)
  assert.deepEqual(score.subtotals.map(({ id, points }) => [id, points]), [
    ['text-appearance', 4],
    ['element-appearance', 4],
    ['composition', 5],
    ['motion', 6],
    ['visual-identity', 5],
    ['navigation-chrome', 3],
    ['responsive', 3],
  ])
})

test('all threes earn exactly the 15-point floor', () => {
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), Array(7).fill(3)))
  assert.equal(score.total, 15)
  assert.equal(score.gate_passed, true)
})

test('each rating maps to its earned fraction without intermediate rounding', () => {
  const ratings = [5, 4, 3, 2, 5, 4, 3]
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), ratings))
  const weights = [4, 4, 5, 6, 5, 3, 3]
  const expected = ratings.reduce(
    (sum, rating, index) => sum + (rating - 1) / 4 * weights[index],
    0,
  )
  assert.ok(Math.abs(score.total - expected) < 1e-9)
  assert.equal(score.total, score.subtotals.reduce((sum, { points }) => sum + points, 0))
})

test('the component gate fails below the 15-point floor', () => {
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), Array(7).fill(2)))
  assert.ok(score.total < 15)
  assert.equal(score.gate_passed, false)
  assert.ok(score.gate_failures.some(({ rule }) => rule === 'human-floor'))
})

test('any rating of 1 fails the component gate regardless of the total', () => {
  const ratings = Array(7).fill(5)
  ratings[3] = 1
  const score = scoreHumanReview(rubric, fill(createReviewState(provenance()), ratings))
  assert.ok(score.total >= 15)
  assert.equal(score.gate_passed, false)
  assert.ok(score.gate_failures.some(({ rule }) => rule === 'human-rating-one'))
})

test('an incomplete review has no score and no gate result', () => {
  const state = fill(createReviewState(provenance()), Array(7).fill(5))
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
  let state = fill(createReviewState(provenance()), Array(7).fill(5))
  state = recordResponse(rubric, state, { id: 'composition', rating: 2, rationale: 'overlapping labels' })
  assert.equal(state.responses.length, 7)
  const replaced = state.responses.find(({ id }) => id === 'composition')
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
  const { io, written } = scriptedIo(interviewInputs({ ratings: Array(7).fill(5) }))
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
  assert.equal(saved.length, 8)
})

test('each prompt shows that question\'s rating labels rather than the global anchors', async () => {
  const { io, written } = scriptedIo(['yes', null])
  const result = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })

  assert.equal(result.interrupted, true)
  const transcript = written.join('\n')
  assert.match(transcript, /1 — Missing or unusable/)
  assert.match(transcript, /5 — Exceptional text system/)
  assert.doesNotMatch(transcript, /Broken or crude/)
  assert.doesNotMatch(transcript, /Unacceptable — broken, unusable/)
})

test('readiness confirmation records no rating', async () => {
  const { io } = scriptedIo(interviewInputs({ ratings: Array(7).fill(4), ready: 'y' }))
  const result = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  assert.equal(result.state.responses.length, 7)
  assert.equal(result.state.readiness_confirmed, true)
})

test('an invalid response repeats the same question without advancing', async () => {
  const { io, written } = scriptedIo([
    'yes',
    '9', 'out of range',
    '2', '',
    '2', 'labels overlap',
    ...Array(6).fill(0).flatMap(() => ['5', '']),
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
  const { io, written } = scriptedIo(interviewInputs({ ratings: Array(7).fill(5) }))
  await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  const transcript = written.join('\n')
  assert.match(transcript, /30(\.0+)? \/ 30/)
  assert.match(transcript, /Overall visual identity/)
  assert.match(transcript, /human-review component gate: pass/i)
})

test('the reviewer can revise an answer and see the recalculated summary', async () => {
  const { io, written } = scriptedIo(interviewInputs({
    ratings: Array(7).fill(5),
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
  assert.equal(result.state.responses.find(({ id }) => id === 'motion').rating, 2)
  assert.equal(result.score.total < 30, true)
  // The revision is saved before the recalculated summary asks for confirmation.
  assert.equal(persisted.length, 9)
  const totals = written.join('\n').match(/\/ 30/g)
  assert.equal(totals.length, 2)
})

test('an unconfirmed interview leaves the review unfinished', async () => {
  const { io } = scriptedIo(interviewInputs({ ratings: Array(7).fill(5), tail: ['quit'] }))
  const result = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })
  assert.equal(result.confirmed, false)
  assert.equal(result.state.complete, false)
})

test('a confirmed review records the full finalized artifact', async () => {
  const { io } = scriptedIo(interviewInputs({ ratings: Array(7).fill(4) }))
  const { state } = await runInterview({
    rubric, state: createReviewState(provenance()), candidateUrl: 'http://x/', io, persist: async () => {},
  })

  assert.equal(state.schema_version, HUMAN_REVIEW_SCHEMA_VERSION)
  assert.equal(state.complete, true)
  assert.equal(state.candidate.candidate_identity, 'candidate-abc')
  assert.equal(state.rubric.sha256, human.sha256)
  assert.equal(state.rubric.version, human.version)
  assert.equal(state.responses.length, 7)
  for (const response of state.responses) {
    assert.equal(typeof response.question_text, 'string')
    assert.ok(response.question_text.length > 0)
  }
  assert.equal(state.score.total, 22.5)
  assert.equal(state.score.gate_passed, true)
  assert.equal(state.score.subtotals.length, 7)
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

// --- Corrupted or externally edited saved reviews --------------------------

test('a saved rating outside the rubric scale never scores', () => {
  const state = fill(createReviewState(provenance()), Array(7).fill(5))
  state.responses[2].rating = 999

  const score = scoreHumanReview(rubric, state)

  assert.equal(score.complete, false)
  assert.equal(score.total, null)
  assert.equal(score.gate_passed, null)
})

test('a saved low rating whose rationale was stripped never scores', () => {
  const state = fill(createReviewState(provenance()), Array(7).fill(3))
  state.responses[0].rationale = ''

  assert.equal(scoreHumanReview(rubric, state).complete, false)
})

test('validateSavedReview names every way a persisted review is unusable', () => {
  assert.deepEqual(validateSavedReview(rubric, fill(createReviewState(provenance()), Array(7).fill(4))), [])

  const corrupted = fill(createReviewState(provenance()), Array(7).fill(4))
  corrupted.responses[1].rating = -10
  corrupted.responses[4].id = 'text-appearance'
  corrupted.responses.push({ id: 'not-a-question', number: 99, rating: 4, rationale: '' })

  const problems = validateSavedReview(rubric, corrupted)
  assert.ok(problems.some((problem) => problem.includes('element-appearance')), problems.join('; '))
  assert.ok(problems.some((problem) => problem.includes('duplicate')), problems.join('; '))
  assert.ok(problems.some((problem) => problem.includes('not-a-question')), problems.join('; '))
})
