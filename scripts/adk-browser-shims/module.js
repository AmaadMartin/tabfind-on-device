// Shim for the dead `createRequire` banner that leaks into @google/adk's web build.
// Verified: 187 files import it, 0 files ever invoke it.
export function createRequire() {
  return function require() {
    throw new Error('require() is not available in the browser build');
  };
}
export default { createRequire };
