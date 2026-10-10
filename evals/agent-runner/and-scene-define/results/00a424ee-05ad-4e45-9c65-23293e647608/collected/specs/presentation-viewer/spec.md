## ADDED Requirements

### Requirement: Presentation routes
The presentation page's root route SHALL display the presentation index, with each listed presentation
linking to its own route. Opening a route for a slug that is not registered SHALL display a not-found
message with a link to the index.

#### Scenario: Index links to a presentation
- **WHEN** the viewer opens the presentation page root and activates a listed presentation
- **THEN** that presentation opens at its own route

#### Scenario: Unknown slug
- **WHEN** the viewer opens the route for a slug that is not registered
- **THEN** a not-found message is displayed with a link to the index

### Requirement: URL-addressable viewer state
The URL SHALL identify the presentation, the current step, and the current mode. Opening a URL SHALL
display that presentation at that step in that mode. Navigating between steps or switching modes SHALL
update the URL by replacing the current history entry rather than adding a new one. The document title
SHALL be the current step title followed by the presentation title.

#### Scenario: Open a specific step and mode
- **WHEN** the viewer opens the URL for step 3 of a presentation in present mode
- **THEN** the presentation is displayed at step 3 in present mode

#### Scenario: URL follows navigation without adding history
- **WHEN** the viewer opens a presentation from the index, moves from step 1 to step 4, and then uses the
  browser's back action
- **THEN** the URL identified step 4 before the back action, and the back action returns to the index

#### Scenario: Out-of-range step
- **WHEN** the URL names step 12 of a presentation with 8 steps
- **THEN** step 8 is displayed and the URL is corrected to step 8

#### Scenario: Missing or non-numeric step
- **WHEN** the URL names no step or a non-numeric step
- **THEN** step 1 is displayed and the URL is corrected to step 1

#### Scenario: Document title
- **WHEN** step 2, titled "Add the index", of the presentation "Using the skill" is displayed
- **THEN** the document title is "Add the index — Using the skill"

### Requirement: Opening mode
A presentation MAY declare the mode it opens in. When the URL does not name a mode, the viewer SHALL
open in the presentation's declared mode, or in browse mode if the presentation declares none. A mode
named in the URL SHALL take precedence over the declared mode.

#### Scenario: No declared mode
- **WHEN** a presentation that declares no opening mode is opened from a URL that names no mode
- **THEN** it opens in browse mode

#### Scenario: Declared mode
- **WHEN** a presentation that declares present mode is opened from a URL that names no mode
- **THEN** it opens in present mode

#### Scenario: URL mode overrides declared mode
- **WHEN** a presentation that declares present mode is opened from a URL that names browse mode
- **THEN** it opens in browse mode

### Requirement: Present mode
Present mode SHALL display only the diagram, a step marker showing the current step number and total
step count, and the current step's one-line title. It SHALL NOT display the caption, table of contents,
prev/next controls, or progress indicators. The step title SHALL remain on a single line and SHALL be
truncated with an ellipsis when it does not fit. The diagram SHALL occupy the remaining viewport space.

#### Scenario: Present mode content
- **WHEN** step 3 of an 8-step presentation is displayed in present mode
- **THEN** the diagram, the marker "3 / 8", and step 3's title are visible, and the caption, table of
  contents, prev/next controls, and progress indicators are not displayed

#### Scenario: Long title on a narrow viewport
- **WHEN** a step title does not fit on one line at the current viewport width in present mode
- **THEN** the title stays on one line and ends with an ellipsis

### Requirement: Browse mode
Browse mode SHALL display the diagram, the current step's title and caption, prev/next controls, and a
progress indicator that shows the current position within the total and lets the viewer jump to a step.
On viewports at least 1024 px wide it SHALL also display a table of contents listing every step title,
indicating the current step, and jumping to a step when one is chosen; on narrower viewports it SHALL NOT
display the table of contents. The caption SHALL be fully readable and SHALL NOT cover the diagram. The
previous control SHALL be disabled on the first step and the next control on the last step; each SHALL be
enabled whenever another step exists in its direction.

#### Scenario: Browse mode on a wide viewport
- **WHEN** a presentation is displayed in browse mode on a 1440 px wide viewport
- **THEN** the diagram, step title, caption, prev/next controls, progress indicator, and table of
  contents are visible, with the current step indicated in the table of contents

#### Scenario: Browse mode on a narrow viewport
- **WHEN** a presentation is displayed in browse mode on a 390 px wide viewport
- **THEN** the diagram, step title, caption, prev/next controls, and progress indicator are visible and
  the table of contents is not displayed

#### Scenario: Jump from the table of contents
- **WHEN** the viewer chooses step 5 in the table of contents
- **THEN** step 5 is displayed and indicated as current

#### Scenario: Jump from the progress indicator
- **WHEN** the viewer activates the progress indicator's segment for step 6
- **THEN** step 6 is displayed

