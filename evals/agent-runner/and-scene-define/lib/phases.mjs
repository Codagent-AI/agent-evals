// Registrations may be added independently, but never bypass a missing predecessor.
export const AUTOMATED_PHASES = ['preflight', 'materialization', 'define-workflow', 'artifact-collection', 'conversation-reconciliation', 'contamination-audit', 'disclosure-audit', 'gates-and-judging', 'discovery', 'metrics', 'result-and-report', 'publication']
export async function runPhases({ handlers, execute = async (name, handler) => handler(), phases = AUTOMATED_PHASES }) {
  const completed = []
  for (const name of phases) {
    if (!handlers[name]) return { completed, missing: phases.filter(phase => !handlers[phase]), blocked: name }
    const result = await execute(name, handlers[name])
    completed.push(name)
    if (result?.stop) return { completed, missing: [], blocked: null, outcome: result.outcome }
  }
  return { completed, missing: [], blocked: null }
}
