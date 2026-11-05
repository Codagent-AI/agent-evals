## ADDED Requirements

### Requirement: Topic to presentation
When given a topic, the skill SHALL produce a presentation that is one evolving diagram, not separate slides. It SHALL have an ordered sequence of steps, each with a caption, and it SHALL use only the supported primitives.

#### Scenario: Presentation is one evolving diagram
- **WHEN** the user asks for a presentation on "how a request travels through a CDN"
- **THEN** the skill produces a presentation whose steps build up and change one diagram, with a caption on every step

### Requirement: Ask before assuming
Before generating, the skill SHALL ask the user about details that materially shape the presentation and that the user has not already given, such as the audience, the depth or scope, the key points to cover, and the desired length. It SHALL NOT assume such details when the user could still provide them, even if the topic is clear. It SHALL ask only about details not yet given, and where the user delegates a decision it SHALL choose a value and state it.

#### Scenario: Clear topic, missing details
- **WHEN** the user asks for a presentation on "how a request travels through a CDN" and gives no audience, scope or length
- **THEN** the skill asks about those details and generates nothing until the user answers

#### Scenario: Details already given
- **WHEN** the user's request already states the audience, scope, key points and length
- **THEN** the skill does not ask for them again

#### Scenario: User delegates a decision
- **WHEN** the user answers "you decide" for the length
- **THEN** the skill picks a length, tells the user which one, and continues

#### Scenario: No topic
- **WHEN** the request gives no basis for choosing what to depict (for example, "make a presentation")
- **THEN** the skill asks for the topic before anything else

### Requirement: Self-sufficient diagrams
Because Present mode shows no caption, the skill SHALL make the diagram's own labels carry the meaning of each step. The caption SHALL add explanation, not be the only place a key fact appears.

#### Scenario: Labels carry meaning
- **WHEN** a step introduces a new component
- **THEN** that component is visibly labeled in the diagram, independent of the caption

### Requirement: Output location and naming
The skill SHALL create the presentation as its own module under the project's presentations directory, named by a kebab-case slug of the topic, and register it so the host can serve it. It SHALL NOT overwrite an existing presentation of the same name without the user's confirmation.

#### Scenario: New presentation
- **WHEN** the skill generates "request routing" in a project with no presentation of that name
- **THEN** a new presentation `request-routing` exists and loads at `?presentation=request-routing`

#### Scenario: Name collision
- **WHEN** a presentation with that slug already exists
- **THEN** the skill asks whether to replace it or use a different name, and changes nothing until the user answers

### Requirement: Bootstrap into a project lacking the scene kit
Before generating, the skill SHALL detect whether the target project has the scene kit. If it is missing, the skill SHALL install the template snapshot (scene kit, host and discovery, verification harness and scripts) and the required dependencies, then continue. The initial supported target SHALL be a Vite + React + TypeScript project.

#### Scenario: Fresh Vite project
- **WHEN** the skill runs in a Vite + React + TypeScript project with no scene kit
- **THEN** the kit, host, verification command and dependencies are installed, the project's entry file is wired so a URL with a `presentation` parameter shows the host while other URLs still show the project's own app, and the presentation is generated and verified using them

#### Scenario: Project already has the kit
- **WHEN** the kit is already present
- **THEN** the skill does not reinstall or modify it

#### Scenario: Unsupported project
- **WHEN** the project is not a Vite + React + TypeScript project
- **THEN** the skill makes no changes and tells the user the project type is not supported

#### Scenario: Entry cannot be wired
- **WHEN** the project's entry file does not match the expected shape
- **THEN** the skill makes no edit to it and tells the user exactly what to add

#### Scenario: Existing kit differs from the snapshot
- **WHEN** the project has a scene kit whose files differ from the template snapshot
- **THEN** the skill does not overwrite it, and tells the user which files differ

### Requirement: Self-verification before reporting success
After generating, the skill SHALL validate the presentation data, run typecheck, lint and build, and render the presentation in a browser using the verification command. It SHALL NOT report the presentation as done unless all of these pass.

#### Scenario: All checks pass
- **WHEN** generation completes and every check passes
- **THEN** the skill reports success with the link to open the presentation

#### Scenario: A check fails
- **WHEN** validation, build or browser rendering fails
- **THEN** the skill uses the failure details to fix the presentation and re-runs the checks, up to three attempts

#### Scenario: Cannot be fixed
- **WHEN** the checks still fail after three attempts
- **THEN** the skill reports failure with the remaining problems and does not claim success

#### Scenario: Browser unavailable
- **WHEN** the verification browser is not installed
- **THEN** the skill reports that verification could not run, with the install hint, rather than reporting success

### Requirement: Sample presentation about the skill
The repository SHALL include a sample presentation, authored with the skill, that explains how to use the skill. It SHALL pass the verification command.

#### Scenario: Sample is served and valid
- **WHEN** the sample's id is opened in the host
- **THEN** the sample loads and explains how to use the skill step by step
