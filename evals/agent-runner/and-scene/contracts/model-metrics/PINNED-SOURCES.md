# Pinned model-metrics contracts

The `v1/` directory is a verbatim fixture and schema snapshot used by the
and-scene suite. It is pinned to these clean product revisions:

- Agent Validator: `c747dc8cb11ac119da5a3d65a8e4597572a5c46a`
- Agent Runner: `869ea5ec5ad0b6c904e694b2c58c8b772716f822`

The Validator files were copied from `contracts/model-metrics/v1/`. The Runner
invocation schema was copied from
`internal/measurements/invocation-v1.schema.json`.

The compatible wire versions are Agent Runner `run-metrics.json` schema v4,
Runner aggregate v1, Runner native-measurement v1 and v2, and Agent Validator
measurement/export v1. Native-measurement v2 (Agent Runner `3ad7008` and
later) adds per-thread Claude `allocations` and `subagent_collection`; it is
tested in `test/runner-metrics.test.mjs`, not in the `v1/` snapshot. Update this snapshot and its fixture tests together;
do not silently accept a new outer or nested version.
