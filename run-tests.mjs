/**
 * Bundles a test entry the same way the app is bundled, then runs it on Node.
 *
 * The bundle is the point: it type-checks and links against the browser build
 * of `@google/adk`, so a test exercises the code path the extension ships,
 * not a Node-only variant of it.
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2] ?? 'tests/pipeline.test.ts';

await esbuild.build({
  entryPoints: [path.join(root, entry)],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome138',
  conditions: ['browser'],
  outfile: path.join(root, 'tmp/test.mjs'),
  logLevel: 'warning',
  logLimit: 0,
});

const result = spawnSync(process.execPath, [path.join(root, 'tmp/test.mjs')], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
