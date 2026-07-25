## ADDED Requirements

### Requirement: Independent role profile selection
The evaluation harness SHALL require an explicit lead-agent profile and an explicit task-implementor profile for each new Agent Runner evaluation run. Each profile SHALL independently specify the Agent Runner CLI adapter, model, and effort setting used for that role.

The harness SHALL map the selected lead-agent profile to the `planner` agent used by the `implement-change2` named `lead-agent` session and the selected task-implementor profile to the `implementor` agent used by its task workflows. Both roles SHALL execute within the same end-to-end `implement-change2` run.

#### Scenario: Different profiles are selected
- **WHEN** a run selects different CLI, model, or effort settings for the lead agent and task implementor
- **THEN** the harness configures Agent Runner's `planner` and `implementor` agents independently with the selected settings
- **AND** both participate in the same end-to-end workflow run

#### Scenario: Same settings are selected explicitly
- **WHEN** the lead-agent and task-implementor profiles explicitly contain the same settings
- **THEN** the harness accepts them as two independently declared role profiles

#### Scenario: A required role profile is missing
- **WHEN** either the lead-agent profile or task-implementor profile is absent for a new run
- **THEN** the harness rejects the configuration before starting Agent Runner

#### Scenario: Reference baseline bypasses implementation
- **WHEN** a reference-baseline run evaluates an existing candidate without invoking Agent Runner
- **THEN** lead-agent and task-implementor profiles are not required and are reported not applicable

### Requirement: Profile validation
Before starting Agent Runner, the harness SHALL validate both role profiles against the capabilities of the recorded Agent Runner revision. Validation SHALL reject unsupported CLI adapters, unavailable or invalid model identifiers, invalid effort values, and configurations that cannot run the applicable workflow role autonomously. A validation failure SHALL identify the affected role and invalid field without launching an implementation workflow.

#### Scenario: Both profiles are valid
- **WHEN** both selected profiles use supported and available settings for their workflow roles
- **THEN** the harness permits the Agent Runner workflow to start

#### Scenario: Lead profile is invalid
- **WHEN** the selected lead-agent profile contains a setting Agent Runner cannot use for the `planner` role
- **THEN** the harness rejects the run and identifies the lead-agent setting that failed validation

#### Scenario: Implementor profile is invalid
- **WHEN** the selected task-implementor profile contains a setting Agent Runner cannot use for the `implementor` role
- **THEN** the harness rejects the run and identifies the task-implementor setting that failed validation

### Requirement: Evaluation-scoped Agent Runner configuration
The harness SHALL materialize the two selected profiles only within the disposable evaluation environment. It SHALL NOT modify or depend upon the user's global or project Agent Runner configuration outside that environment. The generated configuration SHALL retain the autonomous execution modes required by the noninteractive evaluation workflow.

#### Scenario: Evaluation configuration is created
- **WHEN** the harness prepares the Agent Runner environment
- **THEN** it writes an evaluation-scoped profile configuration containing the selected `planner` and `implementor` settings

#### Scenario: User has an Agent Runner configuration
- **WHEN** the host contains global or project Agent Runner profile settings
- **THEN** the evaluation does not modify those settings or allow them to silently change the selected evaluation profiles

### Requirement: Role configuration continuity on resume
The harness SHALL checkpoint the normalized lead-agent and task-implementor profile selections with the run. Before resuming, it SHALL compare the requested selections with the checkpointed selections and SHALL reject a mismatch rather than continue one evaluation with changed role profiles.

#### Scenario: Resume uses matching profiles
- **WHEN** a resumable evaluation is invoked with role profiles matching the checkpointed selections
- **THEN** the harness continues the recorded Agent Runner run with those profiles

#### Scenario: Resume changes one profile
- **WHEN** a resume invocation changes the lead-agent or task-implementor profile from its checkpointed selection
- **THEN** the harness rejects the resume and identifies the profile mismatch

### Requirement: Configured and effective role reporting
The evaluation result SHALL record the normalized configured profile for each role and the actual role, CLI adapter, provider, model, effort, Agent Runner session, workflow step, and attempt identity observed for every agent invocation. It SHALL retain retries and resumed attempts and SHALL clearly identify any difference between configured and observed values.

Role configuration and per-attempt details SHALL appear in `result.json` and `report.html` and SHALL be available to the agent-and-model usage and cost aggregation. Missing effective-profile evidence SHALL be reported as incomplete rather than inferred from configuration alone.

#### Scenario: Agent invocation matches its configuration
- **WHEN** an Agent Runner attempt reports the role settings that were configured for it
- **THEN** the evaluation links the configured profile to the observed CLI, provider, model, effort, session, step, and attempt

#### Scenario: Effective setting differs from configuration
- **WHEN** an observed Agent Runner attempt uses a CLI, model, or effort different from its selected role profile
- **THEN** the evaluation preserves both values and prominently reports the mismatch

#### Scenario: Effective-profile evidence is unavailable
- **WHEN** Agent Runner artifacts do not establish the actual settings for an attempt
- **THEN** the evaluation marks effective role details incomplete without treating configured values as observed values

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
