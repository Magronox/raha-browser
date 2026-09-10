// Site-data clearing: the software-level fix for cookie-based lockouts
// (bot-check loops, consent walls, corrupted sessions). Everything here is
// plain Electron session API — deleting cookies and stored data, nothing
// exotic — plus the one piece of per-site state Raha keeps itself: the
// Accept-CH memory of the Chrome identity (privacy.js), which Chrome also
// clears with cookies. Used by the page context menu ("Clear Cookies & Data
// for This Site"), the Settings nuke button, and the siteData:* IPC channels.
import { forgetAcceptCh } from './privacy.js';

/**
 * Remove cookies + storage for a host and its subdomains, including
 * partitioned third-party cookies whose top-level site is this host (the
 * CHIPS jar — where e.g. Cloudflare challenge cookies live).
 * @param {Electron.Session} ses
 * @param {string} host bare lowercase hostname (page host)
 * @returns {Promise<{ cookiesRemoved: number }>}
 */
export async function clearSiteData(ses, host) {
  const h = String(host || '').toLowerCase();
  if (!h) return { cookiesRemoved: 0 };
  const all = await ses.cookies.get({});
  let removed = 0;
  for (const c of all) {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    const domainMatch = d === h || d.endsWith(`.${h}`) || h.endsWith(`.${d}`);
    const pk = String(/** @type {any} */ (c).partitionKey?.topLevelSite || '')
      .replace(/^https?:\/\//, '').toLowerCase();
    const partitionMatch = pk !== '' && (h === pk || h.endsWith(`.${pk}`) || pk.endsWith(`.${h}`));
    if (!domainMatch && !partitionMatch) continue;
    const url = `http${c.secure ? 's' : ''}://${d}${c.path || '/'}`;
    try { await ses.cookies.remove(url, c.name); removed += 1; } catch { /* keep sweeping */ }
  }
  for (const origin of [`https://${h}`, `http://${h}`]) {
    try { await ses.clearStorageData({ origin }); } catch { /* keep sweeping */ }
  }
  await ses.cookies.flushStore().catch(() => {});
  forgetAcceptCh(ses, h);
  return { cookiesRemoved: removed };
}

/**
 * The nuke: every cookie, every site's storage, the HTTP cache. Signs the
 * user out of everything — callers must confirm with the user first.
 * @param {Electron.Session} ses
 */
export async function clearAllSiteData(ses) {
  await ses.clearStorageData();
  await ses.clearCache().catch(() => {});
  await ses.cookies.flushStore().catch(() => {});
  forgetAcceptCh(ses);
  return { ok: true };
}