#### Scenario: Controls at the ends
- **WHEN** the first step of a multi-step presentation is displayed in browse mode
- **THEN** the previous control is disabled and the next control is enabled; and when the last step is
  displayed the next control is disabled and the previous control is enabled

#### Scenario: Single-step presentation
- **WHEN** a presentation with exactly one step is displayed in browse mode
- **THEN** both the previous and next controls are disabled

### Requirement: Step navigation
In both modes the viewer SHALL move to the next step with the Right Arrow, Down Arrow, Space, or Page Down
keys and to the previous step with the Left Arrow, Up Arrow, Shift+Space, or Page Up keys; Home and End
SHALL move to the first and last steps. A leftward swipe on the diagram SHALL move to the next step and a
rightward swipe to the previous step. When a viewer control has keyboard focus, Space and Enter SHALL
activate only that control and SHALL NOT also trigger step navigation. Key presses combined with Control,
Meta, or Alt SHALL be ignored by the viewer, and the viewer SHALL prevent the browser's default action
only for key presses it handles. In present mode, clicking or tapping the left third of the diagram
SHALL move to the previous step and clicking or tapping elsewhere on the diagram SHALL move to the next
step. Navigation SHALL NOT wrap past the first or last step.

#### Scenario: Keyboard navigation
- **WHEN** step 2 is displayed and the viewer presses Right Arrow, then End, then Home
- **THEN** step 3, then the last step, then step 1 is displayed

#### Scenario: Swipe navigation
- **WHEN** step 2 is displayed on a touch device and the viewer swipes left on the diagram
- **THEN** step 3 is displayed

#### Scenario: Tap zones in present mode
- **WHEN** step 4 is displayed in present mode and the viewer taps the left third of the diagram
- **THEN** step 3 is displayed; and tapping the right two-thirds from step 3 displays step 4

#### Scenario: Focused control takes precedence
- **WHEN** step 2 is displayed in browse mode with the next control focused and the viewer presses Space
- **THEN** exactly step 3 is displayed

#### Scenario: Space on the focused step marker
- **WHEN** step 4 is displayed in present mode with the step marker focused and the viewer presses Space
- **THEN** browse mode is displayed at step 4

#### Scenario: Modified keys are ignored
- **WHEN** the viewer presses Control+Right Arrow or Meta+Left Arrow
- **THEN** the displayed step does not change

#### Scenario: No wrap at the ends
- **WHEN** the last step is displayed and the viewer presses Right Arrow
- **THEN** the last step remains displayed

### Requirement: Mode switching
The viewer SHALL switch between present and browse mode with the P key, by activating the step marker in
present mode, or by activating a visible mode toggle in browse mode. The Escape key SHALL switch from
present mode to browse mode. Switching modes SHALL keep the current step and SHALL NOT replay the
current step's transition.

#### Scenario: Toggle preserves the step
- **WHEN** step 5 is displayed in browse mode and the viewer presses P, then P again
- **THEN** step 5 is displayed in present mode, then step 5 is displayed in browse mode, without the
  diagram animating

#### Scenario: Touch toggle from present mode
- **WHEN** step 2 is displayed in present mode on a touch device and the viewer taps the step marker
- **THEN** step 2 is displayed in browse mode

#### Scenario: Escape leaves present mode
- **WHEN** present mode is active and the viewer presses Escape
- **THEN** browse mode is displayed at the same step

### Requirement: Responsive layout
The viewer SHALL lay out both modes without horizontal scrolling on phone (390 px), tablet (768 px), and
desktop (1440 px) viewport widths in portrait and landscape orientation. In present mode the diagram, step
marker, and step title SHALL all fit within the viewport without scrolling.

#### Scenario: Present mode fits the viewport
- **WHEN** present mode is displayed on a 390 × 844 viewport
- **THEN** the diagram, step marker, and step title are fully visible without scrolling in either
  direction

#### Scenario: No horizontal scrolling
- **WHEN** either mode is displayed at any of the phone, tablet, or desktop widths
- **THEN** the page does not scroll horizontally

### Requirement: Reduced motion
When the user's system requests reduced motion, the viewer SHALL change steps without animation and SHALL
display the same final diagram as when animations run.

#### Scenario: Reduced motion
- **WHEN** reduced motion is requested and the viewer moves from step 2 to step 3
- **THEN** step 3's diagram is displayed immediately without animated transitions

### Requirement: Accessible viewer
Every viewer control SHALL be operable by keyboard and have an accessible name. The diagram SHALL have an
accessible name equal to the presentation title. When the step changes, the new step's title SHALL be
announced to assistive technology, together with its caption in browse mode.

#### Scenario: Step change is announced
- **WHEN** the viewer moves to step 4 in browse mode
- **THEN** assistive technology is notified of step 4's title and caption

#### Scenario: Controls are named
- **WHEN** browse mode is displayed
- **THEN** the prev/next controls, progress indicator segments, table of contents entries, and mode
  toggle each expose an accessible name and can be activated from the keyboard
