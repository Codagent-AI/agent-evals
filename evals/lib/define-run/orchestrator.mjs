// Fine-grained resume planning for the run-state orchestrator.

export async function planReusableUnits({
  units,
  verify,
  provable = true,
}) {
  if (!provable) return { restart: true, reuse: [], run: [...units] }
  const reuse = []
  const run = []
  for (const unit of units) {
    const result = await verify(unit)
    ;(result.reusable ? reuse : run).push(unit)
  }
  return { restart: false, reuse, run }
}
