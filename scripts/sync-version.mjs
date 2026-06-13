/**
 * sync-version.mjs
 * ----------------
 * Single source of truth for the app version is package.json. This script copies
 * that version into app.json (the Even Hub manifest) and the `**Version:**` line
 * of each doc, so they never drift.
 *
 * Runs automatically via two package.json hooks:
 *   - `version`  — during `npm version <patch|minor|major>`, then git-adds the
 *                  synced files so they land in the version commit.
 *   - `prebuild` — before every `npm run build`, so a stale version can't ship.
 *
 * Run it by hand any time with `npm run sync-version`. Idempotent: it only writes
 * files whose version actually differs, and prints what (if anything) changed.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sync-version: package.json version "${version}" is not x.y.z`)
  process.exit(1)
}

const DOCS = ['README.md', 'HANDOFF.md', 'USER-GUIDE.md', 'DEV-GUIDE.md']
const changed = []

// app.json — targeted replace of the version string so the rest of the manifest
// (key order, the permissions block, formatting) is left byte-for-byte intact.
const appPath = join(root, 'app.json')
const appBefore = readFileSync(appPath, 'utf8')
const appAfter = appBefore.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)
if (!/("version":\s*")[^"]*(")/.test(appBefore)) {
  console.error('sync-version: no "version" field found in app.json')
  process.exit(1)
}
if (appAfter !== appBefore) {
  writeFileSync(appPath, appAfter)
  changed.push('app.json')
}

// docs — replace the single `**Version:** x.y.z` line in each.
for (const doc of DOCS) {
  const path = join(root, doc)
  const before = readFileSync(path, 'utf8')
  if (!/^\*\*Version:\*\*/m.test(before)) {
    console.warn(`sync-version: ${doc} has no "**Version:**" line — skipped`)
    continue
  }
  const after = before.replace(/^\*\*Version:\*\*.*$/m, `**Version:** ${version}`)
  if (after !== before) {
    writeFileSync(path, after)
    changed.push(doc)
  }
}

console.log(
  changed.length
    ? `sync-version: set ${version} in ${changed.join(', ')}`
    : `sync-version: all files already at ${version}`,
)
