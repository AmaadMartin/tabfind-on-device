/**
 * Browser stand-in for `node:crypto`.
 *
 * ADK's dist/web/utils/env_aware_utils.js already prefers `globalThis.crypto`
 * and only calls the Node import as a last resort — but the import is static,
 * so a bundler must resolve it even though a browser never reaches that line.
 * One unreachable import breaks every browser build.
 *
 * Filed with the other packaging defects under google/adk-js#607.
 */

export function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ]
    .map((group) => group.join(''))
    .join('-');
}

export function createHash() {
  throw new Error('createHash is not available in the browser build.');
}

export default { randomUUID, createHash };
