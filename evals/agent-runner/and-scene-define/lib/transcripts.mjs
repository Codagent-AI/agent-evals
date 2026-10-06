// Native CLI evidence is normalized only on the host; raw records remain retained.
import { execFileSync } from 'node:child_process'
export const jsonl = text => text.split('\n').filter(line => line.trim()).map((line, index) => {
  try { return JSON.parse(line) } catch { throw new Error(`invalid transcript JSON at line ${index + 1}`) }
})
const stringify = value => typeof value === 'string' ? value : JSON.stringify(value ?? '')
const contentText = content => typeof content === 'string' ? content : (content ?? []).filter(c => ['text', 'input_text'].includes(c.type)).map(c => c.text).join('\n')
export function cursorRecords(path) {
  // SQLite's backup API includes committed WAL pages, without mutating the source.
  const output = execFileSync('sqlite3', ['-json', path, 'SELECT rowid, CAST(data AS TEXT) AS data FROM blobs ORDER BY rowid'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  return JSON.parse(output || '[]').map(row => { try { return JSON.parse(row.data) } catch { throw new Error(`invalid Cursor blob ${row.rowid}`) } })
}
export function parseTranscript(records, { cli, session, requireComplete = true } = {}) {
  const calls = new Map(); const users = []; let pending = false; let finals = 0; let turn = null
  const ensure = (id, name = 'unknown') => {
    if (!calls.has(id)) calls.set(id, { id, name, input: '', output: '', hasInput: false, hasOutput: false })
    const call = calls.get(id); if (name && name !== 'unknown') call.name = name; return call
  }
  const add = (id, name, field, value) => { const call = ensure(id, name); call[field] = stringify(value); call[field === 'input' ? 'hasInput' : 'hasOutput'] = true }
  for (const [index, record] of records.entries()) {
    const p = record.payload ?? record; const message = record.message ?? p
    const blocks = Array.isArray(message.content) ? message.content : []
    const role = message.role ?? record.type
    if (record.type === 'event_msg' && p.type === 'task_started') turn = p.turn_id ?? `turn-${index}`
    if (role === 'user' && !record.sourceToolUseID && !blocks.some(c => ['tool_result', 'tool-result'].includes(c.type))) {
      const text = contentText(message.content); if (text) { if (cli === 'codex' && turn && users.at(-1)?.turn === turn) users.at(-1).text += '\n' + text
        else users.push({ text, index, turn }); pending = true }
    }
    if (record.type === 'turn.started' || (record.type === 'event_msg' && p.type === 'task_started')) pending = true
    if (record.sourceToolUseID) {
      const call = ensure(record.sourceToolUseID)
      call.output += '\n' + contentText(message.content); call.hasOutput = true
    }
    for (const block of blocks) {
      if (block.type === 'tool_use' || block.type === 'tool-call') {
        add(block.id ?? block.toolCallId, block.name ?? block.toolName, 'input', block.input ?? block.args); pending = true
      }
      if (block.type === 'tool_result' || block.type === 'tool-result') add(block.tool_use_id ?? block.toolCallId, block.toolName, 'output', block.content ?? block.result)
    }
    if (record.type === 'response_item') {
      if (['function_call', 'custom_tool_call'].includes(p.type)) { add(p.call_id ?? p.id, p.name, 'input', p.arguments ?? p.input); pending = true }
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) add(p.call_id ?? p.id, null, 'output', p.output)
      if (p.type === 'web_search_call') {
        const id = p.call_id ?? p.id ?? `web-${index}`
        add(id, 'web_search', 'input', p.action ?? p.query); add(id, 'web_search', 'output', p.results ?? p.output ?? p)
      }
    }
    if (['web_search', 'web_search_call', 'web_search_result'].includes(p.type) && record.type !== 'response_item') {
      const id = p.call_id ?? p.id ?? `web-${index}`
      if (p.type !== 'web_search_result') add(id, 'web_search', 'input', p.action ?? p.query ?? p)
      if (p.type !== 'web_search_call' || p.results !== undefined || p.output !== undefined) add(id, 'web_search', 'output', p.results ?? p.output ?? p)
    }
    // Codex --json output copies contain completed items rather than response_items.
    if (record.type?.startsWith('item.') && record.item) {
      const item = record.item
      if (!['agent_message', 'reasoning', 'todo_list'].includes(item.type)) {
        const id = item.id ?? `item-${index}`
        add(id, item.type, 'input', item.command ?? item.arguments ?? item.action ?? item.query ?? item)
        if (record.type === 'item.completed') add(id, item.type, 'output', item.aggregated_output ?? item.result ?? item.results ?? item.output ?? item)
      }
    }
    // Cursor stream-json output has separate call/result events.
    if (record.type === 'tool_call') {
      const id = record.call_id ?? record.tool_call_id ?? `cursor-${index}`
      const tool = record.tool_call ?? record
      if (record.subtype === 'started') add(id, record.name ?? Object.keys(tool)[0], 'input', tool)
      else if (record.subtype === 'completed') { add(id, record.name ?? Object.keys(tool)[0], 'input', tool); add(id, null, 'output', record.result ?? tool) }
    }
    const final = (cli === 'claude' && record.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(message.stop_reason))
      || record.type === 'result' || record.type === 'turn.completed'
      || (record.type === 'event_msg' && p.type === 'task_complete')
      || (cli === 'cursor' && role === 'assistant' && blocks.some(c => c.type === 'text') && !blocks.some(c => c.type === 'tool-call'))
    if (final) { pending = false; finals++ }
  }
  const incomplete = [...calls.values()].find(call => !call.hasInput || !call.hasOutput)
  if (requireComplete && (pending || !finals || incomplete || (cli === 'cursor' && !calls.size))) {
    throw new Error(`truncated or incomplete transcript ${cli}:${session}${incomplete ? ` tool call ${incomplete.id}` : ''}`)
  }
  return { users, calls: [...calls.values()].map(({ hasInput, hasOutput, ...call }) => call), finals }
}
