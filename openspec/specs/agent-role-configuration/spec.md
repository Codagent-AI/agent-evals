# agent-role-configuration Specification

## Purpose
Define independent configuration and recorded provenance for the Agent Runner lead and task-implementor roles used by evaluations.
## Requirements
### Requirement: Independent role profile selection
The evaluation harness SHALL require an explicit lead-agent profile, an explicit crosscheck profile, an explicit task-implementor profile, and an explicit tester profile for each new Agent Runner evaluation run, selected through `--lead-*`, `--crosscheck-*`, `--implementor-*`, and `--tester-*` options that each take a CLI, model, and effort. Each profile SHALL independently specify the Agent Runner CLI adapter, model, and effort setting used for that role. No role SHALL be permitted to fall back to an Agent Runner default.

The harness SHALL map each selected role profile to the Agent Runner agent of the same name: the lead-agent profile to `lead`, the crosscheck profile to `crosscheck`, the task-implementor profile to `implementor`, and the tester profile to `tester`. The harness SHALL NOT depend on which steps, sessions, or sub-workflows of the evaluated workflow use each agent. All roles SHALL execute within the same end-to-end run of the evaluated workflow. A configured role that the run never invokes SHALL be reported as not invoked rather than as an error.

The harness SHALL NOT configure a role through a deprecated agent alias, and SHALL configure no Agent Runner agent other than these four.

#### Scenario: Different profiles are selected
- **WHEN** a run selects different CLI, model, or effort settings for the lead agent and task implementor
- **THEN** the harness configures Agent Runner's `lead` and `implementor` agents independently with the selected settings
- **AND** both participate in the same end-to-end workflow run

#### Scenario: Same settings are selected explicitly
- **WHEN** the lead-agent and task-implementor profiles explicitly contain the same settings
- **THEN** the harness accepts them as two independently declared role profiles

#### Scenario: A required role profile is missing
- **WHEN** the lead-agent, crosscheck, task-implementor, or tester profile is absent for a new run
- **THEN** the harness rejects the configuration before starting Agent Runner
- **AND** it identifies the absent role

#### Scenario: Acceptance profile reaches the acceptance agent
- **WHEN** a run selects a tester profile
- **THEN** the harness configures the Agent Runner `tester` agent with the selected settings
- **AND** every attempt Agent Runner records for the `tester` agent is attributed to the tester profile

#### Scenario: Crosscheck profile reaches the crosscheck agent
- **WHEN** a run selects a crosscheck profile
- **THEN** the harness configures the Agent Runner `crosscheck` agent with the selected settings, so task review never falls back to an Agent Runner default

#### Scenario: Configured role is never invoked
- **WHEN** the evaluated workflow completes without any attempt by one of the configured agents
- **THEN** the result reports that role as configured but not invoked
- **AND** the run is not failed for that reason

#### Scenario: Reference baseline bypasses implementation
- **WHEN** a reference-baseline run evaluates an existing candidate without invoking Agent Runner
- **THEN** the lead-agent, crosscheck, task-implementor, and tester profiles are not required and are all reported not applicable

### Requirement: Profile validation
Before starting Agent Runner, the harness SHALL validate every role profile against the stable capabilities of the recorded Agent Runner revision. Validation SHALL reject unsupported CLI adapters, missing or syntactically invalid model identifiers, invalid effort values, and configurations that cannot run the applicable workflow role autonomously. The harness SHALL NOT maintain or enforce a static allowlist of model names; Agent Runner and the selected CLI SHALL determine model availability at execution time. A validation failure SHALL identify the affected role and invalid field without launching an implementation workflow. Until a focused integration check shows that a `cursor` lead can complete an agent call to the configured crosscheck agent inside the evaluation sandbox, the harness SHALL reject a lead profile whose CLI is `cursor` before any model execution, naming the lead role and the unverified capability.

#### Scenario: Both profiles are valid
- **WHEN** every selected profile uses supported and available settings for its workflow role
- **THEN** the harness permits the Agent Runner workflow to start

