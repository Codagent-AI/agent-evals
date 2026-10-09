// The job-filtered judging diagnostic.
//
// A maintainer judges only the named scored jobs against a retained run's
// verified inputs, under the current rubric and judging protocol, to calibrate
// a criterion or check known answers. Its directory records what it judged
// against before any judge runs, so a resume can refuse to blend judgings made
// against a different source, job list, expected-verdict file, or evaluator.
// Its results are diagnostics: no score, official result, or publication.
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { hashFile, hashJson, hashString, readJson, writeJsonAtomic } from './persistence.mjs'

export const DIAGNOSTIC_MODE = 'judge-diagnostic'
export const DIAGNOSTIC_SCHEMA_VERSION = 1
export const DIAGNOSTIC_FILE = 'diagnostic.json'
export const DIAGNOSTIC_RESULT_FILE = 'diagnostic-result.json'
export const EXPECTED_VERDICTS = ['pass', 'fail']

const diagnosticError = (code, message) => Object.assign(new Error(message), { code })

// Sorted, unique, and each a scored job this rubric applies, so `b,a` and
// `a,b,a` name the same diagnostic.
export function normalizeJudgeJobs(value, knownJobs) {
  const jobs = [...new Set(String(value ?? '').split(',').map((job) => job.trim()).filter(Boolean))].sort()
  if (jobs.length === 0) throw diagnosticError('invalid-arguments', '--judge-jobs names no judge job')
  const unknown = jobs.filter((job) => !knownJobs.includes(job))
  if (unknown.length > 0) {
    throw diagnosticError('invalid-arguments',
      `--judge-jobs names unknown scored judge jobs: ${unknown.join(', ')}; known: ${knownJobs.join(', ')}`)
  }
  return jobs
}

async function walk(root, prefix, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const offset = relative(root, path).split(sep).join('/')
    // Published results are historical output, not evaluator code; Finder
    // metadata changes without anyone editing the evaluator.
    if (offset === 'results' || entry.name === '.DS_Store') continue
    if (entry.isDirectory()) {
      await walk(root, prefix, path, files)
    } else if (entry.isSymbolicLink()) {
      files.push({ path: `${prefix}/${offset}`, sha256: hashString(`symlink:${await readlink(path)}`) })
    } else if (entry.isFile()) {
      files.push({ path: `${prefix}/${offset}`, sha256: hashString(await readFile(path)) })
    }
  }
}

// A sorted manifest of every evaluator file and its SHA-256, committed or not:
// the shared panel library and the whole suite (controller, prompts, rubrics,
// and the fixture snapshot judges read), excluding published results.
// `roots` maps a repository-relative prefix to the directory it names.
export async function evaluatorContentManifest(roots) {
  const files = []
  for (const [prefix, root] of Object.entries(roots)) {
    const stat = await lstat(root).catch(() => null)
    if (!stat?.isDirectory()) throw diagnosticError('evaluator-content', `evaluator root ${prefix} is not a directory: ${root}`)
    await walk(root, prefix, root, files)
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { sha256: hashJson(files), files }
}

// The expected-verdict file: { "<source-run-id>": { "<criterion>": "pass" | "fail" } }.
export function validateExpectedVerdicts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw diagnosticError('invalid-expected', 'the expected-verdict file must be a JSON object keyed by source run id')
  }
  for (const [runId, criteria] of Object.entries(value)) {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw diagnosticError('invalid-expected', `expected verdicts for ${runId} must be an object keyed by criterion`)
    }
    for (const [criterion, verdict] of Object.entries(criteria)) {
      if (!EXPECTED_VERDICTS.includes(verdict)) {
        throw diagnosticError('invalid-expected', `expected verdict for ${runId} ${criterion} must be pass or fail: ${verdict}`)
      }
    }
  }
  return value
}

export async function readExpectedFile(path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw diagnosticError('invalid-expected', `cannot read the expected-verdict file ${path}: ${error.message}`)
  }
  return { path, sha256: hashString(bytes), bytes }
}

