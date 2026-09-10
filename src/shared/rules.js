// Programmable per-domain rules ("keep *.youtube.com alive", "cap slack.com
// at 800MB"). Pure functions; unit-tested in tests/unit/rules.test.js.
//
// Matching semantics (documented in README + settings UI, keep in sync):
// - "example.com"    matches exactly example.com
// - "*.example.com"  matches example.com AND any subdomain of it
// - First matching rule in the list wins; later rules are ignored.

/**
 * @param {string} host lowercase hostname (no port)
 * @param {string} pattern normalized pattern from validate.js
 * @returns {boolean}
 */
export function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pattern;
}

/**
 * @param {string|null} host
 * @param {import('./defaults.js').DomainRule[]} rules
 * @returns {import('./defaults.js').DomainRule|null} first matching rule
 */
export function findRule(host, rules) {
  if (!host) return null;
  for (const r of rules) {
    if (hostMatches(host, r.pattern)) return r;
  }
  return null;
}

/**
 * Effective policy for one tab = explicit per-tab override, else first
 * matching domain rule, else nothing.
 * @param {{ keepAlive: boolean, memLimitMB: number|null, host: string|null }} tab
 * @param {import('./defaults.js').DomainRule[]} rules
 * @returns {{ keepAlive: boolean, memLimitMB: number|null, fromRule: string|null }}
 */
export function effectivePolicy(tab, rules) {
  const rule = findRule(tab.host, rules);
  const keepAlive = tab.keepAlive || Boolean(rule && rule.keepAlive);
  let memLimitMB = tab.memLimitMB;
  if (memLimitMB == null && rule && typeof rule.memLimitMB === 'number' && rule.memLimitMB > 0) {
    memLimitMB = rule.memLimitMB;
  }
  return { keepAlive, memLimitMB: memLimitMB ?? null, fromRule: rule ? rule.pattern : null };
}

/**
 * @param {string} url
 * @returns {string|null} lowercase host or null for non-http(s)/invalid URLs
 */
export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}
