# Panel judging extraction baseline (INT-009)

`baseline.json` was captured before extraction from commit
`c8908e94418285f520747a250f166610a858129d`, using `capture()` in
`recording.mjs`. The invoker is a local stub; no model calls are made.

All six jobs include consensus passes, consensus failures, and a disagreement
settled by a line-cited third sample. Source jobs also run closed-world source
audits; evidence jobs use the evidence-view citation inventory. Prompt and
schema hashes, complete saved records, fresh and cached outcomes, and scorer
outputs are retained. Fresh and cached outcomes are captured separately because
the original cache path strips optional citations and changes output hashes.

The input paths are repository-relative so recorded cache hashes are portable.
The regression tests replay this fixed baseline; do not regenerate it to make an
extraction regression pass.

After extraction, only the ordering of the recorded prompt fingerprints was
changed to use serialized entries in UTF-16 code unit order rather than locale
collation. All captured values remain unchanged. Live capture uses the same
locale-independent ordering.