export function parseExpectedFile(expected) {
  let parsed
  try {
    parsed = JSON.parse(expected.bytes.toString('utf8'))
  } catch (error) {
    throw diagnosticError('invalid-expected', `the expected-verdict file ${expected.path} is not valid JSON: ${error.message}`)
  }
  return validateExpectedVerdicts(parsed)
}

// The source's expected verdicts must exist and name only criteria the
// selected jobs judge, or the comparison could never report a match.
export function expectedForSource(verdicts, sourceRunId, judgedCriteria) {
  const expected = verdicts[sourceRunId]
  if (!expected || Object.keys(expected).length === 0) {
    throw diagnosticError('invalid-expected', `the expected-verdict file has no verdicts for source run ${sourceRunId}`)
  }
  const unjudged = Object.keys(expected).filter((criterion) => !judgedCriteria.includes(criterion))
  if (unjudged.length > 0) {
    throw diagnosticError('invalid-expected',
      `expected verdicts for ${sourceRunId} name criteria the selected jobs do not judge: ${unjudged.join(', ')}`)
  }
  return expected
}

// The fields a resume must reproduce exactly, in the order they are reported.
export const DIAGNOSTIC_IDENTITY_FIELDS = [
  'judge_jobs',
  'source',
  'expected_sha256',
  'evaluator_commit',
  'evaluator_content_sha256',
  'rubric_sha256',
  'judge_profiles',
]

function identityValue(identity, field) {
  if (field === 'source') {
    return identity.source ? { path: identity.source.path, provenance_sha256: identity.source.provenance_sha256 } : null
  }
  if (field === 'expected_sha256') return identity.expected?.sha256 ?? null
  return identity[field] ?? null
}

export function compareDiagnosticIdentity(recorded, current) {
  const mismatches = []
  for (const field of DIAGNOSTIC_IDENTITY_FIELDS) {
    const before = identityValue(recorded, field)
    const now = identityValue(current, field)
    if (hashJson(before) === hashJson(now)) continue
    let detail = ''
    if (field === 'evaluator_content_sha256') {
      const old = new Map((recorded.evaluator_content_manifest ?? []).map(({ path, sha256 }) => [path, sha256]))
      const fresh = new Map((current.evaluator_content_manifest ?? []).map(({ path, sha256 }) => [path, sha256]))
      const changed = [...new Set([...old.keys(), ...fresh.keys()])].filter((path) => old.get(path) !== fresh.get(path)).sort()
      if (changed.length > 0) detail = `; changed files: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}`
    }
    mismatches.push({
      field,
      recorded: before,
      current: now,
      message: `the diagnostic was recorded with a different ${field}; resume refused before reusing any judging${detail}`,
    })
  }
  return mismatches
}

export function diagnosticRecord(identity) {
  return {
    schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    mode: DIAGNOSTIC_MODE,
    ...identity,
    expected: { path: identity.expected.path, sha256: identity.expected.sha256 },
  }
}

export async function readDiagnostic(runDir) {
  return readJson(join(runDir, DIAGNOSTIC_FILE), null)
}

export async function writeDiagnostic(runDir, identity) {
  return writeJsonAtomic(join(runDir, DIAGNOSTIC_FILE), diagnosticRecord(identity))
}

// Each judged criterion's verdict and judging basis, by job.
export function diagnosticVerdicts(judging) {
  const verdicts = {}
  for (const [job, results] of Object.entries(judging?.judges ?? {})) {
    if (!Array.isArray(results)) continue
    const bases = new Map((judging.consensus?.[job] ?? []).map(({ id, basis }) => [id, basis]))
    for (const result of results) {
      const basis = bases.get(result.id)
        ?? (result.evidence ?? []).find((item) => String(item).startsWith('judging basis: '))?.slice('judging basis: '.length)
        ?? null
      verdicts[result.id] = { job, verdict: result.verdict, basis }
    }
  }
  return verdicts
}

export function diagnosticStatus({ outcome = null, errors = [] } = {}) {
  if (errors.some(({ code }) => code === 'invalid-rescore-source')) return 'unloadable'
  if (outcome?.product_failure) return 'unloadable'
  if (errors.length > 0 || outcome?.failure) return 'failed'
  return 'complete'
}

