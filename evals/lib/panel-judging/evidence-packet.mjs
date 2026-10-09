// The harness-written frame of an evidence judge packet (packet.txt).
//
// The packet opens, before any candidate text, with two blocks the harness
// writes: the cut index, which lists every artifact the packet budget cut or
// dropped by its in-place marker, and the layout, which gives every candidate
// artifact's packet lines. Every stage reads the frame from the top of the
// packet only, so candidate text that imitates it cannot add a marker or move
// an artifact boundary.

export const CUT_INDEX_BEGIN = '# BEGIN PACKET CUT INDEX'
export const CUT_INDEX_END = '# END PACKET CUT INDEX'
export const LAYOUT_BEGIN = '# BEGIN PACKET LAYOUT'
export const LAYOUT_END = '# END PACKET LAYOUT'
export const PACKET_PATH = 'packet.txt'

// The in-place markers. Each one names the artifact, its full size, and for a
// cut the size kept, so a stage can name exactly what it did not see.
export const truncatedMarker = (id, kept, total) => `[truncated: ${id} kept ${kept} of ${total} characters]`
export const omittedMarker = (id, role, total) => `[omitted: ${id} (${role}), ${total} characters, packet budget]`

export const layoutLine = ({ start, end, id, role, marker = null }) => (start === null || start === undefined
  ? `- not included: ${id} (${role}) ${marker}`
  : `- lines ${start}-${end}: ${id} (${role})${marker ? ` ${marker}` : ''}`)

// The frame's lines: the cut index (`- none` when nothing was cut), the
// layout, and a blank line before the verified index.
export function packetFrame({ cuts, entries }) {
  return [
    CUT_INDEX_BEGIN,
    ...(cuts.length ? cuts.map((marker) => `- ${marker}`) : ['- none']),
    CUT_INDEX_END,
    LAYOUT_BEGIN,
    ...entries.map(layoutLine),
    LAYOUT_END,
    '',
  ]
}

// The text between a block's BEGIN and END lines, at `from` or, when `from` is
// null, at the block's first occurrence. Null when the block is absent.
function blockBody(text, begin, end, from = null) {
  const value = String(text ?? '')
  const at = from === null ? value.indexOf(`${begin}\n`) : (value.startsWith(`${begin}\n`, from) ? from : -1)
  if (at < 0) return null
  const start = at + begin.length + 1
  // END must be a whole line, so candidate text such as `${end} extra` never closes the block.
  let stop = value.indexOf(`\n${end}`, start - 1)
  while (stop >= 0) {
    const after = stop + end.length + 1
    if (after === value.length || value[after] === '\n') break
    stop = value.indexOf(`\n${end}`, stop + 1)
  }
  if (stop < start - 1) return null
  return { body: value.slice(start, Math.max(start, stop)), next: stop + end.length + 2 }
}

const entryLines = (body) => (body ?? '').split('\n').filter((line) => line.startsWith('- '))

function parseCuts(body) {
  return entryLines(body).flatMap((line) => {
    const marker = line.slice(2)
    const match = /^\[(truncated|omitted): (\S+?)(?:\s|\])/.exec(marker)
    return match ? [{ marker, kind: match[1], id: match[2] }] : []
  })
}

// The cuts a packet's own cut index lists. In a packet file the index must
// open the file; in a prompt that quotes a packet, its first occurrence is the
// harness's, because the packet's frame precedes every candidate artifact.
export function packetCuts(text, { atStart = false } = {}) {
  const block = blockBody(text, CUT_INDEX_BEGIN, CUT_INDEX_END, atStart ? 0 : null)
  return block ? parseCuts(block.body) : []
}

// The cut index block itself, verbatim, for the audits and checks that must
// know what was cut; null for a packet without one.
export function cutIndexText(text) {
  const block = blockBody(text, CUT_INDEX_BEGIN, CUT_INDEX_END, 0)
  return block ? [CUT_INDEX_BEGIN, block.body, CUT_INDEX_END].join('\n') : null
}

