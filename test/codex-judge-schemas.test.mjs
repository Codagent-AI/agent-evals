import { makeTempDir } from './temp-dir.mjs'
// Every schema handed to `codex exec --output-schema` is sent to OpenAI as a
// strict structured-output format. Strict mode rejects the whole request with
// HTTP 400 `invalid_json_schema` unless every object lists every property key in
// `required` and sets `additionalProperties: false`; optional fields must be
// expressed as required and nullable instead. A rejected schema silently turns
// a judge phase into an incomplete diagnostic, so check every judge schema here.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AMBIGUITY_RESULT_SCHEMA, parseAmbiguityOutput } from '../evals/agent-runner/and-scene/lib/ambiguity.mjs'
import {
  JUDGE_RESULT_SCHEMA,
  PANEL_AUDIT_RESULT_SCHEMA,
  PANEL_CHECK_RESULT_SCHEMA,
  SOURCE_AUDIT_RESULT_SCHEMA,
  SOURCE_JUDGE_RESULT_SCHEMA,
} from '../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import { PRICING_FINDING_SCHEMA } from '../evals/agent-runner/and-scene/lib/pricing.mjs'
import {
  LINE_CITED_RESULT_SCHEMA,
  LINE_CITED_CLAIM_MAP_RESULT_SCHEMA,
  buildJudgeRequest,
  buildSpanAuditRequest,
  buildTiebreakRequest,
  buildSourceAuditRequest,
  productJudgeJobs,
} from '../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import { SECOND_OPINION_SCHEMA, buildSecondOpinionRequest, buildSpanAuditRequest as buildOpinionAuditRequest }
  from '../evals/agent-runner/and-scene/lib/second-opinion.mjs'
import { loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CODEX_JUDGE_SCHEMAS = {
  AMBIGUITY_RESULT_SCHEMA,
  JUDGE_RESULT_SCHEMA,
  SOURCE_JUDGE_RESULT_SCHEMA,
  SOURCE_AUDIT_RESULT_SCHEMA,
  PANEL_AUDIT_RESULT_SCHEMA,
  PANEL_CHECK_RESULT_SCHEMA,
  PRICING_FINDING_SCHEMA,
  LINE_CITED_RESULT_SCHEMA,
  // The testing-evidence decider's schema: every criterion returns claim_map,
  // the empty form when it takes none, because strict mode has no optional field.
  LINE_CITED_CLAIM_MAP_RESULT_SCHEMA,
  SECOND_OPINION_SCHEMA,
}

function isObjectSchema(node) {
  const types = Array.isArray(node.type) ? node.type : [node.type]
  return types.includes('object') || Object.hasOwn(node, 'properties')
}

// Returns a description of every strict-mode violation under `node`.
function strictViolations(node, path) {
  if (!node || typeof node !== 'object') return []
  const violations = []
  if (isObjectSchema(node)) {
    if (node.additionalProperties !== false) {
      violations.push(`${path}: additionalProperties must be false`)
    }
    const keys = Object.keys(node.properties ?? {}).sort()
    const required = [...(node.required ?? [])].sort()
    if (JSON.stringify(keys) !== JSON.stringify(required)) {
      violations.push(`${path}: required ${JSON.stringify(required)} must list every property ${JSON.stringify(keys)}`)
    }
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    violations.push(...strictViolations(child, `${path}.properties.${key}`))
  }
  if (node.items) violations.push(...strictViolations(node.items, `${path}.items`))
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    for (const [index, child] of (node[combinator] ?? []).entries()) {
      violations.push(...strictViolations(child, `${path}.${combinator}[${index}]`))
    }
  }
  for (const [key, child] of Object.entries(node.$defs ?? {})) {
    violations.push(...strictViolations(child, `${path}.$defs.${key}`))
  }
  return violations
}

// The root of a strict response format must be an object, never a union.
function rootViolations(schema, name) {
  return schema?.type === 'object' && !schema.anyOf && !schema.oneOf ? [] : [`${name}: root must be a plain object`]
}

for (const [name, schema] of Object.entries(CODEX_JUDGE_SCHEMAS)) {
  test(`${name} satisfies OpenAI strict structured-output rules`, () => {
    assert.deepEqual(strictViolations(schema, name), [])
  })
}

