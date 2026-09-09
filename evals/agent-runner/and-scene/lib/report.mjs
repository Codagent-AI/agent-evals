// The offline HTML report.
//
// `report.html` is a pure rendering of the current `result.json`: it computes
// nothing, embeds no candidate markup or external asset, and links artifacts
// relative to its own run directory so the whole run reads from a file:// URL.
//
// Every value that reaches the page goes through `escapeHtml`, including values
// the harness produced — a rationale, an evidence string, or a step title can
// all carry candidate-controlled text, and a report that executed any of it
// would let a graded candidate rewrite its own verdict.
//
// The one thing the report refuses to do is disagree with the result. If the
// outcome it would print differs from the current `result.json`, rendering fails
// rather than publishing two contradictory accounts of the same run.

export class ReportConsistencyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReportConsistencyError'
    this.code = 'report-result-disagreement'
  }
}

// The outcome facts the report leads with. These are exactly the fields the
// consistency check compares, because these are what a reader acts on.
const OUTCOME_FIELDS = [
  'evaluation_status', 'product_verdict', 'official_score',
  'score_denominator', 'label', 'failed_phase',
]

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character])
}

function points(value) {
  if (!Number.isFinite(value)) return 'not available'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function delta(value) {
  if (!Number.isFinite(value)) return 'not applicable'
  return value > 0 ? `+${points(value)}` : points(value)
}

function verdictCell(value) {
  return value === null || value === undefined ? 'not observed' : String(value)
}

function table(headings, rows) {
  if (rows.length === 0) return '<p class="empty">Nothing recorded.</p>'
  const head = headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n')
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`
}

function section(title, body) {
  return `<details><summary>${escapeHtml(title)}</summary>\n${body}\n</details>`
}

function describe(value) {
  if (value === null || value === undefined) return 'not available'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function tokenCount(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : 'not available'
}

function usd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : 'not available'
}

function implementationUsageSection(result) {
  const cost = result.cost && typeof result.cost === 'object' ? result.cost : null
  const rows = Array.isArray(cost?.rows) ? cost.rows : []
  const implementation = table(
    [
      'Role', 'Tool', 'Provider', 'Model', 'Attempts', 'Canonical input', 'Cached input',
      'Cache write', 'Canonical output', 'Reasoning detail', 'Canonical total',
      'Usage', 'Cost', 'Cost state', 'Cost source', 'Verification',
    ],
    rows.map((row) => [
      row.agent_role ?? 'unknown',
      row.tool ?? 'unknown',
      row.provider ?? 'unknown',
      row.model ?? 'unknown',
      tokenCount(row.attempt_count),
      tokenCount(row.token_totals?.input),
      tokenCount(row.tokens?.cached_input),
      tokenCount(row.tokens?.cache_write),
      tokenCount(row.token_totals?.output),
      tokenCount(row.tokens?.reasoning ?? row.tokens?.reasoning_output),
      tokenCount(row.token_totals?.total),
      row.usage_complete ? 'complete' : 'incomplete',
      usd(row.cost?.amount_usd),
      row.cost?.state ?? 'unavailable',
      row.cost?.sources?.join(', ') || 'not available',
      row.verification ?? 'not available',
    ]),
  )
  const usage = cost?.usage
  const usageTotal = [
    '<h3>Implementation token total</h3>',
    table(
      ['Metric', 'Value'],
      [
        ['State', usage?.state ?? 'unavailable'],
        ['Canonical input', tokenCount(usage?.token_totals?.input)],
        ['Cached input detail', tokenCount(usage?.tokens?.cached_input)],
        ['Cache write detail', tokenCount(usage?.tokens?.cache_write)],
        ['Canonical output', tokenCount(usage?.token_totals?.output)],
        ['Reasoning detail', tokenCount(usage?.tokens?.reasoning ?? usage?.tokens?.reasoning_output)],
        ['Canonical total', tokenCount(usage?.token_totals?.total)],
      ],
    ),
  ].join('\n')
  const total = table(
    ['Implementation total', 'Value'],
    keyValueRows(cost?.total ?? cost?.implementation ?? {}),
  )
  const evalOwned = cost?.eval_owned
  const evalRows = Array.isArray(evalOwned?.by_phase) ? evalOwned.by_phase : []
  const evaluator = [
    '<h3>Eval-owned model usage</h3>',
    '<p>Reported separately from implementation usage and never included in implementation cost.</p>',
    table(
      [
        'Phase', 'Provider', 'Model', 'Attempts', 'Canonical input', 'Cached input',
        'Cache write', 'Canonical output', 'Reasoning detail', 'Canonical total', 'Usage',
      ],
      evalRows.map((row) => [
        row.phase ?? 'unknown',
        row.provider ?? 'unknown',
        row.model ?? 'unknown',
        tokenCount(row.attempt_count ?? 1),
        tokenCount(row.token_totals?.input),
        tokenCount(row.tokens?.cached_input),
        tokenCount(row.tokens?.cache_write),
        tokenCount(row.token_totals?.output),
        tokenCount(row.tokens?.reasoning ?? row.tokens?.reasoning_output),
        tokenCount(row.token_totals?.total),
        row.usage_complete === false ? 'incomplete' : 'complete',
      ]),
    ),
  ].join('\n')
  const metrics = result.implementation_metrics
  const metricSummary = metrics && typeof metrics === 'object'
    ? {
        state: metrics.state ?? null,
        reason: metrics.reason ?? null,
        history_complete: metrics.history_complete ?? null,
        attempt_count: metrics.attempt_count ?? null,
        active_duration_ms: metrics.active_duration_ms ?? null,
        coverage: metrics.coverage ?? null,
      }
    : metrics
  return section(
    'Implementation usage and cost',
    '<p>Canonical input/output totals are non-overlapping billing totals; cache and reasoning columns are detail categories within those totals.</p>'
      + implementation + usageTotal + total + evaluator
      + table(['Metric', 'Value'], keyValueRows(metricSummary)),
  )
}

// Machine field names that would otherwise put "provenance" in front of a
// reader. Human-facing output says source and version details instead.
const FIELD_LABELS = {
  provenance: 'source and version details',
  workflow_provenance: 'workflow source and version details',
  agent_runner_provenance: 'Agent Runner source and version details',
  rubric_provenance: 'rubric source and version details',
}

function keyValueRows(record) {
  return Object.entries(record ?? {}).map(([key, value]) => [FIELD_LABELS[key] ?? key, describe(value)])
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
h1 { font-size: 2.5rem; letter-spacing: .04em; margin: 0 0 .25rem; }
h1.pass { color: #14652c; } h1.fail { color: #8a1420; } h1.pending, h1.failed { color: #7a4a05; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
th, td { border: 1px solid #8886; padding: .35rem .5rem; text-align: left; vertical-align: top; }
details { border: 1px solid #8886; border-radius: .4rem; margin: .5rem 0; padding: .5rem .75rem; }
summary { cursor: pointer; font-weight: 600; }
.banner { border-left: .3rem solid #8a1420; padding: .5rem .75rem; margin: 1rem 0; }
.empty { color: #6668; font-style: italic; }
`.trim()

function headlineClass(result) {
  if (result.product_verdict === 'pass') return 'pass'
  if (result.product_verdict === 'fail') return 'fail'
  if (result.product_verdict === 'not-applicable') return 'reference'
  return result.evaluation_status === 'pending-human-review' ? 'pending' : 'failed'
}

function summaryBlock(result) {
  const lines = []
  if (Number.isFinite(result.official_score)) {
    lines.push(
      `<p><strong>Official score:</strong> ${escapeHtml(points(result.official_score))} / `
      + `${escapeHtml(String(result.score_denominator ?? 100))}</p>`,
    )
  } else if (result.product_failure) {
    const automatedFailure = result.product_failure.phase === 'automated-scoring'
    lines.push(automatedFailure
      ? '<p><strong>No official score:</strong> automated requirements failed, so human review was not required.</p>'
      : '<p><strong>No official score:</strong> the official score and human review are unavailable because the delivered product could not build or serve.</p>')
    lines.push(
      `<div class="banner"><strong>${automatedFailure ? 'Automated product failure' : 'Conclusive product failure'}`
      + `${result.product_failure.gate ? ` (${escapeHtml(result.product_failure.gate)})` : ''}:</strong> `
      + `${escapeHtml(result.product_failure.reason ?? 'the delivered product could not build or serve')}</div>`,
    )
  } else {
    lines.push('<p><strong>No official score:</strong> the product verdict is unavailable for this run.</p>')
  }
  const subtotal = result.automated_subtotal
  if (subtotal) {
    lines.push(
      `<p><strong>Automated subtotal:</strong> ${escapeHtml(points(subtotal.points))} / `
      + `${escapeHtml(String(subtotal.possible))}${subtotal.complete ? '' : ' (incomplete)'}</p>`,
    )
  }
  lines.push(`<p><strong>Run:</strong> ${escapeHtml(result.run_id)} (${escapeHtml(result.mode)})</p>`)
  lines.push(`<p><strong>Evaluation status:</strong> ${escapeHtml(result.evaluation_status)}</p>`)
  lines.push(
    `<p><strong>Score denominator:</strong> `
    + `${escapeHtml(result.score_denominator ?? 'not available')}</p>`,
  )

  if (result.failure) {
    const owner = result.failure.owner === 'implementation-workflow'
      ? 'Implementation workflow'
      : 'Evaluation harness'
    lines.push(
      `<div class="banner"><strong>${owner} failure in ${escapeHtml(result.failure.phase ?? 'an unnamed phase')}:</strong> `
      + `${escapeHtml(result.failure.reason ?? 'no reason recorded')}</div>`,
    )
  }
  if (result.cleanup && result.cleanup.completed === false) {
    lines.push(
      `<div class="banner"><strong>Candidate-server cleanup did not complete:</strong> `
      + `${escapeHtml(result.cleanup.error ?? result.cleanup.reason ?? 'no detail recorded')}</div>`,
    )
  }
  return lines.join('\n')
}

function deliverySection(result) {
  return section(
    'Candidate delivery identity',
    table(['Field', 'Value'], keyValueRows(result.delivery)),
  )
}

function evidenceRows(summary) {
  return (summary?.artifacts ?? []).map((artifact) => [
    artifact.id,
    artifact.kind,
    artifact.ownership,
    artifact.sha256,
    artifact.revision,
    artifact.verification_state,
    (artifact.coverage ?? []).join(' | '),
    (artifact.limitations ?? []).join(' | '),
  ])
}

function evidenceSection(title, summary) {
  const overview = table(['Field', 'Value'], keyValueRows(summary
    ? {
        ownership: summary.ownership,
        readiness: summary.readiness,
        final_sha: summary.final_sha,
        manifest_sha256: summary.manifest_sha256,
        candidate_reported_ci: summary.ci_claims,
      }
    : null))
  const artifacts = table(
    ['Identifier', 'Kind', 'Ownership', 'SHA-256', 'Revision', 'Verification', 'Coverage', 'Limitations'],
    evidenceRows(summary),
  )
  return section(title, overview + artifacts)
}

function evidenceAuditSection(result) {
  return section(
    'Evidence lineage and contradictions',
    table(['Lineage field', 'Value'], keyValueRows(result.evidence?.lineage))
    + table(
      ['Identifier', 'Claim', 'Consequence', 'Candidate evidence', 'Evaluator evidence'],
      (result.evidence?.contradictions ?? []).map((item) => [
        item.id,
        item.claim ?? '',
        item.consequence ?? '',
        item.candidate?.id ?? '',
        item.evaluator?.id ?? '',
      ]),
    ),
  )
}

function componentSections(result) {
  const components = result.score?.components ?? []
  const componentRows = components.map((component) => [
    component.id,
    component.title ?? '',
    component.applicable === false
      ? 'not applicable'
      : points(component.raw_points_awarded ?? component.points_awarded),
    component.applicable === false ? 'not applicable' : points(component.points_awarded),
    Number.isFinite(component.adjudication_adjustment)
      ? delta(component.adjudication_adjustment)
      : 'none',
    component.points_possible,
    component.floor ?? 'none',
    component.complete ? 'complete' : 'incomplete',
  ])
  const subcomponentRows = components.flatMap((component) => (component.subcomponents ?? []).map((sub) => [
    component.id,
    sub.id,
    sub.title ?? '',
    points(sub.points_awarded),
    sub.points_possible,
    sub.complete ? 'complete' : 'incomplete',
  ]))
  return section(
    'Component and subcomponent scores',
    table(
      ['Component', 'Title', 'Raw awarded', 'Adjudicated', 'Adjustment', 'Possible', 'Floor', 'State'],
      componentRows,
    )
    + table(['Component', 'Subcomponent', 'Title', 'Awarded', 'Possible', 'State'], subcomponentRows),
  )
}

function adjudicationSection(result) {
  const review = result.technical_adjudication
  if (!review) return ''
  const history = result.technical_adjudication_history ?? []
  return section(
    'Technical score adjudication',
    table(['Field', 'Value'], [
      ['Approved by', review.approved_by],
      ['Approved at', review.approved_at],
      ['Prior shared technical score', points(review.prior_shared_technical_score)],
      ['Revised shared technical score', points(review.revised_shared_technical_score)],
      ...(Number.isFinite(review.revised_workflow_quality_score)
        ? [
            ['Prior workflow-quality score', points(review.prior_workflow_quality_score)],
            ['Revised workflow-quality score', points(review.revised_workflow_quality_score)],
          ]
        : []),
      ...(review.revised_gate_verdicts
        ? [
            ['Prior hard gates', JSON.stringify(review.prior_gate_verdicts)],
            ['Revised hard gates', JSON.stringify(review.revised_gate_verdicts)],
          ]
        : []),
      ['Prior official score', points(review.prior_official_score)],
      ['Revised official score', points(review.revised_official_score)],
      ...(review.reviewed_rubric
        ? [
            [
              'Reviewed rubric',
              `${review.reviewed_rubric.rubric_id} ${review.reviewed_rubric.version}`,
            ],
            ['Reviewed rubric SHA-256', review.reviewed_rubric.sha256],
          ]
        : []),
      ['Rationale', review.rationale],
    ])
    + table(
      ['Finding'],
      (review.findings ?? []).map((finding) => [finding]),
    )
    + (history.length === 0
      ? ''
      : '<h3>Superseded technical adjudications</h3>'
        + table(
          ['Approved at', 'Prior shared', 'Revised shared', 'Rationale'],
          history.map((prior) => [
            prior.approved_at,
            points(prior.prior_shared_technical_score),
            points(prior.revised_shared_technical_score),
            prior.rationale,
          ]),
        )),
  )
}

function criteriaSection(result) {
  const rows = (result.score?.components ?? []).flatMap((component) => (
    (component.subcomponents ?? []).flatMap((sub) => (sub.criteria ?? []).map((criterion) => [
      criterion.id,
      sub.id,
      verdictCell(criterion.verdict),
      criterion.rationale ?? 'not observed',
      (criterion.evidence ?? []).join(' | '),
    ]))
  ))
  return section('Automated criteria', table(['Criterion', 'Subcomponent', 'Verdict', 'Rationale', 'Evidence'], rows))
}

function humanSection(result) {
  const review = result.human_review
  if (!review) return section('Human review', '<p class="empty">Human review has not been finalized.</p>')
  const responses = table(
    ['#', 'Question', 'Rating', 'Rationale'],
    (review.responses ?? []).map((response) => [
      response.number, response.question_text, `${response.rating} / 5`, response.rationale || '—',
    ]),
  )
  const subtotals = table(
    ['Dimension', 'Points', 'Possible'],
    (review.score?.subtotals ?? []).map((subtotal) => [
      subtotal.title, points(subtotal.points), subtotal.points_possible,
    ]),
  )
  const total = review.score
    ? `<p><strong>Human-review total:</strong> ${escapeHtml(points(review.score.total))} / `
      + `${escapeHtml(String(review.score.possible))} — component gate `
      + `${escapeHtml(review.score.gate_passed ? 'pass' : 'fail')}</p>`
    : ''
  return section('Human review', `${responses}${subtotals}${total}`)
}

function humanReviewSupersessionSection(result) {
  const review = result.human_review_supersession
  if (!review) return ''
  const history = result.human_review_history ?? []
  const supersessionHistory = result.human_review_supersession_history ?? []
  const rubric = (value) => [value?.rubric_id, value?.version].filter(Boolean).join(' ') || 'not available'
  return section(
    'Human-review supersession',
    table(['Field', 'Value'], [
      ['Approved by', review.approved_by],
      ['Approved at', review.approved_at],
      ['Prior rubric', rubric(review.prior_rubric)],
      ['Prior rubric SHA-256', review.prior_rubric?.sha256 ?? 'not available'],
      ['Reviewed rubric', rubric(review.reviewed_rubric)],
      ['Reviewed rubric SHA-256', review.reviewed_rubric?.sha256 ?? 'not available'],
      ['Prior human-review score', points(review.prior_human_score)],
      ['Revised human-review score', points(review.revised_human_score)],
      ['Prior official score', points(review.prior_official_score)],
      ['Revised official score', points(review.revised_official_score)],
      ['Rationale', review.rationale],
    ])
    + (history.length === 0
      ? ''
      : '<h3>Superseded human reviews</h3>'
        + table(
          ['Rubric', 'SHA-256', 'Score', 'Possible', 'Completed at'],
          history.map((prior) => [
            rubric(prior.rubric),
            prior.rubric?.sha256 ?? 'not available',
            points(prior.score?.total),
            points(prior.score?.possible),
            prior.completed_at ?? 'not available',
          ]),
        ))
    + (supersessionHistory.length === 0
      ? ''
      : '<h3>Earlier human-review supersessions</h3>'
        + table(
          ['Approved at', 'Prior human score', 'Revised human score', 'Rationale'],
          supersessionHistory.map((prior) => [
            prior.approved_at,
            points(prior.prior_human_score),
            points(prior.revised_human_score),
            prior.rationale,
          ]),
        )),
  )
}

function baselineSection(result) {
  const baseline = result.baseline
  if (!baseline) return ''
  if (!baseline.comparable) {
    return section(
      'Reference baseline',
      `<p>These runs cannot be compared directly: ${escapeHtml(baseline.reason ?? 'the rubrics do not match')}.</p>`,
    )
  }
  const totals = table(
    ['Measure', 'Baseline', 'Candidate', 'Delta'],
    [
      [
        `Shared score / ${baseline.denominator ?? 92}`,
        points(baseline.totals?.baseline),
        points(baseline.totals?.candidate),
        delta(baseline.totals?.delta),
      ],
      ['Human review', points(baseline.human_review?.baseline), points(baseline.human_review?.candidate), delta(baseline.human_review?.delta)],
      [
        'Implementation cost (USD)',
        // A reference baseline ran no implementation workflow, so its cost is
        // absent rather than zero and no delta is meaningful.
        baseline.implementation_cost?.baseline === null ? 'not applicable' : points(baseline.implementation_cost?.baseline),
        points(baseline.implementation_cost?.candidate),
        delta(baseline.implementation_cost?.delta),
      ],
    ],
  )
  const rows = (kind) => (baseline[kind] ?? []).map((row) => [
    row.id, row.title ?? '', points(row.baseline), points(row.candidate), delta(row.delta),
  ])
  return section(
    'Reference baseline comparison',
    `<p><strong>Baseline run:</strong> ${escapeHtml(baseline.baseline_run_id)}</p>`
    + `<p>Baseline values marked not applicable are absent, not zero: `
    + `${escapeHtml((baseline.not_applicable ?? []).join(', ') || 'none')}.</p>`
    + totals
    + table(['Component', 'Title', 'Baseline', 'Candidate', 'Delta'], rows('components'))
    + table(['Subcomponent', 'Title', 'Baseline', 'Candidate', 'Delta'], rows('subcomponents'))
    + table(
      ['Gate', 'Baseline', 'Candidate', 'Changed'],
      (baseline.gates ?? []).map((gate) => [gate.id, gate.baseline, gate.candidate, gate.changed ? 'yes' : 'no']),
    ),
  )
}

function availableSection(result) {
  const available = result.available_component_scores ?? []
  if (available.length === 0) return ''
  return section(
    'Available component scores',
    '<p>Completed components from an incomplete evaluation. They are preserved as evidence and are '
    + 'deliberately not summed into a score.</p>'
    + table(
      ['Component', 'Title', 'Awarded', 'Possible'],
      available.map((component) => [
        component.id, component.title ?? '', points(component.points_awarded), component.points_possible,
      ]),
    ),
  )
}

function artifactSection(result) {
  const artifacts = result.artifacts ?? []
  if (artifacts.length === 0) return section('Artifacts', '<p class="empty">Nothing recorded.</p>')
  const rows = artifacts
    .map(({ path, bytes }) => {
      const renderedPath = safeArtifactPath(path)
        ? `<a href="${escapeHtml(path)}">${escapeHtml(path)}</a>`
        : escapeHtml(path)
      return `<tr><td>${renderedPath}</td><td>${escapeHtml(bytes)}</td></tr>`
    })
    .join('\n')
  return section(
    'Artifacts',
    `<table><thead><tr><th>Path</th><th>Bytes</th></tr></thead><tbody>\n${rows}\n</tbody></table>`,
  )
}

function safeArtifactPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false
  const segments = path.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function assertMatchesCurrent(result, current) {
  const differing = OUTCOME_FIELDS.filter((field) => (current[field] ?? null) !== (result[field] ?? null))
  if (differing.length > 0) {
    throw new ReportConsistencyError(
      `the report would contradict result.json on ${differing.join(', ')}; refusing to publish the report`,
    )
  }
}

export function renderReport(result, { current = null } = {}) {
  if (current) assertMatchesCurrent(result, current)

  const label = result.label ?? 'EVALUATION FAILED'
  const body = [
    `<h1 class="${headlineClass(result)}">${escapeHtml(label)}</h1>`,
    summaryBlock(result),
    availableSection(result),
    componentSections(result),
    adjudicationSection(result),
    section(
      'Hard gates',
      table(
        ['Gate', 'Requirement', 'Verdict', 'Rationale', 'Evidence'],
        (result.score?.gates ?? []).map((gate) => [
          gate.id, gate.requirement ?? '', verdictCell(gate.verdict), gate.rationale ?? 'not observed',
          (gate.evidence ?? []).join(' | '),
        ]),
      )
      + table(
        ['Pass-contract failure', 'Identifier', 'Value', 'Required'],
        (result.score?.pass_failures ?? []).map((failure) => [
          failure.rule, failure.id ?? '', describe(failure.value), describe(failure.required),
        ]),
      ),
    ),
    criteriaSection(result),
    humanSection(result),
    humanReviewSupersessionSection(result),
    deliverySection(result),
    evidenceSection('Candidate-produced evidence', result.evidence?.candidate),
    evidenceSection('Evaluator-produced evidence', result.evidence?.evaluator),
    evidenceAuditSection(result),
    section(
      'Workflow and harness outcomes',
      table(['Field', 'Value'], keyValueRows(result.workflow))
      + table(['Harness', 'Value'], keyValueRows(result.score?.harness))
      + table(['Judge detail', 'Value'], keyValueRows(result.judging)),
    ),
    section('Agent roles and models', table(['Role', 'Selection'], keyValueRows(result.role_configuration))),
    implementationUsageSection(result),
    section('Pricing sources', table(['Field', 'Value'], keyValueRows(result.pricing))),
    section('Machine timing', table(['Field', 'Value'], keyValueRows(result.timing))),
    section('Completeness', table(['Dimension', 'State'], keyValueRows(result.completeness))),
    section('Ambiguity diagnostics', table(['Field', 'Value'], keyValueRows(result.ambiguity))),
    section(
      'Checkpoint and resume history',
      table(['State field', 'Value'], keyValueRows(result.run_state?.resume))
      + table(
        ['Event', 'Owner', 'Phase', 'Recorded at'],
        (result.run_state?.events ?? []).map((event) => [
          event.type, event.owner ?? '', event.phase ?? '', event.at ?? '',
        ]),
      ),
    ),
    baselineSection(result),
    section(
      // Plain language: a reader should not need the word "provenance" to know
      // which rubric, workflow, and revision produced this page.
      'Source and version details',
      table(
        ['Rubric', 'Identifier', 'Version', 'SHA-256'],
        Object.entries(result.rubrics ?? {}).map(([kind, rubric]) => [
          kind, rubric.rubric_id, rubric.version, rubric.sha256,
        ]),
      )
      + table(['Event', 'Status', 'Verdict'], (result.history ?? []).map((entry) => [
        entry.event, entry.evaluation_status, entry.product_verdict,
      ])),
    ),
    artifactSection(result),
  ].filter(Boolean).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>and-scene evaluation — ${escapeHtml(result.run_id)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${body}
</body>
</html>
`
}
