import { jsonl } from './transcripts.mjs'
const key = exchange => JSON.stringify([exchange.step, exchange.step_id, exchange.attempt, exchange.turn])
const identityKey = identity => JSON.stringify([identity.step_key, identity.attempt, identity.turn])
export function runnerReplies(records) {
  const requests = new Map(); const replies = []
  for (const record of records) {
    const id = identityKey(record.identity ?? record)
    if (record.type === 'request_written') {
      const previous = requests.get(id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(record.request)) throw new Error(`Runner exchange ${id}: differing request`)
      requests.set(id, record.request)
    }
    if (record.type === 'reply_acted') {
      const request = requests.get(id)
      if (!request) throw new Error(`Runner exchange ${id}: reply without request`)
      replies.push({ ...request, reply: record.reply?.text ?? record.reply?.reason, reply_type: record.reply?.action === 'abort' ? 'abort' : 'text' })
    }
  }
  return replies
}
function starts(audit) {
  const result = []; const active = new Map()
  for (const line of audit.split('\n')) {
    const match = line.match(/\[([^\]]+)\]\s+(\S+)\s+(\{.*\})$/)
    if (!match) continue
    const data = jsonl(match[3])[0]
    const prefix = match[1].split(',').map(p => p.trim()).join('/')
    if (match[2] === 'step_start' && data.prompt !== undefined) {
      const start = { ...data, prefix, replay: false }; result.push(start); active.set(prefix, start)
    }
    const start = active.get(prefix)
    if (start && match[2] === 'external_user_request') start.requested = true
    if (start && match[2] === 'external_user_reply' && !start.requested && data.replayed) start.replay = true
    if (start && match[2] === 'step_end') start.resolved_session_id ||= data.discovered_session_id ?? data.identity?.session_id
  }
  return result
}
export function reconcileConversation({ conversation, exchanges, transcripts, manifest, audit }) {
  const runner = runnerReplies(exchanges)
  const hostByKey = new Map()
  for (const reply of conversation) {
    const id = key(reply)
    if (hostByKey.has(id)) throw new Error(`host conversation exchange ${id}: duplicate reply`)
    hostByKey.set(id, reply)
    const counterparts = runner.filter(r => key(r) === id)
    if (counterparts.length !== 1 || counterparts[0].reply !== (reply.reply ?? reply.text) || (counterparts[0].reply_type === 'abort') !== (reply.reply_type === 'abort')) throw new Error(`Runner exchange ${id}: missing, duplicate, or differing reply`)
  }
  for (const reply of runner) if (!hostByKey.has(key(reply))) throw new Error(`Runner exchange ${key(reply)}: extra reply`)
  const origins = starts(audit)
  const checked = new Set()
  for (const transcript of transcripts.filter(t => t.role === 'lead')) {
    const session = transcript.session_id
    const replies = runner.filter(r => r.session_id === session && r.reply_type === 'text')
    const hostOrder = conversation.filter(r => replies.some(reply => key(reply) === key(r))).map(key)
    if (JSON.stringify(hostOrder) !== JSON.stringify(replies.map(key))) throw new Error(`lead transcript ${session}: reply order differs from host conversation`)
    const users = [...transcript.users]
    // A step_start audits the Runner-originated initial/resume turn. When
    // replay supplies an outstanding reply, that start does not add a prompt.
    // Consume starts in transcript order, using exact audited prompt text when
    // it is present; Claude may store the step prompt in its system snapshot.
    const sessionStarts = origins.filter(o => o.resolved_session_id === session || o.identity?.session_id === session || (!o.resolved_session_id && manifest.invocations.some(i => i.session_id === session && (i.prefix === o.prefix || i.step === o.prefix.split('/').at(-1)))))
    const promptStarts = sessionStarts.filter(o => !o.replay)
    const originCount = promptStarts.length
    let cursor = 0; let origin = 0
    for (const reply of replies) {
      const id = key(reply)
      // Initial prompts precede the first reply; subsequent starts are matched
      // by their audited prompt, so an arbitrary extra turn cannot be skipped.
      while (origin < originCount && cursor < users.length) {
        const prompt = promptStarts[origin]?.prompt
        if (origin === 0 && cursor === 0 || (prompt && users[cursor].text.includes(prompt))) { cursor++; origin++ } else break
      }
      if (!users[cursor]?.text.includes(reply.reply)) throw new Error(`lead transcript ${session} exchange ${id}: missing or differing reply`)
      cursor++; checked.add(id)
    }
    while (origin < originCount && cursor < users.length && (origin === 0 && cursor === 0 || users[cursor].text.includes(promptStarts[origin]?.prompt))) { origin++; cursor++ }
    if (cursor !== users.length || origin !== originCount) throw new Error(`lead transcript ${session} exchange ${replies.at(-1) ? key(replies.at(-1)) : 'none'}: extra or missing Runner user turn at ${cursor}`)
  }
  for (const reply of runner.filter(r => r.reply_type === 'text')) if (!checked.has(key(reply))) throw new Error(`lead transcript ${reply.session_id} exchange ${key(reply)}: missing reply session`)
  return { status: 'clean', exchanges: runner.length }
}
