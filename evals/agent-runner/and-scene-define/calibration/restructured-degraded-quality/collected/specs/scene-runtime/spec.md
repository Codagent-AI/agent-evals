## ADDED Requirements

### Requirement: Step sequence
A presentation SHALL be a single diagram that advances through an ordered sequence of named steps; it SHALL NOT be built as a set of independent slides. Every step SHALL declare a unique `id` and the diagram state that is visible while that step is current. Sections SHALL be declared once per presentation as a chapter list, where each chapter has a label and names the `id` of its first step; a step belongs to the chapter whose range contains it.

#### Scenario: Step declares identity and state
- **WHEN** an author adds a step to a presentation
- **THEN** the step has an `id` that no other step in that presentation uses and the diagram state shown while it is current
- **AND** the step belongs to exactly one chapter, determined by the chapter list

#### Scenario: Displayed numbers follow sequence position
- **WHEN** an author inserts, deletes, or moves a step
- **THEN** every visible step number is recomputed from its position in the sequence without manual edits

#### Scenario: Typed step state needs no assertions
- **WHEN** the steps of a presentation share a strongly typed state shape
- **THEN** `<Presentation>` accepts the step list with that type preserved and the author writes no type assertions at that call

### Requirement: Step narration
Every step SHALL carry narration that serves both a live talk and self-paced reading. A step SHALL provide a `body` written for readers and MAY provide a `headline` written for a speaker; when the headline is omitted, the runtime SHALL use the first sentence of the body as the headline.

#### Scenario: Both narration forms supplied
- **WHEN** a step defines a `headline` and a `body`
- **THEN** present mode displays the headline and browse mode displays both the headline and the body

#### Scenario: Headline derived from the body
- **WHEN** a step defines a `body` but no `headline`
- **THEN** the headline shown for that step is the first sentence of its body

### Requirement: Entity continuity
The diagram SHALL be composed of entities keyed by stable ids. An entity present in two consecutive steps SHALL remain the same rendered element and SHALL animate from its earlier position, size, label, and emphasis to its later ones; it SHALL NOT vanish and reappear. Continuing entities SHALL be matched by key and animated by measuring their first and last layout boxes (FLIP), and SHALL never receive the entrance treatment reserved for new entities. Entities that first appear in a step SHALL be revealed one after another on a separate reveal layer, so that a newcomer never changes the path of a continuing entity. Entities that the next step drops SHALL dissolve and be removed from the document before that step's newcomers are revealed, so no stale content stays on screen.

#### Scenario: Shared entity changes in place
- **WHEN** entity `a` exists in step 3 and step 4 with a different position, size, label, and emphasis
- **THEN** moving from step 3 to step 4 animates the same element to its new values
- **AND** no rendered frame of that transition lacks entity `a`

#### Scenario: Continuing entity is not re-entered
- **WHEN** entity `a` continues from one step into the next
- **THEN** `a` receives no entrance animation and keeps the same element

#### Scenario: Newcomer is revealed without disturbing others
- **WHEN** step 4 introduces entity `b`
- **THEN** `b` appears through the staggered reveal on the reveal layer
- **AND** every continuing entity follows the same path it would follow without `b`

#### Scenario: Dropped entity leaves the scene
- **WHEN** entity `c` exists in step 4 but not in step 5 and the viewer moves forward
- **THEN** `c` dissolves and is absent from the document once the transition ends, before step 5's newcomers are revealed

### Requirement: Persistent scene instance
The runtime SHALL mount a presentation's scene component once and SHALL pass it the current step's state on every change; navigating SHALL update that mounted instance instead of unmounting and rebuilding the diagram. Deliberate overlapping or stacking chosen by the author SHALL be preserved through transitions; the runtime SHALL NOT spread entities apart to suit its own implementation.

#### Scenario: Navigation updates the mounted scene
- **WHEN** the viewer moves from any step to an adjacent step
- **THEN** the scene's root element remains the same document node and only the state it renders changes

#### Scenario: Deliberate stacking survives transitions
- **WHEN** an author places two entities so that they intentionally overlap
- **THEN** that overlap is still present after every transition involving those entities and their motion stays clean

### Requirement: Styling ownership
The scene runtime SHALL contain no visual styling of its own: no palette, typefaces, colors, borders, glows, card looks, button looks, spacing scale, or theme tokens, and it SHALL NOT depend on a styling framework. Geometry that positions the canvas and chrome regions counts as layout behavior, not styling. Every runtime element and chrome region SHALL accept a class name supplied through a slot map passed to `<Presentation>` as `classNames`, keyed by slot (`stage`, `entity`, `headline`, `body`, `progress`, `outline`, `navButton`, `current`, `attribution`), so all visual decisions are made by the presentation or host app. For diagrams that need exact coordinates, the runtime SHALL provide a `Positioned` primitive that takes explicit x, y, width, and height per step, and authors MAY turn any custom SVG or HTML element into a tracked entity by calling `useEntity(id)`.

#### Scenario: Slot classes reach rendered elements
- **WHEN** a presentation passes `classNames={{ body: 'talk-body', current: 'is-here' }}`
- **THEN** the body region renders with class `talk-body` and the current progress segment renders with class `is-here`
- **AND** its colors, type, spacing, borders, and shadows come only from the presentation's or host's stylesheets

#### Scenario: Runtime adds no fallback look
- **WHEN** a presentation renders without any stylesheet of its own
- **THEN** the runtime emits no color, typeface, border, shadow, card look, or button look

#### Scenario: Styling frameworks stay optional
- **WHEN** an author wants Tailwind or another styling framework
- **THEN** the presentation or host app configures it and the runtime declares no dependency on it

#### Scenario: Exact coordinates and custom shapes
- **WHEN** a diagram needs literal coordinates per step or a shape that no primitive provides
- **THEN** the author positions entities with `Positioned` or registers a custom element through `useEntity`
- **AND** that element follows the same continuity rules as built-in primitives

### Requirement: Attribution link
Unless its attribution options are overridden, every presentation SHALL show a link labelled "made by and-scene" in the bottom-right corner that leads to the and-scene GitHub repository. The link SHALL render through the `attribution` slot so presentation or host CSS can style it. The runtime SHALL NOT place a brand link in the top-left header; a host app MAY supply one explicitly.

#### Scenario: Default attribution
- **WHEN** a presentation renders with default attribution options
- **THEN** the bottom-right corner contains a link labelled "made by and-scene" that leads to the and-scene GitHub repository

#### Scenario: Attribution can be styled
- **WHEN** a presentation passes an `attribution` slot class
- **THEN** the attribution link carries that class

#### Scenario: No implicit header brand
- **WHEN** the host app supplies no brand
- **THEN** the top-left header region contains no and-scene brand link

### Requirement: Fitted canvas
The diagram SHALL be authored in a fixed coordinate space, 880 × 380 units unless the presentation overrides it, rendered inside an SVG root whose `viewBox` equals that space with `preserveAspectRatio="xMidYMid meet"`; HTML entities are placed through `foreignObject`. The browser therefore scales the whole diagram uniformly to the space available, the internal layout never reflows, and transitions stay clean at every size. The space available SHALL be measured from the stage region of the active mode with a `ResizeObserver`, so present mode and browse mode each get their own fit.

#### Scenario: Window resize
- **WHEN** the browser window is resized
- **THEN** the diagram continues to look right

#### Scenario: Default coordinate space
- **WHEN** a presentation does not override its canvas size
- **THEN** its coordinate space is 880 × 380 units

#### Scenario: Fit follows the active mode
- **WHEN** the viewer switches between present mode and browse mode
- **THEN** the diagram is refitted to the stage region of the newly active mode
