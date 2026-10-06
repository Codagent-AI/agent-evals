import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export function assertStrictSchema(schema) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
    Object.values(schema.properties).forEach(assertStrictSchema)
  }
  if (schema.items) assertStrictSchema(schema.items)
}
export async function claudeStub(t, outputs) {
  const runDir = await mkdtemp(join(tmpdir(), 'define-invoker-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const command = join(runDir, 'claude')
  await writeFile(join(runDir, 'outputs.json'), JSON.stringify(outputs))
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const root = ${JSON.stringify(runDir)};
const callsPath = path.join(root, 'calls.jsonl');
const n = fs.existsSync(callsPath) ? fs.readFileSync(callsPath,'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(callsPath, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),files:fs.readdirSync('.'),nested:process.env.CLAUDECODE,home:process.env.HOME})+'\\n');
const out = JSON.parse(fs.readFileSync(path.join(root,'outputs.json')))[n];
process.stdout.write(out.stdout); process.stderr.write(out.stderr || ''); process.exitCode = out.code || 0;
`)
  await chmod(command, 0o755)
  return { runDir, command, calls: async () => (await readFile(join(runDir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) }
}
export function stream(reply = { reply_type: 'answer', text: 'No preference, your call.' }, extra = []) {
  return { stdout: [
    { type: 'system', subtype: 'init', tools: ['StructuredOutput'] },
    ...extra,
    { type: 'result', subtype: 'success', structured_output: reply, usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.1 },
  ].map(JSON.stringify).join('\n') }
}
