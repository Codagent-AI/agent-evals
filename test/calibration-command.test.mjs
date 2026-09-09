// Calibration is an explicit maintainer diagnostic, not a runtime receipt that
// callers must preserve and supply to candidate evaluations.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseArgs, runCalibrationCommand } from '../evals/agent-runner/and-scene/calibrate.mjs'

async function root() {
  return mkdtemp(join(tmpdir(), 'agent-evals-calibration-command-'))
}

test('calibration writes its diagnostic ledger without a separate receipt', async () => {
  const dir = await root()
  const out = join(dir, 'run')
  const outcome = await runCalibrationCommand({ argv: ['--out', out] })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  const ledger = JSON.parse(await readFile(join(out, 'calibration.json'), 'utf8'))
  assert.equal(ledger.passed, true)
})

test('calibration rejects obsolete receipt options', () => {
  assert.throws(() => parseArgs(['--check-record', '/tmp/receipt.json']), /unknown calibrate option/)
  assert.throws(() => parseArgs(['--out', '/tmp/run', '--record', '/tmp/receipt.json']), /unknown calibrate option/)
})
