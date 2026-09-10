// Window layout constants shared by the main process (positions the content
// WebContentsView) and the UI (sizes the chrome regions in CSS-independent
// logic). Change here and both sides stay in sync; the UI also mirrors these
// as CSS custom properties set from JS at boot.

export const SIDEBAR_WIDTH = 264;
export const TOPBAR_HEIGHT = 48;
export const LIVEBAR_HEIGHT = 40;

/**
 * Rectangle for the web-content view inside the window.
 * @param {{ width: number, height: number }} contentBounds window client size
 * @param {{ sidebarVisible?: boolean }} [opts] sidebar toggled off = content takes its space
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function contentRect(contentBounds, opts = {}) {
  const sidebar = opts.sidebarVisible === false ? 0 : SIDEBAR_WIDTH;
  return {
    x: sidebar,
    y: TOPBAR_HEIGHT,
    width: Math.max(0, contentBounds.width - sidebar),
    height: Math.max(0, contentBounds.height - TOPBAR_HEIGHT - LIVEBAR_HEIGHT),
  };
}
