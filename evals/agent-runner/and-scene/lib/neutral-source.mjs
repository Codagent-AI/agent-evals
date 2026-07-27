// Identity-neutral, immutable judge inputs.
//
// Product judges never receive the live candidate checkout. This module reads
// blobs from the verified final commit, filters known evaluation/workflow
// material, neutralizes identity-bearing path metadata, and records every
// transformation without modifying the delivered candidate.
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { hashJson, hashString, writeJsonAtomic } from './persistence.mjs'

export const NEUTRAL_INPUT_SCHEMA_VERSION = 2

const PLACEHOLDERS = {
  run: '<RUN_ID>',
  branch: '<BRANCH_ID>',
  pull_request: '<PULL_REQUEST_ID>',
  pr: '<PULL_REQUEST_ID>',
  baseline: '<BASELINE_ID>',
  candidate: '<CANDIDATE_ID>',
  change: '<CHANGE_ID>',
  evaluation: '<EVALUATION_ID>',
}

export const JUDGE_INPUT_POLICIES = Object.freeze({
  'demo-integration': {
    neutral_source: true,
    neutral_requirements: true,
    deterministic_facts: true,
    candidate_evidence: false,
    evaluator_evidence: false,
    revision_provenance: false,
    ambiguity_sources: false,
  },
  'scene-kit': {
    neutral_source: true,
    neutral_requirements: true,
    deterministic_facts: true,
    candidate_evidence: false,
    evaluator_evidence: false,
    revision_provenance: false,
    ambiguity_sources: false,
  },
  'presentation-skill': {
    neutral_source: true,
    neutral_requirements: true,
    deterministic_facts: true,
    candidate_evidence: false,
    evaluator_evidence: false,
    revision_provenance: false,
    ambiguity_sources: false,
  },
  'verification-tooling': {
    neutral_source: true,
    neutral_requirements: true,
    deterministic_facts: true,
    candidate_evidence: false,
    evaluator_evidence: false,
    revision_provenance: false,
    ambiguity_sources: false,
  },
  'testing-evidence': {
    neutral_source: false,
    neutral_requirements: false,
    deterministic_facts: false,
    candidate_evidence: true,
    evaluator_evidence: 'contradictions-only',
    revision_provenance: true,
    ambiguity_sources: false,
  },
  'assumption-handling': {
    neutral_source: false,
    neutral_requirements: true,
    deterministic_facts: 'consequences-only',
    candidate_evidence: 'assumption-sources-only',
    evaluator_evidence: false,
    revision_provenance: true,
    ambiguity_sources: true,
  },
  'ambiguity-diagnostics': {
    neutral_source: false,
    neutral_requirements: true,
    deterministic_facts: 'consequences-only',
    candidate_evidence: 'ambiguity-sources-only',
    evaluator_evidence: false,
    revision_provenance: true,
    ambiguity_sources: true,
  },
})

function gitBuffer(worktree, args, label) {
  const result = spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.status !== 0 || result.error) {
    const detail = Buffer.concat([
      Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(''),
      Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(''),
    ]).toString('utf8').trim()
    throw new Error(`${label} failed${detail ? `: ${detail.slice(0, 1000)}` : ''}`)
  }
  return result.stdout
}

function trackedEntries(worktree, finalSha) {
  const raw = gitBuffer(
    worktree,
    ['ls-tree', '-rz', '--full-tree', '-r', finalSha],
    'neutral source tree lookup',
  )
  return raw.toString('utf8').split('\0').filter(Boolean).map((row) => {
    const match = row.match(/^(\d+)\s+(\S+)\s+([a-f0-9]+)\t(.+)$/)
    if (!match) throw new Error(`cannot parse tracked source entry: ${row}`)
    return { mode: match[1], type: match[2], object: match[3], path: match[4] }
  })
}

function excludedSource(path, changeName) {
  const normalized = path.replaceAll('\\', '/')
  return normalized === '.git'
    || normalized.startsWith('.git/')
    || normalized === '.agent-runner'
    || normalized.startsWith('.agent-runner/')
    || normalized === `openspec/changes/${changeName}`
    || normalized.startsWith(`openspec/changes/${changeName}/`)
}

function requirementSource(path, changeName) {
  return path.startsWith(`openspec/changes/${changeName}/specs/`) && path.endsWith('/spec.md')
}

function exactTokenPattern(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return /^[a-zA-Z0-9]+$/.test(token)
    ? new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'g')
    : new RegExp(escaped, 'g')
}

function identityReplacements(identities, { pathSafe = false } = {}) {
  return Object.entries(identities ?? {})
    .flatMap(([type, values]) => (Array.isArray(values) ? values : [values])
      .filter((value) => value !== null && value !== undefined && String(value).length > 0)
      .map((value) => ({
        type,
        token: String(value),
        placeholder: pathSafe
          ? (PLACEHOLDERS[type] ?? `<${type.toUpperCase()}_ID>`)
              .replace(/[<>]/g, '__')
          : (PLACEHOLDERS[type] ?? `<${type.toUpperCase()}_ID>`),
      })))
    .sort((left, right) => right.token.length - left.token.length)
}

function redactPath(path, identities) {
  let output = path
  const transformations = []
  for (const replacement of identityReplacements(identities, { pathSafe: true })) {
    let count = 0
    output = output.replace(exactTokenPattern(replacement.token), () => {
      count += 1
      return replacement.placeholder
    })
    if (count > 0) {
      transformations.push({
        type: 'exact-identity-path-token-replacement',
        identity_type: replacement.type,
        placeholder: replacement.placeholder,
        occurrences: count,
        token_sha256: hashString(replacement.token),
      })
    }
  }
  return { path: output, transformations }
}

