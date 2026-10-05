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
  SOURCE_AUDIT_RESULT_SCHEMA,
  SOURCE_JUDGE_RESULT_SCHEMA,
} from '../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import { PRICING_FINDING_SCHEMA } from '../evals/agent-runner/and-scene/lib/pricing.mjs'
import { SECOND_OPINION_SCHEMA, validReplay } from '../evals/agent-runner/and-scene/lib/second-opinion.mjs'

const CODEX_JUDGE_SCHEMAS = {
  SECOND_OPINION_SCHEMA,
  AMBIGUITY_RESULT_SCHEMA,
  JUDGE_RESULT_SCHEMA,
  SOURCE_JUDGE_RESULT_SCHEMA,
  SOURCE_AUDIT_RESULT_SCHEMA,
  PRICING_FINDING_SCHEMA,
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
    if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      violations.push(`${path}: properties must be an object`)
    }
    if (!Array.isArray(node.required)) {
      violations.push(`${path}: required must be an array`)
    }
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

test('every replay schema variant uses exactly the keys accepted by validReplay', () => {
  const replay = SECOND_OPINION_SCHEMA.properties.replay.properties
  const actions = replay.actions.items.anyOf
  const expectations = replay.expect.anyOf
  assert.ok(Array.isArray(actions))
  assert.ok(Array.isArray(expectations))
  assert.deepEqual(actions.map((variant) => variant.properties.type.enum[0]).sort(),
    ['navigate', 'click', 'press', 'keys', 'swipe', 'wait'].sort())
  assert.deepEqual(expectations.map((variant) => variant.properties.type.enum[0]).sort(),
    ['step-index-equals', 'step-index-changes', 'step-count-changes', 'mode-equals',
      'selector-visible', 'selector-hidden', 'text-present'].sort())
  const sample = (variant) => Object.fromEntries(variant.required.map((key) => {
    const field = variant.properties[key]
    return [key, field.enum?.[0] ?? (field.type === 'integer' ? 0 : key === 'path' ? '/demo' : 'sample')]
  }))
  for (const action of actions.map(sample)) {
    for (const expect of expectations.map(sample)) {
      assert.equal(validReplay({ actions: action.type === 'navigate' ? [action]
        : [{ type: 'navigate', path: '/demo' }, action], expect }), true,
      JSON.stringify({ action, expect }))
    }
  }
})
