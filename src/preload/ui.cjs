// Preload for the UI chrome view ONLY. Web content tabs get NO preload and
// NO bridge — pages cannot reach into Raha (docs/INVARIANTS.md #5).
//
// The bridge forwards only channels that are in the contract. It cannot
// import src/shared/ipc-contract.js directly — a sandboxed preload is CommonJS
// and the contract is ESM — so main passes the two channel lists down through
// webPreferences.additionalArguments (see src/main/electron/window.js). That
// keeps channel names in exactly one file (docs/INVARIANTS.md #7) while making
// the allow-list a real check rather than a comment.
//
// Sandboxed preloads must be CommonJS — do not convert this file to ESM.
const { contextBridge, ipcRenderer } = require('electron');

/** @param {string} flag @returns {Set<string>|null} */
function readChannelList(flag) {
  const arg = process.argv.find((a) => a.startsWith(flag));
  if (!arg) return null;
  try {
    const parsed = JSON.parse(arg.slice(flag.length));
    if (!Array.isArray(parsed) || parsed.some((c) => typeof c !== 'string')) return null;
    return new Set(parsed);
  } catch {
    return null;
  }
}

const invokeOk = readChannelList('--raha-invoke=');
const eventOk = readChannelList('--raha-events=');
const versionArg = process.argv.find((a) => a.startsWith('--raha-version='));
const appVersion = versionArg ? versionArg.slice('--raha-version='.length) : 'dev';

if (!invokeOk || !eventOk) {
  // Fail closed: no bridge at all rather than an unchecked one.
  console.error('raha preload: channel allow-list missing from additionalArguments; bridge not exposed');
} else {
  contextBridge.exposeInMainWorld('raha', {
    /** App version for Settings → About. Static data, not a channel. */
    version: appVersion,
    /**
     * @param {string} channel
     * @param {unknown} [payload]
     * @returns {Promise<unknown>}
     */
    invoke(channel, payload) {
      const c = String(channel);
      if (!invokeOk.has(c)) {
        return Promise.reject(new Error(`raha: "${c}" is not an IPC contract channel`));
      }
      return ipcRenderer.invoke(c, payload);
    },
    /**
     * @param {string} channel
     * @param {(payload: unknown) => void} handler
     * @returns {() => void} unsubscribe
     */
    on(channel, handler) {
      const c = String(channel);
      if (!eventOk.has(c)) {
        console.error(`raha: refusing a listener on non-contract channel "${c}"`);
        return () => {};
      }
      /** @param {unknown} _e @param {unknown} payload */
      const wrapped = (_e, payload) => handler(payload);
      ipcRenderer.on(c, wrapped);
      return () => ipcRenderer.removeListener(c, wrapped);
    },
  });
}
