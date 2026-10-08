## ADDED Requirements

### Requirement: Presentation definition
A presentation SHALL have a unique URL-safe slug, a title, an optional summary, a fixed-size drawing
area, and an ordered list of at least one step organized into scene groups. Each step SHALL have a
one-line title, a caption, and typed data for its scene. Steps SHALL be numbered from 1 in the order
they are defined across scene groups.

#### Scenario: Steps follow definition order across scene groups
- **WHEN** a presentation defines scene group A with 2 steps followed by scene group B with 3 steps
- **THEN** the presentation has 5 steps numbered 1 to 5, with A's steps first in their defined order

### Requirement: Each step defines its full diagram
The diagram shown for a step SHALL be that step's scene rendered with that step's data. It SHALL NOT
depend on which steps were shown before it.

#### Scenario: Direct and sequential arrival match
- **WHEN** step 4 is opened directly, and separately reached by moving through steps 1, 2, 3, and 4
- **THEN** after transitions finish both show the same entities, positions, sizes, and labels

### Requirement: Scene groups
Adjacent steps MAY share a scene group that uses one scene component. Moving between steps of the same
scene group SHALL keep the scene mounted and change only the step's data. Each step's data SHALL conform
to its scene's declared data type.

#### Scenario: Scene persists within a group
- **WHEN** the viewer moves between two steps of the same scene group
- **THEN** the scene is not re-created and entities present in both steps morph from their current
  on-screen state

#### Scenario: Mismatched step data fails the build
- **WHEN** a step supplies data that does not conform to its scene's declared data type
- **THEN** type-checking fails and identifies that step's data

### Requirement: Scene primitives
The scene kit SHALL provide these primitives, each rendered with a stable entity id: a node (a
positioned, sized box with label text), a connector (an arrow between two entities referenced by id,
with an optional label), a label (free-standing text), a region (a labeled area), an icon (a lucide-react
icon), a symbol chip (a small chip showing a short symbol or text), and an emphasis primitive that marks
entities as the focus of the step. A connector MAY join nodes, regions, labels, icons, symbol chips, and
custom entities that declare bounds. When a connector's endpoints change between steps, its ends SHALL
animate from the old endpoints to the new ones. When an endpoint entity departs, the connector SHALL stay
attached to it while both animate out.

#### Scenario: Connector attaches to its endpoints
- **WHEN** a connector joins node A to node B
- **THEN** the arrow runs from A's edge to B's edge and stays attached while either node moves

#### Scenario: Connector is reconnected
- **WHEN** connector `c` joins A to B in step 2 and A to C in step 3, and the viewer moves from step 2 to
  step 3
- **THEN** `c`'s end animates from B's edge to C's edge without `c` being removed and re-added

#### Scenario: Connector departs with its endpoint
- **WHEN** node B and connector `c` from A to B are in step 2 and neither is in step 3, and the viewer
  moves from step 2 to step 3
- **THEN** `c` remains attached to B while both animate out

#### Scenario: Icon renders
- **WHEN** a step renders an icon primitive with a lucide-react icon at a position
- **THEN** that icon is displayed at that position in the diagram

#### Scenario: Symbol chip renders
- **WHEN** a step renders a symbol chip with the text "API"
- **THEN** a chip showing "API" is displayed at its position

#### Scenario: Emphasis applies only to its step
- **WHEN** step 3 emphasizes node A and step 4 renders node A without emphasis
- **THEN** node A is visibly marked as the focus on step 3 and is not marked on step 4

### Requirement: Custom motion entities
Authors MAY render their own `motion` elements inside a custom entity with a stable entity id when no
primitive has the required shape. Such custom entities SHALL enter, morph, and exit between steps in the
same way as primitives, using the kit's transition timing, so they settle and respect reduced motion like
primitives. Raw motion elements inside a custom entity SHALL NOT set their own transition or repeat
animations; the structure check reports any that do, and does not report the raw motion elements
themselves. A custom entity MAY declare its bounds; the out-of-bounds check SHALL apply to it only when
it does.

#### Scenario: Custom entity morphs
- **WHEN** a custom motion entity with id `x` has a different shape or position in two consecutive steps
- **THEN** moving between those steps animates `x` from its previous shape and position to its new ones

#### Scenario: Custom entity enters and exits
- **WHEN** a custom motion entity is present in one step and absent from the next
- **THEN** moving to the next step animates it out, and moving back animates it in

#### Scenario: Custom entity passes the structure check
- **WHEN** a step renders raw motion elements inside a custom entity with a unique id and no declared bounds
- **THEN** the structure check reports no problem for that entity

#### Scenario: Custom entity under reduced motion
- **WHEN** reduced motion is requested and a custom entity's raw motion elements change between two steps
- **THEN** they take their new values immediately, like primitives

#### Scenario: Custom element with its own transition
- **WHEN** a raw motion element inside custom entity `x` in step 3 sets its own transition or a repeating
  animation
- **THEN** the structure check reports custom entity `x` at step 3 as overriding the kit's transitions

### Requirement: Transitions between steps
When the viewer moves from one step to another, entities whose id is present in both steps SHALL morph
in place, animating position, size, label text, and appearance; entities present only in the target step
SHALL animate in; and entities present only in the departing step SHALL animate out. This SHALL apply
both within a scene group and across scene groups. When a transition completes, the displayed diagram
SHALL be exactly the target step's diagram, regardless of the navigation path or of navigation that
occurred while an earlier transition was still running.

