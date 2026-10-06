# Real candidate definitions

This slot holds real candidate definitions from completed and-scene-define runs,
each with expected verdicts that a maintainer has reviewed. It is empty because no
reviewed real candidates exist yet. Do not add verdicts that a maintainer has not
reviewed, and do not copy unreviewed judge output in as expectations.

To add a candidate after maintainer review:

1. Create `real-candidates/<run-id>/` containing:
   - `collected/`: the run's frozen `collected/` directory, byte for byte;
   - `conversation.jsonl`: the run's simulated-user conversation, unchanged;
   - `expectations.json`: the same shape as the synthetic inputs. `expected` must
     give `met`, `partial`, or `missing` for all 72 graded items.
     `expected_outcome` is the maintainer's pass/fail call. Add `reviewer`,
     `review_date`, `source_run` (the run directory and its result commit), and
     `rubric_version`.
2. Add the input to `../manifest.json` under `real_candidates.inputs` with
   SHA-256 hashes of every file.
3. Real candidates are host-only, like the rest of `calibration/`. They are never
   staged into a sandbox or published.
