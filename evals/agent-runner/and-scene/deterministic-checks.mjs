#!/usr/bin/env node
// Static source evidence about the delivered candidate.
//
// These scans no longer produce criterion verdicts of their own. The scored
// criteria come from the live browser evaluation and the four product judges;
// what this module produces is bounded, cited evidence those judges reason
// over, plus the source half of the canonical-sample hard gate.
import { opendir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEMO_STEP_TITLES } from './lib/demo-contract.mjs'

const MAX_TEXT_FILES = 500
const MAX_TEXT_FILE_BYTES = 512 * 1024
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024
const MAX_SCAN_ENTRIES = 2000

// The canonical outline is normative and shared with the browser evaluation.
const SAMPLE_TITLES = DEMO_STEP_TITLES

async function textFiles(root, directory, budget) {
  const base = join(root, directory)
  try {
    if (!(await stat(base)).isDirectory()) return []
  } catch {
    return []
  }
  const output = []
  async function walk(current) {
    if (budget.exceeded.length > 0) return
    const entries = []
    const directory = await opendir(current)
    for await (const entry of directory) {
      budget.entries += 1
      if (budget.entries > MAX_SCAN_ENTRIES) {
        budget.exceeded.push(`more than ${MAX_SCAN_ENTRIES} filesystem entries`)
        return
      }
      entries.push(entry)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(?:[cm]?[jt]sx?|css|md)$/.test(entry.name)) {
        const candidatePath = relative(root, path)
        if (entry.isSymbolicLink()) {
          budget.exceeded.push(`${candidatePath} is a symbolic link`)
          return
        }
        if (budget.files >= MAX_TEXT_FILES) {
          budget.exceeded.push(`more than ${MAX_TEXT_FILES} text files`)
          return
        }
        const info = await stat(path)
        budget.files += 1
        if (info.size > MAX_TEXT_FILE_BYTES) {
          budget.exceeded.push(`${candidatePath} exceeds ${MAX_TEXT_FILE_BYTES} bytes`)
          return
        }
        if (budget.bytes + info.size > MAX_TOTAL_TEXT_BYTES) {
          budget.exceeded.push(`text files exceed ${MAX_TOTAL_TEXT_BYTES} total bytes`)
          return
        }
        budget.bytes += info.size
        output.push({ path: candidatePath, text: await readFile(path, 'utf8') })
      }
    }
  }
  await walk(base)
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

function result(id, pass, note, evidence) {
  return { id, verdict: pass ? 'pass' : 'fail', note, evidence }
}

function hasTokens(text, tokens) {
  const lower = text.toLowerCase()
  return tokens.every((token) => lower.includes(token.toLowerCase()))
}

// The full scan: the evidence rows plus the bounded list of candidate source
// paths that produced them. Judges need the paths to know what there is to
// review; without them a judge would be answering source-review criteria having
// been shown no source at all.
export async function collectSourceEvidence(root, options = {}) {
  const scanBudget = { entries: 0, files: 0, bytes: 0, exceeded: [] }
  const evidence = await runDeterministicChecks(root, { ...options, scanBudget })
  return {
    evidence,
    files: scanBudget.paths,
    budget_exceeded: [...new Set(scanBudget.exceeded)],
  }
}

