<div align="center">
  <img src="build/icon.png" width="96" alt="Raha icon">

# Raha

**A calm browser where you decide which tabs get your memory and CPU.**

Raha runs only as many tabs as you allow. The rest sleep and give their memory back.

<img src="docs/screenshots/grid.png" width="820" alt="Raha: folder grid with thumbnails, nested sidebar, live bar with per-tab memory badges">
</div>

The current version is 0.3.3, released 11 November 2026. It fixes privacy issues found in 0.3.1; the [advisory](https://github.com/Magronox/raha-browser/security/advisories) describes the two most serious. [Known issues](#known-issues-in-033) are listed below. Version 1.0 is being finished and has no date. This repository holds the 0.3.3 code.

*Raha (رها) is Persian for "free" or "released".*

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-4fd1b3)](LICENSE)

## What it does

- You set how many tabs may run; the default is six. The rest sleep. Raha closes a sleeping tab's process, so it uses no CPU and almost no memory, but it keeps its place, title, thumbnail and history. Click one and it loads again.
- The live bar at the bottom lists every running tab with the memory and CPU your system reports for it.
- Pin a tab to keep it running, give a site its own memory limit, or keep a whole site running with a rule. Tabs playing sound are left alone by default.
- Folders nest inside folders, show as a grid of thumbnails, and take tabs by drag and drop. When you reopen Raha, the whole tree is there, asleep.

Raha can also freeze a tab: it stops running but keeps its page exactly as it was. It has a command palette (⌘K or Ctrl+K) to find any tab or command, a downloads panel, local history, and a preview of a sleeping tab that does not wake it.

## How tabs are put to sleep

Five rules decide which tabs sleep, in this order.

1. **Per-tab memory limit.** A tab over its limit sleeps, even if pinned, because you set that limit yourself. The tab you are looking at stays awake, and Raha shows a warning.
2. **Idle timer** (off by default). A background tab idle for longer than you set goes to sleep.
3. **Tab cap.** Over the cap, the background tab used least recently sleeps first. Pinned tabs, tabs playing sound and the tab on screen are skipped.
4. **Memory budget** (off by default). If running tabs together use more than your budget, the least recently used sleep until they fit.
5. **Freeze** (after two minutes by default). A background tab idle that long is frozen: it keeps its memory and uses no CPU until you return. Pinned tabs, tabs playing sound and pages still loading are skipped.

These are defaults; each can be changed in Settings. The rules are in [`src/shared/policy.js`](src/shared/policy.js). When a tab sleeps, Raha closes its process and the memory goes back to your system ([why](docs/DECISIONS/ADR-0006-sleep-is-process-destruction.md)). Back and forward still work after it wakes.

## Privacy

Raha has no telemetry, analytics or crash reports. Your history and tabs stay on your computer.

Apart from the pages you open, Raha makes three kinds of request on its own:

- **Update check.** About 30 seconds after start and every four hours, Raha asks GitHub whether a new version exists. One check is a few requests to GitHub. They carry no cookies. Each sends the system language and an ID that is all zeros in every copy of Raha. On Windows, and on Linux with the AppImage, Raha then downloads a new version from GitHub in the background and installs it when you quit. On macOS it only says that one exists. Update checks are on by default; one switch turns them off.
- **Site icons.** Raha loads each tab's icon from that tab's site, even after a restart when every tab is asleep.
- **Dictionary.** On Windows and Linux, if spellcheck is set to Always, Chromium downloads a dictionary from Google.

| | |
|---|---|
| Ads and trackers | Known ads and trackers are blocked with EasyList and EasyPrivacy, through Ghostery's open-source engine. The lists ship inside the app and are not downloaded while it runs. Ads and trackers have separate switches. |
| Global Privacy Control | Raha asks every site not to sell or share your data, by sending `Sec-GPC: 1` and `DNT: 1` with each request a page makes. |
| Camera, microphone, location, notifications, clipboard | A site must ask in Raha's own prompt. You choose Allow once, Always allow, Never for this site, or Not now. Remembered answers can be removed in Settings. Full screen, locking the mouse pointer (as games do) and copying to the clipboard are allowed without a prompt. Other permission requests are refused, and Raha says so. |
| Search | DuckDuckGo by default; Brave, Startpage, Ecosia, Google, Bing or Kagi if you prefer. |
| New tab page | Built into the app. It loads nothing from the web. |
| Connections | A web address you type without `http://` opens over HTTPS. If that fails, the error page offers plain HTTP, used only if you click it. Links, redirects, `localhost` and IP addresses are not upgraded. |
| Isolation | Pages run in Chromium's sandbox with no access to Raha itself. A page can open only `http:`, `https:`, `raha:` and `blob:` addresses, so it cannot make Raha show a file from your disk or a page built from a `data:` address, a trick used for fake login pages. |
| Dependencies | Raha relies on two outside libraries, the updater and the ad-block engine, each fixed at an exact version. With the libraries those two need, 28 packages ship in the app; check with `npm ls --omit=dev --all`. |
| Switches | Everything above is a default. Ad blocking, tracker blocking, Global Privacy Control, HTTPS first, update checks and history each have a switch in Settings, and the shield in the address bar turns blocking off for one site. The sandbox and the limits on what a page may open cannot be turned off. |

