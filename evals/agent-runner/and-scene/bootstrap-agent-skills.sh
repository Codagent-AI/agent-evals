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
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
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
const text = readFileSync(workflowPath, 'utf8')
const skills = [...text.matchAll(/codagent:([a-z0-9][a-z0-9-]*)/g)]
  .map((match) => match[1])
console.log([...new Set(skills)].sort().join('\n'))
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
    *)
      echo "unsupported agent adapter for Codagent skills: $adapter" >&2
      exit 2
      ;;
  esac
done