#### Scenario: A newly available model is selected
- **WHEN** a role specifies a syntactically valid model identifier that is not named in the eval harness
- **THEN** the harness permits the Agent Runner workflow to start
- **AND** Agent Runner and the selected CLI determine whether the model is available

#### Scenario: Lead profile is invalid
- **WHEN** the selected lead-agent profile contains a setting Agent Runner cannot use for the `lead` role
- **THEN** the harness rejects the run and identifies the lead-agent setting that failed validation

#### Scenario: Implementor profile is invalid
- **WHEN** the selected task-implementor profile contains a setting Agent Runner cannot use for the `implementor` role
- **THEN** the harness rejects the run and identifies the task-implementor setting that failed validation

#### Scenario: Cursor lead is not yet supported
- **WHEN** a new run selects a lead profile whose CLI is `cursor`
- **THEN** the harness rejects the run before any model execution
- **AND** the error names the lead role and states that Cursor agent calls are not yet verified

#### Scenario: Crosscheck profile is invalid
- **WHEN** the selected crosscheck profile contains a setting Agent Runner cannot use for the `crosscheck` role
- **THEN** the harness rejects the run and identifies the crosscheck setting that failed validation

#### Scenario: Acceptance profile is invalid
- **WHEN** the selected tester profile contains a setting Agent Runner cannot use for the `tester` role
- **THEN** the harness rejects the run and identifies the tester setting that failed validation

### Requirement: Evaluation-scoped Agent Runner configuration
The harness SHALL materialize the selected profiles only within the disposable evaluation environment. It SHALL NOT modify or depend upon the user's global or project Agent Runner configuration outside that environment. The generated configuration SHALL retain the autonomous execution modes required by the noninteractive evaluation workflow.

#### Scenario: Evaluation configuration is created
- **WHEN** the harness prepares the Agent Runner environment
- **THEN** it writes an evaluation-scoped profile configuration containing the selected `lead`, `crosscheck`, `implementor`, and `tester` settings

#### Scenario: User has an Agent Runner configuration
- **WHEN** the host contains global or project Agent Runner profile settings
- **THEN** the evaluation does not modify those settings or allow them to silently change the selected evaluation profiles

### Requirement: Role configuration continuity on resume
The harness SHALL checkpoint the normalized lead-agent, crosscheck, task-implementor, and tester profile selections with the run. Before resuming, it SHALL compare the requested selections with the checkpointed selections and SHALL reject a mismatch rather than continue one evaluation with changed role profiles.

#### Scenario: Resume uses matching profiles
- **WHEN** a resumable evaluation is invoked with role profiles matching the checkpointed selections
- **THEN** the harness continues the recorded Agent Runner run with those profiles

#### Scenario: Resume changes one profile
- **WHEN** a resume invocation changes the lead-agent, crosscheck, task-implementor, or tester profile from its checkpointed selection
- **THEN** the harness rejects the resume and identifies the profile mismatch

### Requirement: Configured and effective role reporting
The evaluation result SHALL record the normalized configured profile for each role and the actual role, CLI adapter, provider, model, effort, Agent Runner session, workflow step, and attempt identity observed for every agent invocation. It SHALL retain retries and resumed attempts and SHALL clearly identify any difference between configured and observed values.

The harness SHALL attribute each observed Agent Runner attempt to a role by the Agent Runner agent that `run-metrics.json` records for it: `lead` to the lead-agent role, `crosscheck` to the crosscheck role, `implementor` to the task-implementor role, and `tester` to the acceptance-reviewer role. An agent call SHALL be attributed by the agent it targeted, or by the agent of the named session it targeted. An Agent Validator attempt SHALL be reported under the Validator and linked to the Runner attempt that invoked it, identified by its Runner attribution. Attribution SHALL NOT depend on step identifiers, step paths, session names, or the position of an attempt in the workflow. An attempt whose agent is not recorded SHALL be reported as unattributed rather than guessed.

