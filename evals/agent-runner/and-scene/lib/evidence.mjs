// Ownership-separated acceptance evidence.
//
// Candidate files are copied as opaque bytes after delivery identity is known.
// Parsing below only adds evaluator findings; it never repairs or replaces the
// bytes a candidate produced.
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { hashJson, hashString, writeJsonAtomic } from './persistence.mjs'

export const CANDIDATE_EVIDENCE_SCHEMA_VERSION = 1
export const EVALUATOR_EVIDENCE_SCHEMA_VERSION = 1
export const CONTRADICTION_SCHEMA_VERSION = 1

export const EVIDENCE_ROLE_REGISTRY = [
  {
    role: 'acceptance-flow-record',
    required: true,
    multiple: false,
    aliases: [
      'acceptance-flow-evidence.md',
      'acceptance-test-results.md',
      'acceptance-flow.md',
      'acceptance-evidence.md',
      'flow-evidence.md',
    ],
  },
  {
    role: 'screenshot',
    required: true,
    multiple: true,
    aliases: ['*.png', '*.jpg', '*.jpeg', '*.webp'],
  },
  {
    role: 'screenshot-metadata',
    required: true,
    multiple: false,
    aliases: [
      'acceptance-test.md',
      'capture-metadata.json',
      'screenshot-metadata.json',
      'screenshot-manifest.json',
      'capture-manifest.json',
    ],
  },
  {
    role: 'findings-history',
    required: true,
    multiple: false,
    aliases: [
      'findings-history.md',
      'retest-history.md',
      'acceptance-findings.md',
      'findings.md',
      'acceptance-retest.md',
    ],
  },
  {
    role: 'final-handoff',
    required: true,
    multiple: false,
    aliases: [
      'acceptance-handoff.md',
      'final-acceptance-handoff.md',
      'acceptance-final-handoff.md',
      'final-handoff.md',
    ],
  },
  {
    role: 'assumptions-ledger',
    required: true,
    multiple: false,
    aliases: [
      'acceptance-assumptions.md',
      'assumptions-ledger.md',
      'acceptance-assumption-ledger.md',
      'assumptions.md',
    ],
  },
  {
    role: 'session-audit',
    required: false,
    multiple: true,
    aliases: [
      'session-report.md',
      'session-report.json',
      'assumption-audit.md',
      'context-gap-audit.md',
    ],
  },
]

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.log'])
const MAX_DISCOVERY_ENTRIES = 2000
const MAX_ARTIFACTS = 200
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

export class EvidenceReadinessError extends Error {
  constructor(message, missingRoles = []) {
    super(message)
    this.name = 'EvidenceReadinessError'
    this.code = 'missing-evidence-role'
    this.owner = 'implementation-workflow'
    this.resumable = true
    this.missing_roles = missingRoles
    this.missing_delivery_output = missingRoles
  }
}

function mediaType(path) {
  switch (extname(path).toLowerCase()) {
    case '.md': return 'text/markdown'
    case '.txt':
    case '.log': return 'text/plain'
    case '.json': return 'application/json'
    case '.yaml':
    case '.yml': return 'application/yaml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    default: return 'application/octet-stream'
  }
}

function roleFor(path) {
  const name = basename(path).toLowerCase()
  const extension = extname(name)
  for (const definition of EVIDENCE_ROLE_REGISTRY) {
    if (definition.role === 'screenshot' && IMAGE_EXTENSIONS.has(extension)) return definition.role
    if (definition.aliases.some((alias) => alias.toLowerCase() === name)) return definition.role
  }
  const normalized = path.split(sep).join('/').toLowerCase()
  if (/session-reports?\//.test(normalized) || /(?:session|assumption|context-gap)[-_]?audit/.test(name)) {
    return 'session-audit'
  }
  return null
}

async function walkFiles(root) {
  const output = []
  let visited = 0
  async function walk(directory, depth) {
    if (depth > 14 || output.length >= MAX_ARTIFACTS || visited >= MAX_DISCOVERY_ENTRIES) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw new Error(`failed to read evidence directory ${directory}`, { cause: error })
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      visited += 1
      if (visited > MAX_DISCOVERY_ENTRIES) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile()) output.push(path)
    }
  }
  await walk(root, 0)
  return output
}

function within(root, path) {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

async function canonicalRoots({ worktree, sessionDir }) {
  const roots = []
  for (const [namespace, path] of [
    ['candidate-worktree', worktree],
    ['runner-session', sessionDir],
  ]) {
    if (!path) continue
    let canonical
    try {
      canonical = await realpath(path)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`failed to resolve evidence root ${path}`, { cause: error })
      }
      canonical = resolve(path)
    }
    roots.push({ namespace, path: canonical })
  }
  return roots
}

async function safeOrigin(path, roots) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`failed to inspect evidence artifact ${path}`, { cause: error })
  }
  if (!info?.isFile() || info.isSymbolicLink()) return null
  let canonical
  try {
    canonical = await realpath(path)
  } catch (error) {
    throw new Error(`failed to resolve evidence artifact ${path}`, { cause: error })
  }
  const root = roots.find((candidate) => within(candidate.path, canonical))
  if (!root) return null
  return {
    namespace: root.namespace,
    root: root.path,
    absolute_path: canonical,
    relative_path: relative(root.path, canonical).split(sep).join('/'),
  }
}

