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
const promptFile = process.argv[process.argv.indexOf('--system-prompt-file') + 1];
const prompt = process.argv.includes('--system-prompt-file') ? {system:fs.readFileSync(promptFile,'utf8'),promptMode:fs.statSync(promptFile).mode & 0o777} : {};
fs.appendFileSync(callsPath, JSON.stringify({...prompt,scratchMode:fs.statSync('.').mode & 0o777,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN === 'test-oauth-secret',apiKey:process.env.ANTHROPIC_API_KEY === 'test-api-secret',claudeApiKey:process.env.CLAUDE_CODE_API_KEY === 'test-claude-api-secret',configDir:process.env.CLAUDE_CONFIG_DIR,bedrock:process.env.CLAUDE_CODE_USE_BEDROCK,argv:process.argv.slice(2),cwd:process.cwd(),files:fs.readdirSync('.'),nested:process.env.CLAUDECODE,home:process.env.HOME})+'\\n');
const out = JSON.parse(fs.readFileSync(path.join(root,'outputs.json')))[n];
if (out.flood) {
  process.on('SIGTERM', () => {
    fs.appendFileSync(path.join(root,'signals.jsonl'), 'SIGTERM\\n');
    process.stdout.write('x'.repeat(out.flood)); process.stderr.write('y'.repeat(out.flood));
    if (!out.ignoreTerm) setTimeout(() => process.exit(0), 50);
  });
  process.stdout.write('x'.repeat(out.flood));
  process.stderr.write('y'.repeat(out.flood));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(out.stdout); process.stderr.write(out.stderr || ''); process.exitCode = out.code || 0;
}
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
