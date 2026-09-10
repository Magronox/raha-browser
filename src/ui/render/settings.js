// Settings panel (modal). Every control writes through api.settingsSet
// immediately — there is no "save" button; the governor reacts instantly.
import { api } from '../api.js';
import { store } from '../store.js';
import { icons } from '../icons.js';
import { esc, captureFocusedField, restoreFocusedField, captureScrollTop, restoreScrollTop } from './util.js';
import { PERMISSION_KINDS, permissionKindLabel } from '../../shared/permissions.js';

/** @type {HTMLElement} */ let root;

/** App version handed to the preload by main (additionalArguments). */
function appVersion() {
  return /** @type {{ version?: string }|undefined} */ (/** @type {any} */ (globalThis).raha)?.version ?? 'dev';
}

export function initSettings(/** @type {HTMLElement} */ el) {
  root = el;
  render();
}

export function render() {
  const snap = store.snap;
  if (!snap || !store.local.settingsOpen) { root.innerHTML = ''; root.classList.remove('open'); return; }
  const s = snap.settings;
  root.classList.add('open');

  const engines = ['duckduckgo', 'brave', 'startpage', 'ecosia', 'google', 'bing', 'kagi'];
  const budgetOpts = [0, 1024, 2048, 4096, 8192];
  const idleOpts = [0, 5, 15, 30, 60, 120];

  const rulesRows = s.rules.map((r, i) => `
    <div class="rule-row" data-rule-i="${i}">
      <code class="rule-pat">${esc(r.pattern)}</code>
      <span class="rule-flags">${r.keepAlive ? 'keep alive' : ''}${r.keepAlive && r.memLimitMB ? ' · ' : ''}${r.memLimitMB ? `≤ ${r.memLimitMB} MB` : ''}</span>
      <button class="mini act danger" data-rule-del="${i}" title="Delete rule">${icons.close}</button>
    </div>`).join('');

  // Site permissions (R-103): one row per site, a chip per remembered kind.
  // Hosts are page-controlled strings — esc() on every render, attribute
  // included.
  const permHosts = Object.keys(s.sitePermissions);
  const permRows = permHosts.map((host) => {
    const decisions = s.sitePermissions[host];
    const chips = PERMISSION_KINDS.filter((k) => decisions[k] !== undefined).map((k) => `
          <span class="scheme-chip perm-chip perm-${decisions[k] === 'allow' ? 'allowed' : 'blocked'}"><code>${esc(permissionKindLabel(k))}: ${decisions[k] === 'allow' ? 'allowed' : 'blocked'}</code><button class="mini act danger" data-perm-forget-host="${esc(host)}" data-perm-forget-kind="${k}" title="Ask again about ${esc(permissionKindLabel(k))} on ${esc(host)}">${icons.close}</button></span>`).join('');
    return `
    <div class="perm-row">
      <code class="perm-host">${esc(host)}</code>
      <span class="scheme-list">${chips}</span>
      <button class="btn subtle perm-forget-site" data-perm-forget-host="${esc(host)}" title="Forget every decision for ${esc(host)}">Forget site</button>
    </div>`;
  }).join('');

  const typing = captureFocusedField(root); // e.g. a rule pattern mid-word
  const modalScroll = captureScrollTop(root, '.modal'); // mid-scroll tick must not jump to top
  root.innerHTML = `
    <div class="modal-backdrop" data-close-settings></div>
    <div class="modal settings" role="dialog" aria-label="Settings">
      <div class="modal-head"><h2>Settings</h2>
        <button class="iconbtn" data-close-settings title="Close (Esc)">${icons.close}</button></div>

      <h3>The governor</h3>
      <label class="setting">
        <span>Max live tabs <b class="val">${s.maxLiveTabs}</b></span>
        <input type="range" min="1" max="16" step="1" value="${s.maxLiveTabs}" data-set="maxLiveTabs">
        <small>Only this many tabs may run at once. The least-recently used background tab is put to sleep first. Pinned and audio tabs are protected.</small>
      </label>
      <label class="setting">
        <span>Total memory budget</span>
        <select data-set="globalBudgetMB">
          ${budgetOpts.map((v) => `<option value="${v}" ${s.globalBudgetMB === v ? 'selected' : ''}>${v === 0 ? 'Off' : v >= 1024 ? `${v / 1024} GB` : `${v} MB`}</option>`).join('')}
        </select>
        <small>When running tabs together exceed this, Raha sleeps the least-recent ones until it fits.</small>
      </label>
      <label class="setting">
        <span>Sleep background tabs after</span>
        <select data-set="idleSleepMinutes">
          ${idleOpts.map((v) => `<option value="${v}" ${s.idleSleepMinutes === v ? 'selected' : ''}>${v === 0 ? 'Never (cap only)' : `${v} min idle`}</option>`).join('')}
        </select>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.protectAudio ? 'checked' : ''} data-set-bool="protectAudio">
        <span>Never auto-sleep tabs that are playing sound</span>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.runawayGuard ? 'checked' : ''} data-set-bool="runawayGuard">
        <span>Warn when a tab's CPU or memory use explodes, and offer to terminate it</span>
      </label>

      <h3>Privacy</h3>
      <label class="setting toggle">
        <input type="checkbox" ${s.blockAds ? 'checked' : ''} data-set-bool="blockAds">
        <span>Block ads (bundled EasyList — network-level, so some pages show empty boxes where ads were)</span>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.blockTrackers ? 'checked' : ''} data-set-bool="blockTrackers">
        <span>Block trackers (bundled EasyPrivacy)</span>
      </label>
      <label class="setting">
        <small>Filter lists ship inside the app and update with each Raha release — never downloaded at runtime. If a site misbehaves, click the shield in the address bar to turn blocking off for that site only.</small>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.gpc ? 'checked' : ''} data-set-bool="gpc">
        <span>Send Global Privacy Control (Sec-GPC) + DNT</span>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.httpsFirst ? 'checked' : ''} data-set-bool="httpsFirst">
        <span>HTTPS first for typed addresses</span>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.autoUpdate ? 'checked' : ''} data-set-bool="autoUpdate">
        <span>Install security updates automatically (checks GitHub Releases)</span>
      </label>
      <label class="setting toggle">
        <input type="checkbox" ${s.recordHistory ? 'checked' : ''} data-set-bool="recordHistory">
        <span>Remember pages I visit (powers address-bar suggestions)</span>
        <small>A file on this computer only — nothing ever leaves it. Search it via the clock icon; clear it there too.</small>
      </label>
      <label class="setting">
        <span>Default browser</span>
        <button class="btn" data-default-browser>Use Raha as my default browser</button>
        <small>macOS will ask you to confirm. Links from other apps then open in Raha.</small>
      </label>
      ${s.allowedExternalSchemes.length ? `
      <label class="setting">
        <span>App links opened without asking</span>
        <span class="scheme-list">${s.allowedExternalSchemes.map((sc) => `
          <span class="scheme-chip"><code>${esc(sc)}</code><button class="mini act danger" data-forget-scheme="${esc(sc)}" title="Ask again for ${esc(sc)} links">${icons.close}</button></span>`).join('')}</span>
        <small>Raha opens these in their app without asking. Remove one to be asked again.</small>
      </label>` : ''}
      <label class="setting">
        <span>Site permissions</span>
        <div class="perm-sites">${permRows || '<div class="rules-empty">No decisions yet — sites ask when they need something.</div>'}</div>
        <small>Sites ask the first time they want your camera, microphone, location, notifications, or clipboard. “Always allow” and “Never for this site” land here; “Allow once” and “Not now” are never remembered. Remove a chip (or the whole site) to be asked again.</small>
      </label>
      <label class="setting">
        <span>Site data</span>
        <button class="btn subtle" data-clear-all-data>Clear all cookies &amp; site data…</button>
        <small>Signs you out of every site (asks first). For ONE misbehaving site, right-click its page → “Clear Cookies &amp; Data for This Site”.</small>
      </label>
      <label class="setting">
        <span>Search engine</span>
        <select data-set-str="searchEngine">
          ${engines.map((e) => `<option value="${e}" ${s.searchEngine === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
      </label>

      <h3>Domain rules <small class="h3sub">first match wins · <code>site.com</code> or <code>*.site.com</code></small></h3>
      <div class="rules">${rulesRows || '<div class="rules-empty">No rules yet. Example: keep <code>*.music.youtube.com</code> alive, or cap <code>*.slack.com</code> at 800 MB.</div>'}</div>
      <div class="rule-add">
        <input type="text" placeholder="*.example.com" data-rule-pattern spellcheck="false">
        <label><input type="checkbox" data-rule-keepalive> keep alive</label>
        <input type="number" placeholder="MB limit" min="50" max="16384" data-rule-mem>
        <button class="btn" data-rule-addbtn>${icons.plus} Add rule</button>
      </div>

      <p class="settings-note">Raha sends no telemetry, ever. Its only own network request is the security-update check above — turn it off and Raha is fully silent.</p>

      <h3>About</h3>
      <p class="about-line">
        Raha ${esc(appVersion())} · GPL-3.0-only ·
        <a data-about-link="https://github.com/Magronox/raha-browser">GitHub</a> ·
        <a data-about-link="https://github.com/Magronox/raha-browser/issues/new/choose">Report a bug</a> ·
        <a data-about-link="https://venmo.com/u/magronox">Support</a>
      </p>
      <small class="about-sub">Support funds code-signing certificates, nothing else. Links open as tabs.</small>
    </div>
  `;

  restoreFocusedField(root, typing);
  restoreScrollTop(root, '.modal', modalScroll);

  root.querySelectorAll('[data-close-settings]').forEach((el) =>
    el.addEventListener('click', () => store.setLocal({ settingsOpen: false })));

  // About links: the chrome never navigates (invariant #13) — open as tabs,
  // same pattern as the history panel's row-click.
  root.querySelectorAll('[data-about-link]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const url = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.aboutLink);
      store.setLocal({ settingsOpen: false });
      void api.tabCreate({ url, activate: true });
    }));

  root.querySelectorAll('[data-forget-scheme]').forEach((el) =>
    el.addEventListener('click', () => {
      const sc = /** @type {HTMLElement} */ (el).dataset.forgetScheme;
      void api.settingsSet({ allowedExternalSchemes: s.allowedExternalSchemes.filter((x) => x !== sc) });
    }));

  root.querySelectorAll('[data-perm-forget-host]').forEach((el) =>
    el.addEventListener('click', () => {
      const { permForgetHost, permForgetKind } = /** @type {HTMLElement} */ (el).dataset;
      if (!permForgetHost) return;
      void api.permissionForget(permForgetHost, /** @type {import('../../shared/permissions.js').PermissionKind|undefined} */ (permForgetKind));
    }));

  root.querySelector('[data-default-browser]')?.addEventListener('click', () =>
    void api.defaultBrowserSet());
  root.querySelector('[data-clear-all-data]')?.addEventListener('click', () =>
    void api.siteDataClearAll());

  root.querySelectorAll('[data-set]').forEach((el) => {
    const input = /** @type {HTMLInputElement|HTMLSelectElement} */ (el);
    input.addEventListener('change', () => {
      void api.settingsSet({ [/** @type {string} */ (input.dataset.set)]: Number(input.value) });
    });
    if (input.type === 'range') {
      input.addEventListener('input', () => {
        const label = input.closest('.setting')?.querySelector('.val');
        if (label) label.textContent = input.value;
      });
    }
  });
  root.querySelectorAll('[data-set-bool]').forEach((el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    input.addEventListener('change', () =>
      void api.settingsSet({ [/** @type {string} */ (input.dataset.setBool)]: input.checked }));
  });
  root.querySelectorAll('[data-set-str]').forEach((el) => {
    const input = /** @type {HTMLSelectElement} */ (el);
    input.addEventListener('change', () =>
      void api.settingsSet({ [/** @type {string} */ (input.dataset.setStr)]: input.value }));
  });

  root.querySelectorAll('[data-rule-del]').forEach((el) =>
    el.addEventListener('click', () => {
      const i = Number(/** @type {HTMLElement} */ (el).dataset.ruleDel);
      const rules = s.rules.filter((_r, idx) => idx !== i);
      void api.settingsSet({ rules });
    }));

  root.querySelector('[data-rule-addbtn]')?.addEventListener('click', () => {
    const pat = /** @type {HTMLInputElement} */ (root.querySelector('[data-rule-pattern]')).value.trim();
    const keepAlive = /** @type {HTMLInputElement} */ (root.querySelector('[data-rule-keepalive]')).checked;
    const memRaw = /** @type {HTMLInputElement} */ (root.querySelector('[data-rule-mem]')).value;
    if (!pat) return;
    /** @type {import('../../shared/defaults.js').DomainRule} */
    const rule = { pattern: pat };
    if (keepAlive) rule.keepAlive = true;
    if (memRaw) rule.memLimitMB = Number(memRaw);
    void api.settingsSet({ rules: [...s.rules, rule] });
  });
}
