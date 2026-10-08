## ADDED Requirements

### Requirement: Viewing modes
Every presentation SHALL offer a present mode for live talks and a browse mode for self-paced reading. The viewer SHALL be able to change mode at any time, either with the on-screen mode switch or by pressing `P`, and an author MAY declare which mode the presentation starts in. Changing mode in either direction SHALL leave the current step unchanged.

In present mode the stage fills the window and a lower-third strip shows the current step's headline and a counter such as "3 / 9"; the body text, chapter outline, and on-screen previous/next buttons are not shown to the audience. Pressing `N` in present mode opens a separate presenter-notes window that shows the current body text to the speaker only.

In browse mode a side panel shows the current headline and full body, previous and next buttons, a progress bar made of one clickable segment per step, and a chapter outline listing each chapter's steps. When the window is narrower than 720 CSS pixels the outline collapses behind a menu button in the side panel.

#### Scenario: Present mode keeps attention on the diagram
- **WHEN** a presentation is in present mode
- **THEN** the lower-third strip shows the current headline and step counter
- **AND** the body text, chapter outline, and previous/next buttons are not rendered in the audience view

#### Scenario: Presenter notes stay with the speaker
- **WHEN** the speaker presses `N` in present mode
- **THEN** a separate window opens showing the current step's body text and follows later step changes

#### Scenario: Browse mode supports reading
- **WHEN** a presentation is in browse mode on a window at least 720 CSS pixels wide
- **THEN** the side panel shows the current headline, the full body, previous and next buttons, the progress bar, and the chapter outline

#### Scenario: Outline collapses on narrow windows
- **WHEN** a presentation is in browse mode on a window narrower than 720 CSS pixels
- **THEN** the chapter outline is available from a menu button and every other browse element remains visible

#### Scenario: Mode change keeps the step
- **WHEN** the viewer is on step 5 in browse mode, switches to present mode, and switches back
- **THEN** step 5 is current after each switch

#### Scenario: Declared starting mode
- **WHEN** a presentation declares `initialMode: 'browse'`
- **THEN** it opens in browse mode on its first step

### Requirement: Moving between steps
The viewer SHALL be able to move one step at a time with the keyboard, touch gestures, and on-screen buttons, and SHALL be able to jump straight to any step or chapter. `ArrowRight`, `ArrowDown`, and `Space` SHALL move forward one step; `ArrowLeft`, `ArrowUp`, and `Shift+Space` SHALL move back one step. A horizontal swipe to the left SHALL move forward and a swipe to the right SHALL move back. Clicking a progress segment SHALL make that segment's step current, and clicking a chapter in the outline SHALL make that chapter's first step current. The current progress segment and the current outline entry SHALL carry `aria-current="step"` and the `current` slot class, and a polite live region SHALL announce "Step N of M" followed by the headline after every change. While keyboard focus is inside a button, link, form field, or other interactive control, key presses SHALL be handled by that control only and SHALL NOT change the step.

#### Scenario: Keyboard forward and back
- **WHEN** the viewer is on step 2 and presses `ArrowDown`
- **THEN** step 3 is current
- **AND WHEN** the viewer then presses `Shift+Space`
- **THEN** step 2 is current again

#### Scenario: Swipe gestures
- **WHEN** the viewer swipes left on a touch screen
- **THEN** the next step becomes current, and a swipe right makes the previous step current

#### Scenario: Progress segment jump
- **WHEN** the viewer clicks the seventh progress segment
- **THEN** step 7 is current

#### Scenario: Outline jump goes to the chapter start
- **WHEN** the viewer clicks the third chapter in the outline
- **THEN** the first step of that chapter is current

#### Scenario: Current position is announced and marked
- **WHEN** step 4 of 9 becomes current
- **THEN** its progress segment and outline entry have `aria-current="step"` and the `current` slot class
- **AND** the live region announces "Step 4 of 9" followed by step 4's headline

#### Scenario: Focused control keeps its keys
- **WHEN** keyboard focus is on the mode switch and the viewer presses `Space`
- **THEN** the mode switch is activated and the current step does not change

### Requirement: Sequence ends
Navigation SHALL always stay within the first and last step and SHALL NOT wrap around. Moving back from the first step SHALL leave the first step current and play a short edge nudge on the stage; moving forward from the last step SHALL leave the last step current and show an "End" marker after the progress bar.

#### Scenario: Back from the first step
- **WHEN** step 1 is current and the viewer presses `ArrowLeft`
- **THEN** step 1 remains current and the stage plays the edge nudge

#### Scenario: Forward from the last step
- **WHEN** the last step is current and the viewer presses `ArrowRight`
- **THEN** the last step remains current and the "End" marker is shown
