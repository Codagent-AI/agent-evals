const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
// Inline every result field, including detailed panels and provenance. No assets
// or executable content are required to inspect a copied report offline.
export function renderReport(result) {
  const fields = Object.entries(result).map(([key, value]) => `<section><h2>${escape(key)}</h2><pre>${escape(JSON.stringify(value, null, 2))}</pre></section>`).join('\n')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>and-scene-define ${escape(result.run_id)}</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#202124}h2{font-size:1.1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f6;padding:1rem}section{border-top:1px solid #ddd}</style><h1>and-scene-define</h1><p>${escape(result.evaluation_status)} / ${escape(result.definition_verdict)}</p>${fields}</html>\n`
}