Role configuration and per-attempt details SHALL appear in `result.json` and `report.html` and SHALL be available to the agent-and-model usage and cost aggregation. Missing effective-profile evidence SHALL be reported as incomplete rather than inferred from configuration alone.

#### Scenario: Agent invocation matches its configuration
- **WHEN** an Agent Runner attempt reports the role settings that were configured for it
- **THEN** the evaluation links the configured profile to the observed CLI, provider, model, effort, session, step, and attempt

#### Scenario: Acceptance attempt is attributed to its role
- **WHEN** Agent Runner records an attempt or agent call for the `tester` agent
- **THEN** the evaluation attributes that attempt to the acceptance-reviewer role
- **AND** it does not attribute it to the lead-agent role

#### Scenario: Same step name occurs in two role contexts
- **WHEN** the same step identifier is recorded once for an `implementor` attempt and once for a `lead` attempt
- **THEN** the evaluation attributes the first attempt to the task-implementor role and the second to the lead-agent role, from the recorded agents alone

#### Scenario: Effective setting differs from configuration
- **WHEN** an observed Agent Runner attempt uses a CLI, model, or effort different from its selected role profile
- **THEN** the evaluation preserves both values and prominently reports the mismatch

#### Scenario: Effective-profile evidence is unavailable
- **WHEN** Agent Runner artifacts do not establish the actual settings for an attempt
- **THEN** the evaluation marks effective role details incomplete without treating configured values as observed values

#### Scenario: Task-review call is attributed to crosscheck
- **WHEN** Agent Runner records an agent call to the `crosscheck` agent
- **THEN** the evaluation attributes that attempt to the crosscheck role

#### Scenario: Attempt has no recorded agent
- **WHEN** an Agent Runner attempt in `run-metrics.json` records no agent
- **THEN** the evaluation reports it as unattributed with its usage and cost retained
- **AND** it does not infer a role from the attempt's step path

#### Scenario: Role has retries
- **WHEN** a lead-agent or task-implementor step is retried or resumed
- **THEN** every attempt is retained under the applicable role and configured profile

### Requirement: End-to-end product evaluation only
Independent role configuration SHALL NOT create isolated lead-agent evaluations, isolated task-implementor evaluations, or role-specific product-quality scores. The official score and verdict SHALL evaluate only the delivered product from the complete configured workflow. Per-role attempts, outcomes, usage, cost, and timing SHALL remain diagnostic data for comparisons among end-to-end runs.

#### Scenario: End-to-end workflow completes
- **WHEN** independently configured lead and implementor roles produce a candidate
- **THEN** the scorer evaluates the final delivered product under the common product-quality rubric
- **AND** it does not assign separate product-quality scores to either role

#### Scenario: Runs use different role combinations
- **WHEN** evaluators compare end-to-end runs with different lead-agent or task-implementor profiles
- **THEN** each run retains its role-level diagnostic data while its official result remains the score of its delivered product

### Requirement: Crosscheck profile in recorded identity
Wherever the harness preflights, checkpoints, verifies on resume, or records the configured workflow role profiles, including evaluation preflight, durable checkpoint provenance, Agent Runner resume verification, workflow execution provenance, `result.json` role configuration, and `report.html`, it SHALL include the crosscheck profile alongside the lead, implementor, and tester profiles. Because an experiment baseline's identity includes each configured role in `role_configuration.roles`, a repetition whose configured crosscheck CLI, model, effort, or agent differs from the baseline's SHALL be an identity mismatch.

#### Scenario: Crosscheck profile is recorded
- **WHEN** a new evaluation starts with a crosscheck profile
- **THEN** the checkpoint, workflow provenance, `result.json`, and report record the crosscheck CLI, model, effort, and `crosscheck` agent

#### Scenario: Baseline repetition differs only in crosscheck
- **WHEN** a repetition matches a baseline in every identity field except its configured crosscheck model
- **THEN** the baseline command refuses it unless `--allow-mismatch` is given, naming the crosscheck model field and both values

