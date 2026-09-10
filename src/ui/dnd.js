// HTML5 drag & drop for the sidebar tree and the grid.
// Semantics (kept intentionally simple and predictable):
//   - drop ON a folder row/card    -> move INTO that folder (append at end)
//   - drop on the upper half of any row -> insert BEFORE it (same parent)
//   - drop on the lower half of a TAB row -> insert AFTER it (same parent)
//   - drop on the bottom dropzone -> move to root, end of list
//   - drop on a breadcrumb link   -> move INTO that ancestor folder
//   - drop on the grid's card area -> move INTO the folder being viewed
// Sidebar and grid share one draggingId, so a card drags onto a sidebar row
// and a sidebar row drags onto the grid — that is how a tab leaves a folder.
// Illegal moves (folder into its own subtree) are refused by the engine;
// the UI never needs to duplicate that check.
import { api } from './api.js';
import { store } from './store.js';

/** @type {string|null} */ let draggingId = null;

/** The sidebar must never innerHTML-rebuild mid-drag — replacing the dragged
 * row aborts the browser's drag operation (this is what made "hold and move
 * a tab" feel impossible before render memoization; a mid-drag governor
 * change could still do it). Renderers check this and skip. */
export function isDragging() { return draggingId != null; }

/** @param {HTMLElement} root sidebar root */
export function wireDnd(root) {
  root.querySelectorAll('.row').forEach((el) => {
    const row = /** @type {HTMLElement} */ (el);
    if (row.classList.contains('rootrow')) return wireRootRow(row);

    row.addEventListener('dragstart', (e) => {
      draggingId = /** @type {string} */ (row.dataset.id);
      const de = /** @type {DragEvent} */ (e);
      de.dataTransfer?.setData('text/plain', draggingId);
      if (de.dataTransfer) de.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      draggingId = null;
      row.classList.remove('dragging');
      clearMarks(root);
      // A snapshot may have been skipped while the drag was in flight —
      // nudge a render now (no-op patch just notifies subscribers).
      store.setLocal({});
    });
    row.addEventListener('dragover', (e) => {
      if (!draggingId || draggingId === row.dataset.id) return;
      e.preventDefault();
      const zone = zoneOf(row, /** @type {DragEvent} */ (e));
      clearMarks(root);
      row.classList.add(zone === 'into' ? 'drop-into' : zone === 'before' ? 'drop-before' : 'drop-after');
    });
    row.addEventListener('dragleave', () => clearMarks(root));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      clearMarks(root);
      if (!draggingId || draggingId === row.dataset.id) return;
      const targetId = /** @type {string} */ (row.dataset.id);
      const zone = zoneOf(row, /** @type {DragEvent} */ (e));
      if (zone === 'into') {
        void api.nodeMove(draggingId, targetId); // append into folder
      } else {
        const parent = parentOf(targetId);
        if (!parent) return;
        const idx = parent.childIds.indexOf(targetId);
        void api.nodeMove(draggingId, parent.id, zone === 'before' ? idx : idx + 1);
      }
      draggingId = null;
    });
  });

  const rootZone = /** @type {HTMLElement|null} */ (root.querySelector('[data-dropzone="root"]'));
  if (rootZone) {
    rootZone.addEventListener('dragover', (e) => { if (draggingId) e.preventDefault(); });
    rootZone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (draggingId && store.snap) void api.nodeMove(draggingId, store.snap.rootId);
      draggingId = null;
    });
  }
}