function redactContent(bytes, identities) {
  const text = bytes.toString('utf8')
  // Binary or otherwise non-UTF-8 source is never rewritten.
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { bytes, transformations: [] }
  let output = text
  const transformations = []
  for (const replacement of identityReplacements(identities, { pathSafe: true })
    .filter(({ token }) => token.length >= 6)) {
    let count = 0
    output = output.replace(exactTokenPattern(replacement.token), () => {
      count += 1
      return replacement.placeholder
    })
    if (count > 0) {
      transformations.push({
        type: 'exact-identity-content-token-replacement',
        identity_type: replacement.type,
        placeholder: replacement.placeholder,
        occurrences: count,
        token_sha256: hashString(replacement.token),
        behavioral_edit: false,
      })
    }
  }
  return { bytes: Buffer.from(output), transformations }
}

async function writeSnapshotFile(root, path, bytes) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return target
}

function normativeRequirements(bytes) {
  const text = bytes.toString('utf8')
  const first = text.search(/^## (?:ADDED|MODIFIED )?Requirements?\s*$/m)
  if (first === -1) return text
  const afterHeading = text.indexOf('\n', first)
  return text.slice(afterHeading + 1).replace(/^\s+|\s+$/g, '') + '\n'
}

export async function materializeNeutralInputs({
  worktree,
  runDir,
  finalSha,
  changeName,
  identities = {},
}) {
  if (!finalSha) throw new Error('neutral inputs require the verified final SHA')
  if (!changeName) throw new Error('neutral inputs require the approved change name')
  const runRoot = resolve(runDir)
  const neutralRoot = join(runRoot, 'neutral')
  const judgeRoot = join(neutralRoot, 'judge')
  const sourceRoot = join(judgeRoot, 'source')
  const requirementsRoot = join(judgeRoot, 'requirements')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(requirementsRoot, { recursive: true })

  const entries = trackedEntries(worktree, finalSha)
  const manifestEntries = []
  const requirements = []
  const includedPaths = new Set()

  for (const entry of entries) {
    if (entry.type !== 'blob' || !/^100[0-7]{3}$/.test(entry.mode)) continue
    const original = gitBuffer(
      worktree,
      ['cat-file', 'blob', `${finalSha}:${entry.path}`],
      `neutral source blob ${entry.path}`,
    )
    if (requirementSource(entry.path, changeName)) {
      requirements.push({ entry, original })
      continue
    }
    if (excludedSource(entry.path, changeName)) continue
    const neutralPath = redactPath(entry.path, identities)
    if (includedPaths.has(neutralPath.path)) {
      throw new Error(`identity redaction creates a neutral source path collision: ${neutralPath.path}`)
    }
    includedPaths.add(neutralPath.path)
    const neutralContent = redactContent(original, identities)
    await writeSnapshotFile(sourceRoot, neutralPath.path, neutralContent.bytes)
    manifestEntries.push({
      namespace: 'neutral-source',
      path: `source/${neutralPath.path}`,
      origin: { revision: finalSha, path: entry.path, object: entry.object },
      original_sha256: hashString(original),
      sha256: hashString(neutralContent.bytes),
      transformations: [...neutralPath.transformations, ...neutralContent.transformations],
    })
  }

  let requirementIndex = 0
  for (const { entry, original } of requirements.sort((left, right) => (
    left.entry.path.localeCompare(right.entry.path)
  ))) {
    requirementIndex += 1
    const path = `requirement-${String(requirementIndex).padStart(3, '0')}.md`
    // Requirement descriptions and scenarios are copied without behavioral
    // rewriting. Only an outer OpenSpec delta heading is omitted when present.
    const content = redactContent(Buffer.from(normativeRequirements(original)), identities)
    await writeSnapshotFile(requirementsRoot, path, content.bytes)
    manifestEntries.push({
      namespace: 'neutral-requirements',
      path: `requirements/${path}`,
      origin: { revision: finalSha, path: entry.path, object: entry.object },
      original_sha256: hashString(original),
      sha256: hashString(content.bytes),
      transformations: [
        ...(original.equals(Buffer.from(normativeRequirements(original)))
          ? []
          : [{ type: 'remove-openspec-delta-container-heading', behavioral_edit: false }]),
        ...content.transformations,
      ],
    })
  }

  const manifest = {
    schema_version: NEUTRAL_INPUT_SCHEMA_VERSION,
    source_revision: finalSha,
    source: {
      root: 'neutral/judge/source',
      content_sha256: hashJson(manifestEntries.filter(({ namespace }) => namespace === 'neutral-source')),
    },
    requirements: {
      root: 'neutral/judge/requirements',
      content_sha256: hashJson(manifestEntries.filter(({ namespace }) => namespace === 'neutral-requirements')),
    },
    entries: manifestEntries,
    exclusions: {
      git_metadata: true,
      original_change_directory: true,
      exact_harness_paths: ['.agent-runner', `openspec/changes/${changeName}`],
    },
  }
  manifest.manifest_sha256 = hashJson(manifest)
  const manifestPath = join(neutralRoot, 'provenance', 'manifest.json')
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeJsonAtomic(manifestPath, manifest)
  return {
    judge: { root: 'neutral/judge' },
    source: manifest.source,
    requirements: manifest.requirements,
    manifest,
    manifest_path: relative(runRoot, manifestPath).split(sep).join('/'),
  }
}
