/**
 * Build script.
 *
 * This is the whole thing. `@google/adk` publishes a `browser` export
 * condition and a browser build that bundles, so a browser app imports the
 * package the way a Node app does and esbuild resolves it: no aliases, no
 * plugins, no shims for Node built-ins.
 *
 * That was not true before google/adk-js#614 and #618. An earlier version of
 * this sample carried 226 lines of workaround — four shims, a stub for an
 * unparseable module, and a dual-resolution import layer — to get the same
 * result. Those files are gone, and this comment is the only trace.
 *
 *   node build.mjs [--watch] [--dev]
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome138',
  minify: !dev,
  sourcemap: dev ? true : 'linked',
  logLevel: 'info',
  logLimit: 0,
  define: { 'process.env.NODE_ENV': '"production"' },
};

const outdir = path.join(root, 'dist');
fs.mkdirSync(outdir, { recursive: true });

const targets = [
  ['src/ext/sidepanel.ts', 'dist/sidepanel.js'],
  ['src/ext/service-worker.ts', 'dist/service-worker.js'],
  ['src/harness/harness.ts', 'dist/harness.js'],
];

const STATIC = [
  ['src/ext/manifest.json', 'dist/manifest.json'],
  ['src/ext/panel.css', 'dist/panel.css'],
  ['src/ext/sidepanel.html', 'dist/sidepanel.html'],
  ['src/harness/harness.html', 'dist/harness.html'],
];

function copyStatic() {
  for (const [from, to] of STATIC) {
    const source = path.join(root, from);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.copyFileSync(source, path.join(root, to));
  }
}

const options = ([entry, out]) => ({
  ...shared,
  entryPoints: [path.join(root, entry)],
  outfile: path.join(root, out),
});

if (watch) {
  copyStatic();
  const contexts = await Promise.all(targets.map((t) => esbuild.context(options(t))));
  await Promise.all(contexts.map((c) => c.watch()));
  fs.watch(path.join(root, 'src'), { recursive: true }, copyStatic);
  console.log('watching…');
} else {
  await Promise.all(targets.map((t) => esbuild.build(options(t))));
  copyStatic();
  console.log(`built ${targets.length} bundles`);
}