function extractReferences(text) {
  const references = new Set()
  for (const match of text.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) references.add(match[1].trim())
  for (const match of text.matchAll(/(?:^|[\s"'`])((?:\.{0,2}\/)?[\w@%+.,/ -]+\.(?:md|json|png|jpe?g|webp|ya?ml|log))(?:$|[\s"'`)])/gim)) {
    references.add(match[1].trim())
  }
  return [...references].filter((value) => value && !/^(?:https?:|data:|#)/i.test(value))
}

function claimedRevision(text) {
  for (const label of [
    'Revision this combined coverage supports',
    'Current head SHA',
    'Final revision',
    'Head SHA',
    'Fix commit',
  ]) {
    const value = textField(text, label)
    const sha = value?.match(/\b([a-f0-9]{7,40})\b/i)?.[1]
    if (sha) return sha
  }
  const scoped = text.match(
    /(?:revision|commit|head|sha)(?:\s+(?:is|at))?\s*[:=`-]\s*([a-f0-9]{7,40}|absent|pending|unavailable)/i,
  )
  return scoped?.[1] ?? null
}

function coverageFrom(value) {
  const rows = []
  if (Array.isArray(value)) rows.push(...value)
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/^\s*(?:coverage|covered flows|requirements?)\s*:\s*([^\n]+)/gim)) {
      rows.push(...match[1].split(/[,;]/))
    }
  } else if (value && typeof value === 'object') {
    for (const field of ['coverage', 'covered_flows', 'flow', 'flows', 'requirements']) {
      if (Array.isArray(value[field])) rows.push(...value[field])
      else if (typeof value[field] === 'string') rows.push(value[field])
    }
  }
  return [...new Set(rows.map((entry) => String(entry).trim()).filter(Boolean))]
}

function ciClaims(text) {
  return text.split(/\r?\n/)
    .filter((line) => /\bCI\b|continuous integration|checks?\s+(?:pass|fail|pend|unavailable|absent)/i.test(line))
    .map((verbatim) => ({ verbatim, claimed_revision: claimedRevision(verbatim) }))
}

function textField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const value = text.match(
    new RegExp(`^\\s*(?:\\*\\*)?${escaped}\\s*:(?:\\*\\*)?\\s*(.+?)\\s*$`, 'im'),
  )?.[1]
  return value?.replace(/^\s*[`*]+|[`*]+\s*$/g, '').trim() ?? null
}

function listField(text, label) {
  const value = textField(text, label)
  return value ? value.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean) : []
}

function booleanField(text, label) {
  const value = textField(text, label)
  if (/^(?:true|yes|changed)$/i.test(value ?? '')) return true
  if (/^(?:false|no|unchanged)$/i.test(value ?? '')) return false
  return null
}

function normalizeLineageClaim(raw, fallback = {}) {
  const kind = String(raw?.kind ?? raw?.evidence_kind ?? fallback.kind ?? 'unknown')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/\s+/g, '-')
  return {
    kind,
    revision: raw?.revision ?? raw?.sha ?? fallback.revision ?? null,
    trustworthy: raw?.trustworthy ?? fallback.trustworthy ?? false,
    bounded_impact: raw?.bounded_impact ?? fallback.bounded_impact ?? false,
    affected_flows: [...(raw?.affected_flows ?? fallback.affected_flows ?? [])],
    dependent_flows: [...(raw?.dependent_flows ?? fallback.dependent_flows ?? [])],
    covered_flows: [...(raw?.covered_flows ?? raw?.coverage ?? fallback.covered_flows ?? [])],
    intervening_changes: [...(raw?.intervening_changes ?? fallback.intervening_changes ?? [])],
    tracked_product_changed: raw?.tracked_product_changed
      ?? fallback.tracked_product_changed
      ?? null,
  }
}

function flowIds(text, marker = null) {
  const ids = []
  for (const match of text.matchAll(/^##\s+Flow\s+(\d+)\b([^\n]*)$/gim)) {
    if (marker && !match[2].toLowerCase().includes(marker.toLowerCase())) continue
    ids.push(`flow-${Number(match[1])}`)
  }
  return [...new Set(ids)]
}

function section(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.match(
    new RegExp(`^##\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'im'),
  )?.[1] ?? ''
}

function sectionFlowIds(text, heading) {
  const body = section(text, heading)
  const ids = []
  for (const match of body.matchAll(/(?:\bFlow\s+|\|\s*\*\*)(\d+)\b/gi)) {
    ids.push(`flow-${Number(match[1])}`)
  }
  return [...new Set(ids)]
}

function mentionedPaths(text) {
  const paths = []
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1].trim()
    if (
      !/\s/.test(value)
      && !value.includes('*')
      && (
        value.includes('/')
        || /\.(?:[cm]?[jt]sx?|css|md|json|ya?ml|html|template)$/i.test(value)
      )
    ) {
      paths.push(value)
    }
  }
  if (/\bboth step templates\b/i.test(text)) paths.push('Step.tsx.template')
  return [...new Set(paths)]
}

function lineageClaims({
  role,
  text,
  parsed,
  revision,
  trustworthy,
  coverage,
  impactText = '',
}) {
  const structured = Array.isArray(parsed?.lineage)
    ? parsed.lineage
    : (Array.isArray(parsed?.lineage?.evidence) ? parsed.lineage.evidence : null)
  if (structured) {
    return structured.map((claim) => normalizeLineageClaim(claim, {
      revision,
      trustworthy,
      covered_flows: coverage,
    }))
  }
  if (role === 'acceptance-flow-record') {
    const baseline = textField(text, 'Full baseline')?.match(/\b([a-f0-9]{7,40})\b/i)?.[1] ?? null
    const scope = textField(text, 'Current verification scope')?.toLowerCase() ?? ''
    if (baseline && scope.includes('targeted') && revision) {
      const affectedFlows = sectionFlowIds(impactText, 'Flows the fix changes directly')
      const dependentFlows = sectionFlowIds(impactText, 'Directly dependent flows')
      return [
        normalizeLineageClaim({}, {
          kind: 'full-flow',
          revision: baseline,
          trustworthy,
          covered_flows: flowIds(text),
        }),
        normalizeLineageClaim({}, {
          kind: 'targeted',
          revision,
          trustworthy,
          bounded_impact: /##\s+Surfaces bounded out\b/i.test(impactText),
          affected_flows: affectedFlows,
          dependent_flows: dependentFlows,
          covered_flows: flowIds(text, '[TARGETED'),
          intervening_changes: mentionedPaths(impactText),
        }),
      ]
    }
  }
  const declared = textField(text, 'Verification kind') ?? textField(text, 'Evidence kind')
  let kind = declared
  if (!kind && role === 'acceptance-flow-record' && /\bfull[- ]flow\b/i.test(text)) kind = 'full-flow'
  if (!kind && role === 'acceptance-flow-record' && /\btargeted (?:verification|retest)\b|\btargeted\b/i.test(text)) {
    kind = 'targeted'
  }
  if (!kind && /\bexternal (?:state )?alignment\b|\bevidence-only alignment\b/i.test(text)) {
    kind = 'external-alignment'
  }
  if (!kind) return []
  return [normalizeLineageClaim({}, {
    kind,
    revision,
    trustworthy,
    bounded_impact: booleanField(text, 'Bounded impact') === true,
    affected_flows: listField(text, 'Affected flows'),
    dependent_flows: listField(text, 'Dependent flows'),
    covered_flows: coverage,
    intervening_changes: listField(text, 'Intervening changes'),
    tracked_product_changed: booleanField(text, 'Tracked product changed'),
  })]
}

function evidenceClaims(text, parsed) {
  const structured = Array.isArray(parsed?.claims)
    ? parsed.claims
    : (Array.isArray(parsed?.criteria) ? parsed.criteria : [])
  const claims = structured.flatMap((claim) => {
    if (!claim?.id || !['pass', 'fail'].includes(String(claim.verdict ?? claim.status).toLowerCase())) return []
    return [{
      id: String(claim.id),
      verdict: String(claim.verdict ?? claim.status).toLowerCase(),
      claim: String(claim.claim ?? claim.note ?? ''),
    }]
  })
  for (const match of text.matchAll(/^\s*[-|]?\s*([a-z][a-z0-9]+(?:-[a-z0-9]+)+)\s*(?:[|:]|—|-)\s*(pass(?:ed)?|fail(?:ed)?)\b(?:\s*(?:[|:]|—|-)\s*(.*))?$/gim)) {
    claims.push({
      id: match[1],
      verdict: match[2].toLowerCase().startsWith('pass') ? 'pass' : 'fail',
      claim: (match[3] ?? '').trim(),
    })
  }
  return claims
}

function finding(code, message, artifactId = null, details = {}) {
  return {
    id: `finding-${hashJson({ code, message, artifactId, details }).slice(0, 16)}`,
    code,
    message,
    artifact_id: artifactId,
    ...details,
  }
}

function artifactId(origin, role, bytes) {
  return `candidate-${hashJson({
    namespace: origin.namespace,
    relative_path: origin.relative_path,
    role,
    sha256: hashString(bytes),
  }).slice(0, 16)}`
}

async function discoverCandidateFiles({ worktree, sessionDir }) {
  const roots = await canonicalRoots({ worktree, sessionDir })
  const sessionOutput = sessionDir ? join(resolve(sessionDir), 'output') : null
  const scanned = []
  // The Runner-owned acceptance output is the discovery anchor. Candidate
  // worktree files enter only through safe references from that material, so
  // an unrelated product file with a familiar basename cannot satisfy a role.
  for (const root of [sessionOutput].filter(Boolean)) {
    scanned.push(...await walkFiles(root))
  }

  const findings = []
  const selected = new Map()
  for (const path of scanned) {
    const role = roleFor(path)
    if (!role) continue
    const origin = await safeOrigin(path, roots)
    if (!origin) {
      findings.push(finding('unsafe-artifact', `refused evidence outside an approved root: ${path}`))
      continue
    }
    const definition = EVIDENCE_ROLE_REGISTRY.find((entry) => entry.role === role)
    if (!definition.multiple && selected.has(role)) continue
    const bytes = await readFile(path)
    if (bytes.length === 0) continue
    selected.set(definition.multiple ? `${role}:${origin.namespace}:${origin.relative_path}` : role, {
      role,
      origin,
      bytes,
    })
  }

  const handoff = [...selected.values()].find(({ role }) => role === 'final-handoff')
  if (handoff) {
    const queued = [
      handoff,
      ...[...selected.values()].filter((entry) => entry !== handoff),
    ]
    const processed = new Set()
    while (queued.length > 0 && selected.size <= MAX_ARTIFACTS) {
      const source = queued.shift()
      const sourceKey = `${source.origin.namespace}:${source.origin.relative_path}`
      if (processed.has(sourceKey) || !TEXT_EXTENSIONS.has(extname(source.origin.relative_path).toLowerCase())) {
        continue
      }
      processed.add(sourceKey)
      const text = source.bytes.toString('utf8')
      for (const reference of extractReferences(text)) {
        const candidates = [
          resolve(dirname(source.origin.absolute_path), reference),
          ...(sessionOutput ? [resolve(sessionOutput, reference)] : []),
          resolve(worktree, reference),
        ]
        let accepted = false
        for (const path of candidates) {
          const origin = await safeOrigin(path, roots)
          if (!origin) continue
          const bytes = await readFile(path)
          if (bytes.length === 0) continue
          accepted = true
          const role = roleFor(path) ?? 'session-audit'
          const definition = EVIDENCE_ROLE_REGISTRY.find((entry) => entry.role === role)
          const key = definition?.multiple === false ? role : `${role}:${origin.namespace}:${origin.relative_path}`
          if (!selected.has(key)) {
            const discovered = { role, origin, bytes }
            selected.set(key, discovered)
            queued.push(discovered)
          }
          break
        }
        if (!accepted) {
          findings.push(finding(
            candidates.some((path) => roots.every((root) => !within(root.path, path)))
              ? 'unsafe-reference'
              : 'missing-reference',
            `candidate reference could not be safely resolved: ${reference}`,
            null,
            { reference },
          ))
        }
      }
    }
  }

  return { roots, selected: [...selected.values()], findings }
}

export async function buildCandidateEvidenceManifest({
  worktree,
  sessionDir,
  runDir,
  delivery,
}) {
  if (!delivery?.final_sha || delivery.pull_request?.head_sha !== delivery.final_sha) {
    throw new EvidenceReadinessError(
      'candidate evidence cannot be materialized without a verified matching final PR SHA',
      ['verified-delivery-identity'],
    )
  }

  const discovery = await discoverCandidateFiles({ worktree, sessionDir })
  const presentRoles = new Set(discovery.selected.map(({ role }) => role))
  const missingRoles = EVIDENCE_ROLE_REGISTRY
    .filter(({ required, role }) => required && !presentRoles.has(role))
    .map(({ role }) => role)
  if (missingRoles.length > 0) {
    throw new EvidenceReadinessError(
      `required candidate evidence roles are missing or unreadable: ${missingRoles.join(', ')}`,
      missingRoles,
    )
  }

  const root = join(resolve(runDir), 'evidence', 'candidate')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const findings = [...discovery.findings]
  const artifacts = []
  let totalBytes = 0
  let screenshotMetadata = null
  const impactText = discovery.selected
    .find(({ origin }) => basename(origin.relative_path).toLowerCase() === 'acceptance-impact-scope.md')
    ?.bytes.toString('utf8') ?? ''

  for (const source of discovery.selected.sort((left, right) => (
    `${left.role}:${left.origin.namespace}:${left.origin.relative_path}`
      .localeCompare(`${right.role}:${right.origin.namespace}:${right.origin.relative_path}`)
  ))) {
    if (source.bytes.length > MAX_ARTIFACT_BYTES || totalBytes + source.bytes.length > MAX_TOTAL_BYTES) {
      findings.push(finding(
        'artifact-bounds-exceeded',
        `candidate evidence exceeds the byte budget: ${source.origin.relative_path}`,
      ))
      continue
    }
    totalBytes += source.bytes.length
    const id = artifactId(source.origin, source.role, source.bytes)
    const filename = `${id}-${basename(source.origin.relative_path).replace(/[^a-zA-Z0-9._-]/g, '-')}`
    const destination = join(artifactRoot, filename)
    await writeFile(destination, source.bytes)

    let parsed = null
    let metadataError = null
    if (
      source.role === 'screenshot-metadata'
      && extname(source.origin.relative_path).toLowerCase() === '.json'
    ) {
      try {
        parsed = JSON.parse(source.bytes.toString('utf8'))
        screenshotMetadata = parsed
      } catch (error) {
        metadataError = error.message
        findings.push(finding(
          'malformed-metadata',
          `screenshot metadata is not valid JSON: ${error.message}`,
          id,
        ))
      }
    }
    const text = TEXT_EXTENSIONS.has(extname(source.origin.relative_path).toLowerCase())
      ? source.bytes.toString('utf8')
      : ''
    const references = extractReferences(text)
    const rawRevision = parsed?.revision ?? parsed?.sha ?? claimedRevision(text)
    const validRevision = typeof rawRevision === 'string'
      && /^[a-f0-9]{7,40}$/i.test(rawRevision)
    const revision = (
      validRevision
      && delivery.final_sha.toLowerCase().startsWith(rawRevision.toLowerCase())
    ) ? delivery.final_sha : rawRevision
    const verification = []
    if (rawRevision !== null && rawRevision !== undefined && !validRevision) {
      verification.push('malformed-revision')
    }
    if (revision && revision !== delivery.final_sha) verification.push('claimed-revision-mismatch')
    if (metadataError) verification.push('malformed-metadata')
    const verificationState = verification.length === 0 ? 'verified' : 'defective'
    artifacts.push({
      id,
      role: source.role,
      kind: source.role,
      ownership: 'candidate-produced',
      origin: {
        namespace: source.origin.namespace,
        relative_path: source.origin.relative_path,
      },
      path: relative(resolve(runDir), destination).split(sep).join('/'),
      media_type: mediaType(source.origin.relative_path),
      bytes: source.bytes.length,
      sha256: hashString(source.bytes),
      claimed_revision: revision ?? null,
      capture_metadata: source.role === 'screenshot-metadata' ? parsed : null,
      coverage: coverageFrom(parsed ?? text),
      references,
      verification_state: verificationState,
      limitations: verification,
      ci_claims: ciClaims(text).map((claim) => ({
        ...claim,
        claimed_revision: claim.claimed_revision ?? revision ?? null,
      })),
      lineage_claims: lineageClaims({
        role: source.role,
        text,
        parsed,
        revision,
        trustworthy: verificationState === 'verified',
        coverage: coverageFrom(parsed ?? text),
        impactText,
      }),
      claims: evidenceClaims(text, parsed),
    })
  }

  const materializedRoles = new Set(artifacts.map(({ role }) => role))
  const omittedRequiredRoles = EVIDENCE_ROLE_REGISTRY
    .filter(({ required, role }) => required && !materializedRoles.has(role))
    .map(({ role }) => role)
  if (omittedRequiredRoles.length > 0) {
    throw new EvidenceReadinessError(
      `required candidate evidence roles exceed materialization bounds: ${omittedRequiredRoles.join(', ')}`,
      omittedRequiredRoles,
    )
  }

  if (screenshotMetadata) {
    const captures = Array.isArray(screenshotMetadata.captures)
      ? screenshotMetadata.captures
      : (Array.isArray(screenshotMetadata.screenshots) ? screenshotMetadata.screenshots : [])
    const named = new Map(captures.map((capture) => [capture.path ?? capture.file ?? capture.filename, capture]))
    for (const artifact of artifacts.filter(({ role }) => role === 'screenshot')) {
      const metadata = [...named.entries()].find(([path]) => path && (
        path === artifact.origin.relative_path
        || basename(path) === basename(artifact.origin.relative_path)
      ))?.[1]
      if (!metadata) {
        artifact.verification_state = 'defective'
        artifact.limitations.push('missing-capture-metadata')
        findings.push(finding(
          'screenshot-metadata-inconsistent',
          `screenshot metadata does not describe ${artifact.origin.relative_path}`,
          artifact.id,
        ))
      } else {
        artifact.capture_metadata = metadata
        artifact.coverage = coverageFrom(metadata)
        const captureRevision = metadata.revision
          ?? metadata.sha
          ?? screenshotMetadata.revision
          ?? screenshotMetadata.sha
          ?? null
        for (const [code, absent] of [
          ['missing-capture-revision', captureRevision === null],
          ['capture-revision-mismatch', captureRevision !== null && captureRevision !== delivery.final_sha],
          ['missing-capture-flow', artifact.coverage.length === 0],
          ['missing-capture-state', !metadata.state],
        ]) {
          if (!absent) continue
          artifact.verification_state = 'defective'
          artifact.limitations.push(code)
          findings.push(finding(
            'screenshot-metadata-inconsistent',
            `screenshot metadata ${code.replaceAll('-', ' ')} for ${artifact.origin.relative_path}`,
            artifact.id,
          ))
        }
        if (metadata.sha256 && metadata.sha256 !== artifact.sha256) {
          artifact.verification_state = 'defective'
          artifact.limitations.push('recorded-hash-mismatch')
          findings.push(finding(
            'hash-mismatch',
            `recorded screenshot hash does not match ${artifact.origin.relative_path}`,
            artifact.id,
          ))
        }
      }
    }
  }

  const manifest = {
    schema_version: CANDIDATE_EVIDENCE_SCHEMA_VERSION,
    ownership: 'candidate-produced',
    readiness: 'ready',
    delivery: {
      final_sha: delivery.final_sha,
      pr_head_sha: delivery.pull_request.head_sha,
      branch: delivery.branch ?? null,
      pull_request: delivery.pull_request.url ?? delivery.pull_request.number ?? null,
    },
    role_registry: EVIDENCE_ROLE_REGISTRY.map(({ role, required, aliases }) => ({
      role, required, aliases,
    })),
    artifacts,
    findings,
    ci_claims: artifacts.flatMap(({ id, ci_claims: claims }) => (
      claims.map((claim) => ({ artifact_id: id, ownership: 'candidate-produced', ...claim }))
    )),
  }
  manifest.manifest_sha256 = hashJson(manifest)
  await writeJsonAtomic(join(root, 'manifest.json'), manifest)
  return manifest
}

export async function inspectCandidateEvidenceReadiness({ worktree, sessionDir }) {
  const discovery = await discoverCandidateFiles({ worktree, sessionDir })
  const presentRoles = new Set(discovery.selected.map(({ role }) => role))
  const missingRoles = EVIDENCE_ROLE_REGISTRY
    .filter(({ required, role }) => required && !presentRoles.has(role))
    .map(({ role }) => role)
  if (missingRoles.length > 0) {
    throw new EvidenceReadinessError(
      `required candidate evidence roles are missing or unreadable: ${missingRoles.join(', ')}`,
      missingRoles,
    )
  }
  return {
    artifacts: discovery.selected.map(({ role, origin, bytes }) => ({
      role: role === 'screenshot' ? 'acceptance-screenshot' : role,
      path: origin.absolute_path,
      sha256: hashString(bytes),
    })),
    findings: discovery.findings,
  }
}

function revisionNode(revisions, sha) {
  return revisions.find((revision) => revision.sha === sha) ?? null
}

function coversTargetedImpact(item) {
  if (item.bounded_impact !== true || !Array.isArray(item.intervening_changes) || item.intervening_changes.length === 0) {
    return false
  }
  const required = [...(item.affected_flows ?? []), ...(item.dependent_flows ?? [])]
  const covered = new Set(item.covered_flows ?? [])
  return required.length > 0 && required.every((flow) => covered.has(flow))
}

function testOnlyChange(path) {
  const name = basename(path)
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name)
    || /^(?:vitest|jest)\.config\.[cm]?[jt]s$/i.test(name)
    || /(?:^|\/)(?:test|tests|__tests__)\//i.test(path)
}

function declaredChange(path, declared) {
  return [...declared].some((entry) => {
    if (entry === path || path.endsWith(`/${entry}`)) return true
    if (entry.endsWith('/*')) {
      const prefix = entry.slice(0, -1)
      return path.startsWith(prefix) || path.includes(`/${prefix}`)
    }
    if (entry.endsWith('/')) return path.startsWith(entry) || path.includes(`/${entry}`)
    return false
  })
}

export function validateEvidenceLineage({ finalSha, revisions = [], evidence = [] }) {
  const findings = []
  const finalRevision = revisionNode(revisions, finalSha)
  const fullAtFinal = evidence.find((item) => (
    item.kind === 'full-flow' && item.revision === finalSha && item.trustworthy === true
  ))
  let accepted = false
  let mode = 'unsupported'
  if (fullAtFinal) {
    accepted = true
    mode = 'final-full-flow'
  } else {
    const baselines = evidence.filter((item) => {
      const revision = revisionNode(revisions, item.revision)
      return item.kind === 'full-flow'
        && item.trustworthy === true
        && item.revision !== finalSha
        && revision?.ancestor_of_final === true
    })
    const targeted = evidence.find((item) => (
      item.kind === 'targeted'
      && item.revision === finalSha
      && coversTargetedImpact(item)
    ))
    const alignment = evidence.find((item) => (
      item.kind === 'external-alignment'
      && item.revision === finalSha
      && item.tracked_product_changed === false
    ))
    if (baselines.length > 0 && targeted) {
      accepted = true
      mode = 'ancestor-plus-targeted'
    } else if (baselines.length > 0 && alignment) {
      accepted = true
      mode = 'evidence-only-alignment'
    }
  }

  if (!finalRevision) {
    findings.push(finding('final-revision-node-missing', `lineage has no final revision node for ${finalSha}`))
  } else if (finalRevision.ancestor_of_final === false) {
    findings.push(finding('final-revision-invalid', `lineage final node ${finalSha} is not accepted`))
  }
  if (!accepted) {
    findings.push(finding(
      'new-final-full-flow-required',
      'a trustworthy final full flow is required because bounded final-revision support was not established',
    ))
  }
  return {
    schema_version: 1,
    final_sha: finalSha,
    accepted: accepted && Boolean(finalRevision),
    final_revision_supported: accepted && Boolean(finalRevision),
    mode,
    revisions,
    evidence: evidence.map((item) => ({ ...item })),
    findings,
  }
}

export async function validateCandidateEvidenceLineage({
  finalSha,
  worktree,
  manifest,
  exec = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options }),
}) {
  let evidence = (manifest?.artifacts ?? []).flatMap((artifact) => (
    (artifact.lineage_claims ?? []).map((claim) => ({ id: artifact.id, ...claim }))
  ))
  const revisionShas = [...new Set([
    finalSha,
    ...evidence.map(({ revision }) => revision).filter((revision) => /^[a-f0-9]{40}$/i.test(revision ?? '')),
  ])]
  const revisions = revisionShas.map((sha) => {
    if (sha === finalSha) return { sha, ancestor_of_final: true }
    const ancestry = exec(
      'git',
      ['-C', worktree, 'merge-base', '--is-ancestor', sha, finalSha],
      { encoding: 'utf8' },
    )
    return { sha, ancestor_of_final: ancestry.status === 0 && !ancestry.error }
  })
  const baseline = evidence.find((item) => (
    item.kind === 'full-flow'
    && item.trustworthy === true
    && item.revision !== finalSha
    && revisions.find(({ sha }) => sha === item.revision)?.ancestor_of_final === true
  ))
  if (baseline) {
    const diff = exec(
      'git',
      ['-C', worktree, 'diff', '--name-only', '-z', baseline.revision, finalSha, '--'],
      { encoding: 'utf8' },
    )
    const changed = diff.status === 0 && !diff.error
      ? String(diff.stdout ?? '').split('\0').filter(Boolean)
      : null
    // Only exact harness-owned namespaces are non-product. Ordinary product
    // modules named evidence, delivery, or acceptance remain product changes.
    const productChanges = changed?.filter((path) => (
      !path.startsWith('.agent-runner/')
      && !path.startsWith('openspec/changes/')
    )) ?? null
    evidence = evidence.map((item) => {
      if (item.revision !== finalSha || !['targeted', 'external-alignment'].includes(item.kind)) {
        return item
      }
      if (item.kind === 'external-alignment') {
        return {
          ...item,
          tracked_product_changed: productChanges === null || productChanges.length > 0,
          observed_product_changes: productChanges,
        }
      }
      const declared = new Set(item.intervening_changes ?? [])
      const changesBounded = productChanges !== null
        && productChanges.length > 0
        && productChanges.every((path) => testOnlyChange(path) || declaredChange(path, declared))
      return {
        ...item,
        bounded_impact: item.bounded_impact === true && changesBounded,
        observed_product_changes: productChanges,
      }
    })
  }
  return validateEvidenceLineage({ finalSha, revisions, evidence })
}

export async function buildEvaluatorEvidenceManifest({
  runDir,
  finalSha,
  artifacts = [],
}) {
  const root = join(resolve(runDir), 'evidence', 'evaluator')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const records = []
  for (const [index, artifact] of artifacts.entries()) {
    const bytes = artifact.source_path
      ? await readFile(artifact.source_path)
      : Buffer.isBuffer(artifact.content)
        ? artifact.content
        : Buffer.from(String(artifact.content ?? ''))
    const id = artifact.id ?? `evaluator-${hashJson({
      index,
      kind: artifact.kind,
      sha256: hashString(bytes),
    }).slice(0, 16)}`
    const filename = `${String(index + 1).padStart(3, '0')}-${id.replace(/[^a-zA-Z0-9._-]/g, '-')}`
    const destination = join(artifactRoot, filename)
    await writeFile(destination, bytes)
    records.push({
      id,
      kind: artifact.kind ?? 'deterministic-evidence',
      ownership: 'evaluator-produced',
      path: relative(resolve(runDir), destination).split(sep).join('/'),
      media_type: artifact.media_type ?? mediaType(artifact.source_path ?? ''),
      bytes: bytes.length,
      sha256: hashString(bytes),
      revision: artifact.revision ?? finalSha,
      coverage: [...(artifact.coverage ?? [])],
      verification_state: artifact.verification_state ?? 'verified',
      limitations: [...(artifact.limitations ?? [])],
      claims: (artifact.claims ?? []).map((claim) => ({ ...claim })),
    })
  }
  const manifest = {
    schema_version: EVALUATOR_EVIDENCE_SCHEMA_VERSION,
    ownership: 'evaluator-produced',
    final_sha: finalSha,
    candidate_credit: 'prohibited',
    artifacts: records,
  }
  manifest.manifest_sha256 = hashJson(manifest)
  await writeJsonAtomic(join(root, 'manifest.json'), manifest)
  return manifest
}

export function detectEvidenceContradictions({ candidate, evaluator }) {
  const candidateClaims = (candidate?.artifacts ?? []).flatMap((artifact) => (
    (artifact.claims ?? []).map((claim) => ({ artifact, claim }))
  ))
  const evaluatorClaims = (evaluator?.artifacts ?? []).flatMap((artifact) => (
    artifact.verification_state === 'verified'
      ? (artifact.claims ?? []).map((claim) => ({ artifact, claim }))
      : []
  ))
  const contradictions = []
  for (const candidateEntry of candidateClaims) {
    if (candidateEntry.claim.verdict !== 'pass') continue
    for (const evaluatorEntry of evaluatorClaims) {
      if (
        evaluatorEntry.claim.id !== candidateEntry.claim.id
        || evaluatorEntry.claim.verdict !== 'fail'
      ) continue
      contradictions.push({
        candidate_id: candidateEntry.artifact.id,
        evaluator_id: evaluatorEntry.artifact.id,
        claim: candidateEntry.claim.claim || `${candidateEntry.claim.id} passed`,
        consequence: evaluatorEntry.claim.note
          ?? evaluatorEntry.claim.claim
          ?? `${candidateEntry.claim.id} was independently disproved`,
        coverage: [candidateEntry.claim.id],
      })
    }
  }
  return contradictions
}

export async function recordEvidenceContradictions({
  runDir,
  candidate,
  evaluator,
  contradictions = [],
}) {
  const candidateById = new Map((candidate?.artifacts ?? []).map((item) => [item.id, item]))
  const evaluatorById = new Map((evaluator?.artifacts ?? []).map((item) => [item.id, item]))
  const items = contradictions.map((entry) => {
    const candidateArtifact = candidateById.get(entry.candidate_id)
    const evaluatorArtifact = evaluatorById.get(entry.evaluator_id)
    if (!candidateArtifact || !evaluatorArtifact) {
      throw new Error('contradiction must cite existing candidate and evaluator evidence')
    }
    const item = {
      candidate: {
        id: candidateArtifact.id,
        ownership: 'candidate-produced',
        sha256: candidateArtifact.sha256,
      },
      evaluator: {
        id: evaluatorArtifact.id,
        ownership: 'evaluator-produced',
        sha256: evaluatorArtifact.sha256,
      },
      claim: String(entry.claim ?? ''),
      consequence: String(entry.consequence ?? ''),
      coverage: [...(entry.coverage ?? [])],
      scoring_effect: 'disproof-only',
    }
    return {
      id: `contradiction-${hashJson(item).slice(0, 16)}`,
      ...item,
    }
  })
  const record = {
    schema_version: CONTRADICTION_SCHEMA_VERSION,
    ownership_separated: true,
    items,
  }
  await mkdir(join(resolve(runDir), 'evidence', 'evaluator'), { recursive: true })
  await writeJsonAtomic(join(resolve(runDir), 'evidence', 'evaluator', 'contradictions.json'), record)
  return record
}

async function copyViewArtifacts({ runDir, root, artifacts }) {
  const copied = []
  for (const artifact of artifacts) {
    const source = join(resolve(runDir), artifact.path)
    const bytes = await readFile(source)
    if (hashString(bytes) !== artifact.sha256) {
      throw new Error(`candidate evidence changed before judge-view materialization: ${artifact.id}`)
    }
    const path = join(root, 'candidate', `${artifact.id}-${basename(artifact.path)}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    copied.push({
      ...artifact,
      path: relative(resolve(runDir), path).split(sep).join('/'),
    })
  }
  return copied
}

const JUDGE_PACKET_MAX_CHARS = 220_000
const JUDGE_PACKET_ARTIFACT_MAX_CHARS = 50_000
const TESTING_PACKET_ROLES = new Set([
  'acceptance-flow-record',
  'assumptions-ledger',
  'final-handoff',
  'findings-history',
  'screenshot-metadata',
  'session-audit',
])

async function evidenceJudgePacket({ runDir, index, artifacts }) {
  let packet = [
    '# BEGIN VERIFIED INDEX',
    JSON.stringify(index, null, 2),
    '# END VERIFIED INDEX',
  ].join('\n')
  if (packet.length > JUDGE_PACKET_MAX_CHARS) {
    throw new Error('verified evidence index exceeds the judge packet character budget')
  }
  for (const artifact of artifacts) {
    if (!String(artifact.media_type ?? '').startsWith('text/')) continue
    const prefix = `# BEGIN UNTRUSTED CANDIDATE ARTIFACT ${artifact.id} (${artifact.role})`
    const suffix = `# END UNTRUSTED CANDIDATE ARTIFACT ${artifact.id}`
    const wrapperChars = 2 + prefix.length + 1 + 1 + suffix.length
    const contentBudget = Math.min(
      JUDGE_PACKET_ARTIFACT_MAX_CHARS,
      JUDGE_PACKET_MAX_CHARS - packet.length - wrapperChars,
    )
    if (contentBudget <= 0) break

    const handle = await open(join(resolve(runDir), artifact.path), 'r')
    let content
    try {
      const buffer = Buffer.alloc(contentBudget)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      content = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    packet += `\n\n${prefix}\n${content}\n${suffix}`
  }
  if (packet.length > JUDGE_PACKET_MAX_CHARS) {
    throw new Error('verified evidence packet exceeds its character budget')
  }
  return packet
}

export async function materializeEvidenceJudgeViews({
  runDir,
  candidate,
  evaluator,
  contradictions,
  lineage,
}) {
  const runRoot = resolve(runDir)
  const viewsRoot = join(runRoot, 'evidence', 'judge-views')
  const testingRoot = join(viewsRoot, 'testing-evidence')
  const assumptionRoot = join(viewsRoot, 'assumption-handling')
  await mkdir(testingRoot, { recursive: true })
  await mkdir(assumptionRoot, { recursive: true })

  const testingArtifacts = await copyViewArtifacts({
    runDir,
    root: testingRoot,
    artifacts: candidate?.artifacts ?? [],
  })
  const testingIndex = {
    ownership_boundary: 'candidate evidence may support credit; evaluator evidence may only disprove it',
    permissions: {
      candidate_evidence: true,
      evaluator_evidence: 'contradictions-only',
      revision_provenance: true,
    },
    candidate: {
      ownership: 'candidate-produced',
      artifacts: testingArtifacts,
      findings: candidate?.findings ?? [],
      ci_claims: candidate?.ci_claims ?? [],
    },
    contradictions: contradictions?.items ?? [],
    lineage,
  }
  await writeJsonAtomic(join(testingRoot, 'index.json'), testingIndex)
  const testingPacket = await evidenceJudgePacket({
    runDir,
    index: testingIndex,
    artifacts: testingArtifacts.filter(({ role }) => TESTING_PACKET_ROLES.has(role)),
  })

  const assumptionRoles = [
    'assumptions-ledger',
    'final-handoff',
    'findings-history',
    'session-audit',
  ]
  const assumptionArtifacts = await copyViewArtifacts({
    runDir,
    root: assumptionRoot,
    artifacts: (candidate?.artifacts ?? []).filter(({ role }) => assumptionRoles.includes(role)),
  })
  const assumptionIndex = {
    ownership_boundary: 'untrusted candidate ambiguity sources',
    permissions: {
      candidate_evidence: 'assumption-sources-only',
      evaluator_evidence: false,
      revision_provenance: true,
    },
    candidate: {
      ownership: 'candidate-produced',
      artifacts: assumptionArtifacts,
    },
    lineage,
  }
  await writeJsonAtomic(join(assumptionRoot, 'index.json'), assumptionIndex)
  const assumptionPacket = await evidenceJudgePacket({
    runDir,
    index: assumptionIndex,
    artifacts: assumptionArtifacts,
  })

  return {
    'testing-evidence': {
      root: relative(runRoot, testingRoot).split(sep).join('/'),
      index: relative(runRoot, join(testingRoot, 'index.json')).split(sep).join('/'),
      permissions: testingIndex.permissions,
      packet: testingPacket,
    },
    'assumption-handling': {
      root: relative(runRoot, assumptionRoot).split(sep).join('/'),
      index: relative(runRoot, join(assumptionRoot, 'index.json')).split(sep).join('/'),
      permissions: assumptionIndex.permissions,
      roles: assumptionRoles,
      packet: assumptionPacket,
    },
  }
}

export function summarizeEvidenceManifest(manifest) {
  if (!manifest) return null
  return {
    ownership: manifest.ownership,
    readiness: manifest.readiness ?? 'complete',
    final_sha: manifest.delivery?.final_sha ?? manifest.final_sha ?? null,
    manifest_sha256: manifest.manifest_sha256 ?? null,
    ci_claims: manifest.ci_claims ?? [],
    artifacts: (manifest.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      ownership: artifact.ownership,
      sha256: artifact.sha256,
      revision: artifact.claimed_revision ?? artifact.revision ?? null,
      verification_state: artifact.verification_state,
      coverage: artifact.coverage ?? [],
      limitations: artifact.limitations ?? [],
    })),
  }
}
