## ADDED Requirements

### Requirement: Presentation definition
A presentation SHALL be an ordered list of at least one step and a set of elements. Each element SHALL have an id that is unique within the presentation, and every step SHALL have a non-empty caption.

#### Scenario: Valid presentation loads
- **WHEN** a presentation has unique element ids and every step has a caption
- **THEN** the viewer displays it starting at step 1

#### Scenario: Invalid presentation is described, not rendered
- **WHEN** a presentation has a duplicate id, a step with no caption, or a step that refers to a nonexistent element
- **THEN** validation reports each problem with the step and element involved, and the viewer shows those problems instead of a diagram

### Requirement: Supported primitives
The scene kit SHALL support node (a labeled box with an optional icon), group (a container holding other elements), connector (an arrow between two elements, with an optional label), text (standalone text), and highlight (emphasis around an existing element). Elements SHALL be placed at named grid positions rather than raw coordinates.

#### Scenario: Each primitive renders
- **WHEN** a step shows one of each primitive
- **THEN** all five appear, with the connector joining its two endpoints and the highlight around its target

#### Scenario: Unsupported primitive or position rejected
- **WHEN** an element has an unknown type or a position outside the grid
- **THEN** validation reports it

### Requirement: Reference rules
Connector endpoints and highlight targets SHALL refer to existing nodes, groups or text elements, and SHALL NOT refer to connectors or highlights. Group members SHALL be existing nodes, text elements or other groups, an element SHALL belong to at most one group, and group containment SHALL NOT be cyclic. Groups MAY be nested.

#### Scenario: Nested groups are valid
- **WHEN** a group has as members a node and another group that holds two nodes
- **THEN** the presentation is valid

#### Scenario: Connector to a connector rejected
- **WHEN** a connector's endpoint is another connector
- **THEN** validation reports that connector and the invalid endpoint

#### Scenario: Highlight of a highlight rejected
- **WHEN** a highlight's target is another highlight
- **THEN** validation reports that highlight and the invalid target

#### Scenario: Cyclic containment rejected
- **WHEN** group A lists group B as a member and group B lists group A as a member
- **THEN** validation reports the cycle

#### Scenario: Two parents rejected
- **WHEN** a node is a member of two groups
- **THEN** validation reports the node and both groups

### Requirement: Layout validity
A step's scene SHALL be valid only if it has no unintended overlap. Containment inside a declared group, connector crossings, and highlights around their target SHALL be valid overlaps. Overlap between element bodies, overlap between text labels, and elements outside the canvas SHALL be invalid. A step SHALL show at most 14 non-connector elements and at most 16 connectors.

#### Scenario: Declared containment is allowed
- **WHEN** nodes sit inside a group that declares them as members
- **THEN** the step is valid

#### Scenario: Unintended overlap is rejected
- **WHEN** two nodes that are not in a containment relationship occupy overlapping positions in the same step
- **THEN** validation reports the step and both elements

#### Scenario: Density cap exceeded
- **WHEN** a step shows 15 non-connector elements
- **THEN** validation reports the step and the limit

### Requirement: Step scenes are deterministic
Each step after the first SHALL declare only its changes from the previous step, and the first step SHALL declare everything it shows. The scene for a step SHALL depend only on the presentation and the step number, not on how the viewer arrived there.

#### Scenario: Same scene regardless of path
- **WHEN** step 4 is reached by going forward from step 3, backward from step 5, by an outline jump from step 1, or by loading a link
- **THEN** the scene shown is identical in every case

#### Scenario: Changes accumulate
- **WHEN** step 2 adds a node and step 3 relabels another
- **THEN** step 3 shows the node added in step 2 and the new label

### Requirement: Animated transitions
Moving between steps SHALL animate persistent elements in place: appearing, disappearing, moving, being relabeled, and gaining or losing connections. When the user prefers reduced motion, changes SHALL apply instantly without animation.

#### Scenario: Element moves rather than being redrawn
- **WHEN** a step moves a node to a new position
- **THEN** the same node travels to it instead of disappearing and reappearing

#### Scenario: Reduced motion
- **WHEN** the user prefers reduced motion and goes to the next step
- **THEN** the new scene appears with no animation

### Requirement: Step navigation
Steps SHALL be numbered from 1 and navigation SHALL NOT wrap. Navigation SHALL be available through previous/next controls, keys, and touch swipe. Next SHALL be →, ↓, PageDown or Space; previous SHALL be ←, ↑, PageUp or Shift+Space; Home and End SHALL go to the first and last step. Keys pressed with Ctrl, Alt or Meta SHALL be ignored.

#### Scenario: Keys move between steps
- **WHEN** the viewer is on step 2 and PageDown is pressed
- **THEN** step 3 is shown

#### Scenario: Boundaries
- **WHEN** the viewer is on step 1, or on the last step
- **THEN** previous (or next) is disabled and the matching key does nothing

#### Scenario: Home and End
- **WHEN** End is pressed
- **THEN** the last step is shown

#### Scenario: Swipe
- **WHEN** the user swipes left on a touch screen
- **THEN** the next step is shown

