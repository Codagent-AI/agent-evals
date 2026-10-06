# Recorded clean definition conversations

These fixtures retain the user, assistant, and tool records from the native
sessions of `claude-20261004T023042Z` and `codex-20261004T023437Z`, whose public
proof-of-concept records live in `openspec/changes/eval-the-whole-workflow/poc/runs/`.
Both runs asked questions and received requirements from the simulated user.

Absolute workspace and personal home paths and email addresses were redacted.
Thinking signatures, telemetry, and unrelated CLI metadata were omitted. Tool
inputs, tool results, user replies, and final-turn markers remain. The metrics
and exchange records translate the proof-of-concept conversation into Runner's
record shapes; their CLI and session mapping is fixture metadata, not measured
usage. `audit.log` identifies the single Runner-originated initial turn. The
proof-of-concept did not use Runner's external-user transport.
