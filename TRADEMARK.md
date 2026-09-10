# Trademark notice

The name **"Raha"**, the phrase **"Raha Browser"**, and the Raha bird mark
(`build/icon.svg` / `build/icon.png`) identify the official project
maintained by Amir Basareh. All rights in these identifiers are reserved.

The GPL-3.0 license covers the **code**. It does not grant any right to use
the Raha name or logo (see GPLv3 section 7(e), under which no trademark
rights are granted).

You are encouraged to:
- fork, modify, and redistribute the code under GPL-3.0;
- state truthfully that your project is "based on Raha".

You may not, without written permission:
- distribute modified versions under the name "Raha" or with the Raha logo;
- use the name or logo in a way that suggests official status or endorsement.

If you fork: pick your own name and icon (change `productName`/`appId` in
package.json + electron-builder.yml, replace `build/icon.*`, and update the
UI brand strings in `src/ui/render/sidebar.js` and window title). That's the
whole rebrand surface, by design.

This is the same convention used by Firefox and Rust: open code, protected
identity — so users always know what the official Raha is.
