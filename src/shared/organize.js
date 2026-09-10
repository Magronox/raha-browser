// The tab organizer: a pure classifier that plans folders for loose tabs.
//
// Design rules (the engine and UI rely on these):
//   - Only tabs sitting DIRECTLY under the root are organized. Tabs the user
//     already filed into folders are never touched — the organizer tidies the
//     mess, it does not re-file someone's system.
//   - A plan is deterministic for a given tree: same input, same folders,
//     same order. No clocks, no randomness (unit-testable, invariant #1).
//   - Nothing is dumped into a "Misc" folder: a tab that matches no category
//     and shares no domain with 2+ siblings simply stays where it is.
//
// This module is deliberately the whole algorithm. Improving categorization
// (new categories, smarter matching) should happen HERE, with tests in
// tests/unit/organize.test.js, and nowhere else — the engine only executes
// whatever plan comes out.

import { hostOf } from './rules.js';

/** A folder is only created when a category catches at least this many tabs. */
export const MIN_CATEGORY_TABS = 2;
/** Unmatched tabs sharing a registrable domain group when at least this many. */
export const MIN_DOMAIN_GROUP = 3;

/**
 * Ordered, most-specific-first: the first entry whose host list matches wins
 * (music.youtube.com must be listed before youtube.com catches it).
 * A host entry matches when the tab's hostname equals it OR ends with
 * ".<entry>" — so an entry "edu" matches every *.edu campus site.
 * @type {Array<{ name: string, hosts: string[] }>}
 */
