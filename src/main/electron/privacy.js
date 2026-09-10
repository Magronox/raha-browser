// Session hardening for the web-content session. All privacy behavior in one
// place: ad/tracker blocking, GPC/DNT headers, permission gating, downloads,
// and the wire half of Raha's Chrome identity (below).
// Blocking uses the BUNDLED filter lists (ADR-0009) — Raha itself performs no
// network requests except the optional security-update check (ADR-0008,
// `autoUpdate` setting): no telemetry, no list fetches (docs/INVARIANTS.md
// #6). The chrome does load favicons from sites directly via <img>; those
// requests come from the UI partition and therefore do NOT pass through the
// header/blocking hooks below, which are installed on the web-content
// session only (alignSessionClientHints covers the UI partition).
//
// Chrome identity, three layers (ADR-0012; src/shared/client-hints.js has
// the measurements behind each):
//   1. CDP identity — chrome-identity.js, per tab: the JS view
//      (navigator.userAgent/userAgentData), renderer-initiated subresource
//      headers, dedicated workers, and out-of-process iframes.
//   2. Header synthesis — onBeforeSendHeaders here: the Chrome UA forced on
//      EVERY request, any brand header the renderer sent recomputed, and
//      the three low-entropy Sec-CH-UA hints added to navigations — the
//      requests Electron leaves bare and Chrome decorates. Only to secure
//      origins and loopback (never plain http), and never on WebSocket
//      handshakes or worker requests: real Chrome sends none there
//      (measured side by side).
//   3. Accept-CH emulation — onHeadersReceived here remembers, per origin,
//      which high-entropy hints a top-level document asked for; the send
//      hook adds exactly those where Chrome's default `self` policy would
//      (planClientHints). Forgotten with the site's data (forgetAcceptCh).
// Known divergences, stated honestly (ADR-0012 has the full list): no
// Critical-CH restart, synthesized hints land after Accept-Language,
// window.chrome is an empty object, and a permission the user has not yet
// decided reads "denied" to a mere check (Notification.permission,
// permissions.query) where Chrome says "prompt" — Electron's check handler
// has no third answer (ADR-0013).
import { decideBlock } from '../../shared/blocking.js';
import {
  chromeClientHints,
  hostArch,
  applyClientHintHeaders,
  planClientHints,
  setHeader,
  clientHintsAllowedFor,
  hintOrigin,
  acceptChFromResponse,
  AcceptChCache,
} from '../../shared/client-hints.js';
import { hostOf } from '../../shared/rules.js';
import { permissionKindsForRequest, permissionKindForCheck } from '../../shared/permissions.js';
import { log } from './log.js';

/**
 * A standard Chrome user agent for this platform — no Raha token, no
 * Electron token (partial R-114). The default Electron UA is an anomaly that
 * anti-bot edges (Cloudflare) and login gates (Google's "browser may not be
 * secure") score against, breaking real sites for real users — and it
 * uniquely fingerprints Raha. Chrome major comes from our actual Chromium;
 * the trailing .0.0.0 mirrors Chrome's own reduced-UA format.
 * @returns {string}
 */
