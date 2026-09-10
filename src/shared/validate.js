// Hand-rolled validation for settings and domain rules. Zero dependencies on
// purpose (see docs/DECISIONS/ADR-0004-zero-runtime-deps.md).
//
// Contract: validateSettings NEVER throws. It always returns a fully valid
// settings object, silently clamping/regenerating anything malformed, plus a
// list of human-readable problems for logging. Persistence must only ever
// write objects that came out of this function.

import { defaultSettings, RANGES, SEARCH_ENGINES, SETTINGS_SCHEMA_VERSION } from './defaults.js';
import { classifyExternal, schemeOf } from './external.js';
import { isPermissionKind, isPermissionDecision, SITE_PERMISSIONS_CAP } from './permissions.js';

/**
 * @param {unknown} raw
 * @returns {{ value: import('./defaults.js').RahaSettings, problems: string[] }}
 */
export function validateSettings(raw) {
  const d = defaultSettings();
  /** @type {string[]} */
  const problems = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) problems.push('settings: not an object, using defaults');
    return { value: d, problems };
  }
  const o = /** @type {Record<string, unknown>} */ (raw);

  /** @param {'maxLiveTabs'|'idleSleepMinutes'|'globalBudgetMB'} key */
  const num = (key) => {
    const v = o[key];
    const [min, max] = RANGES[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (v !== undefined) problems.push(`settings.${key}: not a number, using default ${d[key]}`);
      return d[key];
    }
    const clamped = Math.min(max, Math.max(min, Math.round(v)));
    if (clamped !== v) problems.push(`settings.${key}: clamped ${v} -> ${clamped}`);
    return clamped;
  };

  /** @param {'protectAudio'|'runawayGuard'|'blockAds'|'blockTrackers'|'gpc'|'httpsFirst'|'autoUpdate'|'recordHistory'|'defaultBrowserPrompted'|'restorePageState'} key */
  const bool = (key) => {
    const v = o[key];
    if (typeof v !== 'boolean') {
      if (v !== undefined) problems.push(`settings.${key}: not a boolean, using default ${d[key]}`);
      return d[key];
    }
    return v;
  };

  const engine = typeof o.searchEngine === 'string' && o.searchEngine in SEARCH_ENGINES
    ? /** @type {import('./defaults.js').RahaSettings['searchEngine']} */ (o.searchEngine)
    : (o.searchEngine !== undefined ? (problems.push(`settings.searchEngine: unknown '${String(o.searchEngine)}', using ${d.searchEngine}`), d.searchEngine) : d.searchEngine);

  return {
    value: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      maxLiveTabs: num('maxLiveTabs'),
      idleSleepMinutes: num('idleSleepMinutes'),
      globalBudgetMB: num('globalBudgetMB'),
      protectAudio: bool('protectAudio'),
      runawayGuard: bool('runawayGuard'),
      blockAds: bool('blockAds'),
      blockTrackers: bool('blockTrackers'),
      noBlockHosts: validateNoBlockHosts(o.noBlockHosts, problems),
      allowedExternalSchemes: validateExternalSchemes(o.allowedExternalSchemes, problems),
      gpc: bool('gpc'),
      httpsFirst: bool('httpsFirst'),
      autoUpdate: bool('autoUpdate'),
      recordHistory: bool('recordHistory'),
      defaultBrowserPrompted: bool('defaultBrowserPrompted'),
      sitePermissions: validateSitePermissions(o.sitePermissions, problems),
      restorePageState: bool('restorePageState'),
      searchEngine: engine,
      rules: validateRules(o.rules, problems),
    },
    problems,
  };
}

/**
 * @param {unknown} raw
 * @param {string[]} problems
 * @returns {import('./defaults.js').DomainRule[]}
 */
export function validateRules(raw, problems = []) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('settings.rules: not an array, dropping');
    return [];
  }
  /** @type {import('./defaults.js').DomainRule[]} */
  const out = [];
  for (const [i, r] of raw.entries()) {
    if (typeof r !== 'object' || r === null) { problems.push(`settings.rules[${i}]: not an object, dropped`); continue; }
    const rr = /** @type {Record<string, unknown>} */ (r);
    const pattern = normalizeHostPattern(rr.pattern);
    if (!pattern) { problems.push(`settings.rules[${i}]: bad pattern '${String(rr.pattern)}', dropped`); continue; }
    /** @type {import('./defaults.js').DomainRule} */
    const rule = { pattern };
    if (rr.keepAlive !== undefined) {
      if (typeof rr.keepAlive === 'boolean') rule.keepAlive = rr.keepAlive;
      else problems.push(`settings.rules[${i}].keepAlive: not boolean, ignored`);
    }
    if (rr.memLimitMB !== undefined) {
      const v = rr.memLimitMB;
      const [min, max] = RANGES.memLimitMB;
      if (typeof v === 'number' && Number.isFinite(v) && v >= min) rule.memLimitMB = Math.min(max, Math.round(v));
      else problems.push(`settings.rules[${i}].memLimitMB: invalid, ignored`);
    }
    out.push(rule);
    if (out.length >= 200) { problems.push('settings.rules: truncated at 200 rules'); break; }
  }
  return out;
}

