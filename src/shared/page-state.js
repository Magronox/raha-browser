// R-104: scroll + form state capture/restore for sleeping tabs. Pure: the
// data shape, the capture script (a string for executeJavaScript), the
// restore script, and the sanitizer applied to everything entering the
// engine — from the page AND from state.json.
//
// Security: passwords, hidden fields, file inputs, payment/OTP autocomplete
// are NEVER captured. state.json is plaintext on disk — R-119's vault is the
// only place secrets may go. This is also Chromium's own session-restore rule.

/** @typedef {'text'|'check'|'select'|'multi'} FieldKind */
/**
 * @typedef {Object} FieldState
 * @property {string} p  child-index path from body ("2/0/5")
 * @property {string} n  signature "tag:type:name-or-id"
 * @property {FieldKind} k  kind
 * @property {string|boolean|string[]} v  value
 */
/**
 * @typedef {Object} PageState
 * @property {1} v  version
 * @property {string} url  the page URL (exact, fragment included)
 * @property {number} at  ms epoch when captured
 * @property {number} sx  scrollX
 * @property {number} sy  scrollY
 * @property {FieldState[]} fields  user-changed fields (never passwords)
 */

export const PAGE_STATE_VERSION = 1;
export const PAGE_STATE_LIMITS = Object.freeze({
  maxFields: 200,
  maxValueChars: 8_000,
  maxBytes: 16 * 1024,
  maxPathChars: 120,
  maxSigChars: 160,
  formTtlMs: 7 * 24 * 3_600_000,
});

const SENSITIVE_TYPES = new Set(['password', 'hidden', 'file']);
const SENSITIVE_AC = new Set([
  'cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  'cc-csc', 'cc-type', 'one-time-code', 'current-password', 'new-password',
]);

/**
 * Validate and cap a raw PageState (from the page or from state.json).
 * Returns null for anything invalid.
 * @param {unknown} raw
 * @returns {PageState|null}
 */
export function sanitizePageState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (o.v !== PAGE_STATE_VERSION) return null;
  if (typeof o.url !== 'string' || !o.url) return null;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const sx = typeof o.sx === 'number' && Number.isFinite(o.sx) ? Math.max(0, Math.round(o.sx)) : 0;
  const sy = typeof o.sy === 'number' && Number.isFinite(o.sy) ? Math.max(0, Math.round(o.sy)) : 0;

  /** @type {FieldState[]} */
  const fields = [];
  if (Array.isArray(o.fields)) {
    for (const f of o.fields) {
      if (!f || typeof f !== 'object') continue;
      const ff = /** @type {Record<string, unknown>} */ (f);
      if (typeof ff.p !== 'string' || !ff.p || ff.p.length > PAGE_STATE_LIMITS.maxPathChars) continue;
      if (typeof ff.n !== 'string' || !ff.n || ff.n.length > PAGE_STATE_LIMITS.maxSigChars) continue;
      if (isSensitiveSig(ff.n)) continue;
      const k = ff.k;
      if (k !== 'text' && k !== 'check' && k !== 'select' && k !== 'multi') continue;
      const v = sanitizeFieldValue(k, ff.v);
      if (v === null) continue;
      fields.push({ p: ff.p, n: ff.n, k, v });
      if (fields.length >= PAGE_STATE_LIMITS.maxFields) break;
    }
  }
  const state = { v: /** @type {1} */ (1), url: o.url, at: o.at, sx, sy, fields };
  if (JSON.stringify(state).length > PAGE_STATE_LIMITS.maxBytes) state.fields = [];
  return state;
}

/**
 * Decide what to restore. Scroll if the URL matches exactly (fragment
 * included). Fields only if additionally within the TTL.
 * @param {PageState} state
 * @param {string} url  the page URL as loaded
 * @param {number} now  ms epoch
 * @returns {{ scroll: { x: number, y: number }|null, fields: FieldState[] }}
 */
export function pageStateFor(state, url, now) {
  if (state.url !== url) return { scroll: null, fields: [] };
  const scroll = { x: state.sx, y: state.sy };
  const fields = now - state.at <= PAGE_STATE_LIMITS.formTtlMs ? state.fields : [];
  return { scroll, fields };
}

/** @param {string} sig @returns {boolean} */
function isSensitiveSig(sig) {
  const parts = sig.split(':');
  if (parts.length < 2) return true;
  const type = parts[1];
  if (SENSITIVE_TYPES.has(type)) return true;
  const nameOrId = parts.slice(2).join(':').toLowerCase();
  for (const ac of SENSITIVE_AC) {
    if (nameOrId.includes(ac)) return true;
  }
  return false;
}

/**
 * @param {FieldKind} k
 * @param {unknown} v
 * @returns {string|boolean|string[]|null}
 */
function sanitizeFieldValue(k, v) {
  if (k === 'check') return typeof v === 'boolean' ? v : null;
  if (k === 'multi') {
    if (!Array.isArray(v)) return null;
    const out = v.filter((x) => typeof x === 'string').map((x) => x.slice(0, PAGE_STATE_LIMITS.maxValueChars));
    return out.length > 0 ? out : null;
  }
  if (typeof v !== 'string') return null;
  return v.slice(0, PAGE_STATE_LIMITS.maxValueChars);
}

