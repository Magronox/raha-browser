// Per-site permission asks (ROADMAP R-103, ADR-0013). Pure: the vocabulary
// Raha asks about, the mapping from Electron's permission names to it, the
// remembered-decision lookup, the settings-shape helpers, and the words the
// ask uses. The engine (src/main/core/engine.js) owns the ask lifecycle;
// src/main/electron/privacy.js is the only place that talks to Electron's
// permission handlers.
//
// Consent-first, same rule the app-link ask set (ADR-0011): nothing
// sensitive is ever granted silently, and a dialog appears only for the
// page the user is looking at. Anything outside PERMISSION_KINDS keeps the
// v0.1 deny-by-default behavior.

/** @typedef {'camera'|'microphone'|'geolocation'|'notifications'|'clipboard'} PermissionKind */
/** @typedef {'allow'|'deny'} PermissionDecision */
/**
 * Remembered answers: normalized site host (normalizeSiteHost — bare
 * lowercase, www stripped, same key as noBlockHosts) -> kind -> decision.
 * Insertion order is age: the newest decided site is last.
 * @typedef {Record<string, Partial<Record<PermissionKind, PermissionDecision>>>} SitePermissions
 */

/** Canonical order — also the order kinds are worded in. */
export const PERMISSION_KINDS = /** @type {readonly PermissionKind[]} */ (Object.freeze(['camera', 'microphone', 'geolocation', 'notifications', 'clipboard']));

/** Sites remembered at most; beyond it the oldest decision is dropped. */
export const SITE_PERMISSIONS_CAP = 200;

/** @param {unknown} x @returns {x is PermissionKind} */
export function isPermissionKind(x) {
  return typeof x === 'string' && PERMISSION_KINDS.includes(/** @type {PermissionKind} */ (x));
}

/** @param {unknown} x @returns {x is PermissionDecision} */
export function isPermissionDecision(x) {
  return x === 'allow' || x === 'deny';
}

/**
 * Electron permission REQUEST -> the kinds Raha asks about. Empty = not
 * askable (keeps deny-by-default). A single getUserMedia for audio+video
 * is ONE ask covering both kinds.
 * @param {string} permission Electron's name ('media', 'geolocation', …)
 * @param {unknown} [mediaTypes] details.mediaTypes for 'media': Array<'video'|'audio'>
 * @returns {PermissionKind[]}
 */
export function permissionKindsForRequest(permission, mediaTypes) {
  if (permission === 'media') {
    if (!Array.isArray(mediaTypes)) return [];
    /** @type {PermissionKind[]} */ const kinds = [];
    if (mediaTypes.includes('video')) kinds.push('camera');
    if (mediaTypes.includes('audio')) kinds.push('microphone');
    return kinds;
  }
  if (permission === 'geolocation') return ['geolocation'];
  if (permission === 'notifications') return ['notifications'];
  if (permission === 'clipboard-read') return ['clipboard'];
  return [];
}

/**
 * Electron permission CHECK -> one kind, or null when Raha has no
 * per-site answer for it (the check then falls back to deny-by-default).
 * @param {string} permission
 * @param {unknown} [mediaType] details.mediaType for 'media': 'video'|'audio'|'unknown'
 * @returns {PermissionKind|null}
 */
export function permissionKindForCheck(permission, mediaType) {
  if (permission === 'media') {
    return mediaType === 'video' ? 'camera' : mediaType === 'audio' ? 'microphone' : null;
  }
  return permissionKindsForRequest(permission)[0] ?? null;
}

/**
 * Canonical order + dedupe, so coalescing keys and wording are stable
 * whatever order Electron lists media types in.
 * @param {readonly unknown[]} kinds
 * @returns {PermissionKind[]}
 */
export function normalizeKinds(kinds) {
  return PERMISSION_KINDS.filter((k) => kinds.includes(k));
}