export function standardUserAgent() {
  const major = process.versions.chrome.split('.')[0];
  const os = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** @type {{ userAgent: string, navigatorPlatform: string, hints: ReturnType<typeof chromeClientHints> } | null} */
let identityMemo = null;

/**
 * Host facts only the wiring layer can know. This file deliberately does
 * not import 'electron' (unit tests load it through chrome-identity.js),
 * so index.js hands them over before the first session or tab exists.
 */
const hostFacts = { arm64Translation: false };

/**
 * @param {{ arm64Translation?: boolean }} facts
 *   arm64Translation: Electron's app.runningUnderARM64Translation — an x64
 *   build under Rosetta 2 or Windows ARM64 emulation, where Chrome reports
 *   architecture "arm" (client-hints.js hostArch).
 */
export function configureChromeIdentity(facts) {
  hostFacts.arm64Translation = facts.arm64Translation === true;
  identityMemo = null; // recomputed on next use
}

/**
 * The one Chrome identity Raha presents, memoized: the UA string, what
 * navigator.platform says on this OS, and every client hint Chrome of our
 * Chromium version would report on this machine (request headers + the
 * CDP userAgentMetadata). Consumed by the header hooks below and by
 * chrome-identity.js — one source, so the three layers cannot disagree.
 * @returns {{ userAgent: string, navigatorPlatform: string, hints: ReturnType<typeof chromeClientHints> }}
 */
export function chromeIdentity() {
  if (!identityMemo) {
    identityMemo = {
      userAgent: standardUserAgent(),
      // What Chrome reports on each OS (MacIntel even on Apple Silicon).
      navigatorPlatform: process.platform === 'darwin' ? 'MacIntel' : process.platform === 'win32' ? 'Win32' : 'Linux x86_64',
      hints: chromeClientHints({
        chromeVersion: process.versions.chrome,
        platform: process.platform,
        arch: hostArch(process.arch, hostFacts.arm64Translation),
        osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : undefined,
      }),
    };
  }
  return identityMemo;
}

/**
 * Brand alignment for a session with no other webRequest needs — the
 * chrome's own session, whose favicon fetches hit every visited site. It
 * presents the Chrome UA (window.js), so its client hints must agree too,
 * or each favicon request re-broadcasts the exact header-vs-UA mismatch
 * the web session stopped sending. Electron allows ONE onBeforeSendHeaders
 * listener per session: this claims the UI session's slot, so any future
 * UI-session header need must extend this hook, not add a second one.
 * @param {Electron.Session} ses
 */
export function alignSessionClientHints(ses) {
  const identity = chromeIdentity();
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    // Force the UA for symmetry with the web session and recompute the
    // brand headers the chrome's renderer sends (it has no CDP override, so
    // its list is Chromium's: wrong brand, and wrong order for most majors).
    // It already sends the low-entropy hints itself where Chrome would
    // (secure origins), so nothing is synthesized here.
    const requestHeaders = applyClientHintHeaders(
      setHeader({ ...details.requestHeaders }, 'User-Agent', identity.userAgent),
      { lowEntropy: identity.hints.lowEntropyHeaders, highEntropy: identity.hints.highEntropyHeaders, wanted: [], addLow: false },
    );
    callback({ requestHeaders });
  });
}

/**
 * @param {Electron.Session} ses the persist:main web session
 * @param {{
 *   getSettings: () => import('../../shared/defaults.js').RahaSettings,
 *   matchers: import('../../shared/blocking.js').Matchers|null,
 *   topHostForWebContentsId: (wcId: number|undefined) => string|null,
 *   onBlocked: (wcId: number|undefined) => void,
 *   toast: (kind: 'info'|'warn'|'download', text: string) => void,
 *   askPermission: (wcId: number|undefined, kinds: import('../../shared/permissions.js').PermissionKind[], requestingUrl: string, isMainFrame: boolean) => Promise<boolean>,
 *   checkPermission: (wcId: number|undefined, kind: import('../../shared/permissions.js').PermissionKind) => boolean,
 * }} hooks   `matchers` null = engines failed to load; blocking fails OPEN
 *            (the wiring in index.js logs and toasts). askPermission /
 *            checkPermission reach engine.permissionRequest / permissionCheck
 *            (R-103): the engine decides, asks the user when it must, and
 *            is the only place that grants.
 */
