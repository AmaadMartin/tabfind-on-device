/**
 * Browser shim for `node:async_hooks`, pulled in by @google/adk's web build via
 * dist/web/utils/client_labels.js, which uses AsyncLocalStorage to carry
 * telemetry client labels.
 *
 * A faithful AsyncLocalStorage needs async context tracking the browser does not
 * expose. ADK uses it only for optional telemetry labels, so a synchronous
 * stack-based approximation is correct for our purposes: `run()` propagates the
 * value to anything called synchronously within it, which is how ADK uses it.
 */
export class AsyncLocalStorage {
  constructor() {
    this._stack = [];
  }

  getStore() {
    return this._stack.length ? this._stack[this._stack.length - 1] : undefined;
  }

  run(store, callback, ...args) {
    this._stack.push(store);
    try {
      const result = callback(...args);
      // If the callback is async, pop once it settles so the value survives the
      // synchronous portion without leaking forever.
      if (result && typeof result.then === 'function') {
        const pop = () => {
          const i = this._stack.lastIndexOf(store);
          if (i !== -1) this._stack.splice(i, 1);
        };
        return result.then(
          (v) => {
            pop();
            return v;
          },
          (e) => {
            pop();
            throw e;
          },
        );
      }
      this._stack.pop();
      return result;
    } catch (e) {
      this._stack.pop();
      throw e;
    }
  }

  exit(callback, ...args) {
    const saved = this._stack;
    this._stack = [];
    try {
      return callback(...args);
    } finally {
      this._stack = saved;
    }
  }

  enterWith(store) {
    this._stack.push(store);
  }

  disable() {
    this._stack = [];
  }
}

export default { AsyncLocalStorage };
