# The Raha User Guide

Everything about using Raha, in one place. (Developers: you want
[CLAUDE.md](../CLAUDE.md) and [ARCHITECTURE.md](ARCHITECTURE.md) instead.)

On macOS read `Ctrl` as `⌘` throughout — the app itself always shows the
right key for your platform.

## 1. Install

**From a release** (recommended): grab the file for your OS from the
project's Releases page.

- **macOS**: open the `.dmg`, drag Raha to Applications. v0.1 is unsigned, so
  the FIRST launch needs: right-click the app → **Open** → **Open** (once;
  after that it opens normally). This is Apple's Gatekeeper, not an error.
- **Windows**: run the installer. SmartScreen may warn about an unknown
  publisher (unsigned v0.1): **More info → Run anyway**.
- **Linux**: `chmod +x Raha*.AppImage && ./Raha*.AppImage`, or install the
  `.deb` with `sudo apt install ./raha*.deb`.

**From source** (needs [Node.js](https://nodejs.org) 22+):

```bash
git clone <repo-url> && cd raha-browser
npm install
npm start
```

The `npm install` above downloads Electron once (~100 MB; it is a devDependency); every launch
after that takes a second or two.

**Make Raha your default browser** — the first packaged launch asks once,
inside Raha; nothing happens unless you say yes (macOS then double-checks
with its own dialog). Later: Settings → *Use Raha as my default browser*.
Links from Mail, Slack, etc. then open as Raha tabs.

## 2. Your first five minutes

First launch opens the **welcome tour** (get it back anytime: type
`raha://welcome` in the address bar) and a **"Try these"** folder with a few
example tabs — asleep, costing zero memory, loading nothing until you click.

1. **Go somewhere.** `Ctrl+L`, type `wikipedia.org` or any search, `Enter`.
2. **Watch the bottom strip** — the **live bar**. Every running tab appears
   there with its real memory (MB) and CPU. This is the honest meter.
3. **Open five more tabs.** When you pass the cap (6 by default), the tab you
   touched longest ago quietly goes to sleep — a toast tells you why.
4. **Click a sleeping card** (grid) or row (sidebar) — it wakes exactly where
   it was, back/forward history intact.
5. **Quit and reopen.** Everything is back — asleep. Start-up is instant and
   your memory graph is flat until *you* wake something.

## 3. The concepts

| Word | Meaning |
|---|---|
| **Running** | Has a live Chromium process right now (shown in the live bar) |
| **Active** | The one running tab currently on screen |
| **Asleep** | No process at all — 0 MB, 0 CPU. Keeps URL, title, history, thumbnail, place in your folders |
| **Pinned / keep-alive** | Never auto-slept (amber pin icon) |
| **Rule** | A domain pattern that pins or limits every matching tab |
| **The governor** | The logic deciding who sleeps, in this order: per-tab memory limit → idle timer → live-tab cap (least-recently-used first) → global budget |

Protections, always on: the **active tab** is never auto-slept (you get a
warning if it breaks its own limit), and tabs **playing sound** are skipped
by the cap/idle/budget rules (turn off in Settings if you want).

## 4. Everyday moves

**Sleep something now** — hover it (live-bar chip, sidebar row, or grid card)
and hit the moon. Whole folder: right-click → *Sleep all tabs inside*.
Everything: `Ctrl+Shift+A`.

**Keep something alive** — the pin icon in the toolbar, `Ctrl+Shift+K`, or
right-click → *Keep alive*. Pinned tabs survive the cap, idle, and budget —
only their own per-tab limit can sleep them.

**Cap a memory hog** — gauge icon in the toolbar (or right-click → *Set
memory limit…*). If the tab exceeds it, it sleeps — even pinned. If it's the
active tab you get a warning instead.

**Organize** — `+ folder` in the sidebar; drag rows to move (drop *on* a
folder = into it, drop *between* rows = reorder); folders nest without limit.
Grid cards drag too: drop one on a folder card or a sidebar row to file it,
or on a breadcrumb to move it up and out of the folder. Dropping anything on
the grid's background moves it into the folder you are viewing — so to pull a
tab out of a folder, drag it onto the "All tabs" grid, row, or breadcrumb.
Click a folder name to see its tabs as thumbnail cards; `Ctrl+E` returns to
the grid from any page.

**Let Raha organize for you** — the sparkle button in the sidebar header
looks at your *loose* tabs (the ones sitting directly under "All tabs"),
groups them by site category (Dev, Video, Social, …) or shared domain, and
shows you the plan before touching anything. Folders you made yourself are
never rearranged, nothing is dumped into a "Misc", and applying never wakes
a sleeping tab. One tab that fits no group just stays where it is.

**The address bar goes where you are.** Type an address or a search and
press `Enter`: it opens **in the tab you're looking at** — never a surprise
new tab. Under the bar, above the suggestions, Raha shows what Enter will do
and the alternatives: *Open here* (the default), *Switch to open tab* when
another tab already has that page (jump to it instead of opening a copy), and
*Open in new tab → folder*, which names the folder the new tab would land in
— `Ctrl+Enter` takes that one without arrowing down. On the grid, where no tab
is showing, the new-tab row is the default and names the folder you're
viewing.

**…and it suggests as you type** — your open tabs first ("switch to tab"),
then pages you've visited, ranked by how often and how recently. Arrows move,
Enter goes, Tab fills the box, Esc dismisses. Suggestions are matched against
a file on this computer —
your keystrokes are never sent to a suggestion service, unlike mainstream
browsers. Raha remembers its own visits to make this work; turn that off in
Settings → Privacy ("Remember pages I visit"), and clear everything recorded
from the History panel. Pages like `raha://home` are never recorded.

**Bring your history along** — the clock button in the toolbar opens
History. *Import from another browser* lists the Chrome-, Firefox- and
Safari-family profiles found on your machine (Chrome, Chromium, Brave, Edge,
Vivaldi, Opera, Opera GX, Arc, Firefox, Zen, Safari — the exact list depends
on your OS; Arc and Safari are macOS-only); tick the ones you want and import.
History only — passwords, cookies and payment data are never read, and the
other browser's files are never modified (Raha reads a temporary copy).
Search the imported history and click any entry to open it as a tab.
macOS note: Safari's history is Full-Disk-Access protected. You do NOT need
to grant that: in Finder press Shift-Cmd-G, go to `~/Library/Safari`, copy
`History.db` to your Desktop, then click *From a file…* in the History panel
and pick the copy (the picker also accepts a copied Chrome `History` or
Firefox `places.sqlite`). Granting Raha Full Disk Access works too.

**Bring your open tabs along** — the same panel's *Open tabs & windows*
section copies another browser's current windows into Raha: one new folder
per import, a subfolder per window, and every tab arrives **asleep** (title
+ address only — nothing loads until you click it, so importing 200 tabs
costs nothing). For a running browser (Safari, Chrome, Brave, Edge, Vivaldi,
Opera, Arc — macOS), the system asks once to let Raha read that browser's
tabs — that is the small "Automation" permission, not Full Disk Access.
Firefox and Zen are read from their session file directly, running or not.

**Right-click works like a browser** — links (open in new tab / copy),
images, selected text (copy / search with your search engine), Back /
Forward / Reload, and normal cut-copy-paste in text fields, including the
address bar.

**Links that open apps ask first** — click a Zoom, Teams, Slack, `mailto:`
or `tel:` link and Raha shows you which app it belongs to and the full
address, with *Open* and *Cancel*. Nothing leaves the browser until you say
yes. Tick *always allow* and that kind of link opens without asking from
then on — undo it any time in Settings ("App links opened without asking").
A few schemes known to be attack vectors (`file:`, `javascript:`, certain
Windows handlers) are always refused and never offered.

**Sites ask before they use your camera, microphone, location,
notifications, or clipboard** — the ask is Raha's own, in the chrome, and
it names the site and the need ("meet.example wants to use your camera and
microphone"). Nothing is granted silently, and you are never shown a dialog
about a page you can't see: a background tab's request waits until you
switch to it. Your four answers:

- *Allow once* — for this visit; leaving the page (or the tab sleeping or
  closing) ends it. Nothing is remembered.
- *Always allow* — remembered for the site; it won't ask again.
- *Never for this site* — remembered; the site is refused, silently, from
  then on.
- *Not now* (also Escape, or clicking outside) — refused this time only;
  the site may ask again.

Change your mind in Settings → *Site permissions*: one row per site, a chip
per remembered decision, click × to be asked again (or *Forget site*). A
site you have never decided on reads as *blocked* to a site that merely
probes what it could ask for (`navigator.permissions.query`,
`Notification.permission` say "denied" where Chrome would say "prompt") —
it is asked the moment it actually requests. Screen sharing is not offered
yet (it is refused; see the roadmap).

**Runaway tabs get caught** — if a tab burns extreme CPU for ~10 seconds
straight or balloons past ~2 GB, Raha asks whether to terminate it. One
click kills the process immediately; the page, its history and its place in
your sidebar survive, asleep. "Not now" keeps quiet about that tab for five
minutes. Tabs playing audio are exempt from the CPU check while *Never
auto-sleep audio* is on, so calls and music don't nag.

**Rules (the programmable part)** — Settings → *Domain rules*:

| Pattern | Effect |
|---|---|
| `*.music.youtube.com` + keep alive | music never stops |
| `*.slack.com` + 800 MB | Slack lives, but on a diet |
| `mail.example.com` + keep alive | your webmail stays hot |

`site.com` matches exactly; `*.site.com` matches the site and all
subdomains. First matching rule wins. A tab pinned by rule shows a faded pin.

## 5. Settings reference (`Ctrl+,`)

- **Max live tabs** (default 6) — the cap. Live bar shows `used/cap`.
- **Total memory budget** (off) — a ceiling for all running tabs combined.
- **Sleep background tabs after** (off) — idle timer per tab.
- **Never auto-sleep audio** (on) — the music protection.
- **Warn on runaway tabs** (on) — the terminate-this-tab prompt when CPU or
  memory use explodes (sustained, never on a momentary spike).
- **Block ads** (on) — requests matching the bundled EasyList are dropped.
  Network-level only, so a page may show an empty box where an ad was.
- **Block trackers** (on) — same, with the bundled EasyPrivacy list; the
  shield counter in the address bar counts blocked requests per tab.
  The lists ship inside the app and update with each Raha release — they are
  never downloaded at runtime. Click the shield to turn blocking off (or
  back on) for just the current site.
- **Global Privacy Control** (on) — sends `Sec-GPC: 1` + `DNT: 1`.
- **HTTPS first** (on) — typed addresses try HTTPS; failures offer an
  explicit, clearly-labeled HTTP retry.
- **Search engine** — DuckDuckGo (default), Brave, Startpage, Ecosia, Google.
- **App links opened without asking** — appears once you've ticked *always
  allow* on an app-link prompt (Zoom, Teams, …): one chip per link kind,
  click the × to make Raha ask again.
- **Site permissions** — every *Always allow* / *Never for this site* you
  have given (camera, microphone, location, notifications, clipboard), one
  row per site; × on a chip or *Forget site* makes Raha ask again. *Allow
  once* and *Not now* never appear here — they are not remembered.

## 6. Privacy, plainly

Raha sends **no telemetry, ever**. The only network request Raha makes on
its own is a security-update check against GitHub Releases (Settings →
Privacy → "Install security updates automatically" — on by default because
an unpatched browser is the bigger privacy risk; turn it off and Raha is
fully silent). Everything else on the wire is the pages you open (plus
their favicons). The ad/tracker filter lists are bundled with the app and
update only with app releases — never downloaded at runtime.
The new-tab page, welcome tour, and error pages are local files. Permission
requests (camera, microphone, location, notifications, clipboard) are asked
about per site in Raha's own prompt — never granted silently, never a
surprise system dialog (§4, "Sites ask before…"); anything else a page asks
for (screen sharing, MIDI, …) is refused and you're told once. Your data
lives in one folder on YOUR disk:

- macOS: `~/Library/Application Support/Raha/profile/`
- Linux: `~/.config/Raha/profile/`
- Windows: `%APPDATA%/Raha/profile/`

(The directory is named after `productName` — **Raha**, capitalised — not the
npm package name. Verified against a real profile on macOS.)

Back it up by copying the folder; reset Raha by deleting it (cookies/logins
are Chromium's session data alongside it).

## 7. Shortcuts

| Action | Windows/Linux | macOS |
|---|---|---|
| Address bar | `Ctrl+L` | `⌘L` |
| Open the address bar text in a new tab (Enter alone opens it here) | `Ctrl+Enter` | `⌘Enter` |
| Find in page (Enter next, Shift+Enter previous, Esc closes) | `Ctrl+F` | `⌘F` |
| New tab (grid + address bar) | `Ctrl+T` | `⌘T` |
| Close tab (on the grid: back to your last running tab) | `Ctrl+W` | `⌘W` |
| Reopen closed tab | `Ctrl+Shift+T` | `⌘⇧T` |
| Grid / home | `Ctrl+E` | `⌘E` |
| Toggle sidebar | `Ctrl+Shift+B` | `⌘⇧B` |
| History | `Ctrl+H` | `⌘Y` |
| Hard reload (ignore cache) | `Ctrl+Shift+R` | `⌘⇧R` |
| Cycle running tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` | same |
| Jump to Nth running tab (9 = last) | `Ctrl+1…9` | `⌘1…9` |
| Sleep this tab | `Ctrl+Shift+S` | `⌘⇧S` |
| Sleep all tabs | `Ctrl+Shift+A` | `⌘⇧A` |
| Pin (keep alive) | `Ctrl+Shift+K` | `⌘⇧K` |
| Reload / Back / Forward | `Ctrl+R` / `Alt+←` / `Alt+→` | `⌘R` / `⌥←` / `⌥→` (also `⌘[` / `⌘]`) |
| Zoom | `Ctrl` `+` `-` `0` | `⌘` `+` `-` `0` |
| Settings | `Ctrl+,` | `⌘,` |
| DevTools for the page | `F12` | `F12` |
| Minimize window | — | `⌘M` |

## 8. Troubleshooting

**The window is mostly empty on launch.** That's a cold start working as
designed: every tab is asleep, nothing is spending memory. Click any card to
wake it. (First-ever launch shows the welcome tour instead.)

**A tab went to sleep while I was using another one.** The toast says which
rule did it (cap, idle, limit, budget). Raise the cap in Settings, or pin
the tabs that must never sleep.

**"3/2 live" — more running than my cap?** Your cap can be exceeded only by
protected tabs: the active one, pins, and audio. The counter turns amber to
tell you the cap is unsatisfiable, not broken.

**A memory badge has a `*`.** Chromium sometimes hosts two same-site tabs in
one process; both show the full process memory with a `*`. Sleeping one may
not free memory until both sleep.

**A site misbehaves with blocking on.** Click the shield in the address bar
to turn blocking off for that site (the tab reloads automatically; click
again to re-enable) — and please open an issue naming the site.

**A site loops on "verify you are not a robot" or a consent wall.** Raha
used to disagree with itself about what browser it is — the request
headers, the page script's view and embedded frames each said something
different, which is exactly what such checks score. Raha now presents one
Chrome identity in all three places, and tests pin that against the real
wire; whether a particular challenge then passes is verified per release
(the release playbook has a live check), so it is not promised here. If a
site loops, its cookies are usually wedged: right-click the page → *Clear
Cookies & Data for This Site* — it clears that site (subdomains, its
embedded third-party jar, and what the site asked Raha to remember about
itself included) and reloads fresh. Nuclear option: Settings → *Clear all cookies
& site data…* (signs you out everywhere).

**Something crashed.** A crashed tab flips to asleep with a warning toast —
click to reload it. If the whole app misbehaves, run it from a terminal
(`npm start` from source) and include the `[raha:…]` lines in your issue.

**Start truly fresh:** quit Raha, delete the profile folder from §6, relaunch
— you'll get the welcome tour again.
