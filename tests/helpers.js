// Typed unwrap helpers for tests. Not a test file (never matched by the
// tests/unit/*.test.js glob) but typechecked via tsconfig.json.
//
// Engine methods return unions like { tabId } | { error } and tree lookups
// return possibly-undefined — these helpers narrow them so strict typechecking
// passes without weakening any assertion: failure conditions are identical,
// they just throw a named Error instead of a TypeError.

/**
 * Assert a value is present (not null/undefined) and return it narrowed.
 * @template T
 * @param {T} v
 * @param {string} [what]
 * @returns {NonNullable<T>}
 */
export function must(v, what = 'value') {
  if (v == null) throw new Error(`expected ${what}, got ${v}`);
  return /** @type {NonNullable<T>} */ (v);
}

/**
 * Unwrap an engine result union ({ ... } | { error: string }), throwing on error.
 * @template {object} T
 * @param {T} r
 * @returns {Exclude<T, { error: string }>}
 */
export function ok(r) {
  if (r && 'error' in r) throw new Error(`engine error: ${/** @type {{ error: string }} */ (r).error}`);
  return /** @type {Exclude<T, { error: string }>} */ (r);
}
