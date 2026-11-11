// A client certificate is never offered. Without preventDefault Electron
// sends the first matching certificate from the system store on its own, and
// the site learns who you are with no ask. A site that requires one shows its
// own error instead, and the person is told which site asked: at most once a
// minute per site and once every few seconds overall, so a page retrying is
// not a stream of notices.
//
// Kept apart from index.js so the unit tests can load it: it imports neither
// 'electron' nor anything that does. `app` is Electron's app, or a test
// double with the same `on`.
// https://www.electronjs.org/docs/latest/api/app#event-select-client-certificate
import { hostOf } from '../../shared/rules.js';

const LIMITS = { perHostMs: 60_000, anyMs: 5_000, maxHosts: 200 };

/** @param {string} host */
export function clientCertificateRefusedText(host) {
  return `${host} asked for a certificate. Raha didn't share one: Raha is a privacy browser and never sends a certificate.`;
}

/**
 * The host Electron names. It passes `host:port` (e.g. "bank.example:443",
 * "[::1]:8443"), not a URL, so a bare value is read as https.
 * @param {unknown} value
 */
export function certificateRequestHost(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  return hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`) ?? '';
}

/**
 * @param {{ on: (...args: any[]) => unknown }} app Electron's app (its `on` is overloaded per event)
 * @param {{ notify: (text: string) => void, log?: (msg: string) => void, now?: () => number, limits?: Partial<typeof LIMITS> }} opts
 */
export function refuseClientCertificates(app, { notify, log = () => {}, now = Date.now, limits = {} }) {
  const { perHostMs, anyMs, maxHosts } = { ...LIMITS, ...limits };
  /** @type {Map<string, number>} */
  const toldAt = new Map();
  let lastToldAt = -Infinity;
  app.on('select-client-certificate', (
    /** @type {{ preventDefault: () => void }} */ event,
    /** @type {unknown} */ _webContents,
    /** @type {string} */ url,
    /** @type {unknown[]} */ _certificateList,
    /** @type {(certificate?: unknown) => void} */ callback,
  ) => {
    // The refusal comes first and does not depend on anything below.
    event.preventDefault();
    callback();
    const host = certificateRequestHost(url);
    if (!host) return;
    const t = now();
    if (t - lastToldAt < anyMs) return;
    if (t - (toldAt.get(host) ?? -Infinity) < perHostMs) return;
    if (toldAt.size >= maxHosts) toldAt.clear();
    toldAt.set(host, t);
    lastToldAt = t;
    log('refused a client certificate request');
    notify(clientCertificateRefusedText(host));
  });
}
