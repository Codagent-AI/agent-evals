#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0
}

export function sanitizeJudgeManifest(manifest) {
  return {
    expectedPresentations: finiteNumber(manifest.expectedPresentations),
    capturedPresentations: finiteNumber(manifest.capturedPresentations),
    expectedScreenshots: finiteNumber(manifest.expectedScreenshots),
    capturedScreenshots: finiteNumber(manifest.capturedScreenshots),
    complete: manifest.complete === true,
    errorCount: Array.isArray(manifest.presentations)
      ? manifest.presentations.reduce(
          (count, presentation) => count + (Array.isArray(presentation.errors) ? presentation.errors.length : 0),
          0,
        )
      : 0,
  }
}

function valueAfter(args, option) {
  const index = args.indexOf(option)
  if (index === -1 || !args[index + 1]) throw new Error(`missing ${option}`)
  return args[index + 1]
}

async function main(args) {
  const input = valueAfter(args, '--input')
  const output = valueAfter(args, '--output')
  const manifest = JSON.parse(await readFile(input, 'utf8'))
  await writeFile(output, `${JSON.stringify(sanitizeJudgeManifest(manifest), null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
