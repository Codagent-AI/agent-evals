import { join } from 'node:path'

import { hashJson, readJson, writeJsonAtomic } from './persistence.mjs'

export const REVIEW_HOLD_SCHEMA_VERSION = 1
export const REVIEW_HOLD_FILENAME = 'review-hold.json'

export function reviewHoldPath(runDir) {
  return join(runDir, REVIEW_HOLD_FILENAME)
}

export async function readReviewHold(runDir) {
  return readJson(reviewHoldPath(runDir), null)
}

// A different contradiction set belongs to a new scoring result.  Replacing
// the record (rather than mutating it) prevents an earlier release from
// silently releasing newly discovered disagreement.
export async function synchronizeReviewHold({ runDir, contradictions, now = () => new Date().toISOString() }) {
  const current = await readReviewHold(runDir)
  if (!contradictions?.length) return current
  const contradictions_sha256 = hashJson(contradictions)
  if (current?.contradictions_sha256 === contradictions_sha256) return current
  const hold = {
    schema_version: REVIEW_HOLD_SCHEMA_VERSION,
    contradictions_sha256,
    contradictions,
    raised_at: now(),
    release: null,
  }
  await writeJsonAtomic(reviewHoldPath(runDir), hold)
  return hold
}

export function reviewHoldProjection(hold) {
  if (!hold) return null
  return {
    active: hold.release === null,
    contradictions: hold.contradictions ?? [],
    release_command: 'review-hold.sh --run-dir PATH --reviewer NAME --decision stand|verdict-wrong --rationale TEXT',
    raised_at: hold.raised_at,
    release: hold.release,
    resolution: hold.resolution ?? null,
  }
}

export async function resolveReviewHold({ runDir, reviewer, decision, rationale, now = () => new Date().toISOString() }) {
  if (!reviewer?.trim()) throw new Error('--reviewer is required')
  if (!rationale?.trim()) throw new Error('--rationale is required')
  if (!['stand', 'verdict-wrong'].includes(decision)) throw new Error('--decision must be stand or verdict-wrong')
  const hold = await readReviewHold(runDir)
  if (!hold || hold.release !== null) throw new Error('run has no active review hold')
  if (hold.resolution?.decision === 'verdict-wrong') throw new Error('verdict-wrong review hold is terminal')
  const record = { reviewer: reviewer.trim(), time: now(), decision, rationale: rationale.trim() }
  const resolved = decision === 'stand'
    ? { ...hold, release: record }
    : { ...hold, resolution: record }
  await writeJsonAtomic(reviewHoldPath(runDir), resolved)
  return resolved
}
