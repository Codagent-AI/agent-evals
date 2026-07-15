#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function indexResults(results, evaluator, expectedIds) {
  if (!Array.isArray(results)) throw new Error(`${evaluator} results must be an array`)
  const seen = new Set()
  const duplicates = []
  const unknown = []
  const indexed = new Map()
  for (const result of results) {
    if (!result || typeof result.id !== 'string') throw new Error(`${evaluator} result is missing an id`)
    if (seen.has(result.id)) duplicates.push(result.id)
    seen.add(result.id)
    if (!expectedIds.has(result.id)) unknown.push(result.id)
    if (!['pass', 'fail'].includes(result.verdict)) throw new Error(`${evaluator} scenario ${result.id} has invalid verdict`)
    indexed.set(result.id, result)
  }
  if (duplicates.length > 0) throw new Error(`duplicate ${evaluator} scenario IDs: ${duplicates.join(', ')}`)
  if (unknown.length > 0) throw new Error(`unknown ${evaluator} scenario IDs: ${unknown.join(', ')}`)
  const missing = [...expectedIds].filter((id) => !seen.has(id))
  if (missing.length > 0) throw new Error(`missing ${evaluator} scenario IDs: ${missing.join(', ')}`)
  return indexed
}

export function scoreEvaluation({ rubric, deterministicResults, judgeResults }) {
  if (rubric?.version !== 1 || !Array.isArray(rubric.scenarios)) throw new Error('unsupported rubric')
  const rubricIds = rubric.scenarios.map(({ id }) => id)
  if (new Set(rubricIds).size !== rubricIds.length) throw new Error('rubric contains duplicate scenario IDs')
  const deterministicIds = new Set(rubric.scenarios.filter(({ evaluator }) => evaluator === 'deterministic').map(({ id }) => id))
  const judgeIds = new Set(rubric.scenarios.filter(({ evaluator }) => evaluator === 'judge').map(({ id }) => id))
  const deterministic = indexResults(deterministicResults, 'deterministic', deterministicIds)
  const judged = indexResults(judgeResults, 'judge', judgeIds)
  const scenarios = rubric.scenarios.map((policy) => {
    const result = (policy.evaluator === 'deterministic' ? deterministic : judged).get(policy.id)
    return {
      id: policy.id,
      evaluator: policy.evaluator,
      critical: policy.critical,
      weight: policy.weight,
      verdict: result.verdict,
      note: result.note || '',
      evidence: Array.isArray(result.evidence) ? result.evidence : [],
    }
  })
  const totalWeight = scenarios.reduce((sum, { weight }) => sum + weight, 0)
  const passedWeight = scenarios.reduce((sum, { weight, verdict }) => sum + (verdict === 'pass' ? weight : 0), 0)
  const failedCritical = scenarios.filter(({ critical, verdict }) => critical && verdict === 'fail')
  const failed = scenarios.filter(({ verdict }) => verdict === 'fail')
  return {
    rubric_version: rubric.version,
    scenarios,
    overall_score: Math.round((passedWeight / totalWeight) * 100),
    pass: failedCritical.length === 0,
    rationale: failed.length === 0
      ? 'All rubric scenarios passed.'
      : `${failed.length} scenario(s) failed; ${failedCritical.length} critical failure(s).`,
  }
}

function valueAfter(args, option) {
  const index = args.indexOf(option)
  if (index === -1 || !args[index + 1]) throw new Error(`missing ${option}`)
  return args[index + 1]
}

async function main(args) {
  const rubric = JSON.parse(await readFile(valueAfter(args, '--rubric'), 'utf8'))
  const deterministic = JSON.parse(await readFile(valueAfter(args, '--deterministic'), 'utf8'))
  const judge = JSON.parse(await readFile(valueAfter(args, '--judge'), 'utf8'))
  const result = scoreEvaluation({
    rubric,
    deterministicResults: deterministic.scenarios,
    judgeResults: judge.scenarios,
  })
  await writeFile(valueAfter(args, '--output'), `${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
