# Agent Evals

Agent Evals contains evaluation suites for Codagent tools.

## Repository rules

- Keep suites under `evals/<product>/<suite>/`.
- Let each suite own its fixture pins, runner, evidence, scoring, and runbook.
- Do not introduce shared frameworks until at least two suites need the same behavior.
- Keep evaluated product infrastructure in the product repository. For Agent Runner, this includes the sandbox image, local build, authentication forwarding, and devcontainer.
- Use test-driven development for behavior changes. Run targeted tests, then `npm run check`.
- Do not add third-party runtime dependencies without explicit approval.
- Use `chrome-devtools-axi` when an agent needs to inspect or operate a browser. Prefer it over direct Chrome DevTools MCP use.

## Commit messages

Use `type: lowercase description` with one of: `fix`, `feat`, `chore`, `refactor`, `test`, or `docs`.