/** Root row accepts "into" drops only. @param {HTMLElement} row */
function wireRootRow(row) {
  row.addEventListener('dragover', (e) => { if (draggingId) { e.preventDefault(); row.classList.add('drop-into'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-into');
    if (draggingId && store.snap) void api.nodeMove(draggingId, store.snap.rootId);
    draggingId = null;
  });
}

/**
 * Wire the grid region. Cards are drag sources; folder cards, breadcrumb
 * links, and the card area itself are drop targets.
 * @param {HTMLElement} root grid root
 * @param {string} viewedFolderId folder the grid is showing — an area drop moves here
 */
export function wireGridDnd(root, viewedFolderId) {
  root.querySelectorAll('.card').forEach((el) => {
    const card = /** @type {HTMLElement} */ (el);
    const id = card.dataset.opentab ?? card.dataset.openfolder;
    if (!id) return;
    card.addEventListener('dragstart', (e) => {
      draggingId = id;
      const de = /** @type {DragEvent} */ (e);
      de.dataTransfer?.setData('text/plain', id);
      if (de.dataTransfer) de.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      draggingId = null;
      card.classList.remove('dragging');
      clearGridMarks(root);
      store.setLocal({}); // render whatever snapshots were skipped mid-drag
    });
    if (card.dataset.openfolder) {
      // Folder card = drop INTO that folder. stopPropagation keeps the card
      // area's own "into viewed folder" affordance from double-highlighting.
      card.addEventListener('dragover', (e) => {
        if (!draggingId || draggingId === id) return;
        e.preventDefault();
        e.stopPropagation();
        clearGridMarks(root);
        card.classList.add('drop-into');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop-into'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearGridMarks(root);
        if (!draggingId || draggingId === id) return;
        void api.nodeMove(draggingId, id);
        draggingId = null;
      });
    }
  });

  // Breadcrumb links (ancestors of the viewed folder): the classic
  // "drag it out of this folder" gesture.
  root.querySelectorAll('[data-crumb]').forEach((el) => {
    const crumb = /** @type {HTMLElement} */ (el);
    const folderId = /** @type {string} */ (crumb.dataset.crumb);
    crumb.addEventListener('dragover', (e) => {
      if (!draggingId) return;
      e.preventDefault();
      clearGridMarks(root);
      crumb.classList.add('drop-into');
    });
    crumb.addEventListener('dragleave', () => crumb.classList.remove('drop-into'));
    crumb.addEventListener('drop', (e) => {
      e.preventDefault();
      clearGridMarks(root);
      if (!draggingId) return;
      void api.nodeMove(draggingId, folderId);
      draggingId = null;
    });
  });

  // The card area: dropping on the background (or on a plain tab card, which
  // bubbles here) moves the node into the folder being viewed.
  const cards = /** @type {HTMLElement|null} */ (root.querySelector('.cards'));
  if (cards) {
    cards.addEventListener('dragover', (e) => {
      if (!draggingId) return;
      e.preventDefault();
      cards.classList.add('drop-target');
    });
    cards.addEventListener('dragleave', (e) => {
      // dragleave also fires when moving onto a child; only a true exit clears.
      const to = /** @type {Node|null} */ (/** @type {DragEvent} */ (e).relatedTarget);
      if (!to || !cards.contains(to)) cards.classList.remove('drop-target');
    });
    cards.addEventListener('drop', (e) => {
      e.preventDefault();
      clearGridMarks(root);
      if (!draggingId) return;
      void api.nodeMove(draggingId, viewedFolderId);
      draggingId = null;
    });
  }
}

function clearGridMarks(/** @type {HTMLElement} */ root) {
  root.querySelectorAll('.drop-into').forEach((el) => el.classList.remove('drop-into'));
  root.querySelector('.cards')?.classList.remove('drop-target');
}

/**
 * @param {HTMLElement} row @param {DragEvent} e
 * @returns {'into'|'before'|'after'}
 */
function zoneOf(row, e) {
  const rect = row.getBoundingClientRect();
  const frac = (e.clientY - rect.top) / rect.height;
  if (row.dataset.kind === 'folder') {
    return frac < 0.25 ? 'before' : 'into'; // most of a folder row = into
  }
  return frac < 0.5 ? 'before' : 'after';
}

/** @param {string} nodeId @returns {import('../shared/ipc-contract.js').SnapshotFolder|null} */
function parentOf(nodeId) {
  const snap = store.snap;
  if (!snap) return null;
  return snap.folders.find((f) => f.childIds.includes(nodeId)) ?? null;
}

function clearMarks(/** @type {HTMLElement} */ root) {
  root.querySelectorAll('.drop-into,.drop-before,.drop-after').forEach((el) =>
    el.classList.remove('drop-into', 'drop-before', 'drop-after'));
}