#### Scenario: Entity moves
- **WHEN** node A is at (100, 100) in step 2 and at (300, 100) in step 3, and the viewer moves from step 2
  to step 3
- **THEN** node A animates from (100, 100) to (300, 100)

#### Scenario: Entity is relabeled
- **WHEN** node A is labeled "Draft" in step 2 and "Final" in step 3, and the viewer moves from step 2 to
  step 3
- **THEN** node A's label changes from "Draft" to "Final" with an animated transition and node A is not
  removed and re-added

#### Scenario: Entities enter and exit
- **WHEN** entity B is present in step 3 but not step 2, entity C is present in step 2 but not step 3,
  and the viewer moves from step 2 to step 3
- **THEN** B animates in and C animates out

#### Scenario: Entity morphs across scene groups
- **WHEN** steps 3 and 4 belong to different scene groups and both render an entity with id `A`, and the
  viewer moves from step 3 to step 4
- **THEN** `A` morphs in place from its step 3 state to its step 4 state rather than disappearing and
  reappearing

#### Scenario: Jump animates directly to the target
- **WHEN** the viewer jumps from step 1 to step 5
- **THEN** the diagram animates directly to step 5's diagram without displaying steps 2 to 4

#### Scenario: Navigation during a transition settles on the latest target
- **WHEN** the viewer navigates to another step before the current transition has finished
- **THEN** once animation settles the displayed diagram is exactly the most recently requested step's
  diagram

### Requirement: Drawing-area scaling
The drawing area SHALL scale uniformly to fit the space available to it, preserving its aspect ratio and
without cropping any part of it.

#### Scenario: Narrow space
- **WHEN** the available space is proportionally narrower than the drawing area
- **THEN** the entire drawing area is visible, scaled to the available width

#### Scenario: Short space
- **WHEN** the available space is proportionally shorter than the drawing area
- **THEN** the entire drawing area is visible, scaled to the available height

### Requirement: Structure check
The scene kit SHALL provide a structure check that reports every problem it finds in a presentation, each
with its location as a step number, an entity id, or both. It SHALL report a presentation with no steps,
an empty scene group, a step title that is empty, spans more than one line, or exceeds 60 characters, an
empty caption, a duplicate entity id within one step, a connector that references an entity not present
in the same step, a primitive or a custom entity with declared bounds that extends outside the drawing
area, a connector endpoint that is a custom entity without declared bounds, a raw motion element inside a
custom entity that sets its own transition or repeats, a scene that renders markup outside kit primitives
and custom entities, a scene that throws while rendering a step, and a missing, invalid, or duplicate slug
among registered presentations. Entity-level checks SHALL be performed by rendering each
step's scene with that step's data and inspecting the entities it declares.

#### Scenario: All problems are reported
- **WHEN** step 2 has an empty caption and step 5 renders two entities with id `A`
- **THEN** the check reports both problems, one located at step 2 and one at step 5 with entity `A`

#### Scenario: Dangling connector
- **WHEN** step 3 renders a connector to entity `B` and step 3 does not render `B`
- **THEN** the check reports the connector at step 3 as referencing a missing entity `B`

#### Scenario: Out-of-bounds primitive
- **WHEN** a node in step 2 extends beyond the right edge of the drawing area
- **THEN** the check reports that node at step 2 as outside the drawing area

#### Scenario: Markup outside kit entities
- **WHEN** step 4's scene renders a raw element that is neither a kit primitive nor inside a custom entity
- **THEN** the check reports step 4 as rendering markup outside kit entities

#### Scenario: Connector to a custom entity without bounds
- **WHEN** step 2 renders a connector to custom entity `x` that declares no bounds
- **THEN** the check reports the connector at step 2 as having an endpoint without geometry

#### Scenario: Scene throws while rendering
- **WHEN** a scene throws while rendering step 6
- **THEN** the check reports step 6 as failing to render, together with the error message, and still
  reports problems found in other steps

#### Scenario: Overlong title
- **WHEN** step 1's title is 61 characters long
- **THEN** the check reports step 1's title as exceeding 60 characters

#### Scenario: Duplicate slug
- **WHEN** two registered presentations share the same slug
- **THEN** the check reports the duplicate slug

#### Scenario: Valid presentation
- **WHEN** a presentation has none of the listed problems
- **THEN** the check reports no problems

### Requirement: Invalid presentation display
Opening a presentation SHALL run the structure check before any part of the diagram is displayed,
showing a pending state until the check completes. A presentation that fails the check SHALL display the
list of reported problems instead of the diagram.

#### Scenario: Invalid presentation is opened
- **WHEN** a registered presentation that fails the structure check is opened
- **THEN** the page lists its problems with their locations and does not render any part of the diagram

#### Scenario: Valid presentation opens after the check
- **WHEN** a valid presentation is opened
- **THEN** a pending state is shown until the check completes, then the requested step is displayed, with
  no errors logged

### Requirement: Presentation index
Presentations SHALL be added to an app by registering them in the presentation index. The index SHALL
list each registered presentation's title and summary in registration order, and every registered
presentation SHALL be reachable at its own route.

#### Scenario: Registered presentation is listed and reachable
- **WHEN** a presentation is registered in the index
- **THEN** the index lists its title and summary, and the presentation opens at its own route