export async function runDeterministicChecks(root, { screenshotManifest, scanBudget: injected } = {}) {
  const scanBudget = injected ?? { entries: 0, files: 0, bytes: 0, exceeded: [] }
  scanBudget.paths = []
  const sourceFiles = await textFiles(root, 'src', scanBudget)
  const scriptFiles = await textFiles(root, 'scripts', scanBudget)
  const skillFiles = await textFiles(root, 'skills', scanBudget)
  scanBudget.paths = [...sourceFiles, ...scriptFiles, ...skillFiles]
    .map(({ path }) => path)
    .sort()
  const source = sourceFiles.map(({ text }) => text).join('\n')
  const verify = scriptFiles.find(({ path }) => path === 'scripts/verify.mjs')?.text || ''
  const screenshotFile = [...scriptFiles, ...skillFiles]
    .find(({ path, text }) => path.endsWith('.mjs') && text.includes('playwright') && text.includes('screenshot'))
  const screenshot = screenshotFile?.text || ''

  const titlePositions = SAMPLE_TITLES.map((title) => source.indexOf(title))
  let sampleComplete = titlePositions.every((position) => position >= 0)
  if (screenshotManifest) {
    try {
      const manifest = JSON.parse(await readFile(screenshotManifest, 'utf8'))
      const sample = manifest.presentations?.find(({ slug }) => slug === 'how-to-make-a-presentation')
      const titlesInOrder = SAMPLE_TITLES.every((title, index) => sample?.stepTexts?.[index]?.includes(title))
      sampleComplete &&= manifest.expectedScreenshots === 9
        && manifest.capturedScreenshots === 9
        && sample?.expectedScreenshots === 9
        && sample?.capturedScreenshots === 9
        && titlesInOrder
    } catch {
      sampleComplete = false
    }
  }

  const attribution = source.includes('made by and-scene') && source.includes('github.com/Codagent-AI/and-scene')
  const activeState = source.includes('aria-current') && (source.includes('data-active') || source.includes('is-active'))
  const localHelper = Boolean(screenshotFile) && screenshot.includes('playwright')
  const overlap = hasTokens(screenshot, ['overlap', 'warning']) && (screenshot.includes('data-allow-overlap') || screenshot.includes('allow-overlap'))
  const activeWarning = hasTokens(screenshot, ['getComputedStyle', 'active', 'inactive', 'warning']) && screenshot.includes('aria-current')
  const attributionTarget = screenshot.includes('made by and-scene') || screenshot.includes('data-presentation-attribution')
  const attributionMissing = /missing[^\n]{0,40}attribution/i.test(screenshot)
    || /!\s*(?:isVisible\()?attribution/.test(screenshot)
  const attributionSize = screenshot.includes('font-size') || screenshot.includes('fontSize')
  const attributionDefault = screenshot.includes('text-decoration')
    || screenshot.includes('textDecoration')
    || screenshot.includes('defaultLink')
    || screenshot.includes('browser-default')
  const attributionWarning = attributionTarget && attributionMissing && attributionSize && attributionDefault && screenshot.toLowerCase().includes('warning')

  const scenarios = [
    result('verification-sample-outline', sampleComplete, sampleComplete ? 'Canonical nine-step sample is present.' : 'Canonical nine-step sample or nine-frame evidence is incomplete.', sourceFiles.filter(({ text }) => SAMPLE_TITLES.some((title) => text.includes(title))).map(({ path }) => path)),
    result('verification-ipv4-loopback', verify.includes('127.0.0.1') && !verify.includes('localhost'), verify.includes('127.0.0.1') && !verify.includes('localhost') ? 'Verification consistently names IPv4 loopback.' : 'Verification must use 127.0.0.1 and must not use localhost.', ['scripts/verify.mjs']),
    result('attribution-default-link', attribution, attribution ? 'Default attribution label and target are present.' : 'Default made by and-scene GitHub attribution is missing.', sourceFiles.filter(({ text }) => text.includes('made by and-scene')).map(({ path }) => path)),
    result('navigation-active-state', activeState, activeState ? 'Semantic current state and stable active hook are present.' : 'Active navigation needs aria-current plus a stable active hook.', sourceFiles.filter(({ text }) => text.includes('aria-current')).map(({ path }) => path)),
    result('quality-project-local-screenshot-helper', localHelper, localHelper ? 'Project-local Playwright screenshot helper is present.' : 'Project-local Playwright screenshot helper is missing.', screenshotFile ? [screenshotFile.path] : []),
    result('visual-helper-overlap-warning', overlap, overlap ? 'Overlap warning and allow-overlap marker are implemented.' : 'Overlap warning or explicit allow-overlap marker is missing.', screenshotFile ? [screenshotFile.path] : []),
    result('visual-helper-active-state-warning', activeWarning, activeWarning ? 'Active/inactive computed-style warning is implemented.' : 'Active-state visual comparison warning is missing.', screenshotFile ? [screenshotFile.path] : []),
    result('visual-helper-attribution-warning', attributionWarning, attributionWarning ? 'Attribution polish warning is implemented.' : 'Attribution missing/default/size warning is incomplete.', screenshotFile ? [screenshotFile.path] : []),
  ]
  if (scanBudget.exceeded.length === 0) return scenarios

  const reasons = [...new Set(scanBudget.exceeded)]
  const note = `Candidate text scan budget exceeded: ${reasons.join('; ')}.`
  return scenarios.map(({ id }) => result(id, false, note, reasons))
}

function valueAfter(args, option, required = true) {
  const index = args.indexOf(option)
  if (index === -1 || !args[index + 1]) {
    if (!required) return undefined
    throw new Error(`missing ${option}`)
  }
  return args[index + 1]
}

async function main(args) {
  const root = valueAfter(args, '--root')
  const output = valueAfter(args, '--output')
  const scenarios = await runDeterministicChecks(root, {
    screenshotManifest: valueAfter(args, '--screenshot-manifest', false),
  })
  await writeFile(output, `${JSON.stringify({ scenarios }, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