### Requirement: Present mode
Present mode SHALL show the diagram with minimal step controls and a step indicator, and SHALL NOT show the caption or the step outline.

#### Scenario: No caption in Present
- **WHEN** the viewer is in Present mode on any step
- **THEN** the step's caption is not visible anywhere on the page

#### Scenario: Navigation still works
- **WHEN** the viewer is in Present mode and the user presses Space
- **THEN** the next step is shown

### Requirement: Browse mode
Browse mode SHALL show the diagram, the current step's caption, and an outline of all steps. Selecting an outline entry SHALL go to that step, and the current step SHALL be marked in the outline.

#### Scenario: Caption shown
- **WHEN** the viewer is in Browse mode on step 3
- **THEN** step 3's caption is visible

#### Scenario: Outline jump
- **WHEN** the user selects step 6 in the outline
- **THEN** step 6 is shown and marked as current

### Requirement: Mode switching
The user SHALL be able to switch between Present and Browse with a visible control or the `P` key, keeping the current step. The viewer SHALL open in Browse mode unless the URL says otherwise.

#### Scenario: Toggle keeps the step
- **WHEN** the user is on step 4 in Browse and presses `P`
- **THEN** Present mode is shown, still on step 4

#### Scenario: Default mode
- **WHEN** a presentation is opened with no mode in the URL
- **THEN** it opens in Browse mode on step 1

### Requirement: URL state
The URL SHALL carry the presentation id, step and mode (`?presentation=<id>&step=<n>&mode=<present|browse>`). Changing step or mode SHALL update the URL without adding history entries. Loading a URL SHALL restore that view. A missing or out-of-range step SHALL fall back to step 1, and an unrecognised mode SHALL fall back to Browse.

#### Scenario: Link restores view
- **WHEN** `?presentation=sample&step=5&mode=present` is loaded
- **THEN** step 5 of that presentation is shown in Present mode

#### Scenario: Bad step
- **WHEN** the URL has `step=99` on a 10-step presentation
- **THEN** step 1 is shown

#### Scenario: Back leaves the presentation
- **WHEN** the user advances three steps and presses the browser Back button
- **THEN** they leave the presentation rather than moving to the previous step

### Requirement: Presentation host
The host SHALL serve a presentation selected by id. With no id or an unknown id, it SHALL list the available presentations. A presentation that fails validation SHALL show its problems.

#### Scenario: Unknown id
- **WHEN** `?presentation=nope` is loaded
- **THEN** the available presentations are listed with a message that `nope` was not found

#### Scenario: Gated host in an existing app
- **WHEN** a project's own app wraps the host in the presentation gate and the URL has no `presentation` parameter
- **THEN** the project's own app is shown, and a URL with an empty or unknown `presentation` parameter lists the available presentations

### Requirement: Responsive and readable scaling
The diagram SHALL scale to fit the available width and height at any viewport from 360×640 up, including wide and short viewports such as 1280×400, keep its proportions, and never cause horizontal page scroll. In Present mode the whole diagram SHALL be visible without scrolling. Rendered label text SHALL be at least 12px at 360×640. In Browse mode on narrow viewports, the caption, outline and controls SHALL stay usable alongside the diagram.

#### Scenario: Small phone
- **WHEN** a presentation is shown at 360×640 in either mode
- **THEN** the diagram is fully visible, there is no horizontal scroll, and all labels render at 12px or larger

#### Scenario: Narrow Browse
- **WHEN** Browse mode is shown at 360×640
- **THEN** the caption, outline and controls are reachable and none overlaps the diagram

#### Scenario: Wide and short window
- **WHEN** a presentation is shown in Present mode at 1280×400
- **THEN** the whole diagram and the controls are visible without vertical or horizontal scrolling

#### Scenario: Resize
- **WHEN** the window is resized while a step is shown
- **THEN** the diagram rescales to fit, staying on the same step

### Requirement: Independence from the host application's styles
The viewer's layout and text sizes SHALL NOT be altered by the styles of the project's own app, and showing the viewer SHALL NOT change how the project's own app looks at its normal URL.

#### Scenario: Project with global styles
- **WHEN** a project whose own CSS pads `main` elements and centers `body` content serves a presentation at 360×640
- **THEN** the diagram fits, labels render at 12px or larger, and the project's own page at its normal URL looks the same as before the kit was added

### Requirement: Accessible controls
Controls SHALL have accessible names, and in Browse mode the caption SHALL be announced to assistive technology when the step changes.

#### Scenario: Step change announced
- **WHEN** the step changes in Browse mode
- **THEN** the new caption is exposed through a live region

### Requirement: Template snapshot stays in sync
The skill's template snapshot SHALL match the canonical sources. A sync command SHALL update the snapshot, and a check mode SHALL fail and name the differing files when they differ.

#### Scenario: Drift detected
- **WHEN** a canonical file changes and the snapshot is not updated
- **THEN** the check fails and names that file

#### Scenario: Sync restores agreement
- **WHEN** the sync command runs
- **THEN** the check then passes
