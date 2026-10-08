# evaluation-isolation Specification

## Purpose
TBD - created by archiving change eval-the-whole-workflow. Update Purpose after archive.
## Requirements
### Requirement: Hidden material is not mounted
The evaluated environment SHALL contain only the materialized starting repository and the runtime the evaluated workflow needs. The fixture change, the reference implementation, the hidden-reference inventory, the rubric, calibration inputs, the suite's data, and earlier results SHALL NOT be mounted into or readable from it.

#### Scenario: Suite data is absent from the sandbox
- **WHEN** the evaluated sandbox starts
- **THEN** none of the suite's hidden-reference, inventory, rubric, calibration, or result paths is present in its filesystem

### Requirement: Pinned contamination patterns
The suite SHALL pin a versioned list of contamination patterns: the fixture and evaluation repositories' qualified names and URLs, the reference implementation's location, hidden paths, and canary phrases taken from the hidden reference that are distinctive enough not to arise in an independent definition. Patterns SHALL be qualified rather than bare words. Path patterns SHALL match a distinctive fragment of the path, such as the exchange directory with its request or reply file suffix, so that a relative or alternate spelling of the path is also matched. The suite's tests SHALL verify that the list produces no match on the starting environment or on a recorded clean run. The pattern-list version SHALL be part of the series identity.

#### Scenario: Pattern matches the clean baseline
- **WHEN** a pattern matches the starting environment or the recorded clean run
- **THEN** the suite's tests fail and name the pattern and the matched location

### Requirement: Canary check
After the starting environment is materialized and before the evaluated sandbox starts, the harness SHALL search every file that will be mounted or copied into the evaluated environment, including the starting repository, the staged sandbox input, the Agent Skills checkout to be installed, and any forwarded credential or configuration file, for the contamination patterns. The search SHALL run outside the evaluated environment, and the pattern list SHALL NOT enter it. A match SHALL stop the run with `evaluation_status=evaluation-harness-failed` before any evaluated model call and SHALL identify the pattern and location.

#### Scenario: Setup leaks a canary phrase
- **WHEN** a canary phrase is found in a file the evaluated agent can read
- **THEN** the run stops before the define workflow with `evaluation-harness-failed` and reports the phrase and file

#### Scenario: Forwarded configuration names the fixture
- **WHEN** a configuration file that would be forwarded into the sandbox names the fixture repository
- **THEN** the run stops before the sandbox starts with `evaluation-harness-failed` and reports the file and pattern

### Requirement: Contamination audit
After artifact collection, the harness SHALL scan every retained lead and crosscheck tool call, including shell commands, file reads, web fetches, and web searches, matching both the call's input and its output against the contamination patterns. Repository, URL, skill, plugin, and path patterns SHALL match every call's input and output. Because the simulated user legitimately discloses reference content, canary phrases SHALL be narrower: a canary phrase that occurs in any simulated-user reply in the run's conversation SHALL be excluded for that run, and the remaining canary phrases SHALL NOT be matched against content the agent writes through a file-writing or editing tool. The canary check and the audit SHALL be deterministic pattern matching, so the same evidence and pattern list always produce the same outcome. Any match SHALL make the run `contaminated`, with no score and no publication, and the result SHALL list every match with its session, tool call, and matched pattern. There SHALL be no option to override a match.

#### Scenario: Agent fetches the fixture repository
- **WHEN** a web fetch or shell command input names the fixture repository
- **THEN** the run is `contaminated` and the result lists that tool call and pattern

#### Scenario: Tool output carries hidden text
- **WHEN** a web search's query matches no pattern but its output contains a canary phrase
- **THEN** the run is `contaminated` and the result lists that tool call and phrase

#### Scenario: Disclosed phrase is written into an artifact
- **WHEN** the simulated user's reply contains a canary phrase and the agent writes that phrase into a specification
- **THEN** that phrase is not a contamination match for the run

#### Scenario: Undisclosed phrase arrives through a read
- **WHEN** a canary phrase that no simulated-user reply contained appears in a file the agent read or a web result it received
- **THEN** the run is `contaminated` and the result lists that tool call and phrase

#### Scenario: Transport is read through a relative path
- **WHEN** a shell command reads a reply file through a relative path such as `../../exchange/<file>.reply.json`
- **THEN** the run is `contaminated` and the result lists that tool call and pattern

#### Scenario: Rescore reproduces the audit
- **WHEN** a run is rescored from its collected evidence with the same pattern list
- **THEN** the contamination outcome and matches are identical to the original

### Requirement: Complete audit evidence
The contamination audit SHALL require a complete retained session transcript for every evaluated invocation. When any evaluated invocation's transcript is missing or incomplete, the run SHALL end with `evaluation_status=evaluation-harness-failed` and SHALL NOT be reported `complete`.

#### Scenario: Crosscheck transcript is missing
- **WHEN** the transcript for one crosscheck invocation is missing
- **THEN** the run ends `evaluation-harness-failed` and identifies the missing transcript

### Requirement: Conversation reconciliation
The exchange directory and Agent Runner's runtime state are writable by the evaluated agent, so the harness SHALL treat them as untrusted. After the define workflow and before scoring, the harness SHALL reconcile every reply in its own simulated-user conversation with Agent Runner's exchange record and with the user turns in the lead's retained session transcript. A reply that is missing from either record, an extra reply in either record, or a reply whose text differs SHALL end the run with `evaluation_status=evaluation-harness-failed` and SHALL identify the exchange and the record that differs.

#### Scenario: Reply altered inside the sandbox
- **WHEN** the reply text in Agent Runner's exchange record differs from the reply in the harness's conversation for the same exchange
- **THEN** the run ends `evaluation-harness-failed` and identifies the exchange

#### Scenario: Reply never reached the lead
- **WHEN** a reply in the harness's conversation does not appear in any user turn of the lead's session transcript
- **THEN** the run ends `evaluation-harness-failed` and identifies the exchange

### Requirement: Simulated-user boundary
The simulated user, the judges, and the suite's hidden data SHALL run and reside outside the evaluated environment, and the external-user exchange SHALL carry only the conversation. Preflight SHALL verify that the evaluated environment's mounts are exactly the staged sandbox input, the run's sandbox working directory, the Agent Skills checkout, and the selected CLIs' credential files, and SHALL fail with `evaluation_status=evaluation-harness-failed` when any other host path would be mounted. When a selected Claude CLI has no host credentials file, a Claude setup-token passed by name SHALL replace that file; preflight SHALL fail before any model call when neither exists, and no other host environment variable SHALL reach the evaluated environment. The simulated user and judges are eval-owned and SHALL NOT be subject to the contamination audit.

#### Scenario: Unexpected mount
- **WHEN** the planned sandbox invocation would mount a host path outside the allowed set, such as the suite directory or the Agent Runner source
- **THEN** preflight fails before any model call and identifies the path

#### Scenario: Claude login held only in the macOS Keychain
- **WHEN** a selected Claude CLI has no host credentials file and a Claude setup-token is set
- **THEN** the planned sandbox invocation forwards the token by name without mounting a Claude credentials file, and no other host secret is forwarded

### Requirement: Residual-risk statement
Every result and report SHALL state that the evaluated sandbox has network access and the hidden reference is publicly reachable, so contamination is detected by audit rather than prevented, that the exchange and audit evidence are writable by the evaluated agent and checked by reconciliation rather than protected, and SHALL name an enforced outbound-network allowlist and a private fixture as open hardening options.

#### Scenario: Clean run states the risk
- **WHEN** a run completes with a clean contamination audit
- **THEN** its result and report still include the residual-risk statement

