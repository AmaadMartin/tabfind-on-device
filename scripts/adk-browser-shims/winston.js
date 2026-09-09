/**
 * Browser shim for `winston`, pulled in by @google/adk's web build via
 * dist/web/utils/logger.js. Winston is Node-only (needs os/fs/util/zlib/http).
 *
 * We implement only the surface logger.js actually touches:
 *   winston.createLogger({levels, level, format, transports})
 *   winston.format.{combine,label,colorize,timestamp,printf} and format(fn)
 *   winston.transports.Console
 *
 * Everything routes to the browser console.
 */

const LEVEL_TO_CONSOLE = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function makeFormatter(fn) {
  const f = (...args) => fn(...args);
  f.__isFormatter = true;
  return f;
}

export const format = Object.assign(
  // winston.format(fn) -> returns a factory that returns a formatter
  (fn) => () => makeFormatter((info) => fn(info) || info),
  {
    combine: (...formatters) =>
      makeFormatter((info) => {
        let out = info;
        for (const fmt of formatters) {
          if (typeof fmt === 'function') {
            const next = fmt(out);
            if (next) out = next;
          }
        }
        return out;
      }),
    label: ({ label } = {}) => makeFormatter((info) => ({ ...info, label })),
    colorize: () => makeFormatter((info) => info),
    timestamp: () =>
      makeFormatter((info) => ({ ...info, timestamp: new Date().toISOString() })),
    printf: (fn) => makeFormatter((info) => ({ ...info, __rendered: fn(info) })),
  },
);

class Console {
  constructor(opts = {}) {
    this.options = opts;
  }
}

export const transports = { Console };

export function createLogger({ format: fmt } = {}) {
  const emit = (level, message) => {
    let rendered = message;
    try {
      if (typeof fmt === 'function') {
        const info = fmt({ level, message, label: 'ADK' });
        if (info && info.__rendered) rendered = info.__rendered;
      }
    } catch {
      /* formatting must never break logging */
    }
    const method = LEVEL_TO_CONSOLE[level] || 'log';
    // eslint-disable-next-line no-console
    (console[method] || console.log)(rendered);
  };

  return {
    level: 'error',
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    log: (level, m) => emit(level, m),
  };
}

export default { createLogger, format, transports };
