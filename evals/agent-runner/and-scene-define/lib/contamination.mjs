import { compilePatterns } from './canary.mjs'
import { parseTranscript } from './transcripts.mjs'
export const RESIDUAL_RISK = 'The sandbox has network access and the reference is publicly reachable, so contamination is detected by audit rather than prevented. The exchange and audit evidence are writable by the evaluated agent and are checked by reconciliation rather than protected. Open hardening options are an enforced outbound-network allowlist, a private fixture, and a separate OS user for the Runner. The Runner Docker image is not scanned.'
const writingTool = name => /^(?:write|edit|multiedit|notebookedit|apply_patch|file_change|str_replace_editor|str_replace|write_file|edit_file)$/i.test(name.split(/[.:/]/).at(-1))
export function auditContamination({ transcripts, outputs = [], conversation, patterns }) {
  const compiled = compilePatterns(patterns)
  const excluded = compiled.filter(p => p.kind === 'canary' && conversation.some(r => r.reply_type !== 'abort' && p.matches(r.reply ?? r.text ?? ''))).map(p => p.id).sort()
  const matches = []
  const sources = [
    ...transcripts.map(t => ({ source: t.source, session: t.session_id, calls: t.calls })),
    ...outputs.map(o => ({ source: o.source, session: o.session_id, calls: parseTranscript(o.records, { cli: o.cli, session: o.session_id, requireComplete: false }).calls })),
  ]
  for (const source of sources) for (const call of source.calls) for (const field of ['input', 'output']) {
    const text = typeof call[field] === 'string' ? call[field] : JSON.stringify(call[field] ?? '')
    for (const pattern of compiled) {
      if (pattern.kind === 'canary' && (excluded.includes(pattern.id) || writingTool(call.name))) continue
      if (!pattern.matches(text)) continue
      const index = pattern.type === 'literal' ? text.toLowerCase().indexOf(pattern.value.toLowerCase()) : text.search(new RegExp(pattern.value, 'im'))
      matches.push({ session: source.session, source: source.source, tool_call: call.id, tool: call.name, field, pattern: pattern.id, kind: pattern.kind, excerpt: text.slice(Math.max(0, index - 80), index + Math.max(pattern.value.length, 160)) })
    }
  }
  matches.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)
  return { schema_version: 1, pattern_version: patterns.version, status: matches.length ? 'contaminated' : 'clean', ...(matches.length ? { evaluation_status: 'contaminated', definition_verdict: 'unavailable' } : {}), matches, excluded_canaries: excluded, residual_risk: RESIDUAL_RISK }
}
