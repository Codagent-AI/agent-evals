# Agent Evals

Agent Evals contains reproducible evaluation suites for Codagent tools. Each
suite owns its fixture pins, runner, evidence collection, scoring, tests, and
operator documentation.

Suites are grouped by the product they evaluate:

```text
evals/
  agent-runner/
    and-scene/
```

The suites do not share a required scorer or result schema. Common conventions
can move to shared code after more than one suite proves they are actually
common.

## Agent Runner boundary

The `and-scene` suite evaluates Agent Runner against an external, commit-pinned
fixture. This repository owns the eval logic and artifacts. Agent Runner owns
the Docker image, local-source build, authentication forwarding, devcontainer,
and sandbox adapter.

Clone this repository next to Agent Runner, then read the
[`and-scene` runbook](evals/agent-runner/and-scene/README.md).

## Development

The repository has no third-party runtime dependencies. Run all checks with:

```bash
npm run check
```

Generated evaluation output is written under `artifacts/` and is ignored by
Git.
