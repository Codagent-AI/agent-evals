## ADDED Requirements

### Requirement: Export
The project SHALL provide `npm run export -- <slug>` that writes the named presentation as a PDF with one page per step and as one PNG image per step.

#### Scenario: Export a presentation
- **WHEN** the author runs `npm run export -- how-to-make-a-presentation`
- **THEN** a PDF with nine pages and nine PNG images are written under `exports/how-to-make-a-presentation/`

### Requirement: Visual editor
Browse mode SHALL offer an Edit toggle that lets the author drag and resize entities, edit captions, add or delete entities, and save the result back to the presentation's step files.

#### Scenario: Save an edited step
- **WHEN** the author enables Edit, moves an entity on step 2, and saves
- **THEN** the step 2 source file records the entity's new position

### Requirement: Publishing
The repository SHALL include a GitHub Pages workflow that builds the app and publishes every registered presentation on each push to `main`.

#### Scenario: Push publishes presentations
- **WHEN** a commit is pushed to `main`
- **THEN** the workflow deploys the built app so every registered presentation is reachable at its public Pages URL