export async function writeDiagnosticResult(runDir, value) {
  return writeJsonAtomic(join(runDir, DIAGNOSTIC_RESULT_FILE), {
    schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    mode: DIAGNOSTIC_MODE,
    // A calibration diagnostic is never an official result, score, or verdict.
    official: false,
    ...value,
  })
}

// The comparison of each repeat's verdicts with the expected file. Every
// directory must have recorded this exact file's hash; a single mismatch
// refuses the whole comparison rather than report matches against an edit.
export async function compareDiagnostics({ expectedPath, runDirs }) {
  const expectedSha = await hashFile(expectedPath)
  if (expectedSha === null) throw diagnosticError('invalid-expected', `the expected-verdict file does not exist: ${expectedPath}`)
  const expected = validateExpectedVerdicts(JSON.parse(await readFile(expectedPath, 'utf8')))
  const runs = []
  for (const runDir of runDirs) {
    const diagnostic = await readDiagnostic(runDir)
    if (diagnostic?.mode !== DIAGNOSTIC_MODE) {
      throw diagnosticError('not-a-diagnostic', `${runDir} is not a judge diagnostic directory (no ${DIAGNOSTIC_FILE})`)
    }
    if (diagnostic.expected?.sha256 !== expectedSha) {
      throw diagnosticError('expected-hash-mismatch',
        `${runDir} recorded expected-verdict SHA-256 ${diagnostic.expected?.sha256 ?? null}, but ${expectedPath} is ${expectedSha}; refusing to report matches against a changed file`)
    }
    runs.push({ runDir, diagnostic, result: await readJson(join(runDir, DIAGNOSTIC_RESULT_FILE), null) })
  }
  const repeats = new Map()
  const rows = []
  for (const { runDir, diagnostic, result } of runs) {
    const source = diagnostic.source?.run_id ?? null
    const repeat = (repeats.get(source) ?? 0) + 1
    repeats.set(source, repeat)
    const wanted = expected[source] ?? {}
    const verdicts = result?.verdicts ?? {}
    const status = result?.status ?? 'incomplete'
    for (const criterion of [...new Set([...Object.keys(verdicts), ...Object.keys(wanted)])].sort()) {
      const judged = verdicts[criterion] ?? null
      const want = wanted[criterion] ?? null
      rows.push({
        source, repeat, run_dir: runDir, status, criterion,
        job: judged?.job ?? null,
        verdict: judged?.verdict ?? null,
        basis: judged?.basis ?? null,
        expected: want,
        match: want === null ? null : judged?.verdict === want,
      })
    }
    if (Object.keys(verdicts).length === 0 && Object.keys(wanted).length === 0) {
      rows.push({ source, repeat, run_dir: runDir, status, criterion: null, job: null, verdict: null, basis: null, expected: null, match: null })
    }
  }
  const expectedRows = rows.filter(({ expected: want }) => want !== null)
  return {
    expected: { path: expectedPath, sha256: expectedSha },
    rows,
    summary: {
      judged: rows.filter(({ verdict }) => verdict !== null).length,
      expected: expectedRows.length,
      matched: expectedRows.filter(({ match }) => match === true).length,
      mismatched: expectedRows.filter(({ match, verdict }) => match === false && verdict !== null).length,
      unjudged: expectedRows.filter(({ verdict }) => verdict === null).length,
    },
  }
}

export function renderDiagnosticComparison(report) {
  const lines = [
    `expected verdicts: ${report.expected.path} (sha256 ${report.expected.sha256})`,
    ['source', 'repeat', 'status', 'criterion', 'verdict', 'basis', 'expected', 'match'].join('\t'),
  ]
  for (const row of report.rows) {
    lines.push([
      row.source, row.repeat, row.status, row.criterion ?? '-', row.verdict ?? '-', row.basis ?? '-',
      row.expected ?? '-', row.match === null ? '-' : row.match ? 'yes' : 'NO',
    ].join('\t'))
  }
  const { judged, expected, matched, mismatched, unjudged } = report.summary
  lines.push(`judged ${judged}; expected ${expected}: matched ${matched}, mismatched ${mismatched}, unjudged ${unjudged}`)
  return `${lines.join('\n')}\n`
}