export const CATEGORIES = [
  { name: 'Music', hosts: ['music.youtube.com', 'music.apple.com', 'spotify.com', 'soundcloud.com', 'bandcamp.com', 'tidal.com', 'pandora.com'] },
  { name: 'Video', hosts: ['youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'vimeo.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'max.com'] },
  { name: 'Dev', hosts: ['github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'npmjs.com', 'pypi.org', 'developer.mozilla.org', 'docs.rs', 'crates.io', 'rust-lang.org', 'go.dev', 'nodejs.org', 'electronjs.org', 'vercel.com', 'netlify.com', 'localhost', '127.0.0.1'] },
  { name: 'AI', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'claude.ai', 'anthropic.com', 'gemini.google.com', 'perplexity.ai', 'huggingface.co', 'poe.com'] },
  { name: 'Docs', hosts: ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com', 'notion.so', 'coda.io', 'quip.com', 'paper.dropbox.com', 'overleaf.com'] },
  { name: 'Email', hosts: ['mail.google.com', 'gmail.com', 'outlook.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com', 'mail.proton.me', 'protonmail.com', 'fastmail.com'] },
  { name: 'Social', hosts: ['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'reddit.com', 'linkedin.com', 'threads.net', 'bsky.app', 'tiktok.com', 'pinterest.com', 'discord.com', 'web.whatsapp.com', 'whatsapp.com', 't.me', 'telegram.org'] },
  { name: 'News', hosts: ['news.ycombinator.com', 'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'reuters.com', 'apnews.com', 'bloomberg.com', 'wsj.com', 'economist.com', 'arstechnica.com', 'theverge.com', 'techcrunch.com', 'wired.com', 'medium.com', 'substack.com'] },
  { name: 'Shopping', hosts: ['amazon.com', 'amazon.ca', 'amazon.co.uk', 'amazon.de', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'aliexpress.com', 'bestbuy.com', 'temu.com', 'craigslist.org'] },
  { name: 'Research', hosts: ['arxiv.org', 'scholar.google.com', 'jstor.org', 'sciencedirect.com', 'nature.com', 'springer.com', 'ieee.org', 'acm.org', 'pubmed.ncbi.nlm.nih.gov', 'semanticscholar.org', 'researchgate.net', 'wikipedia.org'] },
  { name: 'School', hosts: ['edu', 'instructure.com', 'brightspace.com', 'blackboard.com', 'gradescope.com', 'piazza.com', 'coursera.org', 'edx.org', 'khanacademy.org', 'udemy.com'] },
  { name: 'Finance', hosts: ['paypal.com', 'venmo.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'coinbase.com', 'robinhood.com', 'fidelity.com', 'vanguard.com', 'schwab.com', 'stripe.com'] },
  { name: 'Games', hosts: ['steampowered.com', 'steamcommunity.com', 'epicgames.com', 'itch.io', 'roblox.com', 'minecraft.net', 'chess.com', 'lichess.org'] },
];

/**
 * @typedef {Object} OrganizeGroup
 * @property {string} name           folder name to file these under
 * @property {string|null} folderId  existing top-level folder to reuse, or null to create
 * @property {string[]} tabIds
 *
 * @typedef {Object} OrganizePlan
 * @property {OrganizeGroup[]} groups
 * @property {number} loose      tabs under root that were considered
 * @property {number} leftover   considered tabs the plan leaves untouched
 */

/**
 * Plan folders for the loose tabs under root. Pure: mutates nothing.
 * @param {Array<{ id: string, parentId: string, url: string }>} tabs  ALL tabs
 * @param {Array<{ id: string, parentId: string|null, name: string }>} folders  ALL folders
 * @param {string} rootId
 * @returns {OrganizePlan}
 */
export function planOrganize(tabs, folders, rootId) {
  const loose = tabs.filter((t) => t.parentId === rootId);

  /** @type {Map<string, string[]>} category name -> tabIds */
  const byCategory = new Map();
  /** @type {Array<{ id: string, host: string }>} */
  const unmatched = [];

  for (const t of loose) {
    const host = hostOf(t.url);
    if (!host) continue; // raha://home etc. — never file internal pages
    const cat = categorize(host);
    if (cat) {
      const list = byCategory.get(cat) ?? [];
      list.push(t.id);
      byCategory.set(cat, list);
    } else {
      unmatched.push({ id: t.id, host });
    }
  }

  /** @type {OrganizeGroup[]} */
  const groups = [];
  for (const { name } of CATEGORIES) {
    const ids = byCategory.get(name);
    if (ids && ids.length >= MIN_CATEGORY_TABS) {
      groups.push({ name, folderId: findExistingFolder(folders, rootId, name), tabIds: ids });
    }
  }

  // Fallback: unmatched tabs clustering on one registrable domain.
  /** @type {Map<string, string[]>} */
  const byDomain = new Map();
  for (const u of unmatched) {
    const dom = registrableDomain(u.host);
    const list = byDomain.get(dom) ?? [];
    list.push(u.id);
    byDomain.set(dom, list);
  }
  for (const [dom, ids] of [...byDomain.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ids.length >= MIN_DOMAIN_GROUP) {
      groups.push({ name: dom, folderId: findExistingFolder(folders, rootId, dom), tabIds: ids });
    }
  }

  const planned = groups.reduce((n, g) => n + g.tabIds.length, 0);
  return { groups, loose: loose.length, leftover: loose.length - planned };
}

/** First matching category name, or null. Exported for tests. @param {string} host */
export function categorize(host) {
  for (const cat of CATEGORIES) {
    for (const h of cat.hosts) {
      if (host === h || host.endsWith('.' + h)) return cat.name;
    }
  }
  return null;
}

/**
 * "registrable domain", approximately: last two labels, or three when the
 * ending is a well-known two-part public suffix (co.uk and friends). Not a
 * full public-suffix list — good enough for grouping, cheap to improve.
 * Exported for tests. @param {string} host
 */
export function registrableDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.kr', 'co.in', 'co.nz', 'com.br', 'com.mx', 'com.tr', 'com.cn',
]);

/**
 * Case-insensitive match against existing TOP-LEVEL folders only — reusing a
 * nested folder would silently move tabs into someone's project structure.
 * @param {Array<{ id: string, parentId: string|null, name: string }>} folders
 * @param {string} rootId @param {string} name
 */
function findExistingFolder(folders, rootId, name) {
  const want = name.toLowerCase();
  const hit = folders.find((f) => f.parentId === rootId && f.name.toLowerCase() === want);
  return hit ? hit.id : null;
}