Raha is built on Chromium, through Electron. The download is about 100–140 MB; installed, Raha takes about 300 MB. It has no Safe Browsing, so it does not warn about dangerous sites. There is no fingerprinting protection yet ([roadmap](docs/ROADMAP.md)).

In July 2026, before its first release (0.1.0), Raha was checked against Electron's security checklist by the project itself. The [report](docs/SECURITY-AUDIT-2026-07.md) lists the eight problems found; all were fixed in that release. Later reviews found the issues listed under Fixed in 0.3.3 and Known issues. [SECURITY.md](SECURITY.md) lists the risks that were accepted, such as tab thumbnails stored unencrypted on disk.

## Install

Download from **[Releases](../../releases)** or the [website](https://magronox.github.io/raha-browser/). GitHub shows a SHA-256 checksum next to each file.

- **macOS 13 or later**: a dmg, for Apple Silicon or Intel. It is not signed with a developer certificate, so macOS warns that it cannot check the app. On macOS 14 and earlier, right-click the app and choose Open, then Open. On macOS 15 and later, try to open it once, then open System Settings → Privacy & Security and click Open Anyway.
- **Windows**: an installer. It is not signed, so SmartScreen asks once (*More info → Run anyway*).
- **Linux**: AppImage or deb.

The first launch opens a one-minute tour (`raha://welcome`). The [User Guide](docs/USER_GUIDE.md) covers every setting, rule recipes, shortcuts and troubleshooting.

To run the code from source (Node 22 or later):

```bash
git clone https://github.com/Magronox/raha-browser
cd raha-browser
npm install
npm start
```

There is no build step: the code in `src/` is the code that runs ([ADR-0003](docs/DECISIONS/ADR-0003-no-build-step.md)).

## Keyboard shortcuts

| | macOS | Windows and Linux |
|---|---|---|
| New tab / close tab | ⌘T / ⌘W | Ctrl+T / Ctrl+W |
| Reopen closed tab | ⇧⌘T | Ctrl+Shift+T |
| Go to address | ⌘L | Ctrl+L |
| Find in page | ⌘F | Ctrl+F |
| Command palette | ⌘K | Ctrl+K |
| Grid / home | ⌘E | Ctrl+E |
| Sidebar | ⇧⌘B | Ctrl+Shift+B |
| Downloads | ⌘J | Ctrl+J |
| Sleep this tab / sleep every tab | ⇧⌘S / ⇧⌘A | Ctrl+Shift+S / Ctrl+Shift+A |
| Freeze this tab | ⇧⌘F | Ctrl+Shift+F |
| Pin (keep running) | ⇧⌘K | Ctrl+Shift+K |
| Next running tab / jump to one | Ctrl+Tab / ⌘1…9 | Ctrl+Tab / Ctrl+1…9 |
| Back / forward | ⌘[ / ⌘] | Alt+← / Alt+→ |
| History | ⌘Y | Ctrl+H |
| Settings | ⌘, | Ctrl+, |

## Known issues in 0.3.3

- Third-party cookies are not blocked: a frame from another site can set and read its own cookies.
- When Raha loads a site's icon, it may send that site's cookies.
- A typed address may count as the tab's site before its page has loaded, for permissions and for ad blocking.
- There is no Safe Browsing and no fingerprinting protection.
- On macOS, Raha tells you a new version exists but does not install it.
- The .deb may not update itself; install the new file by hand if it does not.
- Passkeys and USB security keys do not work.
- After a frozen tab resumes, live chats, calls, video and uploads may need a reload.
- When a page only checks a permission you have not decided, Raha answers "denied" where Chrome answers "prompt". If the page then requests it, you are asked as usual.
- After a restart, pages you reach with Back or Forward load fresh, without their scroll position or the text you had typed in them.
- The files are not signed, so macOS and Windows warn before the first launch (see Install).

## Fixed in 0.3.3

The [advisory](https://github.com/Magronox/raha-browser/security/advisories) describes the first two.

- **Client certificates.** When a site asked for a client certificate, 0.3.1 sent the first matching one on the computer without asking, and the site could read what it contains, often a name, email address and organisation. 0.3.3 sends none and says which site asked.
- **Install ID.** Each update check in 0.3.1 sent GitHub the same random ID, kept in a `.updaterId` file. 0.3.3 sends an all-zero ID, the same in every copy, and deletes the file.
- On Linux, and possibly Windows, 0.3.1 downloaded a spellcheck dictionary from Google at first start without being asked. 0.3.3 downloads none unless spellcheck is set to Always.
- With each tab's back and forward steps, 0.3.1 saved in `state.json` the text typed into forms on those pages, and any address that held a name and password. 0.3.3 keeps only each step's address and title, and cleans files saved by 0.3.1 at first start. Backups, and copies Raha set aside because it could not read a file, are not cleaned.
- If Raha could not read its tabs, settings or history file, the next save could write over it. The file is now copied aside first, and is left alone if the copy fails.
- Clear history, Delete folder and Clear site data acted at once. They now ask first and say what is lost.
- A frame from another site shared the page's notification and clipboard permission. It is now refused both.
- On macOS and Linux, other accounts on the computer could read Raha's profile files. Now only yours can.
- Chromium's advertising APIs (Topics, Protected Audience, Shared Storage, Attribution Reporting, Private State Tokens, fenced frames) were on. They are now off.
- The .deb did not start on a stock Ubuntu 24.04. It does now.
- Licence files are now included in the packages. Packages of 0.3.1 and earlier lacked Electron's and Chromium's licence files. They are in 0.3.3.
- A tab that slept after its save failed woke at the top of the page with its typed text gone. Now the last good save is kept.

The [CHANGELOG](CHANGELOG.md) lists every change.

## Version 1.0

Version 1.0 has a new design and further fixes. It will be free to use, and its licence terms will be published with it. Versions up to 0.3.3 stay GPL-3.0.

## Bugs and ideas

Report bugs and ideas through [Issues](https://github.com/Magronox/raha-browser/issues). Issues are public; send security problems through the [private form](https://github.com/Magronox/raha-browser/security/advisories/new) instead ([SECURITY.md](SECURITY.md)).

## How it was built

Raha is written with AI coding assistants, mainly Claude by Anthropic, which wrote most of the code and documentation. Amir Basareh decides what goes in, tests each release and is responsible for it. Automated tests and written rules are there to catch mistakes before a release.

## Working on the code

The code is laid out so a person or an AI agent can change it safely. The logic is separate from Electron and tested on its own, one file lists every message between the window and the engine, and tests enforce the rules.

- People: start with [CONTRIBUTING.md](CONTRIBUTING.md).
- AI agents: start with [CLAUDE.md](CLAUDE.md), which works for any agent. Step-by-step playbooks are in [docs/PLAYBOOKS/](docs/PLAYBOOKS/).
- Decisions are recorded in [ADRs](docs/DECISIONS/); the rules that must not break are in [INVARIANTS.md](docs/INVARIANTS.md).

```bash
npm run verify   # types, lint, unit tests, UI harness and end-to-end tests: the definition of done
```

## Licence and name

The code in this repository is open source under [GPL-3.0-only](LICENSE), © 2026 Amir Basareh. Anyone who distributes a changed version must offer its source under the same licence. The **Raha** name and bird mark are reserved ([TRADEMARK.md](TRADEMARK.md)). Why this combination: [ADR-0002](docs/DECISIONS/ADR-0002-gpl3-plus-trademark.md).

Raha includes Electron (MIT) and Chromium (BSD-style and other licences), Ghostery's ad-block engine (MPL-2.0), and the EasyList and EasyPrivacy lists by the EasyList authors (GPL-3.0 or CC BY-SA 3.0). The 0.3.3 packages carry these licences in `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `LICENSE.electron.txt` and `LICENSES.chromium.html`.
