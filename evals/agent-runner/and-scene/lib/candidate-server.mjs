// Candidate-server identity and lifecycle.
//
// The reviewer must see the same candidate revision the automated rubric and
// the judges scored, and a run directory outlives the process that created it.
// So a recorded server is only ever reused — or stopped — when both its process
// and its endpoint prove it is still that server for that candidate.
//
// A recycled process identifier and an occupied port are the two ways this goes
// wrong in practice. Neither is treated as proof here: an unverified process is
// left running and untouched, and a new server is started somewhere safe.

export class CandidateServerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CandidateServerError'
    this.code = 'candidate-server-unavailable'
  }
}

// Ask the endpoint itself which candidate it serves. A probe that refuses,
// answers for another candidate, or throws all mean the same thing: this is not
// the recorded server, and nothing may be concluded about the process behind it.
async function verify({ server, candidate, isProcessAlive, probe }) {
  if (!server?.pid || !server?.url) return { verified: false, reason: 'no candidate server is recorded' }
  if (!isProcessAlive(server.pid)) {
    return { verified: false, reason: `the recorded candidate server (pid ${server.pid}) is not running` }
  }
  let answer
  try {
    answer = await probe(server.url)
  } catch (error) {
    return { verified: false, reason: `the recorded candidate server did not respond: ${error.message}` }
  }
  if (!answer?.ok) {
    return {
      verified: false,
      reason: `the recorded endpoint does not serve the evaluated candidate: ${answer?.error ?? 'no response'}`,
    }
  }
  if (candidate !== undefined && answer.candidate_identity !== candidate) {
    return {
      verified: false,
      reason: 'the recorded endpoint does not serve the evaluated candidate: '
        + `it serves ${answer.candidate_identity ?? 'an unidentified candidate'}`,
    }
  }
  return { verified: true, reason: null }
}

export async function ensureCandidateServer({ recorded, candidate, isProcessAlive, probe, start }) {
  const existing = await verify({ server: recorded, candidate, isProcessAlive, probe })
  if (existing.verified) {
    return { action: 'reused', reason: null, server: { ...recorded, candidate_identity: candidate } }
  }

  // The recorded process is never terminated here. Whatever now owns that pid or
  // port is not ours, so the starter picks its own endpoint instead.
  const started = await start({ candidate, avoid: recorded?.url ?? null })
  const check = await verify({ server: started, candidate, isProcessAlive, probe })
  if (!check.verified) {
    throw new CandidateServerError(
      `cannot serve the evaluated candidate for human review: ${check.reason}`,
    )
  }
  return {
    action: 'started',
    reason: existing.reason,
    server: { ...started, candidate_identity: candidate },
  }
}

export async function stopCandidateServer({ recorded, isProcessAlive, probe, stop }) {
  if (!recorded?.pid || !recorded?.url) {
    return { completed: true, action: 'already-stopped', reason: null, error: null }
  }
  if (!isProcessAlive(recorded.pid)) {
    return { completed: true, action: 'already-stopped', reason: null, error: null }
  }

  const check = await verify({
    server: recorded,
    candidate: recorded.candidate_identity,
    isProcessAlive,
    probe,
  })
  if (!check.verified) {
    // Refusing to kill an unverified process is the whole point: a recycled pid
    // must never cost someone an unrelated process.
    return { completed: false, action: 'skipped', reason: check.reason, error: null }
  }

  try {
    await stop(recorded)
  } catch (error) {
    return { completed: false, action: 'failed', reason: null, error: error.message }
  }
  return { completed: true, action: 'stopped', reason: null, error: null }
}