test('ambiguity parser accepts the strict nullable form of optional fields', () => {
  const raw = {
    origin: { run_id: null, step: 'implement-task', agent_role: null, task: null },
    source: 'judge-discovered',
    concern: 'captions may wrap or truncate',
    evidence: ['output/session-report.out'],
    handling: 'chose truncation',
    consequence: 'long captions are clipped',
    classification: 'genuine-specification-gap',
    rationale: 'the spec is silent',
    resolution: null,
  }
  const parsed = parseAmbiguityOutput(JSON.stringify({ coverage: 'complete', findings: [raw], proposals: [] }))
  const [finding] = parsed.findings
  assert.deepEqual(finding.origin, { run_id: null, step: 'implement-task', agent_role: null, task: null })
  assert.equal(finding.resolution, 'unresolved')

  // A null origin field and an omitted one identify the same finding.
  const omitted = parseAmbiguityOutput(JSON.stringify({
    coverage: 'complete',
    findings: [{ ...raw, origin: { step: 'implement-task' }, resolution: undefined }],
  }))
  assert.equal(omitted.findings[0].id, finding.id)
  assert.deepEqual(parsed.proposals, [])
})

// Agent-evals #79: the browser second-opinion replay sub-schemas were open
// objects, so every run that needed a browser second opinion got HTTP 400
// invalid_json_schema. Walk the schema of every request the harness sends.
test('every schema the harness actually sends to a judge is strict-mode valid', async () => {
  const rubrics = await loadRubrics()
  const authority = { cli: 'codex', model: 'gpt-test' }
  const root = await makeTempDir(join(tmpdir(), 'and-scene-strict-'))
  await mkdir(join(root, 'source/src'), { recursive: true })
  await writeFile(join(root, 'source/src/a.ts'), 'export const a = 1\n')
  const neutral = { root, source_root: join(root, 'source'), audit_root: root, requirements_root: join(root, 'req'),
    manifest: { entries: [{ namespace: 'neutral-source', path: 'source/src/a.ts' }] } }
  const notObserved = Object.keys(rubrics.automated.rubric.fallbacks)
    .map((id) => ({ id, rationale: 'not observed', looked_for: [], evidence: [] }))
  const sent = []
  for (const { id } of productJudgeJobs(rubrics, { notObserved })) {
    const request = buildJudgeRequest({ rubrics, job: id, authority, neutral, notObserved })
    sent.push([`${id} sample`, request.schema])
    sent.push([`${id} tiebreak`, buildTiebreakRequest({ request, criteria: request.criteria.slice(0, 2),
      inventory: { root: neutral.source_root, kind: 'neutral source', paths: ['src/a.ts'] } }).schema])
    sent.push([`${id} span audit`, buildSpanAuditRequest({ request,
      passes: [{ id: request.criteria[0], rationale: 'r' }], spans: new Map() }).schema])
    if (request.source_audit) {
      const audit = await buildSourceAuditRequest({ request, primaryResults: [{ id: request.criteria[0],
        verdict: 'pass', rationale: 'r', evidence: ['e'], citations: ['src/a.ts'] }] })
      sent.push([`${id} source audit`, audit.schema])
    }
  }
  const browser = { criteria: [{ id: 'demo-supported-navigation', verdict: 'fail', rationale: 'keyboard 1/0, swipe 0/0, direct jump 4' }],
    probes: [{ id: 'demo-supported-navigation', result: { verdict: 'fail', rationale: 'keyboard 1/0, swipe 0/0, direct jump 4' } }], gates: [] }
  const opinion = buildSecondOpinionRequest({ target: { kind: 'criterion', id: 'demo-supported-navigation' },
    rubrics, browser, judging: null, neutral, authority })
  sent.push(['second opinion', opinion.schema])
  sent.push(['second opinion audit', buildOpinionAuditRequest({ request: opinion,
    answer: { mismeasured_step: 's', measurement_fault: 'f' }, spans: [], logSpans: [] }).schema])
  for (const [name, schema] of sent) {
    assert.deepEqual([...rootViolations(schema, name), ...strictViolations(schema, name)], [])
  }
})
