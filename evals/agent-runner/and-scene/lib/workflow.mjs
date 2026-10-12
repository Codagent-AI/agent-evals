// The evaluated Agent Runner workflow, treated as opaque.
//
// The harness knows three things about the workflow it evaluates: its logical
// reference, the parameters it declares, and the `codagent:*` skills its files
// name. It never depends on step identifiers, step order, nesting, named
// sessions, or recorded step paths. Delivery is established from Runner's
// completion status and the observable outputs the run leaves behind
// (lib/candidate.mjs), and roles from the agent Runner records for each attempt
// (lib/runner-metrics.mjs). Observed steps are recorded as data only.
//
// Agent Runner records a run under the `name` its resolved definition declares,
// not under the logical reference it was started with, so the harness keeps both
// identities and checks persisted runs against the expected declared name.
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const DEFAULT_WORKFLOW = 'core:plan-and-implement-change'

export const REQUIRED_WORKFLOW_PARAMETERS = [
  'change_name',
  'change_dir',
  'change_label',
  'change_kind',
  'artifact_validation_instruction',
  'skip_validator',
]

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/

export function parseLogicalWorkflowRef(ref) {
  const [namespace, name, ...rest] = typeof ref === 'string' ? ref.split(':') : []
  if (rest.length > 0 || !SEGMENT.test(namespace ?? '') || !SEGMENT.test(name ?? '')) {
    throw new Error(`invalid logical workflow reference: ${JSON.stringify(ref ?? null)}; expected <namespace>:<workflow>`)
  }
  return { namespace, name }
}

// Agent Runner resolves a logical reference to the latest versioned definition
// `workflows/<namespace>/<name>-v<major>.<minor>.yaml`. The checkout file found
// here is what the harness hashes and scans for skills; the controller then
// requires it to be byte-identical to what the installed CLI resolves.
export async function resolveWorkflowFile({ agentRunnerDir, workflow }) {
  const { namespace, name } = parseLogicalWorkflowRef(workflow)
  const directory = join(agentRunnerDir, 'workflows', namespace)
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return null
  }
  const versioned = new RegExp(`^${name}-v(\\d+)\\.(\\d+)\\.yaml$`)
  const candidates = entries.flatMap((entry) => {
    const match = entry.match(versioned)
    return match ? [{ entry, major: Number(match[1]), minor: Number(match[2]) }] : []
  })
  candidates.sort((left, right) => right.major - left.major || right.minor - left.minor)
  const chosen = candidates[0]?.entry ?? (entries.includes(`${name}.yaml`) ? `${name}.yaml` : null)
  return chosen ? `workflows/${namespace}/${chosen}` : null
}

