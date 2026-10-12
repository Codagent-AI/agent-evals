## MODIFIED Requirements

### Requirement: Command-line usage errors
`experiments.mjs` SHALL accept `baseline <set|add-rep|anchor|show>` and `compare`. An unknown
command, an unknown option, or a missing required argument SHALL produce a usage message and a
non-zero exit without changing the record. `--help` SHALL print usage for the `baseline` commands and
the `compare` command.

#### Scenario: Unknown subcommand
- **WHEN** `experiments.mjs baseline promote` runs
- **THEN** it exits non-zero with a usage message, and the record is unchanged

#### Scenario: Help lists compare
- **WHEN** `experiments.mjs --help` runs
- **THEN** it exits zero and the usage lists the `baseline` commands and
  `compare --eval-issue <owner/repo#N> <result-dir>... [--json]`