export function hardenWebSession(ses, hooks) {
  const identity = chromeIdentity();
  const acceptCh = new AcceptChCache();
  acceptChBySession.set(ses, acceptCh);
  ses.setUserAgent(identity.userAgent);

  /**
   * The requesting frame's origin and its top-level document's origin —
   * what Chrome's `self` policy is evaluated against. Electron's
   * `details.frame` can already be gone (navigated/destroyed between
   * request and hook); then fall back to the engine's view of the tab,
   * which knows only the top HOST: same host as the request → treat it as
   * a first-party request from the top frame, anything else → cross-origin.
   * @param {Electron.OnBeforeSendHeadersListenerDetails} details
   * @returns {{ frameOrigin: string | null, topOrigin: string | null }}
   */
  const requestOrigins = (details) => {
    try {
      const frame = details.frame;
      if (frame) return { frameOrigin: hintOrigin(frame.url), topOrigin: hintOrigin((frame.top ?? frame).url) };
    } catch { /* disposed between request and hook */ }
    const top = hooks.topHostForWebContentsId(details.webContentsId);
    const origin = top !== null && top === hostOf(details.url) ? hintOrigin(details.url) : null;
    return { frameOrigin: origin, topOrigin: origin };
  };

  // --- Ad/tracker blocking (bundled EasyList + EasyPrivacy; decision
  // pipeline in src/shared/blocking.js). This is the session's ONE
  // onBeforeRequest listener — Electron replaces, not stacks, so nothing
  // else may register another.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const s = hooks.getSettings();
    const m = hooks.matchers;
    if (!m) return callback({});
    const top = hooks.topHostForWebContentsId(details.webContentsId);
    if (decideBlock({ url: details.url, resourceType: details.resourceType }, top, s, m)) {
      hooks.onBlocked(details.webContentsId);
      return callback({ cancel: true });
    }
    callback({});
  });

  // --- Global Privacy Control + Do Not Track, and the Chrome identity's
  // wire half (layers 2 + 3 in the header comment). This is the session's
  // ONE onBeforeSendHeaders listener — extend it, never add a second.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const s = hooks.getSettings();
    // The UA is forced on EVERY request, not just set on the session: an
    // out-of-process iframe's requests carried the raw Electron UA before
    // its CDP override landed, and nothing else must ever slip through.
    let requestHeaders = setHeader({ ...details.requestHeaders }, 'User-Agent', identity.userAgent);
    if (s.gpc) {
      requestHeaders['Sec-GPC'] = '1';
      requestHeaders['DNT'] = '1';
    }
    // Client hints follow Chrome's rules (planClientHints): the low-entropy
    // three synthesized on navigations only, high-entropy ones only where
    // the top-level origin asked via Accept-CH (remembered below) AND
    // Chrome's default `self` policy would deliver them — decided from the
    // requesting FRAME, not the tab, so a cross-origin iframe never learns
    // the machine's exact OS build and CPU just because its origin was once
    // visited top-level, and a third-party fetch never carries them.
    const { frameOrigin, topOrigin } = requestOrigins(details);
    const plan = planClientHints({
      url: details.url,
      resourceType: details.resourceType,
      requestHeaders: details.requestHeaders,
      frameOrigin,
      topOrigin,
      cache: acceptCh,
    });
    requestHeaders = applyClientHintHeaders(requestHeaders, {
      lowEntropy: identity.hints.lowEntropyHeaders,
      highEntropy: identity.hints.highEntropyHeaders,
      wanted: plan.wanted,
      addLow: plan.addLow,
    });
    callback({ requestHeaders });
  });

  // --- Accept-CH emulation (layer 3). Electron ignores Accept-CH and
  // Critical-CH (no client-hints delegate), so remember what a top-level
  // document asked for, per origin, the way Chrome's Accept-CH cache does —
  // Chrome honors the header on top-level navigation responses only, never
  // from subresources or iframes. In-memory, bounded, gone on quit, cleared
  // with the site's data (the class states each difference from Chrome).
  // Not emulated: Chrome's Critical-CH RESTART — it re-issues a navigation
  // once when the response declares critical hints the request lacked, so
  // the document it renders was requested with them; here only the NEXT
  // navigation carries them (ADR-0012 lists this). This is the session's
  // ONE onHeadersReceived listener — extend it, never add a second.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && clientHintsAllowedFor(details.url)) {
      const names = acceptChFromResponse(details.responseHeaders);
      if (names.length > 0) acceptCh.remember(hintOrigin(details.url), names);
    }
    callback({});
  });

  // --- Permissions: consent-first (R-103, ADR-0013). Nothing sensitive is
  // ever granted silently. Camera, microphone, location, notifications and
  // clipboard-read are ASKED about — per site, in Raha's own prompt, via
  // engine.permissionRequest (the engine remembers "always"/"never" and is
  // the only place that grants). Everything else keeps deny-by-default:
  // 'display-capture' (screen sharing) needs setDisplayMediaRequestHandler
  // and its own picker — ROADMAP R-103b; the rest ('midi', 'idle-detection',
  // 'storage-access', …) is refused and the user told, once per tab per
  // permission (a page retrying in a loop is not a toast storm).
  //
  // BOTH handlers are required. Electron's own docs: "you must also implement
  // setPermissionCheckHandler to get complete permission handling. Most web
  // APIs do a permission check and then make a permission request if the check
  // is denied." With only the request handler installed, the synchronous check
  // path (navigator.permissions.query, media device enumeration, …) falls back
  // to Electron's default, which is more permissive than what we tell the user
  // — the UI would say "blocked" while a check said otherwise.
  //
  // The check handler can only answer yes or no — there is no way to say
  // "prompt", as Chrome does for an undecided site. So an undecided site
  // reads as DENIED to a mere check (navigator.permissions.query,
  // Notification.permission) and is asked the moment it actually REQUESTS;
  // only a remembered allow, or this visit's "allow once", reads as granted.
  const SILENTLY_ALLOWED = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
  /** @type {WeakMap<Electron.WebContents, Set<string>>} permissions already toasted, per renderer */
  const toasted = new WeakMap();
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (SILENTLY_ALLOWED.has(permission)) return callback(true);
    const kinds = permissionKindsForRequest(permission, 'mediaTypes' in details ? details.mediaTypes : undefined);
    if (kinds.length > 0) {
      hooks.askPermission(wc?.id, kinds, details.requestingUrl, details.isMainFrame)
        .then((granted) => callback(granted === true), () => callback(false));
      return;
    }
    const seen = toasted.get(wc) ?? new Set();
    if (!seen.has(permission)) {
      seen.add(permission);
      toasted.set(wc, seen);
      hooks.toast('info', `Blocked a "${permission}" permission request (Raha denies these by default)`);
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((wc, permission, _requestingOrigin, details) => {
    // Silent: a check is not a user gesture, so toasting here would fire on
    // page load for sites that merely probe what they could ask for.
    if (SILENTLY_ALLOWED.has(permission)) return true;
    const kind = permissionKindForCheck(permission, details?.mediaType);
    if (kind && hooks.checkPermission(wc?.id, kind)) return true;
    log('privacy', `denied permission check: ${permission}${kind ? ` (${kind}: undecided or blocked for this site)` : ''}`);
    return false;
  });

  // --- Downloads: default save dialog + progress toasts
  ses.on('will-download', (_event, item) => {
    const name = item.getFilename();
    hooks.toast('download', `Downloading ${name}…`);
    item.on('done', (_e, state) => {
      if (state === 'completed') hooks.toast('download', `Downloaded ${name}`);
      else if (state === 'interrupted') hooks.toast('warn', `Download failed: ${name}`);
    });
  });

  log('privacy', 'web session hardened (filter-list blocking, GPC, Chrome identity headers + Accept-CH, permission gate, downloads)');
}

/** @type {WeakMap<Electron.Session, AcceptChCache>} */
const acceptChBySession = new WeakMap();

/**
 * Forget an origin's Accept-CH memory along with its site data — site-data.js
 * calls this from both clearing paths. A user who just cleared a site is a
 * fresh visitor to it, and Chrome clears this state with cookies too.
 * @param {Electron.Session} ses
 * @param {string} [host] bare hostname (its subdomains and parent domains
 *   included, like clearSiteData); omitted = every origin
 * @returns {number} origins forgotten
 */
export function forgetAcceptCh(ses, host) {
  const cache = acceptChBySession.get(ses);
  if (!cache) return 0;
  return host ? cache.forget(host) : cache.clear();
}