function scalar(value) {
  // A quoted value keeps any '#' inside its quotes; only a trailing comment goes.
  const quoted = value.trim().match(/^(["'])(.*?)\1(?:\s+#.*)?$/)
  return quoted ? quoted[2] : value.replace(/\s+#.*$/, '').trim()
}

// A deliberately small reader for the two facts the harness depends on: the
// definition's top-level `name` and the parameter names it declares.
export function parseWorkflowDefinition(text) {
  let name = null
  const parameters = []
  let section = null
  for (const rawLine of String(text).split('\n')) {
    if (/^\S/.test(rawLine)) {
      const declaredName = rawLine.match(/^name:\s*(.+)$/)
      if (declaredName) name = scalar(declaredName[1]) || null
      section = /^(?:params|parameters):/.test(rawLine) ? 'parameters' : null
      continue
    }
    if (section !== 'parameters') continue
    const listed = rawLine.match(/^ {2}-\s+name:\s*(\S+)/)
    if (listed) { parameters.push(scalar(listed[1])); continue }
    const mapped = rawLine.match(/^ {2}([A-Za-z_][\w-]*):/)
    if (mapped) parameters.push(mapped[1])
  }
  return { name, parameters }
}

// Lead CLIs verified to run a step that requests the autonomous-interactive
// backend in the sandbox. Agent Runner hands such a step the terminal, and only
// Claude has been shown to complete one there without a human.
export const INTERACTIVE_LEAD_CLIS = new Set(['claude'])

const INTERACTIVE_BACKEND = /^\s*autonomous_backend:\s*["']?interactive["']?\s*(?:#.*)?$/m
const SUB_WORKFLOW = /^\s*workflow:\s*["']?([^"'\s#]+)/gm

// Whether any step of the workflow, or of a sub-workflow it references by file,
// requests the autonomous-interactive backend outright. `interactive-claude`
// falls back to headless for other CLIs, so it imposes no requirement. This is
// the one step-level fact the harness reads: it decides which lead CLIs can
// run the workflow at all, not how the run is judged.
export async function workflowRequestsInteractiveBackend(workflowPath) {
  let workflowsRoot = dirname(resolve(workflowPath))
  while (basename(workflowsRoot) !== 'workflows' && dirname(workflowsRoot) !== workflowsRoot) {
    workflowsRoot = dirname(workflowsRoot)
  }
  const pending = [resolve(workflowPath)]
  const visited = new Set()
  while (pending.length > 0) {
    const path = pending.pop()
    if (visited.has(path)) continue
    visited.add(path)
    let text
    try { text = await readFile(path, 'utf8') } catch { continue }
    if (INTERACTIVE_BACKEND.test(text)) return true
    for (const match of text.matchAll(SUB_WORKFLOW)) {
      const value = match[1]
      if (value.includes('{{') || value.includes('$')) continue
      pending.push(value.startsWith('builtin:')
        ? resolve(workflowsRoot, value.slice('builtin:'.length))
        : resolve(dirname(path), value))
    }
  }
  return false
}

export function verifyWorkflowInputs(text, { workflow = 'the evaluated workflow' } = {}) {
  const definition = parseWorkflowDefinition(text)
  const errors = []
  if (!definition.name) {
    errors.push(`workflow ${workflow} declares no name, so its Runner-reported identity is unknown`)
  }
  for (const parameter of REQUIRED_WORKFLOW_PARAMETERS) {
    if (!definition.parameters.includes(parameter)) {
      errors.push(`workflow ${workflow} lacks the ${parameter} parameter`)
    }
  }
  return { ok: errors.length === 0, errors, name: definition.name, parameters: definition.parameters }
}

export function resolveBoundary({
  skipValidator = false,
  changeName,
  workflow = DEFAULT_WORKFLOW,
  definitionSha256 = null,
  reportedName = null,
}) {
  const skip = String(Boolean(skipValidator))
  const mode = skip === 'true' ? 'skipped' : 'required'
  const workflowArguments = [
    `change_name=${changeName}`,
    `change_dir=openspec/changes/${changeName}`,
    'change_label=OpenSpec change',
    'change_kind=openspec',
    `artifact_validation_instruction=When an approved artifact changed, run \`openspec validate --type change "${changeName}"\`.`,
    `skip_validator=${skip}`,
  ]
  if (workflowArguments.some((argument) => argument.includes('{{'))) {
    throw new Error('workflow arguments cannot contain an unresolved placeholder')
  }
  return {
    workflow,
    runner_workflow_name: reportedName,
    workflow_sha256: definitionSha256,
    // Baseline identity compares `workflow_path`; the resolved-definition hash
    // distinguishes workflow versions without depending on a file layout.
    // Despite its name this is not a path: earlier results stored a relative
    // file path here, and keeping the field name lets the baseline refuse to
    // pair those results with these. The file path lives in
    // `provenance.workflow_path` (see lib/provenance.mjs), which is never
    // compared.
    workflow_path: definitionSha256,
    skip_validator: skip,
    // The evaluated workflow owns the meaning of skip_validator. The harness
    // records what it requested and never verifies it from step outcomes.
    validator_mode: mode,
    task_level_compliance: mode,
    final_validator: mode,
    workflow_arguments: workflowArguments,
  }
}

// The outer eval process restarting must never launch a second implementation
// run, so every recorded run resolves to wait, continue, resume, or error.
// `workflowName` is the name the resolved definition declares; a run is never
// accepted merely because its own reported name is self-consistent.
export function classifyRunnerRun({
  recorded,
  state,
  discovered,
  isProcessAlive,
  workflowName,
}) {
  if (typeof workflowName !== 'string' || workflowName === '') {
    throw new Error('classifying an Agent Runner run requires the expected Runner-reported workflow name')
  }
  // The controller can be interrupted after Agent Runner persisted a run but
  // before that identity reached the checkpoint. Adopt the persisted run rather
  // than starting a duplicate implementation workflow.
  if (!recorded?.run_id) {
    if (!discovered?.run_id) return { status: 'none', action: 'start', reason: null }
    return {
      ...classifyRunnerRun({
        recorded: { run_id: discovered.run_id },
        state: discovered,
        isProcessAlive,
        workflowName,
      }),
      adopted: true,
    }
  }

  if (!state) {
    return {
      status: 'unverifiable',
      action: 'error',
      reason: `cannot verify the status of recorded Agent Runner run ${recorded.run_id}`,
    }
  }
  if (state.run_id !== recorded.run_id) {
    return {
      status: 'unverifiable',
      action: 'error',
      reason: `Agent Runner state describes run ${state.run_id}, not recorded run ${recorded.run_id}`,
    }
  }
  if (state.workflow_name !== workflowName) {
    return {
      status: 'unverifiable',
      action: 'error',
      code: 'workflow-identity',
      reason: `Agent Runner run ${recorded.run_id} reports workflow ${state.workflow_name ?? 'none'}, not the expected ${workflowName}`,
    }
  }

  const lock = state.lock
  if (Number.isInteger(lock?.pid) && lock.pid > 0 && isProcessAlive(lock.pid)) {
    if (lock.run_id !== recorded.run_id) {
      return {
        status: 'unverifiable',
        action: 'error',
        reason: `active Agent Runner process owns run ${lock.run_id}, not recorded run ${recorded.run_id}`,
      }
    }
    return { status: 'active', action: 'wait', reason: null, run_id: recorded.run_id }
  }

  if (state.workflow_completed === true || state.completed === true) {
    return { status: 'completed', action: 'continue', reason: null, run_id: recorded.run_id }
  }

  return {
    status: 'inactive-unfinished',
    action: 'resume',
    reason: null,
    run_id: recorded.run_id,
    command: ['agent-runner', '--resume', recorded.run_id],
  }
}

function entryPath(entry) {
  if (typeof entry === 'string') return [entry]
  if (Array.isArray(entry?.step_path) && entry.step_path.length > 0) return entry.step_path
  const step = entry?.step ?? entry?.id ?? null
  return step ? [step] : []
}

// Observed steps are data for provenance and reports. The last observed leaf
// follows Runner's own path convention (a sub-workflow's children sit under
// `<step>, sub:<step>`), so a container's closing entry does not hide the leaf
// that ran inside it. Nothing here judges which steps should have run.
export function summarizeObservedSteps(history = []) {
  const paths = history.map(entryPath).filter((path) => path.length > 0)
  const leaves = paths.filter((path, index) => {
    const childPrefix = [...path, `sub:${path.at(-1)}`]
    return !paths.slice(0, index).some((earlier) => (
      childPrefix.every((segment, position) => earlier[position] === segment)
    ))
  })
  const last = leaves.at(-1) ?? null
  return {
    observed_steps: history,
    last_observed_step: last?.at(-1) ?? null,
    last_observed_step_path: last,
  }
}
