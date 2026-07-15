#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const SAMPLE_TITLES = [
  'You have a topic',
  'The skill interviews you',
  'Answers become steps',
  'The deck grows',
  'You set the depth',
  'It assembles the scene',
  'It checks its own work',
  'Changed your mind? Loop it.',
  "You're looking at one",
]

async function textFiles(root, directory) {
  const base = join(root, directory)
  try {
    if (!(await stat(base)).isDirectory()) return []
  } catch {
    return []
  }
  const output = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(?:[cm]?[jt]sx?|css|md)$/.test(entry.name)) {
        output.push({ path: relative(root, path), text: await readFile(path, 'utf8') })
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

export async function runDeterministicChecks(root, { screenshotManifest } = {}) {
  const sourceFiles = await textFiles(root, 'src')
  const scriptFiles = await textFiles(root, 'scripts')
  const skillFiles = await textFiles(root, 'skills')
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

  return [
    result('verification-sample-outline', sampleComplete, sampleComplete ? 'Canonical nine-step sample is present.' : 'Canonical nine-step sample or nine-frame evidence is incomplete.', sourceFiles.filter(({ text }) => SAMPLE_TITLES.some((title) => text.includes(title))).map(({ path }) => path)),
    result('verification-ipv4-loopback', verify.includes('127.0.0.1') && !verify.includes('localhost'), verify.includes('127.0.0.1') && !verify.includes('localhost') ? 'Verification consistently names IPv4 loopback.' : 'Verification must use 127.0.0.1 and must not use localhost.', ['scripts/verify.mjs']),
    result('attribution-default-link', attribution, attribution ? 'Default attribution label and target are present.' : 'Default made by and-scene GitHub attribution is missing.', sourceFiles.filter(({ text }) => text.includes('made by and-scene')).map(({ path }) => path)),
    result('navigation-active-state', activeState, activeState ? 'Semantic current state and stable active hook are present.' : 'Active navigation needs aria-current plus a stable active hook.', sourceFiles.filter(({ text }) => text.includes('aria-current')).map(({ path }) => path)),
    result('quality-project-local-screenshot-helper', localHelper, localHelper ? 'Project-local Playwright screenshot helper is present.' : 'Project-local Playwright screenshot helper is missing.', screenshotFile ? [screenshotFile.path] : []),
    result('visual-helper-overlap-warning', overlap, overlap ? 'Overlap warning and allow-overlap marker are implemented.' : 'Overlap warning or explicit allow-overlap marker is missing.', screenshotFile ? [screenshotFile.path] : []),
    result('visual-helper-active-state-warning', activeWarning, activeWarning ? 'Active/inactive computed-style warning is implemented.' : 'Active-state visual comparison warning is missing.', screenshotFile ? [screenshotFile.path] : []),
    result('visual-helper-attribution-warning', attributionWarning, attributionWarning ? 'Attribution polish warning is implemented.' : 'Attribution missing/default/size warning is incomplete.', screenshotFile ? [screenshotFile.path] : []),
  ]
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
