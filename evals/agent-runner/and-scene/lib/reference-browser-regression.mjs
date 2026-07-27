#!/usr/bin/env node
// Real-browser cutover regression for the immutable reference presentation.
//
// The command deliberately consumes an already built and served reference.
// Build and server infrastructure remain in the and-scene product repository;
// this suite owns only the AXI-driven deterministic assertions.
import { pathToFileURL } from 'node:url'

import { createAxiBrowserDriver } from './axi-browser-driver.mjs'
import { runBrowserEvaluation } from './browser-eval.mjs'
import { writeJsonAtomic } from './persistence.mjs'

export const REFERENCE_REVISION = '171c7def1e12aca2a5f605a5e5feafb20d4e4d19'

const CANONICAL_CRITERIA = [
  'demo-route-and-registration',
  'demo-nine-step-content-and-order',
  'demo-required-scene-content',
  'demo-evolving-scene-structure',
  'quality-captions-and-navigation',
]

export async function runReferenceBrowserRegression({
  baseUrl,
  revision,
  driverFactory = ({ baseUrl: url }) => createAxiBrowserDriver({ baseUrl: url }),
  evaluate = ({ driver, revision: evaluatedRevision }) => runBrowserEvaluation({
    driver,
    revision: evaluatedRevision,
    build: { ok: true, log: 'reference build completed before browser regression' },
    verification: {
      machine_readable: true,
      passed: true,
      artifact: 'reference repository npm run verify',
    },
  }),
} = {}) {
  if (revision !== REFERENCE_REVISION) {
    throw new Error(
      `real-browser regression requires pinned reference revision ${REFERENCE_REVISION}; received ${revision ?? 'none'}`,
    )
  }
  const driver = driverFactory({ baseUrl })
  const evaluation = await evaluate({ driver, revision })
  const criteria = new Map((evaluation.criteria ?? []).map((entry) => [entry.id, entry]))
  const probes = new Map((evaluation.probes ?? []).map((entry) => [entry.id, entry]))

  for (const id of CANONICAL_CRITERIA) {
    if (criteria.get(id)?.verdict !== 'pass') {
      throw new Error(`pinned reference browser regression failed canonical criterion ${id}`)
    }
    const probe = probes.get(id)
    if (
      probe?.required_mode !== 'browse'
      || probe?.established_state?.mode !== 'browse'
    ) {
      throw new Error(`pinned reference criterion ${id} was not verified in browse mode`)
    }
    if (probe?.settled_state?.settled !== true) {
      throw new Error(`pinned reference criterion ${id} did not record a settled browser state`)
    }
  }

  return {
    passed: true,
    ownership: 'evaluator-produced',
    evaluator: 'deterministic-browser-reference-regression',
    revision,
    base_url: baseUrl,
    canonical_criteria: CANONICAL_CRITERIA,
    evaluation,
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag)
  if (index === -1 || !args[index + 1]) throw new Error(`missing ${flag}`)
  return args[index + 1]
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const output = valueAfter(args, '--output')
  runReferenceBrowserRegression({
    baseUrl: valueAfter(args, '--url'),
    revision: valueAfter(args, '--revision'),
  }).then(async (result) => {
    await writeJsonAtomic(output, result)
    console.log(`pinned reference browser regression passed at ${result.revision}`)
  }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