/**
 * Exact-site normalization for the per-site shield list (noBlockHosts): like
 * normalizeHostPattern but always a bare host — a "*." wildcard collapses to
 * its base and a leading "www." is stripped, so apex and www toggle together.
 * @param {unknown} p
 * @returns {string|null}
 */
export function normalizeSiteHost(p) {
  const pat = normalizeHostPattern(p);
  if (!pat) return null;
  let host = pat.startsWith('*.') ? pat.slice(2) : pat;
  // Never strip 'www.com' down to a bare TLD.
  if (host.startsWith('www.') && host.slice(4).includes('.')) host = host.slice(4);
  return host;
}

/**
 * @param {unknown} raw
 * @param {string[]} problems
 * @returns {string[]}
 */
export function validateNoBlockHosts(raw, problems = []) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('settings.noBlockHosts: not an array, dropping');
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const [i, v] of raw.entries()) {
    const host = normalizeSiteHost(v);
    if (!host) { problems.push(`settings.noBlockHosts[${i}]: bad host '${String(v)}', dropped`); continue; }
    if (!out.includes(host)) out.push(host);
    if (out.length >= 200) { problems.push('settings.noBlockHosts: truncated at 200'); break; }
  }
  return out;
}

/**
 * Remembered app-link schemes (settings.allowedExternalSchemes). A scheme
 * only lands here through an explicit "always allow" click, and a dangerous
 * one can never land here at all — a tampered settings.json must not turn
 * into a silent launcher for ms-msdt: and friends.
 * @param {unknown} raw @param {string[]} [problems]
 * @returns {string[]}
 */
export function validateExternalSchemes(raw, problems = []) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('settings.allowedExternalSchemes: not an array, dropping');
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const [i, v] of raw.entries()) {
    const scheme = schemeOf(`${String(v).toLowerCase()}:`);
    if (!scheme || classifyExternal(`${scheme}://x`) !== 'app') {
      problems.push(`settings.allowedExternalSchemes[${i}]: refused '${String(v)}'`);
      continue;
    }
    if (!out.includes(scheme)) out.push(scheme);
    if (out.length >= 50) { problems.push('settings.allowedExternalSchemes: truncated at 50'); break; }
  }
  return out;
}

/**
 * Remembered per-site permission answers (settings.sitePermissions, R-103).
 * Every host goes through normalizeSiteHost (so apex and www share one
 * entry, like noBlockHosts) and only known kinds with 'allow'|'deny' land —
 * a hand-edited settings.json cannot inject a kind Raha never asks about,
 * a third "state", or a site key that is not a hostname. Over the cap the
 * OLDEST sites (first keys) are dropped, matching withSitePermission.
 * @param {unknown} raw @param {string[]} [problems]
 * @returns {import('./permissions.js').SitePermissions}
 */
export function validateSitePermissions(raw, problems = []) {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('settings.sitePermissions: not an object, dropping');
    return {};
  }
  /** @type {import('./permissions.js').SitePermissions} */
  const out = {};
  for (const [rawHost, rawDecisions] of Object.entries(raw)) {
    const host = normalizeSiteHost(rawHost);
    if (!host) { problems.push(`settings.sitePermissions: bad host '${rawHost.slice(0, 80)}', dropped`); continue; }
    if (typeof rawDecisions !== 'object' || rawDecisions === null || Array.isArray(rawDecisions)) {
      problems.push(`settings.sitePermissions[${host}]: not an object, dropped`);
      continue;
    }
    const decisions = { ...(out[host] ?? {}) };
    for (const [kind, decision] of Object.entries(rawDecisions)) {
      if (!isPermissionKind(kind)) { problems.push(`settings.sitePermissions[${host}]: unknown kind '${kind.slice(0, 40)}', dropped`); continue; }
      if (!isPermissionDecision(decision)) { problems.push(`settings.sitePermissions[${host}].${kind}: not allow/deny, dropped`); continue; }
      decisions[kind] = decision;
    }
    if (Object.keys(decisions).length === 0) continue;
    delete out[host]; // a re-listed site counts as newest
    out[host] = decisions;
  }
  const hosts = Object.keys(out);
  if (hosts.length > SITE_PERMISSIONS_CAP) {
    problems.push(`settings.sitePermissions: truncated to the newest ${SITE_PERMISSIONS_CAP} sites`);
    for (const h of hosts.slice(0, hosts.length - SITE_PERMISSIONS_CAP)) delete out[h];
  }
  return out;
}

/**
 * Normalize a host pattern: lowercase, trim, strip scheme/path/port.
 * Accepts "example.com" or "*.example.com". Returns null if unusable.
 * @param {unknown} p
 * @returns {string|null}
 */
export function normalizeHostPattern(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  s = s.replace(/[/?#].*$/, '');                // strip path
  s = s.replace(/:\d+$/, '');                   // strip port
  const wildcard = s.startsWith('*.');
  const host = wildcard ? s.slice(2) : s;
  // Conservative host check: letters/digits/hyphen/dot, at least one dot or 'localhost'.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  if (!host.includes('.') && host !== 'localhost') return null;
  return wildcard ? `*.${host}` : host;
}