// A reported marker names a cut when it holds the cut index's marker, or its
// bare `[truncated: <id>` or `[omitted: <id>` prefix: a judge that shortens or
// rewords the size need not repeat a whole output. The canonical marker is
// returned; anything else, such as a paraphrase without the prefix or an id
// the index does not list, is null.
export function matchCutMarker(reported, cuts) {
  const value = String(reported ?? '').trim()
  if (!value) return null
  const whole = cuts.find(({ marker }) => value.includes(marker))
  if (whole) return whole.marker
  for (const cut of cuts) {
    const prefix = `[${cut.kind}: ${cut.id}`
    let at = value.indexOf(prefix)
    while (at >= 0) {
      if (!/[A-Za-z0-9_.-]/.test(value.charAt(at + prefix.length))) return cut.marker
      at = value.indexOf(prefix, at + 1)
    }
  }
  return null
}

// The packet's frame, parsed from the top of the file: its cuts and each
// artifact's packet lines (content lines, including any in-place marker).
export function packetLayout(text) {
  const cutBlock = blockBody(text, CUT_INDEX_BEGIN, CUT_INDEX_END, 0)
  if (!cutBlock) return null
  const layoutBlock = blockBody(text, LAYOUT_BEGIN, LAYOUT_END, cutBlock.next)
  if (!layoutBlock) return null
  const artifacts = entryLines(layoutBlock.body).flatMap((line) => {
    const included = /^- lines (\d+)-(\d+): (\S+) \(([^)]+)\)(?: (\[.+\]))?$/.exec(line)
    if (included) {
      return [{ id: included[3], role: included[4], start: Number(included[1]), end: Number(included[2]), marker: included[5] ?? null }]
    }
    const omitted = /^- not included: (\S+) \(([^)]+)\) (\[.+\])$/.exec(line)
    return omitted ? [{ id: omitted[1], role: omitted[2], start: null, end: null, marker: omitted[3] }] : []
  })
  return { cuts: parseCuts(cutBlock.body), artifacts }
}

// The label of a quoted packet span: every artifact it lies in, with that
// artifact's marker when it was cut, or the harness frame and index it quotes.
export function spanLabel(layout, start, end) {
  if (!layout) return ''
  const included = layout.artifacts.filter((artifact) => artifact.start !== null)
  const touched = included.filter((artifact) => artifact.start <= end && artifact.end >= start)
  const labels = touched.map(({ id, role, marker }) => `artifact ${id} (${role})${marker ? `, cut ${marker}` : ''}`)
  const covered = touched.reduce((count, { start: from, end: to }) => count + Math.min(end, to) - Math.max(start, from) + 1, 0)
  if (covered < end - start + 1) labels.unshift('harness frame or verified index')
  return `[${labels.join('; ')}]`
}

// The sections of the packet that hold artifacts of `roles`, each as a quoted
// span of packet lines with its label.
export function roleSections(layout, roles, lines) {
  if (!layout) return []
  return layout.artifacts
    .filter(({ role, start }) => roles.includes(role) && start !== null)
    .map(({ start, end }) => ({ path: PACKET_PATH, start_line: start, end_line: end,
      lines: lines.slice(start - 1, end).map((text, offset) => ({ line: start + offset, text })),
      label: spanLabel(layout, start, end) }))
}

// The verified index the packet quotes, parsed; null when absent or invalid.
// It is read only where the harness writes it, directly after the frame (or at
// the top of a packet without one), so candidate text that imitates the index
// can never be parsed in its place.
export function packetIndex(text) {
  const value = String(text ?? '')
  let from = 0
  const cutBlock = blockBody(value, CUT_INDEX_BEGIN, CUT_INDEX_END, 0)
  if (cutBlock) {
    const layoutBlock = blockBody(value, LAYOUT_BEGIN, LAYOUT_END, cutBlock.next)
    if (!layoutBlock) return null
    from = layoutBlock.next
    while (value[from] === '\n') from++
  }
  const block = blockBody(value, '# BEGIN VERIFIED INDEX', '# END VERIFIED INDEX', from)
  if (!block) return null
  try {
    return JSON.parse(block.body)
  } catch {
    return null
  }
}