/**
 * What the remembered decisions say about a request. 'deny' if ANY kind
 * is blocked (a page asking for camera+mic with the mic blocked gets
 * nothing — silently, that is what remembering means); 'allow' if EVERY
 * kind is allowed; otherwise 'ask' about the undecided kinds only (the
 * user already answered the rest).
 * @param {SitePermissions} sitePermissions
 * @param {string} host normalized site host
 * @param {readonly PermissionKind[]} kinds
 * @returns {{ verdict: 'allow'|'deny'|'ask', undecided: PermissionKind[] }}
 */
export function rememberedVerdict(sitePermissions, host, kinds) {
  const decisions = Object.hasOwn(sitePermissions, host) ? sitePermissions[host] : {};
  if (kinds.some((k) => decisions[k] === 'deny')) return { verdict: 'deny', undecided: [] };
  const undecided = kinds.filter((k) => decisions[k] !== 'allow');
  return undecided.length === 0 ? { verdict: 'allow', undecided: [] } : { verdict: 'ask', undecided };
}

/**
 * A new map with one decision set. The site moves to the end (newest);
 * over the cap the oldest sites fall off. Never mutates its input.
 * @param {SitePermissions} sitePermissions
 * @param {string} host normalized site host
 * @param {PermissionKind} kind
 * @param {PermissionDecision} decision
 * @returns {SitePermissions}
 */
export function withSitePermission(sitePermissions, host, kind, decision) {
  /** @type {SitePermissions} */ const next = {};
  for (const [h, d] of Object.entries(sitePermissions)) {
    if (h !== host) next[h] = { ...d };
  }
  next[host] = { ...(sitePermissions[host] ?? {}), [kind]: decision };
  return capSitePermissions(next);
}

/**
 * A new map without one decision (or without the whole site when `kind`
 * is omitted). A site with no decisions left disappears.
 * @param {SitePermissions} sitePermissions
 * @param {string} host normalized site host
 * @param {PermissionKind} [kind]
 * @returns {SitePermissions}
 */
export function withoutSitePermission(sitePermissions, host, kind) {
  /** @type {SitePermissions} */ const next = {};
  for (const [h, d] of Object.entries(sitePermissions)) {
    if (h !== host) { next[h] = { ...d }; continue; }
    if (kind === undefined) continue;
    const rest = { ...d };
    delete rest[kind];
    if (Object.keys(rest).length > 0) next[h] = rest;
  }
  return next;
}

/**
 * Enforce SITE_PERMISSIONS_CAP by dropping the OLDEST sites (first keys).
 * Mutates and returns its argument (callers pass a fresh copy).
 * @param {SitePermissions} map
 * @returns {SitePermissions}
 */
export function capSitePermissions(map) {
  const hosts = Object.keys(map);
  for (const h of hosts.slice(0, Math.max(0, hosts.length - SITE_PERMISSIONS_CAP))) delete map[h];
  return map;
}

/** Settings chip / list label for a kind. @param {PermissionKind} kind */
export function permissionKindLabel(kind) {
  return kind === 'geolocation' ? 'location' : kind;
}

/**
 * "use your camera and microphone" / "use your location" / "show
 * notifications" / "read your clipboard" — joined naturally when a
 * request spans several.
 * @param {readonly PermissionKind[]} kinds
 * @returns {string}
 */
export function permissionPhrase(kinds) {
  const k = normalizeKinds(kinds);
  /** @type {string[]} */ const parts = [];
  const devices = k.filter((x) => x === 'camera' || x === 'microphone');
  if (devices.length) parts.push(`use your ${devices.join(' and ')}`);
  if (k.includes('geolocation')) parts.push('use your location');
  if (k.includes('notifications')) parts.push('show notifications');
  if (k.includes('clipboard')) parts.push('read your clipboard');
  if (parts.length === 0) return 'use something';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The ask's title. `host` is the tab's site (normalized, so already a
 * plain hostname) — the UI still passes the result through esc().
 * @param {string} host
 * @param {readonly PermissionKind[]} kinds
 */
export function permissionAskTitle(host, kinds) {
  return `${host} wants to ${permissionPhrase(kinds)}`;
}
