// Small DOM/render helpers. SECURITY: every dynamic string that reaches
// innerHTML MUST go through esc() — tab titles and URLs come from arbitrary
// web pages. Grep rule: no `${...}` inside an html template without esc()
// unless it is provably our own constant (icons, class names).

/**
 * Platform modifier-key label: ⌘ on macOS, Ctrl elsewhere. Use in every
 * user-visible shortcut string so Mac users never read "Ctrl". (The actual
 * accelerators use Electron's CmdOrCtrl and are platform-correct already.)
 */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** @param {unknown} s @returns {string} html-safe text */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** @param {number|null} mb @returns {string} */
export function fmtMB(mb) {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Memory badge severity class. @param {number|null} mb */
export function memClass(mb) {
  if (mb == null) return 'mem-na';
  if (mb > 600) return 'mem-high';
  if (mb > 250) return 'mem-mid';
  return 'mem-low';
}

/** @param {string} url @returns {string} short host-ish label */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'raha:') return 'raha';
    if (u.protocol === 'data:') return 'local page';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Favicon HTML with letter fallback. NOTE: no inline onerror — the UI's CSP
 * forbids inline script. Call wireImgFallbacks(container) after injecting.
 * @param {{ faviconUrl: string|null, title: string }} tab
 */
export function faviconHtml(tab) {
  const chip = `<span class="letterchip" aria-hidden="true">${esc((tab.title || '?').trim().charAt(0).toUpperCase() || '?')}</span>`;
  if (!tab.faviconUrl || !/^https?:/.test(tab.faviconUrl)) return chip;
  return `<img class="favicon" src="${esc(tab.faviconUrl)}" alt="">${chip}`;
}

/**
 * Attach error fallbacks to freshly-rendered images: broken favicons remove
 * themselves (letter chip behind them shows), broken thumbnails hide so the
 * centered fallback shows. Must be called after every innerHTML render that
 * may contain .favicon or .thumb images.
 * @param {HTMLElement} container
 */
export function wireImgFallbacks(container) {
  container.querySelectorAll('img.favicon').forEach((img) =>
    img.addEventListener('error', () => img.remove(), { once: true }));
  container.querySelectorAll('img.thumb').forEach((img) =>
    img.addEventListener('error', () => img.classList.add('gone'), { once: true }));
}

/**
 * Scroll-position twin of captureFocusedField: the same innerHTML swap that
 * would steal focus also resets every scroll container to the top — a
 * governor tick lands and the sidebar/modal jumps while the user is mid-
 * scroll (invisible until a tree grows past one screen; the Safari open-tabs
 * import made it obvious). Capture BEFORE the swap, restore right after.
 * @param {HTMLElement} root
 * @param {string} [selector] scroll container inside root; omit for root itself
 * @returns {number}
 */
export function captureScrollTop(root, selector) {
  const el = selector ? root.querySelector(selector) : root;
  return el instanceof HTMLElement ? el.scrollTop : 0;
}

/**
 * @param {HTMLElement} root
 * @param {string|undefined} selector same selector passed to captureScrollTop
 * @param {number} top
 */
export function restoreScrollTop(root, selector, top) {
  if (!top) return;
  const el = selector ? root.querySelector(selector) : root;
  if (el instanceof HTMLElement) el.scrollTop = top;
}

/**
 * Regions re-render with innerHTML on every snapshot — every governor tick
 * would wipe whatever field the user is typing into and steal its focus.
 * Call captureFocusedField(root) BEFORE the innerHTML swap and
 * restoreFocusedField(root, state) right after: the replacement node with the
 * same identity gets the old text, focus, and caret back. (Removal of a
 * focused element fires blur synchronously — the focus-fixup rule — so
 * capture must happen before the swap.)
 * @param {HTMLElement} root
 * @returns {{ key: string, value: string, start: number|null, end: number|null } | null}
 */
export function captureFocusedField(root) {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement) || !root.contains(el)) return null;
  return { key: fieldKey(el), value: el.value, start: el.selectionStart, end: el.selectionEnd };
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof captureFocusedField>} state
 */
export function restoreFocusedField(root, state) {
  if (!state) return;
  const el = [...root.querySelectorAll('input')].find((i) => fieldKey(i) === state.key);
  if (!el) return;
  el.value = state.value;
  el.focus();
  try {
    if (state.start !== null && state.end !== null) el.setSelectionRange(state.start, state.end);
  } catch { /* number inputs don't support selection */ }
}

/** Stable identity for a field across re-renders. @param {HTMLInputElement} el */
function fieldKey(el) {
  return `${el.className}|${JSON.stringify({ ...el.dataset })}`;
}

/**
 * Thumbnail URL for a tab. Inside the real app the UI is served from
 * raha://app and thumbnails from raha://thumb. In the offline UI test
 * harness (tests/ui/, served over http) the harness provides /__thumbs/.
 * @param {{ id: string, thumbSeq: number }} tab
 */
export function thumbUrl(tab) {
  if (location.protocol === 'raha:') {
    return `raha://thumb/${encodeURIComponent(tab.id)}.png?s=${tab.thumbSeq}`;
  }
  return `/__thumbs/${encodeURIComponent(tab.id)}.png?s=${tab.thumbSeq}`;
}
