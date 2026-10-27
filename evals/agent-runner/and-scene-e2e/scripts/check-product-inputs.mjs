#!/usr/bin/env node
// Validates the product rubric, its preference-value list and the pinned versions against the pinned inventory.
// Usage: check-product-inputs.mjs [--extra-preference-value VALUE]
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPreferenceValues, loadProductInputs, validateProductRubric } from '../lib/product-rubric.mjs'
import { checkVersions } from '../lib/versions.mjs'
export async function check(args = []) {
  const extra = args.includes('--extra-preference-value') ? [args[args.indexOf('--extra-preference-value') + 1]] : []
  const { rubric, inventory, preferenceValues } = await loadProductInputs()
  const values = [...preferenceValues, ...extra]
  return [...validateProductRubric(rubric, inventory, { preferenceValues: values }), ...checkPreferenceValues({ values, inventory }), ...await checkVersions()]
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await check(process.argv.slice(2))
  console.log(errors.length ? errors.join('\n') : 'product inputs are valid')
  process.exitCode = errors.length ? 1 : 0
}
