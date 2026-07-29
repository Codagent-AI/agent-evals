import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  criteriaForJob,
  deterministicCriteria,
  loadRubrics,
} from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { writeJsonAtomic } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

const run = promisify(execFile)
const command = resolve('evals/agent-runner/and-scene/score.mjs')
const rubrics = await loadRubrics()
const automated = rubrics.automated.rubric
const allJobs = [
  'demo-integration',
  'scene-kit',
  'presentation-skill',
  'verification-tooling',
  'testing-evidence',
  'assumption-handling',
]

function verdicts(ids) {
  return ids.map((id) => ({
    id,
    verdict: 'pass',
    rationale: 'durable fixture evidence supports the criterion',
    evidence: ['fixture:verified'],
  }))
}

async function durableInputs(root, jobs = allJobs) {
  const browser = join(root, 'browser.json')
  const judging = join(root, 'judging.json')
  const human = join(root, 'human.json')
  await writeJsonAtomic(browser, {
    criteria: verdicts(deterministicCriteria(automated)),
    gates: verdicts(automated.gates.map(({ id }) => id)),
  })
  await writeJsonAtomic(judging, {
    judges: Object.fromEntries(jobs.map((job) => [job, verdicts(criteriaForJob(automated, job))])),
    retries: {},
    failed_jobs: [],
  })
  await writeJsonAtomic(human, {
    total: 30,
    ratings: Array.from({ length: 13 }, () => 5),
  })
  return { browser, judging, human }
}

async function rescore(mode, jobs = allJobs) {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-score-'))
  const inputs = await durableInputs(root, jobs)
  const output = join(root, 'score.json')
  await run(process.execPath, [
    command,
    '--browser-evaluation', inputs.browser,
    '--judging', inputs.judging,
    '--human-review', inputs.human,
    '--mode', mode,
    '--output', output,
  ])
  return JSON.parse(await readFile(output, 'utf8'))
}

test('score.mjs rescoring produces the candidate 70/100 applicability contract', async () => {
  const score = await rescore('agent-runner')

  assert.equal(score.automated_subtotal.points, 70)
  assert.equal(score.automated_subtotal.possible, 70)
  assert.equal(score.score_denominator, 100)
  assert.equal(score.official_score, 100)
  assert.equal(score.official_pass, true)
})

test('score.mjs rescoring produces the reference 62/92 N/A contract', async () => {
  const score = await rescore('reference-baseline', allJobs.slice(0, 4))

  assert.equal(score.automated_subtotal.points, 62)
  assert.equal(score.automated_subtotal.possible, 62)
  assert.equal(score.score_denominator, 92)
  assert.equal(score.official_score, 92)
  assert.equal(score.official_pass, null)
  assert.deepEqual(
    score.components
      .filter(({ applicable }) => !applicable)
      .map(({ id, points_possible }) => [id, points_possible]),
    [
      ['testing-evidence-quality', 0],
      ['assumption-handling-quality', 0],
    ],
  )
})

test('score.mjs refuses an exhausted required judge instead of fabricating zeroes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-score-'))
  const inputs = await durableInputs(root)
  const judging = JSON.parse(await readFile(inputs.judging, 'utf8'))
  judging.judges['testing-evidence'] = null
  judging.failed_jobs = ['testing-evidence']
  await writeJsonAtomic(inputs.judging, judging)

  await assert.rejects(
    run(process.execPath, [
      command,
      '--browser-evaluation', inputs.browser,
      '--judging', inputs.judging,
      '--human-review', inputs.human,
      '--output', join(root, 'score.json'),
    ]),
    /required judge jobs failed: testing-evidence/,
  )
})
