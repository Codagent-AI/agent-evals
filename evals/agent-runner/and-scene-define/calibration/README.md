# and-scene-define calibration set

`run.sh --calibrate` judges these inputs to check that the judges:
- credit sound alternatives rather than the reference's shape;
- catch removed requirements, contradictions, excluded scope, and planted
  quality and fidelity defects;
- support a pass threshold that separates the expected-pass inputs from the
  degraded variants.

The set is **host-only**. Never stage it into a sandbox or publish it. The
starting-snapshot loader rejects any `calibration/` path (`lib/starting-repo.mjs`).
Sandbox input is a fixed six-file allowlist (`lib/sandbox.mjs`), and only the
input directory, artifact directory, Skills checkout, and credential files are
mounted (`lib/mount-plan.mjs`). These files hold the hidden reference and the
inventory's expected verdicts. Treat them like `hidden/`.

## Layout

```text
manifest.json                 inputs, expected outcomes, SHA-256 of every input file
<input_id>/collected/         the change directory, laid out like a run's collected/
<input_id>/expectations.json  expected per-item verdicts and the planted changes
<input_id>/conversation.jsonl only for inputs that plant fidelity contradictions
real-candidates/README.md     empty slot for maintainer-reviewed real candidates
```

`collected/` holds `proposal.md`, `specs/<capability>/spec.md`, `design.md`, and
`test-plan.md`. Each input passes `openspec validate add-presentation-skill
--strict` when copied to `openspec/changes/add-presentation-skill/` in a scratch
project.

`expectations.json` fields:
- `input_id`, `description`, `base`;
- `expected_outcome` (`pass`/`fail`) and `expected_fail_mark` (`proposed` for every
  degraded variant; the maintainer confirms or rejects each under HT-002);
- `expected`: `met`, `partial`, or `missing` for all 72 graded items (mandatory and
  acceptable-alternative). Coverage criterion IDs are the inventory IDs;
- `removed_items`, `contradicted_items`, `added_scope`, `weakened_items`, and
  `collateral_items`: every intended change and its knock-on effect on other items;
- `quality_defects` and `expected_quality` (proposed verdicts for the four
  `quality:*` criteria);
- `planted_fidelity_contradictions` and `expected_fidelity`, keyed by
  `fidelity:<exchange identity>`, when there is a conversation;
- `swapped_alternatives` and `unswapped_alternatives` (restructured only);
- `notes`, including borderline verdicts.

## Inputs

| Input | Expected | What it tests |
| --- | --- | --- |
| `reference` | pass | The fixture's own change at `ad667a9`, identical to `hidden/reference`. Two honest gaps: INV-094 is missing (only the test plan commits to it) and INV-118 is partial (parity is only enforced for drift that breaks rendering). |
| `restructured` | pass | The reference rewritten with four renamed capabilities, merged and split requirements, and new wording. Mechanisms are swapped for 34 of the 48 acceptable alternatives. All 72 items are met. |
| `reference-degraded-mandatory` | fail (proposed) | Removes INV-024, INV-058, INV-092, and INV-089; weakens INV-064; INV-055 and INV-090 become partial as a result. |
| `reference-degraded-contradictions` | fail (proposed) | Contradicts INV-008, INV-030, INV-045, INV-050, and INV-064. Its conversation plants contradictions of INV-115 (router library) and INV-120 (sample opens in browse mode). |
| `reference-degraded-scope-quality` | fail (proposed) | Adds excluded scope for INV-105, INV-106, and INV-107. Adds untestable scenarios, cross-artifact inconsistencies, decisions without rationale, and test-plan gaps. |
| `restructured-degraded-mandatory` | fail (proposed) | Removes INV-030, INV-075, INV-094, INV-045, and INV-096. |
| `restructured-degraded-mixed` | fail (proposed) | Contradicts INV-024, adds INV-106 as scope, weakens INV-093, and leaves stale test-plan expectations. Its conversation plants contradictions of INV-057 (plain CSS default) and INV-113 (landing page). |
| `restructured-degraded-quality` | fail (proposed) | Removes INV-093. Adds untestable scenarios, a registry inconsistency, decisions without rationale, and test-plan gaps. Its coverage loss is small, so whether it falls below the threshold depends mostly on artifact quality, which the maintainer decides. |

Fidelity is calibrated only through the two inputs with a `conversation.jsonl`.
Their exchanges use the responder's record shape
(`step`, `step_id`, `attempt`, `turn`, `agent_message`, `text`, `reply_type`, …).
Their first exchange carries the pinned starting prompt. The other inputs have no
conversation, so they have no fidelity job and no disclosure or discovery
evidence.

## Maintenance

- Changing any input file changes its hash. Update `manifest.json`, and bump
  `calibration_set_version` whenever expectations or inputs change.
- A new inventory version requires re-checking every expected verdict, because
  anchors may have changed.
- The reference and restructured inputs share the reference's normative sample
  values (titles, captions, 880 × 380, `127.0.0.1`). Apart from those, the
  restructured text shares no sentence of more than eight words with the
  reference.