/**
 * The capture script — evaluated in the top frame via executeJavaScript.
 * Returns a PageState object or null (non-http(s), or nothing to capture).
 * Security: passwords, hidden, file, and sensitive autocomplete are skipped.
 * Only user-changed fields are stored (value !== defaultValue).
 */
export const CAPTURE_SCRIPT = `(() => {
  try {
    if (!/^https?:/.test(location.protocol)) return null;
    const SENSITIVE_TYPES = new Set(['password', 'hidden', 'file']);
    const SENSITIVE_AC = new Set([
      'cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
      'cc-csc', 'cc-type', 'one-time-code', 'current-password', 'new-password',
    ]);
    const MAX_FIELDS = 200;
    const MAX_VALUE = 8000;
    const MAX_PATH = 120;
    const MAX_SIG = 160;
    function pathOf(el) {
      const parts = [];
      let n = el;
      while (n && n !== document.body) {
        const p = n.parentElement;
        if (!p) return null;
        parts.unshift(Array.prototype.indexOf.call(p.children, n));
        n = p;
      }
      const s = parts.join('/');
      return s.length <= MAX_PATH ? s : null;
    }
    function sigOf(el) {
      const tag = el.tagName.toLowerCase();
      const type = el.type || '';
      const name = el.name || el.id || '';
      const s = tag + ':' + type + ':' + name;
      return s.length <= MAX_SIG ? s : null;
    }
    const fields = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.disabled || el.readOnly) continue;
      const type = (el.type || '').toLowerCase();
      if (SENSITIVE_TYPES.has(type)) continue;
      const ac = (el.autocomplete || '').toLowerCase().trim();
      if (SENSITIVE_AC.has(ac)) continue;
      if (el.tagName === 'BUTTON' || type === 'submit' || type === 'reset' || type === 'button' || type === 'image') continue;
      const p = pathOf(el);
      const n = sigOf(el);
      if (!p || !n) continue;
      if (el.tagName === 'SELECT') {
        if (el.multiple) {
          const vals = [];
          for (const o of el.options) if (o.selected !== o.defaultSelected) { vals.push(o.value.slice(0, MAX_VALUE)); }
          if (vals.length === 0) continue;
          fields.push({ p, n, k: 'multi', v: vals });
        } else {
          if (el.value === el.defaultValue) continue;
          fields.push({ p, n, k: 'select', v: el.value.slice(0, MAX_VALUE) });
        }
      } else if (type === 'checkbox' || type === 'radio') {
        if (el.checked === el.defaultChecked) continue;
        fields.push({ p, n, k: 'check', v: el.checked });
      } else {
        if (el.value === el.defaultValue) continue;
        fields.push({ p, n, k: 'text', v: el.value.slice(0, MAX_VALUE) });
      }
      if (fields.length >= MAX_FIELDS) break;
    }
    const sx = Math.round(window.scrollX);
    const sy = Math.round(window.scrollY);
    if (sx === 0 && sy === 0 && fields.length === 0) return null;
    return { v: 1, url: location.href, at: Date.now(), sx, sy, fields };
  } catch { return null; }
})()`;

/**
 * Build a restore script for executeJavaScript. The state is injected as
 * JSON data inside an IIFE — never string-concatenated into code.
 * @param {{ scroll: { x: number, y: number }|null, fields: FieldState[] }} plan
 * @returns {string}
 */
export function restoreScript(plan) {
  return `((plan) => {
  try {
    function pathTo(p) {
      let el = document.body;
      for (const i of p.split('/')) {
        el = el?.children[parseInt(i, 10)];
        if (!el) return null;
      }
      return el;
    }
    function sigOf(el) {
      return el.tagName.toLowerCase() + ':' + (el.type || '') + ':' + (el.name || el.id || '');
    }
    let scrollDone = !plan.scroll;
    let userScrolled = false;
    const targetY = plan.scroll ? plan.scroll.y : 0;
    const targetX = plan.scroll ? plan.scroll.x : 0;
    if (!scrollDone) {
      window.addEventListener('scroll', function h() {
        if (Math.abs(window.scrollY - targetY) > 5) userScrolled = true;
        window.removeEventListener('scroll', h);
      }, { once: true, passive: true });
    }
    function restoreFields() {
      for (const f of plan.fields) {
        const el = pathTo(f.p);
        if (!el || sigOf(el) !== f.n) continue;
        if (f.k === 'check' && (el.type === 'checkbox' || el.type === 'radio')) {
          el.checked = f.v;
        } else if (f.k === 'multi' && el.tagName === 'SELECT' && el.multiple) {
          const set = new Set(f.v);
          for (const o of el.options) o.selected = set.has(o.value);
        } else if (f.k === 'select' && el.tagName === 'SELECT') {
          el.value = f.v;
        } else if (f.k === 'text') {
          el.value = f.v;
        } else { continue; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function tryScroll() {
      if (scrollDone || userScrolled) return;
      window.scrollTo(targetX, targetY);
      if (Math.abs(window.scrollY - targetY) < 50) scrollDone = true;
    }
    let attempts = 0;
    function attempt() {
      restoreFields();
      tryScroll();
      attempts++;
      if (attempts < 12 && !scrollDone) {
        setTimeout(attempt, 250);
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(() => attempt()));
  } catch {}
})(${JSON.stringify(plan)})`;
}
