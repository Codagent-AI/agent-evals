#!/usr/bin/env bash
# Install the exact Codagent skill checkout selected by the evaluation into
# every CLI that can participate in the implementation workflow.
set -euo pipefail

SOURCE_DIR="${1:?agent skills source directory is required}"
WORKFLOW_PATH="${2:?Agent Runner workflow path is required}"
shift 2

if [[ ! -d "$SOURCE_DIR/skills" ]]; then
  echo "Codagent skills directory does not exist: $SOURCE_DIR/skills" >&2
  exit 2
fi
if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "Agent Runner workflow does not exist: $WORKFLOW_PATH" >&2
  exit 2
fi
if (($# == 0)); then
  echo "At least one agent adapter is required for Codagent skill installation." >&2
  exit 2
fi

# The workflow is the contract for which Codagent skills must be available.
# Validate the pinned source before invoking any model so a missing skill cannot
# degrade into an agent-authored fallback with a different evidence contract.
required_skills="$(
  node - "$SOURCE_DIR" "$WORKFLOW_PATH" "$@" <<'NODE'
const { existsSync, readFileSync } = require('node:fs')
const { basename, dirname, resolve } = require('node:path')
const sourceDir = resolve(process.argv[2])
const workflowPath = process.argv[3]
const adapters = new Set(process.argv.slice(4))
const marketplacePath = resolve(sourceDir, '.claude-plugin/marketplace.json')
let marketplace
try {
  marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'))
} catch (error) {
  console.error(`Cannot read Codagent marketplace manifest: ${marketplacePath}: ${error.message}`)
  process.exit(2)
}
const plugin = marketplace.plugins?.find((entry) => entry?.name === 'codagent')
if (!plugin || typeof plugin.source !== 'string' || resolve(sourceDir, plugin.source) !== sourceDir) {
  console.error('Codagent marketplace plugin must resolve to the pinned source root.')
  process.exit(2)
}
// Claude discovers skills from the conventional root-level skills/ directory.
// Codex declares that directory explicitly, so verify its host-specific export
// before relying on the same required-skill files below.
if (adapters.has('codex')) {
  const codexManifestPath = resolve(sourceDir, '.codex-plugin/plugin.json')
  let codexManifest
  try {
    codexManifest = JSON.parse(readFileSync(codexManifestPath, 'utf8'))
  } catch (error) {
    console.error(`Cannot read Codex Codagent plugin manifest: ${codexManifestPath}: ${error.message}`)
    process.exit(2)
  }
  if (
    codexManifest.name !== 'codagent'
    || typeof codexManifest.skills !== 'string'
    || resolve(sourceDir, codexManifest.skills) !== resolve(sourceDir, 'skills')
  ) {
    console.error('Codex Codagent plugin must export the pinned skills root.')
    process.exit(2)
  }
}
// Cursor marketplace add requires a git URL. The evaluation has a pinned
// local checkout, so only verify the host-specific plugin identity here;
// the install step below links that exact tree into ~/.cursor/plugins.
if (adapters.has('cursor')) {
  const cursorManifestPath = resolve(sourceDir, '.cursor-plugin/plugin.json')
  let cursorManifest
  try {
    cursorManifest = JSON.parse(readFileSync(cursorManifestPath, 'utf8'))
  } catch (error) {
    console.error(`Cannot read Cursor Codagent plugin manifest: ${cursorManifestPath}: ${error.message}`)
    process.exit(2)
  }
  if (cursorManifest.name !== 'codagent') {
    console.error('Cursor Codagent plugin must declare name "codagent".')
    process.exit(2)
  }
}
// Follow file-relative sub-workflow references, such as the delegated
// verify-change workflow, so every skill a nested step names is validated too.
const skills = new Set()
const pending = [resolve(workflowPath)]
let workflowsRoot = dirname(resolve(workflowPath))
while (basename(workflowsRoot) !== 'workflows' && dirname(workflowsRoot) !== workflowsRoot) {
  workflowsRoot = dirname(workflowsRoot)
}
const hasWorkflowsRoot = basename(workflowsRoot) === 'workflows'
const visited = new Set()
while (pending.length > 0) {
  const path = pending.pop()
  if (visited.has(path)) continue
  visited.add(path)
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(/codagent:([a-z0-9][a-z0-9-]*)/g)) skills.add(match[1])
  for (const match of text.matchAll(/^\s*workflow:\s*[\x22\x27]?([^\x22\x27\s#]+)/gm)) {
    const value = match[1]
    if (value.includes('{{') || value.includes('${') || value.includes('$')) {
      console.error(`warning: unresolved templated sub-workflow reference ${value} in ${path}; skills in it are not checked`)
      continue
    }
    if (value.startsWith('builtin:') && !hasWorkflowsRoot) {
      console.error(`cannot root builtin sub-workflow ${value}: ${workflowPath} has no workflows ancestor`)
      process.exit(2)
    }
    const referenced = value.startsWith('builtin:')
      ? resolve(workflowsRoot, value.slice('builtin:'.length))
      : resolve(dirname(path), value)
    if (!existsSync(referenced)) {
      console.error(`missing sub-workflow ${value} referenced by ${path}`)
      process.exit(2)
    }
    pending.push(referenced)
  }
}
console.log([...skills].sort().join('\n'))
NODE
)"
while IFS= read -r skill; do
  [[ -z "$skill" ]] && continue
  if [[ ! -s "$SOURCE_DIR/skills/$skill/SKILL.md" ]]; then
    echo "missing required Codagent skill: $skill" >&2
    exit 2
  fi
done <<< "$required_skills"

seen=" "
for adapter in "$@"; do
  if [[ "$seen" == *" $adapter "* ]]; then
    continue
  fi
  seen+="$adapter "
  case "$adapter" in
    claude)
      # Host settings may name a local marketplace path that does not exist
      # inside the container. Replace only that disposable-home entry.
      claude plugin marketplace remove codagent >/dev/null 2>&1 || true
      claude plugin marketplace add "$SOURCE_DIR"
      claude plugin install codagent@codagent
      claude plugin list
      ;;
    codex)
      codex plugin marketplace add "$SOURCE_DIR" --json
      codex plugin add codagent@codagent --json
      codex plugin list
      ;;
    cursor)
      mkdir -p "$HOME/.cursor/plugins"
      # ln -sfn descends into an existing real directory and links inside it,
      # leaving the pinned source uninstalled at the expected path. Replace an
      # existing symlink, and refuse anything else rather than load stale plugins.
      cursor_plugin="$HOME/.cursor/plugins/codagent"
      if [[ -e "$cursor_plugin" && ! -L "$cursor_plugin" ]]; then
        echo "refusing to replace existing Cursor plugin path: $cursor_plugin" >&2
        exit 2
      fi
      rm -f "$cursor_plugin"
      ln -s "$SOURCE_DIR" "$cursor_plugin"
      ;;
    *)
      echo "unsupported agent adapter for Codagent skills: $adapter" >&2
      exit 2
      ;;
  esac
done
