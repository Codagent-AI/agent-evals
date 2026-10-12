---
name: Evaluation request
about: Request a configured and-scene evaluation
title: "Eval: "
labels: ["eval-request"]
type: Eval
---

<!-- The eval-request label is the explicit factory marker. Do not place credentials here. -->

Describe the change or comparison this evaluation should perform.

```eval
# Optional TOML overrides. Invalid values route for correction and are not executed.
agent_runner_ref = "main"
agent_skills_ref = "main"
# fixture_ref = "<and-scene branch, tag, or commit>"  # default: the agent-evals pin
# lead = "claude:claude-sonnet-5-5:high"        # default: factory [eval.defaults]
# crosscheck = "codex:gpt-6.1-sol:high"          # default: factory [eval.defaults]
# implementor = "codex:gpt-6-luna:medium"        # default: factory [eval.defaults]
# tester = "codex:gpt-6-luna:medium"             # default: factory [eval.defaults]
skip_validator = false
repetitions = 3
```
