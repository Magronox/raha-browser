// Inline SVG icons — no icon font, no network, no dependency.
// All 16x16 viewBox, stroke = currentColor so CSS colors them.

const svg = (/** @type {string} */ inner, vb = '0 0 16 16') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  back: svg('<path d="M10 3L5 8l5 5"/>'),
  forward: svg('<path d="M6 3l5 5-5 5"/>'),
  reload: svg('<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3"/>'),
  stop: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  moon: svg('<path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7z"/>'),
  sun: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M4.5 11.5L3 13"/>'),
  pin: svg('<path d="M9.5 2.5l4 4-3 1-2.5 5-1.5-1.5L3 14l-1-1 2.5-3.5L3 8l5-2.5 1.5-3z"/>'),
  folder: svg('<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z"/>'),
  folderOpen: svg('<path d="M1.5 5.5v-1a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v1M1.5 6.5h12l-1.5 6h-10l-.5-6z"/>'),
  chevron: svg('<path d="M6 4l4 4-4 4"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>'),
  shield: svg('<path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4l5.5-2z"/>'),
  audio: svg('<path d="M2.5 6v4h2.5L9 13.5v-11L5 6H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>'),
  grid: svg('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
  sidebar: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  gauge: svg('<path d="M2 12a6 6 0 1 1 12 0"/><path d="M8 12l3-4"/>'),
  clock: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  sparkle: svg('<path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4L8 1.5z"/><path d="M12.7 10.3l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"/>'),
  bird: svg('<path d="M2 12c4 1 9 0 11-4l1.5-.5-1.5-1a4 4 0 0 0-7 1L2 12z"/><path d="M6 12.5c1 .8 3 .8 4 0"/>'),
};

/**
 * Fallback favicon: a letter chip. @param {string} title @returns {string} html
 */
export function letterChip(title) {
  const ch = (title || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="letterchip">${ch}</span>`;
}
