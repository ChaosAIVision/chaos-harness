import { defineConfig } from 'tsdown'
import metadata from './package.json' with { type: 'json' }

const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: (specifier: string) => specifier === metadata.name },
})

/** Loader entries share human approval validation through the package root without private chunks. */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/model-selection-settings.js'),
])
