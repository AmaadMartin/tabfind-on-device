/**
 * Makes an unreleased `@google/adk` browser build available locally.
 *
 * This sample imports `@google/adk` directly and bundles it for the browser
 * with no shims, which is how it works once google/adk-js#614 and #618 are in
 * a published release. They are merged or in review, not yet released, so on
 * today's npm the import resolves to the Node build and the bundle fails.
 *
 * This script patches the *installed copy* in `node_modules` to look the way
 * the released package will:
 *
 *   1. Bundles the browser-safe subset of `dist/web` into a single parseable
 *      `index_web.js`, applying the Node-leak shims once — which is what #614
 *      moves into the package's own build.
 *   2. Adds the `browser` export condition — which is what #618 does.
 *
 * It touches nothing in this repository. Delete `node_modules`, or run
 * `npm ci`, and you are back to the published package. When the release lands,
 * this file and the `patch:adk` script can both go.
 *
 *   node scripts/patch-adk.mjs
 */

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgDir = path.join(root, 'node_modules', '@google', 'adk');
const webDir = path.join(pkgDir, 'dist', 'web');

if (!fs.existsSync(pkgDir)) {
  console.error('@google/adk is not installed. Run npm install first.');
  process.exit(1);
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
);
if (manifest.exports?.['.']?.browser && !fs.existsSync(path.join(webDir, 'agents'))) {
  console.log('Already patched, or already released. Nothing to do.');
  process.exit(0);
}

/* --- 1. the shims the published dist/web still needs ------------------- */

/**
 * Real files in `scripts/adk-browser-shims/`, not strings in this script.
 * They are small but not trivial — the winston stand-in has to implement
 * `format` as a callable with `combine`, `timestamp` and `printf` hung off it,
 * because that is how the logger uses it — and a shim that is quietly wrong
 * fails at run time, well away from here.
 */
const shimDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'adk-browser-shims');

/* --- 2. the browser-safe barrel ---------------------------------------- */

/**
 * The published `index_web.js` re-exports the full Node barrel, which drags in
 * the skills loader, the GCS artifact service and `load_web_page` — and with
 * them node:fs, node:path, node:dns and node:net. #614 replaces it with a
 * browser entry that does not export the Node-only surface. This is that list.
 */
const BROWSER_SURFACE = [
  ['models/base_llm.js', ['BaseLlm']],
  ['models/base_llm_connection.js', []],
  ['models/llm_request.js', []],
  ['models/llm_response.js', []],
  ['tools/base_tool.js', ['BaseTool']],
  ['tools/function_tool.js', ['FunctionTool']],
  ['agents/llm_agent.js', ['LlmAgent']],
  ['agents/parallel_agent.js', ['ParallelAgent']],
  ['agents/sequential_agent.js', ['SequentialAgent']],
  ['agents/loop_agent.js', ['LoopAgent']],
  ['plugins/base_plugin.js', ['BasePlugin']],
  ['runner/runner.js', ['Runner']],
  ['sessions/in_memory_session_service.js', ['InMemorySessionService']],
];

const entryLines = [];
for (const [file, names] of BROWSER_SURFACE) {
  if (!fs.existsSync(path.join(webDir, file))) continue;
  if (names.length) {
    entryLines.push(`export {${names.join(', ')}} from './${file}';`);
  }
}
const entryPath = path.join(webDir, '__browser_entry.js');
fs.writeFileSync(entryPath, `${entryLines.join('\n')}\n`);

const apigeePlugin = {
  name: 'apigee-stub',
  setup(build) {
    build.onResolve({ filter: /apigee_llm\.js$/ }, () => ({
      path: path.join(shimDir, 'apigee.js'),
    }));
  },
};

await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome138',
  outfile: path.join(webDir, 'index_web.patched.js'),
  logLevel: 'error',
  logLimit: 0,
  plugins: [apigeePlugin],
  alias: {
    module: path.join(shimDir, 'module.js'),
    winston: path.join(shimDir, 'winston.js'),
    'node:async_hooks': path.join(shimDir, 'async-hooks.js'),
    'node:crypto': path.join(shimDir, 'crypto.js'),
  },
});

fs.rmSync(entryPath);
fs.renameSync(
  path.join(webDir, 'index_web.patched.js'),
  path.join(webDir, 'index_web.js'),
);

/* --- 3. the browser export condition ----------------------------------- */

manifest.browser = './dist/web/index_web.js';
manifest.exports['.'] = {
  types: './dist/types/index.d.ts',
  browser: './dist/web/index_web.js',
  import: './dist/esm/index.js',
  require: './dist/cjs/index.js',
  default: './dist/esm/index.js',
};
fs.writeFileSync(
  path.join(pkgDir, 'package.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const size = fs.statSync(path.join(webDir, 'index_web.js')).size;
console.log(
  `Patched @google/adk@${manifest.version} in node_modules:\n` +
    `  dist/web/index_web.js  ${(size / 1024).toFixed(0)} kB, one file\n` +
    `  exports["."].browser   added\n\n` +
    'This is local only. `npm ci` undoes it.',
);
