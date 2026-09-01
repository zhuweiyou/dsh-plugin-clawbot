/**
 * Build the Host half: transpile src/*.ts → lib/*.js with esbuild.
 *
 * Unlike tsc's strict type-checking pass, esbuild only transpiles — it strips
 * types without enforcing annotations, which is exactly right for this
 * migrated-JS codebase. The output is plain ESM that the DSH Cordis loader
 * loads directly (same contract as the original handwritten lib/*.js).
 */
import { build } from 'esbuild'
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const srcDir = `${root}/src`
const outDir = `${root}/lib`

// Compile every top-level *.ts in src/ that is NOT under src/client/
const entries = {}
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.ts') && file !== 'client') {
    entries[file.slice(0, -3)] = `${srcDir}/${file}`
  }
}

await build({
  entryPoints: entries,
  outdir: outDir,
  format: 'esm',
  target: 'es2019',
  platform: 'node',
  bundle: false,          // keep internal imports as relative ESM
  sourcemap: false,
  outExtension: { '.js': '.js' },
})

console.log(`[build-host] transpiled ${Object.keys(entries).length} modules → lib/`)
