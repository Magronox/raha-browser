// Tiny id helper. Pure layer: web-standard APIs only (works in node, browsers,
// and electron renderers alike).

let counter = 0;

/**
 * Generate a short unique id. Uses Web Crypto when available, falls back to a
 * counter+time id (used only in exotic test environments).
 * @param {string} [prefix] one-letter kind hint: 't' tab, 'f' folder
 * @returns {string}
 */
export function newId(prefix = 'n') {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 13)}`;
  }
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
