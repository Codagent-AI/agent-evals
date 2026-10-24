#!/usr/bin/env node
// Maintainer script: rebuilds calibration/reference.bundle and the variant patches from the pinned reference
// (and-scene REFERENCE_REF). The bundle is a single synthetic commit of the reference's source tree without its
// documentation assets or its change directory; every patch is produced by a deterministic edit of that tree.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SUITE_ROOT } from '../lib/files.mjs'
import { runShPin } from '../../and-scene/lib/pins.mjs'
const GIT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Calibration', GIT_AUTHOR_EMAIL: 'calibration@example.invalid', GIT_COMMITTER_NAME: 'Calibration', GIT_COMMITTER_EMAIL: 'calibration@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' }
const git = (cwd, args, options = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...GIT }, maxBuffer: 256 * 1024 * 1024, ...options })
const REFERENCE_DIR = 'src/presentations/how-to-make-a-presentation'
// The skill vendors a byte-identical snapshot of the kit, so a kit edit applies to both copies.
const kit = (file, edit) => [[`src/presentation-kit/${file}`, edit], [`skills/presentation/templates/bootstrap/src/presentation-kit/${file}`, edit]]
// Each variant is a list of [file, edit] pairs over the reference tree.
export const VARIANTS = {
  'preference-shifted': [
    ...kit('constants.ts', text => text.replace('DESIGN_W = 880', 'DESIGN_W = 960').replace('DESIGN_H = 380', 'DESIGN_H = 420')),
    // The reference's own tests pin the canvas and the step count, so they follow the shift.
    ['src/presentation-kit/constants.test.ts', text => text.replace('880 × 380', '960 × 420').replace('toBe(880)', 'toBe(960)').replace('toBe(380)', 'toBe(420)')],
    [`${REFERENCE_DIR}/outline.test.ts`, text => text.replace('nine normative steps', 'eight normative steps').replaceAll('toHaveLength(9)', 'toHaveLength(8)').replace('size).toBe(9)', 'size).toBe(8)')],
    ['src/presentations/index.ts', text => text.replace("slug: 'how-to-make-a-presentation'", "slug: 'tour'")],
    // The reference's verifier requires its sample's slug.
    ['scripts/verify-lib.mjs', text => text.replace("REFERENCE_SLUG = 'how-to-make-a-presentation'", "REFERENCE_SLUG = 'tour'")],
    [`${REFERENCE_DIR}/outline.ts`, text => text.replace(/title: '([^']+)'/g, (_, title) => `title: 'Part: ${title}'`).replace(/\n  \{\n    id: 'you-set-the-depth',[\s\S]*?\n  \},/, '')],
    [`${REFERENCE_DIR}/steps.ts`, text => text.replace(/\n  'you-set-the-depth':[^\n]*/, '')],
  ],
  // Preferences only, in the chrome and controls: attribution corner and label, the mode-toggle key, the opening mode.
  // The skill's description of the label and the kit's own key test follow the shift.
  'preference-shifted-chrome': [
    ...kit('Presentation.tsx', text => text.replace("attribution = 'made by and-scene',", "attribution = 'built with and-scene',").replace("            right: 16,\n            bottom: 8,", "            left: 16,\n            bottom: 8,")),
    ...kit('usePresentationNav.ts', text => text.replace("e.key === 'p' || e.key === 'P'", "e.key === 'm' || e.key === 'M'")),
    ['src/presentation-kit/usePresentationNav.test.ts', text => text.replace("{ key: 'p' }", "{ key: 'm' }")],
    ['skills/presentation/SKILL.md', text => text.replaceAll('`made by and-scene`', '`built with and-scene`')],
    [`${REFERENCE_DIR}/Talk.tsx`, text => text.replace('initialMode="browse"', 'initialMode="present"')],
  ],
  // Mandatory: a mode toggle keeps the current step.
  'degraded-mode-toggle-loses-position': [
    ...kit('usePresentationNav.ts', text => text.replace("() => setMode((m) => (m === 'browse' ? 'present' : 'browse')),", "() => { setStep(0); setMode((m) => (m === 'browse' ? 'present' : 'browse')) },")),
  ],
  // Mandatory: browse mode shows each step's caption.
  'degraded-captions-missing': [
    ...kit('chrome/Footer.tsx', text => text.replace(/\n\s*\{current\.caption\}/, '')),
  ],
  // Mandatory: focused controls keep their keys.
  'degraded-focused-controls-lose-keys': [
    ...kit('usePresentationNav.ts', text => text.replace(/      const target = e\.target\n      if \(\n[\s\S]*?\n      \) \{\n        return\n      \}\n/, '')),
  ],
}
export async function buildCalibration({ reference = '/Users/paul/codagent/and-scene', out = join(SUITE_ROOT, 'calibration'), ref = null } = {}) {
  ref ??= await runShPin('REFERENCE_REF')
  const work = await mkdtemp(join(tmpdir(), 'e2e-calibration-'))
  try {
    const tree = join(work, 'tree'); await mkdir(tree)
    const archive = execFileSync('git', ['-C', reference, 'archive', ref, '--', '.', ':!docs', ':!openspec'], { maxBuffer: 256 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', tree], { input: archive })
    git(tree, ['init', '--quiet', '--initial-branch=main']); git(tree, ['add', '-A']); git(tree, ['commit', '--quiet', '-m', `reference ${ref}`])
    git(tree, ['branch', 'add-presentation-skill'])
    await mkdir(out, { recursive: true })
    const bundle = join(out, 'reference.bundle')
    git(tree, ['bundle', 'create', bundle, 'main', 'add-presentation-skill'])
    for (const [name, edits] of Object.entries(VARIANTS)) {
      const checkout = join(work, name)
      execFileSync('git', ['clone', '--quiet', '--no-checkout', bundle, checkout], { env: { PATH: process.env.PATH, ...GIT } })
      git(checkout, ['checkout', '--quiet', 'main'])
      for (const [file, edit] of edits) {
        const path = join(checkout, file); const before = await readFile(path, 'utf8'); const after = edit(before)
        if (after === before) throw new Error(`variant ${name}: the edit to ${file} changed nothing`)
        await writeFile(path, after)
      }
      await writeFile(join(out, `${name}.patch`), git(checkout, ['diff', '--no-color']))
    }
    await writeFile(join(out, 'reference.json'), `${JSON.stringify({ reference_ref: ref, repository: 'Codagent-AI/and-scene', excluded: ['docs', 'openspec'] }, null, 2)}\n`)
    return { ref, variants: Object.keys(VARIANTS) }
  } finally { await rm(work, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await buildCalibration({ reference: process.argv[2] }), null, 2))
