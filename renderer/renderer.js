import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { DocumentStore } from '../src/model/store.mjs';
import { createDocumentFromFile } from '../src/model/create-document-from-file.mjs';
import { createIcon } from './icons.mjs';
import { createTranslator, matchLocale, LOCALES } from '../src/i18n.mjs';
import { ACKNOWLEDGMENTS } from '../src/acknowledgments.mjs';
import { GRID_COLUMNS_OPTIONS } from '../src/settings.mjs';

// Reassigned once at startup (see the init block at the bottom of this file)
// and again by switchLocale() whenever the user picks a different language
// in the Options dialog — every call site just calls the current `t`, no
// extra plumbing needed to react to a language change.
let t = createTranslator('en');
// Tracked alongside `t` (reassigned at the same two call sites: the init
// block at the bottom of this file, and switchLocale()) so
// applyStaticTranslations() can keep `<html lang>` in sync without needing
// the active locale threaded through as a parameter.
let currentLocale = 'en';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).href;

const store = new DocumentStore();

// Each opened file is parsed with pdf.js only once; the resulting
// PDFDocumentProxy is reused via the PdfSource id (not the Document id —
// the model already allows several Documents to share one PdfSource once
// pages move across documents).
//
// Deliberately never pruned/`.destroy()`-ed when a document is removed:
// undo can resurrect a closed document's pages via the store's own
// `_sourceRegistry` (see store.mjs), which needs the matching PdfSource's
// proxy to still be renderable. This does mean a very long session that
// opens and closes many large PDFs grows this map (and the underlying
// pdf.js worker memory) monotonically — an accepted tradeoff for a
// desktop app that's realistically restarted often, not a leak nobody
// noticed.
const pdfProxies = new Map();

// Intrinsic size of every page of an opened file, in PDF points, at scale 1
// and rotation 0 — keyed by PdfSource id, same as `pdfProxies` above, and
// likewise never pruned (undo can resurrect a closed document's pages).
//
// Deliberately a renderer-side side table rather than a field on PdfSource:
// the model is kept free of any PDF-library-specific data on purpose (see
// the comment in src/model/pdf-source.mjs explaining why even `pageCount`
// is passed in from outside), and nothing in src/model/ ever reads these.
// Keying on the source id also means the sizes survive undo/redo for free —
// snapshots only store `sourceId`/`sourcePageIndex` (see store.mjs).
const pdfPageSizes = new Map(); // source.id -> [{ width, height }, ...]

// How many pages to measure per await. `getPage()` is cheap in time
// (~0.13ms/page measured), but each call permanently materializes a
// PDFPageProxy plus its parsed page dictionary in pdf.js's worker cache —
// which is exactly what the virtualization below tries to avoid doing for
// every page up front. Chunking keeps a pathological file (tens of
// thousands of pages) from queueing every worker message in one tick.
const PAGE_SIZE_MEASURE_CHUNK = 200;

// Measures every page of a freshly opened document.
//
// `rotation: 0` is passed explicitly and is load-bearing, not decoration:
// pdf.js defaults this argument to the page's own intrinsic /Rotate, but
// this app ignores intrinsic rotation entirely — computeCanvas() renders
// with `rotation: page.rotation`, i.e. the editor's rotation as an ABSOLUTE
// value (see the matching note in main/pdf-writer.mjs). Measuring without
// this argument would report swapped dimensions for any page whose file
// declares a /Rotate, and the derived cell size would be wrong for exactly
// those pages.
async function readPageSizes(pdf) {
  const sizes = [];
  for (let first = 1; first <= pdf.numPages; first += PAGE_SIZE_MEASURE_CHUNK) {
    const last = Math.min(first + PAGE_SIZE_MEASURE_CHUNK - 1, pdf.numPages);
    const chunk = [];
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      chunk.push(
        pdf.getPage(pageNumber).then((page) => {
          const { width, height } = page.getViewport({ scale: 1, rotation: 0 });
          return { width, height };
        }),
      );
    }
    sizes.push(...(await Promise.all(chunk)));
  }
  return sizes;
}

let currentView = 'canvas'; // 'canvas' | 'grid'

// --- Canvas virtualization ---------------------------------------------
// Only pages that are (approximately) within the visible area are actually
// rasterized with pdf.js. Every page first gets just an empty, fixed-size
// placeholder slot (cheap, even by the hundreds); an IntersectionObserver
// reports when a slot scrolls near the visible area, and only then is the
// actual render enqueued into a concurrency-limited queue. Once rendered, a
// page stays rendered (no eviction on scrolling back out) — for the target
// size named in the concept (several documents with 50+ pages each), this
// is enough to avoid the actual performance problem (rasterizing every page
// of every document up front); real memory eviction would only be needed
// for much larger documents and is deliberately not built here.
const RENDER_CONCURRENCY = 2;

class RenderQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.pending = [];
    this.active = 0;
  }

  add(task) {
    this.pending.push(task);
    this._drain();
  }

  _drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      this.active += 1;
      task().finally(() => {
        this.active -= 1;
        this._drain();
      });
    }
  }
}

const renderQueue = new RenderQueue(RENDER_CONCURRENCY);
const pendingRenders = new WeakMap(); // page-slot element -> render task
let activeObserver = null;

function createViewObserver(root) {
  if (activeObserver) {
    activeObserver.disconnect();
  }
  activeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const task = pendingRenders.get(entry.target);
        if (!task) continue;
        pendingRenders.delete(entry.target);
        activeObserver.unobserve(entry.target);
        renderQueue.add(task);
      }
    },
    { root, rootMargin: '200px', threshold: 0.01 },
  );
  return activeObserver;
}

const emptyState = document.getElementById('empty-state');
const canvasView = document.getElementById('canvas-view');
const canvasZoomWrapper = document.getElementById('canvas-zoom-wrapper');
const gridView = document.getElementById('grid-view');
const gridZoomWrapper = document.getElementById('grid-zoom-wrapper');
const openButton = document.getElementById('open-button');
const saveAllButton = document.getElementById('save-all-button');
const emptyOpenButton = document.getElementById('empty-open-button');
const canvasViewButton = document.getElementById('canvas-view-button');
const gridViewButton = document.getElementById('grid-view-button');
const gridColumnsLabel = document.getElementById('grid-columns-label');
const gridColumnsSelect = document.getElementById('grid-columns-select');
const shortcutsButton = document.getElementById('shortcuts-button');
const optionsButton = document.getElementById('options-button');
const duplicateButton = document.getElementById('duplicate-button');
const rotateLeftButton = document.getElementById('rotate-left-button');
const rotateRightButton = document.getElementById('rotate-right-button');
const deleteButton = document.getElementById('delete-button');
const emptyStateIconSlot = document.getElementById('empty-state-icon-slot');
const toast = document.getElementById('toast');

// --- Icons (Tabler Icons, see src/icons.mjs) --------------------------------
// Inserted before the respective text node (icon+text buttons like
// "Open…"), or as the only content for icon-only buttons. Central stroke
// width/color come from CSS (`--icon-stroke-width`/`--icon-color`, see
// index.html); `createIcon(name, { color })` overrides the color only for
// that one instance — used here for the delete icon (a warning color for a
// destructive action, a meaningful use case for the per-icon override
// rather than a purely demonstrative example).
openButton.prepend(createIcon('folder-open'));
saveAllButton.prepend(createIcon('device-floppy'));
canvasViewButton.prepend(createIcon('layout-columns'));
gridViewButton.prepend(createIcon('layout-grid'));
shortcutsButton.appendChild(createIcon('keyboard'));
optionsButton.appendChild(createIcon('settings'));
duplicateButton.appendChild(createIcon('copy'));
rotateLeftButton.appendChild(createIcon('rotate'));
rotateRightButton.appendChild(createIcon('rotate-clockwise'));
deleteButton.appendChild(createIcon('trash', { color: '#e05252' }));
const emptyStateIcon = createIcon('file', { size: 48 });
emptyStateIcon.classList.add('empty-state-icon');
emptyStateIconSlot.appendChild(emptyStateIcon);

// Act on the current page selection, same as the identically named keyboard
// shortcuts/context menu (see applyPageAction) — deliberately an additional
// entry point, not a replacement (see comment there). disabled/enabled is
// maintained by updateSelectionVisuals().
duplicateButton.addEventListener('click', () => applyPageAction('duplicate', [...selectedPageIds]));
rotateLeftButton.addEventListener('click', () => applyPageAction('rotate-left', [...selectedPageIds]));
rotateRightButton.addEventListener('click', () => applyPageAction('rotate-right', [...selectedPageIds]));
deleteButton.addEventListener('click', () => applyPageAction('delete', [...selectedPageIds]));

// Global setting (applies to all open documents at once):
// 'all' stands for "--" (whole document in one row).
let gridColumnsPerRow = 8;

function log(message) {
  window.api.log('info', message);
}

// A safety net for the several intentionally-fire-and-forget async calls in
// this file (context-menu save/close, the toolbar save-all/header
// save/close buttons, the external-file drop handler) — none of them are
// awaited by their caller, so a rejection among them would previously
// vanish silently instead of surfacing anywhere. This doesn't fix any one
// of them individually, but turns "nobody ever finds out" into at least a
// logged message.
window.addEventListener('unhandledrejection', (event) => {
  log(`Unhandled promise rejection: ${event.reason}`);
});

// Shared by syncDirtyDot() and renderActiveView() — previously each set only
// `saveAllButton.disabled`, never `.title`, so the tooltip stayed stuck on
// its static "No unsaved changes" text (from index.html's data-i18n-title)
// forever, even once something became dirty. Centralizing both the disabled
// state and the title here means there's only one place to keep in sync
// instead of two.
function updateSaveAllButtonState() {
  const hasDirty = store.documents.some((doc) => doc.dirty);
  saveAllButton.disabled = !hasDirty;
  saveAllButton.title = hasDirty ? t('toolbar.saveAllTitle') : t('toolbar.saveAllTitleDisabled');
}

let toastTimer = null;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  // Without clearing a still-pending previous timer, two toasts within
  // 2.5s of each other meant the first toast's timer fired mid-way through
  // the second toast's display and hid it early.
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// Applies the current `t` to every statically marked-up element
// (`data-i18n`/`data-i18n-title`/`data-i18n-aria-label` attributes in
// index.html) — covers all the toolbar/empty-state text that never changes
// shape at runtime. Dynamic content built via `document.createElement`
// (toasts, dialogs, the SHORTCUTS list) instead calls `t()` directly at its
// own build site, since there's no persistent DOM node to re-walk for those
// between renders.
function applyStaticTranslations() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    // A `data-i18n` element that already has an element child (as opposed to
    // plain text) is almost always a button with a prepended icon SVG —
    // `el.textContent = ...` would silently wipe that child out from under
    // it. This exact bug shipped once already; this guard
    // turns a future recurrence into a console warning instead of a missing
    // icon nobody notices.
    if (el.firstElementChild) {
      console.warn('[i18n] data-i18n on an element with element children, skipping:', el);
      continue;
    }
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
  document.documentElement.lang = currentLocale;
}

function getActiveContainer() {
  return currentView === 'canvas' ? canvasView : gridView;
}

// --- Zoom, pan, focus mode (zoom and focus mode work in both
// views; pan is Canvas-only) -------------------------------------------
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
// Focus-mode target: the margin left free when zooming to fill the frame
// (0.92 = 92% of the window's width/height).
const FOCUS_MODE_FILL_RATIO = 0.92;
let focusedSlot = null;
// The zoom state (canvasZoomState/gridZoomState) that is currently
// focused — tracked independently of `currentView` so an exit trigger from
// the respective zoom handler (see attachZoomHandler below) always touches
// the actually affected state, regardless of whether `currentView` changed
// in the meantime.
let focusZoomState = null;
// Zoom/scroll position immediately before focusing — for "back to the
// previous zoom level/position" on a second double-click. On an exit
// triggered by manual zooming/panning, this is deliberately NOT restored
// (see exitFocusMode).
let preFocusViewState = null;

// `bakedZoom` is the zoom level at which the currently visible pages were
// last actually (sharply) rasterized. The not-yet-"baked" remainder is only
// visually scaled up via CSS `zoom` (blurry, but instant) — see
// zoomAtPoint()/scheduleRebake().
const BASE_CANVAS_SCALE = 0.6;
const BASE_GRID_SCALE = 0.25;
// The cell every page sits in (grid track / canvas column) is derived from
// the real page sizes — see syncDerivedCellSizes(). This is only the
// fallback for the window before any size is known, which in practice means
// the empty canvas: sizes are measured before addDocument() fires the
// rebuild. A4 in PDF points, i.e. the same unit the measured sizes use.
const FALLBACK_CELL_SIZE = { width: 595.28, height: 841.89 };

const canvasZoomState = {
  zoom: 1,
  bakedZoom: 1,
  rebakeTimer: null,
  activeAnchor: null, // { el, fractionX, fractionY } — fixed for the duration of a zoom gesture
  container: canvasView,
  wrapper: canvasZoomWrapper,
  baseScale: BASE_CANVAS_SCALE,
  // Both derived from the real page sizes on every render — see
  // syncDerivedCellSizes(). `cellSize` is in PDF points (like the measured
  // sizes), `columnWidth` in CSS px at zoom 1.
  cellSize: FALLBACK_CELL_SIZE,
  columnWidth: Math.ceil(FALLBACK_CELL_SIZE.width * BASE_CANVAS_SCALE) + 1,
  // Base values (at zoom 1) of the CSS custom properties that `gap`/
  // `padding` are defined through in the stylesheet (see index.html).
  // Without this coupling, spacing would stay stuck at its unscaled base
  // size when the wrapper's zoom scale resets, while the pages themselves
  // have already jumped to the new target size — visible flicker in the
  // spacing between pages.
  spacing: { '--page-gap': 8, '--column-gap': 16 },
};
const gridZoomState = {
  zoom: 1,
  bakedZoom: 1,
  rebakeTimer: null,
  activeAnchor: null,
  container: gridView,
  wrapper: gridZoomWrapper,
  baseScale: BASE_GRID_SCALE,
  cellSize: FALLBACK_CELL_SIZE,
  columnWidth: null, // grid sections have no fixed width, no fix needed
  spacing: {
    '--thumb-gap': 10,
    '--section-padding-v': 12,
    '--section-padding-h': 16,
    // Unlike its siblings this is not a constant base value but is rewritten
    // on every render by syncDerivedCellSizes(); applyBakedSizes() then
    // scales it by `bakedZoom` like all the others.
    '--grid-col-width': Math.ceil(FALLBACK_CELL_SIZE.width * BASE_GRID_SCALE) + 1,
  },
};

// --- Cell size derived from the real page dimensions -------------------
// A page's cell (the grid track / canvas column it sits in) used to be a
// fixed constant well above any realistic page size, which left dead space
// around every page — for a corpus of small pages, far more dead space than
// page. Instead, the cell is sized to the LARGEST page across all open
// documents, so a corpus of uniformly small pages packs tightly while a
// mixed corpus still shows the smaller pages proportionally smaller.
//
// The maximum is deliberately global rather than per-document: it is what
// keeps every `.grid-pages` the same total width at the same column count,
// and therefore keeps all documents centered identically (see the
// FALLBACK_CELL_SIZE comment above). Note the consequence — rotating a
// single page to landscape in an otherwise portrait corpus raises the
// global maximum width for everyone.
//
// The render scale itself (BASE_*_SCALE) is untouched: pages keep exactly
// the size they always had, only the box around them shrinks.

// Size a page actually occupies on screen, before scaling — i.e. its
// intrinsic size with width/height swapped when the editor rotation turns
// it sideways. `null` when the source's sizes aren't known.
function effectivePageSize(page) {
  const size = pdfPageSizes.get(page.source.id)?.[page.sourcePageIndex];
  if (!size) return null;
  const sideways = page.rotation === 90 || page.rotation === 270;
  return sideways ? { width: size.height, height: size.width } : size;
}

function globalMaxPageSize() {
  let width = 0;
  let height = 0;
  for (const doc of store.documents) {
    for (const page of doc.pages) {
      const size = effectivePageSize(page);
      if (!size) continue;
      if (size.width > width) width = size.width;
      if (size.height > height) height = size.height;
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

// Per-page slot size at the given view's base scale, falling back to the
// shared cell when the page's own size is unknown.
function slotSizeFor(state, baseScale, page) {
  const size = (page && effectivePageSize(page)) ?? state.cellSize;
  return { width: size.width * baseScale, height: size.height * baseScale };
}

// Pushes the current global maximum into both zoom states. Called from
// renderActiveView (i.e. after every store change), which is enough on its
// own: every mutation that can change the maximum — open, close, rotate,
// delete, duplicate, restore-original, undo/redo — notifies. The two
// `{silent: true}` paths (page drag & drop, document reorder) only relocate
// existing pages and therefore cannot change it.
function syncDerivedCellSizes() {
  const max = globalMaxPageSize() ?? FALLBACK_CELL_SIZE;
  canvasZoomState.cellSize = max;
  gridZoomState.cellSize = max;
  // Rounded up by a pixel: the cell must never come out narrower than the
  // page it holds, or `max-width: 100%` would scale that page down.
  canvasZoomState.columnWidth = Math.ceil(max.width * BASE_CANVAS_SCALE) + 1;
  gridZoomState.spacing['--grid-col-width'] = Math.ceil(max.width * BASE_GRID_SCALE) + 1;
}

// Brings everything that isn't part of the actual page rendering but still
// has a fixed pixel size to the currently baked zoom level: still-invisible
// placeholder slots, (Canvas only) the column width, and all spacing/
// padding referenced in the stylesheet via CSS custom properties
// (`--page-gap` etc.) instead of fixed px values.
function applyBakedSizes(state) {
  // Sized per page rather than from one shared constant, so a slot occupies
  // exactly the space its page will need — no layout jump when it finally
  // rasterizes. `slotRenderInfo` may miss: this also runs (via
  // resetZoomBaking) against the previous build's slots.
  for (const slot of state.container.querySelectorAll('.page-slot:not(.rendered)')) {
    const size = slotSizeFor(state, state.baseScale, slotRenderInfo.get(slot)?.page);
    slot.style.width = `${size.width * state.bakedZoom}px`;
    slot.style.height = `${size.height * state.bakedZoom}px`;
  }
  // The empty-document placeholder has no page behind it — it gets the
  // shared cell, i.e. exactly one max-sized page.
  for (const placeholder of state.container.querySelectorAll('.placeholder-slot')) {
    const size = slotSizeFor(state, state.baseScale, null);
    placeholder.style.width = `${size.width * state.bakedZoom}px`;
    placeholder.style.height = `${size.height * state.bakedZoom}px`;
  }
  if (state.columnWidth) {
    for (const column of state.container.querySelectorAll('.canvas-column')) {
      column.style.width = `${state.columnWidth * state.bakedZoom}px`;
    }
  }
  for (const [property, baseValue] of Object.entries(state.spacing)) {
    state.wrapper.style.setProperty(property, `${baseValue * state.bakedZoom}px`);
  }
}

// `restore: true` (a second double-click) jumps back to the zoom level/
// scroll position from before focusing. `restore: false` (default; called
// by the zoom/pan handlers below on manual zooming/panning) leaves the
// current zoom level/position untouched — the user just set it themselves,
// jumping back would be the wrong response to exactly that input (2.3:
// "everything moves & zooms normally again").
function exitFocusMode({ restore = false } = {}) {
  if (!focusedSlot) return;
  const slot = focusedSlot;
  const state = focusZoomState;
  slot.classList.remove('focused');
  state.container.classList.remove('focus-active');

  if (restore && preFocusViewState) {
    state.zoom = preFocusViewState.zoom;
    state.wrapper.style.zoom = String(state.zoom / state.bakedZoom);
    state.container.scrollLeft = preFocusViewState.scrollLeft;
    state.container.scrollTop = preFocusViewState.scrollTop;
    scheduleRebake(state);
  } else {
    // Removing `focus-active` makes ALL documents visible again at once —
    // at the current (still-focused, usually very high) zoom level, the
    // total content becomes huge as a result, while `scrollLeft`/
    // `scrollTop` stay unchanged at their focus value. The same scroll
    // position then points at a completely different area — reads as a
    // jump to the first page. `scrollIntoView()` only compensates for this
    // on a BEST-EFFORT basis: if the total content (with few documents,
    // even at a high zoom level) isn't enough to actually bring the page to
    // center, the scroll hits its edge — the page stays visible, but
    // offset, NOT at the original cursor position (clientX/clientY), which
    // the triggering zoom/pan handler uses next for its own anchor lookup
    // (`elementFromPoint`) — that then hits the wrong (neighboring)
    // document. So on top of that, explicitly set the zoom
    // anchor to the page itself here: the following zoomAtPoint() call in
    // the handler then already sees a valid, connected anchor
    // (`state.activeAnchor?.el.isConnected` is true) and skips its own
    // position-based anchor lookup entirely — the page is thereby
    // guaranteed to remain the reference point, regardless of where it
    // actually ended up on screen after being unhidden.
    slot.scrollIntoView({ block: 'center', inline: 'center' });
    state.activeAnchor = { el: slot, fractionX: 0.5, fractionY: 0.5 };
  }

  focusedSlot = null;
  focusZoomState = null;
  preFocusViewState = null;
}

function toggleFocusMode(slot) {
  if (focusedSlot === slot) {
    exitFocusMode({ restore: true });
    return;
  }
  if (focusedSlot) return; // another page is already focused (edge case)

  const state = currentView === 'canvas' ? canvasZoomState : gridZoomState;
  preFocusViewState = {
    zoom: state.zoom,
    scrollLeft: state.container.scrollLeft,
    scrollTop: state.container.scrollTop,
  };
  focusZoomState = state;

  // Pick a target zoom that displays the page (at its current size/aspect
  // ratio) filling the frame as closely as possible — the same
  // zoomAtPoint() mechanism as wheel zoom, just with a directly computed
  // rather than an incremental factor. No anchor here (empty `findAnchor`):
  // zoomAtPoint's anchor logic keeps a point fixed at ITS CURRENT screen
  // position (e.g. for "stay under the cursor") — that would enlarge the
  // page wherever it happens to currently sit, not at the window center.
  // Zoom first instead, then center explicitly.
  const rect = slot.getBoundingClientRect();
  const factor = Math.min(
    (window.innerWidth * FOCUS_MODE_FILL_RATIO) / rect.width,
    (window.innerHeight * FOCUS_MODE_FILL_RATIO) / rect.height,
  );
  state.activeAnchor = null;
  zoomAtPoint(state, 0, 0, factor, () => null);

  focusedSlot = slot;
  slot.classList.add('focused');
  // Remove other pages/documents from the layout via `display: none` (CSS,
  // see index.html) — center ONLY AFTER that: scrollIntoView() has to
  // compute against the layout already collapsed onto the one page,
  // otherwise it still factors in the (merely invisible, but still wide)
  // neighboring columns when centering.
  state.container.classList.add('focus-active');
  slot.scrollIntoView({ block: 'center', inline: 'center' });
}

// --- Page selection ------------------------------------------------------
// Single click = replace, Cmd/Ctrl+click = add/remove a single page,
// Shift+click = range from the last-set anchor to the clicked page. Across
// documents: the anchor/range refers to a flat order across all open
// documents (document order, then page order within each document) — the
// same order documents appear in, in both Canvas and Grid view. State is
// indexed by `Page.id`, not by DOM element: slots get recreated on every
// store change/view switch, but the underlying Page objects (and their
// `id`) stay stable, so selection survives that.
const selectedPageIds = new Set();
let selectionAnchorPageId = null;

function getFlatPages() {
  return store.documents.flatMap((doc) => doc.pages);
}

function handlePageClick(page, event) {
  const isToggle = event.metaKey || event.ctrlKey;
  const isRange = event.shiftKey;

  if (isRange && selectionAnchorPageId) {
    const flat = getFlatPages();
    const anchorIndex = flat.findIndex((p) => p.id === selectionAnchorPageId);
    const targetIndex = flat.findIndex((p) => p.id === page.id);
    if (anchorIndex !== -1 && targetIndex !== -1) {
      const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      selectedPageIds.clear();
      for (const p of flat.slice(start, end + 1)) selectedPageIds.add(p.id);
    }
    // Anchor stays unchanged so further Shift+clicks stretch/shrink the same
    // range instead of re-anchoring each time.
  } else if (isToggle) {
    if (selectedPageIds.has(page.id)) {
      selectedPageIds.delete(page.id);
    } else {
      selectedPageIds.add(page.id);
    }
    selectionAnchorPageId = page.id;
  } else {
    selectedPageIds.clear();
    selectedPageIds.add(page.id);
    selectionAnchorPageId = page.id;
  }

  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  for (const slot of document.querySelectorAll('.page-slot')) {
    slot.classList.toggle('selected', selectedPageIds.has(slot.dataset.pageId));
  }
  // Toolbar action buttons (duplicate/rotate/delete) mirror the same
  // selection — disabled/gray with no selection, active once at least one
  // page is selected (see .toolbar-action-button in index.html).
  const hasSelection = selectedPageIds.size > 0;
  for (const button of [duplicateButton, rotateLeftButton, rotateRightButton, deleteButton]) {
    button.disabled = !hasSelection;
  }
}

// --- Drag & drop of pages --------------------------------------------------
// Deliberately the native HTML5 Drag and Drop API instead of a library
// (dnd-kit is React-specific and doesn't fit this app's bundler-free
// vanilla JS approach) or manual pointer-event tracking: the
// browser handles drag-threshold detection for free (a click without
// significant movement still fires a normal `click`, no manual distinction
// needed), the ghost image under the cursor, and Esc-to-cancel.
//
// `dragPayload` holds the set of dragged pages as a plain JS variable (not
// via `dataTransfer`, whose contents aren't readable during `dragover` in
// any browser, only on `drop`) — sufficient since the drag source and
// target are always in the same window.
let dragPayload = null; // { pageIds: string[] } | null
let lastDropTarget = null;

const dropIndicatorEl = document.createElement('div');
dropIndicatorEl.className = 'drop-indicator';
document.body.appendChild(dropIndicatorEl);

const DROP_INDICATOR_THICKNESS = 3;

// Shared by drag-start and the context menu: if the affected page is part
// of a (possibly cross-document) multi-selection, the action applies to the
// whole selection, in its existing relative order. Otherwise the page
// replaces the selection and the action applies only to it — familiar
// behavior from file managers (right-click/dragging an unselected page
// selects it alone first).
function resolveActionPageIds(page) {
  if (selectedPageIds.has(page.id) && selectedPageIds.size > 1) {
    return getFlatPages()
      .filter((p) => selectedPageIds.has(p.id))
      .map((p) => p.id);
  }
  selectedPageIds.clear();
  selectedPageIds.add(page.id);
  selectionAnchorPageId = page.id;
  updateSelectionVisuals();
  return [page.id];
}

function startPageDrag(page, event) {
  const pageIds = resolveActionPageIds(page);

  dragPayload = { pageIds };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/pageboard-pages', '1');

  // Deliberately scoped to the active view: both views coexist in the DOM,
  // an unscoped querySelector could otherwise hit the
  // (invisible) slot of the other view instead — with the effect that the
  // actually visible page shows no visual drag state AND is wrongly not
  // excluded from the reference-page lookup in findInsertionInDocument().
  for (const id of pageIds) {
    getActiveContainer().querySelector(`.page-slot[data-page-id="${id}"]`)?.classList.add('drag-source');
  }

  if (pageIds.length > 1) {
    const badge = document.createElement('div');
    badge.className = 'drag-badge';
    badge.textContent = t('drag.pagesBadge', { count: pageIds.length });
    document.body.appendChild(badge);
    event.dataTransfer.setDragImage(badge, 16, 16);
    // setDragImage() captures the element synchronously — it can go away after that.
    setTimeout(() => badge.remove(), 0);
  }
}

function cleanupDrag() {
  for (const slot of document.querySelectorAll('.page-slot.drag-source')) {
    slot.classList.remove('drag-source');
  }
  dropIndicatorEl.style.display = 'none';
  setPlaceholderDropHighlight(null);
  dragPayload = null;
  lastDropTarget = null;
}

// Dragging a page onto a completely empty document (dropping pages onto
// the placeholder reactivates the document) has no
// neighboring page for the usual thin bar to dock against — instead, the
// dashed placeholder itself is highlighted as the target.
let highlightedPlaceholder = null;
function setPlaceholderDropHighlight(el) {
  if (highlightedPlaceholder === el) return;
  highlightedPlaceholder?.classList.remove('drop-target');
  highlightedPlaceholder = el;
  highlightedPlaceholder?.classList.add('drop-target');
}

// Finds the insertion position within a document and references it via the
// stable `Page.id` of an existing (non-dragged) page, not via an index —
// see the comment on DocumentStore.movePages.
function findInsertionInDocument(container, clientX, clientY) {
  const pagesContainer = container.querySelector('.canvas-pages, .grid-pages');
  const slots = [...pagesContainer.querySelectorAll('.page-slot')].filter(
    (slot) => !slot.classList.contains('drag-source'),
  );
  if (slots.length === 0) return { atEnd: true };

  if (currentView === 'canvas') {
    // Canvas: a document's pages simply stack vertically.
    for (const slot of slots) {
      const r = slot.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return { beforePageId: slot.dataset.pageId };
    }
    return { atEnd: true };
  }

  // Grid: two-dimensional — find the nearest page by center-point distance,
  // then decide before/after from the X position within that page.
  let closestSlot = null;
  let closestRect = null;
  let closestDist = Infinity;
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < closestDist) {
      closestDist = dist;
      closestSlot = slot;
      closestRect = r;
    }
  }
  if (clientX < closestRect.left + closestRect.width / 2) {
    return { beforePageId: closestSlot.dataset.pageId };
  }
  const next = slots[slots.indexOf(closestSlot) + 1];
  return next ? { beforePageId: next.dataset.pageId } : { atEnd: true };
}

// "Before the first or after the last document" — the axis for this
// differs per view: Canvas documents sit side by side (X), Grid sections are
// stacked (Y). If the cursor is in the gap *between* two documents, that is
// explicitly not a drop target (`null`).
function findDropEdgeZone(clientX, clientY, containers) {
  if (containers.length === 0) return null;
  const firstRect = containers[0].getBoundingClientRect();
  const lastRect = containers[containers.length - 1].getBoundingClientRect();
  if (currentView === 'canvas') {
    if (clientX < firstRect.left) return 'start';
    if (clientX > lastRect.right) return 'end';
  } else {
    if (clientY < firstRect.top) return 'start';
    if (clientY > lastRect.bottom) return 'end';
  }
  return null;
}

function computeDropTarget(clientX, clientY) {
  const containers = [...getActiveContainer().querySelectorAll('.document-container')];
  const hovered = containers.find((el) => {
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  });
  if (hovered) {
    return {
      type: 'insert',
      documentId: hovered.dataset.documentId,
      ...findInsertionInDocument(hovered, clientX, clientY),
    };
  }
  const edge = findDropEdgeZone(clientX, clientY, containers);
  if (edge) return { type: 'new-document', position: edge };
  return { type: 'invalid' };
}

function positionIndicator(rectLike, orientation) {
  dropIndicatorEl.style.display = 'block';
  if (orientation === 'horizontal') {
    dropIndicatorEl.style.left = `${rectLike.left}px`;
    dropIndicatorEl.style.width = `${rectLike.width}px`;
    dropIndicatorEl.style.top = `${rectLike.top - DROP_INDICATOR_THICKNESS / 2}px`;
    dropIndicatorEl.style.height = `${DROP_INDICATOR_THICKNESS}px`;
  } else {
    dropIndicatorEl.style.top = `${rectLike.top}px`;
    dropIndicatorEl.style.height = `${rectLike.height}px`;
    dropIndicatorEl.style.left = `${rectLike.left - DROP_INDICATOR_THICKNESS / 2}px`;
    dropIndicatorEl.style.width = `${DROP_INDICATOR_THICKNESS}px`;
  }
}

function updateDropIndicator(target) {
  if (!target || target.type === 'invalid') {
    dropIndicatorEl.style.display = 'none';
    setPlaceholderDropHighlight(null);
    return;
  }

  if (target.type === 'new-document') {
    setPlaceholderDropHighlight(null);
    const containers = [...getActiveContainer().querySelectorAll('.document-container')];
    const edgeContainer = target.position === 'start' ? containers[0] : containers[containers.length - 1];
    const r = edgeContainer.getBoundingClientRect();
    if (currentView === 'canvas') {
      const x = target.position === 'start' ? r.left : r.right;
      positionIndicator({ left: x, top: r.top, width: 0, height: r.height }, 'vertical');
    } else {
      const y = target.position === 'start' ? r.top : r.bottom;
      positionIndicator({ left: r.left, top: y, width: r.width, height: 0 }, 'horizontal');
    }
    return;
  }

  // type === 'insert'
  const container = getActiveContainer().querySelector(
    `.document-container[data-document-id="${target.documentId}"]`,
  );
  const pagesContainer = container?.querySelector('.canvas-pages, .grid-pages');
  const placeholder = pagesContainer?.querySelector('.placeholder-slot');
  if (placeholder) {
    // Empty document: no neighboring page for a bar to dock against — the
    // placeholder itself is marked as the target instead.
    dropIndicatorEl.style.display = 'none';
    setPlaceholderDropHighlight(placeholder);
    return;
  }
  setPlaceholderDropHighlight(null);

  const remainingSlots = pagesContainer
    ? [...pagesContainer.querySelectorAll('.page-slot')].filter((s) => !s.classList.contains('drag-source'))
    : [];
  const referenceSlot = target.beforePageId
    ? pagesContainer?.querySelector(`.page-slot[data-page-id="${target.beforePageId}"]`)
    : null;
  const fallbackSlot = remainingSlots.at(-1);
  const slot = referenceSlot ?? fallbackSlot;
  if (!slot) {
    dropIndicatorEl.style.display = 'none';
    return;
  }
  const r = slot.getBoundingClientRect();

  if (currentView === 'canvas') {
    const top = referenceSlot ? r.top : r.bottom;
    positionIndicator({ left: r.left, top, width: r.width, height: 0 }, 'horizontal');
  } else {
    const left = referenceSlot ? r.left : r.right;
    positionIndicator({ left, top: r.top, width: 0, height: r.height }, 'vertical');
  }
}

function handleDragOver(event) {
  if (documentDragPayload) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // Live preview instead of a bar indicator: the (already dimmed) dragged
    // container is moved directly to the currently targeted spot as soon as
    // the target changes — the user sees the new order while still
    // dragging and just has to release once it looks right.
    const target = computeDocumentDropTarget(event.clientX, event.clientY);
    if (!sameDocumentDropTarget(target, lastDocumentDropTarget)) {
      moveDocumentInDom(documentDragPayload.documentId, target);
      lastDocumentDropTarget = target;
    }
    return;
  }
  if (!dragPayload) return; // external file drop (6.x) — handled separately
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  lastDropTarget = computeDropTarget(event.clientX, event.clientY);
  updateDropIndicator(lastDropTarget);
}

// Moves the actual, already-rendered DOM nodes of the dragged pages
// directly to their new spot, instead of triggering a full rebuild of the
// active view (as a normal store change would). Without this, EVERY page in
// the view would briefly disappear and re-rasterize — visible flicker even
// for pages the actual move never touched. Deliberately
// only affects the currently visible view: the other one gets fully rebuilt
// from the then-current store state on the next switch anyway
// (renderActiveView only rebuilds the active view, never the hidden one).
function moveSlotsInDom(pageIds, toDocumentId, insertion) {
  const toDocEl = getActiveContainer().querySelector(
    `.document-container[data-document-id="${toDocumentId}"]`,
  );
  const toPagesWrap = toDocEl.querySelector('.canvas-pages, .grid-pages');
  const referenceSlot = insertion.beforePageId
    ? toPagesWrap.querySelector(`.page-slot[data-page-id="${insertion.beforePageId}"]`)
    : null;

  // Target document may have been a placeholder — becomes "real" now.
  toPagesWrap.querySelector('.placeholder-slot')?.remove();

  const affectedDocumentIds = new Set([toDocumentId]);
  const sourceWraps = new Set();

  for (const pageId of pageIds) {
    // Scoped to the active view — see the comment in startPageDrag() about
    // the same ambiguity from coexisting view DOM trees.
    const slot = getActiveContainer().querySelector(`.page-slot[data-page-id="${pageId}"]`);
    if (!slot) continue; // shouldn't happen: dragging assumes already-rendered slots

    const originWrap = slot.closest('.canvas-pages, .grid-pages');
    const originDocId = originWrap?.closest('.document-container')?.dataset.documentId;
    if (originDocId) affectedDocumentIds.add(originDocId);
    if (originWrap && originWrap !== toPagesWrap) sourceWraps.add(originWrap);

    if (referenceSlot) toPagesWrap.insertBefore(slot, referenceSlot);
    else toPagesWrap.appendChild(slot);
  }

  // Source document(s) left completely empty by this immediately get their
  // placeholder back (otherwise the section would stay wrongly empty, without
  // the dashed placeholder box, until the next rebuild).
  for (const wrap of sourceWraps) {
    if (wrap.children.length === 0) {
      const state = currentView === 'canvas' ? canvasZoomState : gridZoomState;
      wrap.appendChild(createPlaceholderSlot(state));
    }
  }

  return affectedDocumentIds;
}

// Grid with column count "--" (gridColumnsPerRow === 'all'): the column
// count is tied to the actual page count of the respective document (see
// renderGridView) — without adjusting it, newly added pages would wrap into
// a second row instead of staying in one continuous row as intended. Must
// run AFTER the store mutation (not in moveSlotsInDom, which runs before
// it) — otherwise `doc.pages.length` would still report the old count.
function syncAllColumnsGridWidth(documentIds) {
  if (currentView !== 'grid' || gridColumnsPerRow !== 'all') return;
  for (const documentId of documentIds) {
    const doc = store.getDocument(documentId);
    const gridEl = getActiveContainer().querySelector(
      `.document-container[data-document-id="${documentId}"] .grid-pages`,
    );
    if (doc && gridEl) {
      gridEl.style.gridTemplateColumns = `repeat(${Math.max(1, doc.pages.length)}, var(--grid-col-width))`;
    }
  }
}

// Seamlessly catches up the save status in the section header (dot + save
// button) AND the global "Save all" button after a silent (non-rebuilding)
// store mutation, e.g. drag & drop of pages — a full rebuild would
// otherwise handle both of these automatically (see
// createSectionHeader/renderActiveView). Without this sync, the save button
// stayed disabled after a drag & drop even though the document was dirty
// again in the model — a document moved via drag could then no longer be
// saved again after its first save.
function syncDirtyDot(documentId) {
  const doc = store.getDocument(documentId);
  if (!doc) return;
  for (const header of document.querySelectorAll(
    `.document-container[data-document-id="${documentId}"] .section-header`,
  )) {
    if (doc.dirty && !header.querySelector('.dirty-dot')) {
      const dot = document.createElement('span');
      dot.className = 'dirty-dot';
      dot.textContent = '●';
      dot.title = t('sectionHeader.unsavedTitle');
      header.querySelector('.section-header-name').after(dot);
    }
    const saveButton = header.querySelector('.save-button');
    saveButton.disabled = !doc.dirty;
    saveButton.title = doc.dirty ? t('sectionHeader.saveTitle') : t('sectionHeader.saveDisabledTitle');
  }
  updateSaveAllButtonState();
}

// --- Reordering whole documents by dragging the header --------------------
// A separate, simpler drag mechanism alongside the page drag: a document
// container is already a fully rendered unit including all child elements —
// moving it here just means placing the whole container at a new spot among
// its siblings (see moveDocumentInDom), without a single page inside it
// ever needing to be touched.
let documentDragPayload = null; // { documentId } | null
let lastDocumentDropTarget = null;
// Only set to `true` on an actual drop (see handleDrop) — distinguishes
// "successfully dropped" from "cancelled" (Esc / released outside a
// window), since `dragend` fires for both.
let documentDropCompleted = false;

function startDocumentDrag(documentId, event) {
  documentDragPayload = { documentId };
  documentDropCompleted = false;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/pageboard-document', '1');
  getActiveContainer()
    .querySelector(`.document-container[data-document-id="${documentId}"]`)
    ?.classList.add('drag-source');
}

function cleanupDocumentDrag() {
  for (const el of document.querySelectorAll('.document-container.drag-source')) {
    el.classList.remove('drag-source');
  }
  if (!documentDropCompleted) {
    // Cancelled: the live preview (see handleDragOver) only moved the DOM,
    // never the model (store.moveDocument only ever runs in handleDrop) —
    // a normal rebuild reliably restores the unchanged, original order.
    renderActiveView();
  }
  documentDragPayload = null;
  lastDocumentDropTarget = null;
}

// "Left/right" (Canvas) or "up/down" (Grid) — the same axis as
// findDropEdgeZone for new documents. Unlike page dropping, there's no
// "invalid gap" here: every cursor position resolves to exactly one
// insertion position (before a document, or at the very end).
function computeDocumentDropTarget(clientX, clientY) {
  const containers = [...getActiveContainer().querySelectorAll('.document-container')].filter(
    (el) => el.dataset.documentId !== documentDragPayload.documentId,
  );
  const pos = currentView === 'canvas' ? clientX : clientY;
  for (const el of containers) {
    const r = el.getBoundingClientRect();
    const midpoint = currentView === 'canvas' ? r.left + r.width / 2 : r.top + r.height / 2;
    if (pos < midpoint) return { beforeDocumentId: el.dataset.documentId };
  }
  return { atEnd: true };
}

function sameDocumentDropTarget(a, b) {
  if (!a || !b) return a === b;
  return (a.beforeDocumentId ?? null) === (b.beforeDocumentId ?? null) && !!a.atEnd === !!b.atEnd;
}

function moveDocumentInDom(documentId, insertion) {
  const wrapper = currentView === 'canvas' ? canvasZoomWrapper : gridZoomWrapper;
  const el = getActiveContainer().querySelector(`.document-container[data-document-id="${documentId}"]`);
  if (!el) return;
  const referenceEl = insertion.beforeDocumentId
    ? getActiveContainer().querySelector(`.document-container[data-document-id="${insertion.beforeDocumentId}"]`)
    : null;
  if (referenceEl) wrapper.insertBefore(el, referenceEl);
  else wrapper.appendChild(el);
}

function handleDrop(event) {
  if (documentDragPayload) {
    event.preventDefault();
    event.stopPropagation();
    const target = lastDocumentDropTarget ?? computeDocumentDropTarget(event.clientX, event.clientY);
    // The DOM is already in place thanks to the live preview
    // (handleDragOver) — this call is just a cheap safety net in case no
    // dragover with a changed target ever fired.
    moveDocumentInDom(documentDragPayload.documentId, target);
    store.moveDocument(documentDragPayload.documentId, target, { silent: true });
    documentDropCompleted = true;
    cleanupDocumentDrag();
    return;
  }

  if (!dragPayload) return;
  event.preventDefault();
  event.stopPropagation();

  const target = lastDropTarget ?? computeDropTarget(event.clientX, event.clientY);
  const { pageIds } = dragPayload;

  if (target.type === 'insert') {
    const insertion = target.beforePageId ? { beforePageId: target.beforePageId } : { atEnd: true };
    const affectedDocumentIds = moveSlotsInDom(pageIds, target.documentId, insertion);
    store.movePages(pageIds, target.documentId, insertion, { silent: true });
    syncAllColumnsGridWidth(affectedDocumentIds);
    for (const documentId of affectedDocumentIds) syncDirtyDot(documentId);
  } else if (target.type === 'new-document') {
    // New document = new column/section including a header — a structurally
    // bigger DOM change than a simple move, so this deliberately still uses
    // the normal full rebuild (a much rarer case than normal reordering).
    store.createDocumentFromPages(pageIds, target.position);
  }
  // type === 'invalid' (gap between two documents, 3.2): deliberately do
  // nothing — the page was never removed from the model, so it visually
  // "falls" back to its original spot automatically.

  cleanupDrag();
}

for (const view of [canvasView, gridView]) {
  view.addEventListener('dragover', handleDragOver);
  view.addEventListener('drop', handleDrop);
}

// --- Page operations: delete, rotate, duplicate -----------------------------
// UI decision (the plan explicitly calls for one here): native context menu
// (right-click, built via IPC in the main process — looks native on both
// Mac and Windows) + keyboard shortcuts. Deliberately no additional toolbar
// button: the toolbar is currently purely document-/view-related (open,
// save all, view switcher), a "acts on the current page selection" button
// wouldn't have a natural place there and would be redundant next to the
// context menu + shortcuts.
function applyPageAction(action, pageIds) {
  switch (action) {
    case 'duplicate':
      store.duplicatePages(pageIds);
      break;
    case 'rotate-left':
      store.rotatePages(pageIds, -90);
      break;
    case 'rotate-right':
      store.rotatePages(pageIds, 90);
      break;
    case 'delete':
      store.removePages(pageIds);
      // Deleted pages must not linger as dead references in the
      // selection/anchor (relevant e.g. for the next Shift+click range).
      for (const id of pageIds) selectedPageIds.delete(id);
      if (pageIds.includes(selectionAnchorPageId)) selectionAnchorPageId = null;
      // store.removePages() does trigger a full rebuild (which correctly
      // derives new slots' .selected class from the already-cleaned-up
      // selectedPageIds above), but it doesn't maintain the toolbar action
      // buttons — those aren't .page-slot elements, hence explicitly here.
      updateSelectionVisuals();
      break;
    default:
      break;
  }
}

async function handlePageContextMenu(page, event) {
  event.preventDefault();
  const pageIds = resolveActionPageIds(page);
  const action = await window.api.showPageContextMenu();
  if (!action) return; // menu closed without a selection (click elsewhere/Esc)
  applyPageAction(action, pageIds);
}

// Keyboard shortcuts act on the current selection (no target element needed
// like the context menu). The `activeElement` check prevents e.g. Delete in
// the grid-columns dropdown from accidentally deleting pages.
// Shared by the Ctrl/Cmd+Z keydown shortcut and the native Edit menu's
// Undo/Redo items. `_restore()` (see store.mjs) rebuilds brand-new Page
// objects with new ids on every undo/redo, so any previously selected page
// ids are now dangling — left uncleared, selectedPageIds.size would stay
// > 0 with nothing actually selected, which keeps the toolbar's
// duplicate/rotate/delete buttons wrongly enabled and, if clicked, would
// no-op while still pushing an empty undo snapshot (wiping the redo stack
// in the process).
function performUndoOrRedo(isRedo) {
  if (isRedo) store.redo();
  else store.undo();
  selectedPageIds.clear();
  selectionAnchorPageId = null;
  updateSelectionVisuals();
}

window.addEventListener('keydown', (event) => {
  // While any modal dialog is open, every one of the shortcuts below (Delete,
  // Ctrl/Cmd+D/L/R/Z) must NOT reach the page selection underneath it —
  // previously they did, since this handler only checked focused form
  // controls, not whether a dialog was covering the page at all (e.g.
  // opening Options with pages selected and pressing Delete deleted them
  // behind the dialog). Escape is the one key still handled here: it clicks
  // whichever button the dialog marked as its close/cancel action (see
  // `modal-escape-close`, set by each show*Dialog() function), reusing that
  // button's own real close logic instead of just removing the overlay.
  // Checked BEFORE the activeTag guard below, deliberately — setupModalDialog()
  // focuses the dialog's first focusable control on open, which is often a
  // <select> (e.g. the Options dialog's language picker), and Escape must
  // still close the dialog even though the activeTag guard would otherwise
  // suppress every other shortcut for exactly that element type.
  const openModal = document.querySelector('.modal-overlay');
  if (openModal) {
    if (event.key === 'Escape') {
      event.preventDefault();
      openModal.querySelector('.modal-escape-close')?.click();
    }
    return;
  }

  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') return;

  const isMod = event.metaKey || event.ctrlKey;

  // Undo/redo — independent of a current page selection, so
  // checked before the `selectedPageIds` guard below. Cmd/Ctrl+Z to undo,
  // Cmd/Ctrl+Shift+Z to redo (one combination for both platforms, instead
  // of additionally distinguishing Ctrl+Y on Windows).
  if (isMod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    performUndoOrRedo(event.shiftKey);
    return;
  }

  // Keyboard-shortcuts overview — also independent of a current
  // page selection. `/` instead of e.g. `?` so no Shift is needed (a common
  // convention — Slack/Linear/GitHub, among others, use Ctrl/Cmd+/ for this).
  if (isMod && event.key === '/') {
    event.preventDefault();
    showShortcutsDialog();
    return;
  }

  if (selectedPageIds.size === 0) return;

  const pageIds = [...selectedPageIds];

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    applyPageAction('delete', pageIds);
  } else if (isMod && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    applyPageAction('duplicate', pageIds);
  } else if (isMod && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    applyPageAction('rotate-left', pageIds);
  } else if (isMod && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    applyPageAction('rotate-right', pageIds);
  }
});

// --- Save --------------------------------------------------------------------
// Assembles a fresh PDF file per affected document via pdf-lib in the main
// process (see main/pdf-writer.mjs) and overwrites the target file
// directly. `docs` is either a single document (save button/context menu in
// the header) or all unsaved documents ("save all"). If any of the given
// documents is currently empty, a single combined dialog is shown
// BEFORE any write access — regardless of whether one or several are
// being saved.
async function saveDocuments(docs) {
  const emptyDocs = docs.filter((doc) => doc.isEmpty);
  // "Delete" in the empty-documents
  // dialog performs a real filesystem operation (deleteDocumentFile) and can
  // fail (missing write/delete permissions, file locked externally) —
  // uncaught, that would abort the entire remaining save operation (also
  // for every other, unrelated document in `docs`), since main.js
  // deliberately only ignores ENOENT here and rethrows every other error
  // (see delete-document-file in main.js). On failure, the document stays
  // unchanged in the store (no removeDocument) instead of being wrongly
  // treated as deleted.
  const deleteFailures = [];
  if (emptyDocs.length > 0) {
    const resolution = await showEmptyDocumentsDialog(emptyDocs);
    if (!resolution) return; // entire save operation cancelled

    for (const doc of emptyDocs) {
      if (resolution[doc.id] === 'restore') {
        store.restoreOriginal(doc.id);
      } else {
        try {
          await window.api.deleteDocumentFile(doc.filePath);
          store.removeDocument(doc.id);
        } catch (error) {
          log(`Delete failed (${doc.displayName}): ${error}`);
          deleteFailures.push(doc.displayName);
        }
      }
    }
  }

  // Look the document up again against the store via its current `id`
  // instead of reusing the possibly stale object reference from `docs`:
  // "delete" removed the document (getDocument() then returns nothing,
  // correctly filtered out), "restore original" rebuilt `pages` fresh from
  // `originalSource`.
  const toWrite = docs.map((doc) => store.getDocument(doc.id)).filter((doc) => doc && !doc.isEmpty);

  // Save errors (e.g. missing write permissions, file changed externally)
  // are collected per document instead of reported individually via a
  // toast right away — several showToast() calls in the same pass would
  // otherwise overwrite each other (a single toast element, no queue), so
  // only the last message would ever end up visible.
  const saveFailures = [];
  if (toWrite.length > 0) {
    // Send each involved PdfSource's raw bytes to the main process only
    // ONCE (several pages/documents can share the same source, e.g. after
    // drag & drop between documents) — pages only reference it via
    // `sourceId`.
    const sourceBytesById = new Map();
    const payloadDocuments = toWrite.map((doc) => ({
      documentId: doc.id,
      filePath: doc.filePath,
      pages: doc.pages.map((page) => {
        sourceBytesById.set(page.source.id, page.source.bytes);
        return { sourceId: page.source.id, sourcePageIndex: page.sourcePageIndex, rotation: page.rotation };
      }),
    }));

    const results = await window.api.saveDocuments({
      sources: [...sourceBytesById.entries()].map(([id, bytes]) => ({ id, bytes })),
      documents: payloadDocuments,
    });

    for (const { documentId, error } of results) {
      const doc = store.getDocument(documentId);
      if (!doc) continue;
      if (error) {
        log(`Save failed (${doc.displayName}): ${error}`);
        saveFailures.push(doc.displayName);
        continue;
      }
      doc.dirty = false;
    }

    renderActiveView(); // refresh dirty dots/button states — a rare action, full rebuild is fine
  }

  // Delete failures take priority in the display: rarer and more serious
  // (the file unintentionally remains) than a failed write, which can be
  // retried at any time by saving again.
  if (deleteFailures.length > 0) {
    showToast(
      deleteFailures.length === 1
        ? t('toast.failedToDeleteOne', { name: deleteFailures[0] })
        : t('toast.failedToDeleteMultiple', { count: deleteFailures.length }),
    );
  } else if (saveFailures.length > 0) {
    showToast(
      saveFailures.length === 1
        ? t('toast.failedToSaveOne', { name: saveFailures[0] })
        : t('toast.failedToSaveMultiple', { count: saveFailures.length }),
    );
  }
}

// --- Modal dialog accessibility (focus management, Tab trap) ---------------
// Shared by every modal-overlay-based dialog below (empty-documents,
// shortcuts, options, acknowledgments) instead of duplicating the same
// focus/ARIA wiring four times. Must run after the overlay is actually in
// the document (`.focus()` on a detached element is a no-op).
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let modalReturnFocus = null;

function setupModalDialog(overlay, dialog, headingEl) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (headingEl) {
    if (!headingEl.id) headingEl.id = `modal-heading-${Math.random().toString(36).slice(2)}`;
    dialog.setAttribute('aria-labelledby', headingEl.id);
  }

  modalReturnFocus = document.activeElement;
  const focusables = dialog.querySelectorAll(FOCUSABLE_SELECTOR);
  if (focusables.length === 0) dialog.tabIndex = -1;
  (focusables[0] ?? dialog).focus();

  // Keeps Tab/Shift+Tab cycling within the dialog instead of escaping into
  // the (invisible-behind-the-overlay, but still technically present) rest
  // of the page.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const current = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)];
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

// Restores focus to whatever triggered a dialog once it's actually removed
// from the DOM — a single observer here covers every one of the several ways
// a dialog can close (its own Close/Cancel button, clicking outside, Escape
// via the global keydown handler below) without needing to thread a restore
// call through each of them individually.
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.removedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('modal-overlay')) {
        modalReturnFocus?.focus();
        modalReturnFocus = null;
      }
    }
  }
}).observe(document.body, { childList: true });

// A custom, simple HTML overlay instead of a native dialog: needs an
// independent choice per document (delete vs. restore original), and there
// is no matching native multi-selection dialog template for that.
// Deliberately does NOT appear while editing, only right here, right before
// the write operation. Resolves with `null` on "Cancel", otherwise
// with `{ [documentId]: 'restore' | 'delete' }`.
function showEmptyDocumentsDialog(emptyDocs) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';

    const heading = document.createElement('h2');
    heading.textContent = t('dialog.emptyDocs.heading');
    dialog.appendChild(heading);

    const intro = document.createElement('p');
    intro.textContent = t('dialog.emptyDocs.intro');
    dialog.appendChild(intro);

    const choices = new Map();
    for (const doc of emptyDocs) {
      const row = document.createElement('div');
      row.className = 'modal-doc-row';

      const label = document.createElement('span');
      label.textContent = doc.displayName;
      row.appendChild(label);

      const select = document.createElement('select');
      // "Restore original" only if there actually is a source file — a
      // virtual document (dropped at the canvas edge) has no
      // opening state to return to.
      if (doc.originalSource) {
        const restoreOption = document.createElement('option');
        restoreOption.value = 'restore';
        restoreOption.textContent = t('dialog.emptyDocs.restoreOriginal');
        select.appendChild(restoreOption);
      }
      const deleteOption = document.createElement('option');
      deleteOption.value = 'delete';
      deleteOption.textContent = t('dialog.emptyDocs.delete');
      select.appendChild(deleteOption);

      choices.set(doc.id, select.value); // first option: 'restore' if present, otherwise 'delete'
      select.addEventListener('change', () => choices.set(doc.id, select.value));
      row.appendChild(select);

      dialog.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = t('dialog.emptyDocs.cancel');
    // Marks this as the button Escape should trigger (see the global keydown
    // handler) — reusing the real Cancel click handler means Escape
    // correctly resolves the pending Promise instead of just removing the
    // overlay and leaving the caller's `await` hanging forever.
    cancelButton.classList.add('modal-escape-close');
    cancelButton.addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    actions.appendChild(cancelButton);

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.textContent = t('dialog.emptyDocs.continueButton');
    confirmButton.addEventListener('click', () => {
      overlay.remove();
      resolve(Object.fromEntries(choices));
    });
    actions.appendChild(confirmButton);

    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setupModalDialog(overlay, dialog, heading);
  });
}

// --- Keyboard-shortcuts overview ---------------------------------------------
// The list is deliberately maintained by hand instead of e.g. generated
// from the keydown handlers above — the actual actions are scattered across
// several places (keyboard here, mouse gestures further up, the menu in
// main.js), an automatic roll-up would be more complexity than it saves at
// this hobby app's scale. Add new actions here too when adding one.
// `keysKey`/`descriptionKey` point at i18n keys rather than literal text —
// a few entries (Click, Shift+click, Double-click a page, ...) describe a
// mouse gesture in words, not an actual key combination, so they need
// translating just like `descriptionKey` does; the literal Ctrl/Cmd
// combinations translate to the same text in every locale that uses Latin
// modifier-key names, which is harmless (keeps this loop uniform, no
// per-row branching between "translate" and "don't").
const SHORTCUTS = [
  { keysKey: 'shortcutsList.openPdfsKeys', descriptionKey: 'shortcutsList.openPdfs' },
  { keysKey: 'shortcutsList.undoKeys', descriptionKey: 'shortcutsList.undo' },
  { keysKey: 'shortcutsList.redoKeys', descriptionKey: 'shortcutsList.redo' },
  { keysKey: 'shortcutsList.deleteKeys', descriptionKey: 'shortcutsList.delete' },
  { keysKey: 'shortcutsList.duplicateKeys', descriptionKey: 'shortcutsList.duplicate' },
  { keysKey: 'shortcutsList.rotateLeftKeys', descriptionKey: 'shortcutsList.rotateLeft' },
  { keysKey: 'shortcutsList.rotateRightKeys', descriptionKey: 'shortcutsList.rotateRight' },
  { keysKey: 'shortcutsList.clickKeys', descriptionKey: 'shortcutsList.click' },
  { keysKey: 'shortcutsList.shiftClickKeys', descriptionKey: 'shortcutsList.shiftClick' },
  { keysKey: 'shortcutsList.modClickKeys', descriptionKey: 'shortcutsList.modClick' },
  { keysKey: 'shortcutsList.doubleClickKeys', descriptionKey: 'shortcutsList.doubleClick' },
  { keysKey: 'shortcutsList.rightClickPageKeys', descriptionKey: 'shortcutsList.rightClickPage' },
  { keysKey: 'shortcutsList.rightClickHeaderKeys', descriptionKey: 'shortcutsList.rightClickHeader' },
  { keysKey: 'shortcutsList.showShortcutsKeys', descriptionKey: 'shortcutsList.showShortcuts' },
];

function showShortcutsDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove(); // clicking outside closes it — purely informational dialog, no confirmation needed
  });

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  const heading = document.createElement('h2');
  heading.textContent = t('dialog.shortcuts.heading');
  dialog.appendChild(heading);

  const list = document.createElement('dl');
  list.className = 'shortcuts-list';
  for (const { keysKey, descriptionKey } of SHORTCUTS) {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = t(keysKey);
    dt.appendChild(kbd);
    list.appendChild(dt);

    const dd = document.createElement('dd');
    dd.textContent = t(descriptionKey);
    list.appendChild(dd);
  }
  dialog.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = t('dialog.shortcuts.close');
  closeButton.classList.add('modal-escape-close');
  closeButton.addEventListener('click', () => overlay.remove());
  actions.appendChild(closeButton);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  setupModalDialog(overlay, dialog, heading);
}

shortcutsButton.addEventListener('click', showShortcutsDialog);

// --- Options dialog ----------------------------------------------------------
// A native language's own name for itself ("English"/"Deutsch") — shown as
// each `<option>`'s label in the language picker below. Deliberately NOT run
// through `t()`: a language picker conventionally lists every option in its
// own language, not translated into whichever language happens to be active
// (a German speaker looking for "English" in a French UI still expects to
// see "English", not "Anglais").
const LOCALE_NAMES = { en: 'English', de: 'Deutsch' };

// Populated once at startup (see the init block at the bottom of this file)
// and kept in sync by saveSettingsPatch() — the Options dialog reads this
// to prefill its controls each time it's (re)built, rather than holding its
// own separate copy of the settings state.
let currentSettings = null;

async function saveSettingsPatch(patch) {
  currentSettings = await window.api.saveSettings(patch);
  return currentSettings;
}

// Called when the language `<select>` in Options changes. Re-points the
// module-level `t`, re-applies it to every statically marked-up element,
// and rebuilds the active view so dynamically built text (section headers,
// which bake in `t()` output at creation time rather than reading it live)
// picks up the new language too — a full view rebuild is already how every
// other store change refreshes this content, see renderActiveView().
function switchLocale(locale) {
  t = createTranslator(locale);
  currentLocale = locale;
  // Updated locally before the save resolves (not just left to
  // saveSettingsPatch()'s eventual response): showOptionsDialog() below
  // reads `currentSettings.locale` synchronously to preselect the language
  // `<select>`, and saveSettingsPatch() is deliberately not awaited here —
  // without this, the rebuilt dialog would show the new language's text but
  // the picker itself would still show the previous selection until the IPC
  // round trip finished (found via manual smoke-testing).
  if (currentSettings) currentSettings = { ...currentSettings, locale };
  applyStaticTranslations();
  renderActiveView();
  saveSettingsPatch({ locale });
  // If Options is the dialog currently open, rebuild it in place so its own
  // labels switch language immediately too, instead of only on next open.
  const openOptionsOverlay = document.querySelector('.options-overlay');
  if (openOptionsOverlay) {
    // Removing the (currently focused, e.g. the language <select>) overlay
    // synchronously moves focus to <body> — save the *real* return-focus
    // target (whatever was focused before Options was ever opened) across
    // this remove+recreate cycle, otherwise setupModalDialog() inside the
    // showOptionsDialog() call below would capture <body> as the target to
    // restore focus to once the (rebuilt) dialog eventually closes, instead
    // of the toolbar button that actually opened it.
    const realReturnFocus = modalReturnFocus;
    openOptionsOverlay.remove();
    showOptionsDialog();
    modalReturnFocus = realReturnFocus;
  }
}

async function handleCheckForUpdates(button) {
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = t('dialog.options.checking');
  try {
    const result = await window.api.checkForUpdates();
    if (result.status === 'available') {
      showToast(t('dialog.options.updateAvailable', { version: result.version }));
    } else if (result.status === 'not-available') {
      showToast(t('dialog.options.upToDate'));
    } else {
      showToast(t('dialog.options.checkFailed', { message: result.message }));
    }
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function showOptionsDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay options-overlay';
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  const heading = document.createElement('h2');
  heading.textContent = t('dialog.options.heading');
  dialog.appendChild(heading);

  // --- Display ---
  const displayHeading = document.createElement('h3');
  displayHeading.className = 'modal-section-heading';
  displayHeading.textContent = t('dialog.options.sectionDisplay');
  dialog.appendChild(displayHeading);

  const languageRow = document.createElement('div');
  languageRow.className = 'modal-row';
  const languageLabel = document.createElement('span');
  languageLabel.textContent = t('dialog.options.language');
  languageRow.appendChild(languageLabel);
  const languageSelect = document.createElement('select');
  languageSelect.id = 'options-language-select';
  for (const locale of LOCALES) {
    const option = document.createElement('option');
    option.value = locale;
    option.textContent = LOCALE_NAMES[locale] ?? locale;
    languageSelect.appendChild(option);
  }
  languageSelect.value = currentSettings.locale ?? matchLocale(currentSettings.systemLocale);
  languageSelect.addEventListener('change', () => switchLocale(languageSelect.value));
  languageRow.appendChild(languageSelect);
  dialog.appendChild(languageRow);

  // Default view and default grid-columns both apply on next launch only
  // (decoupled from the toolbar's own live Canvas/Grid switch and column
  // dropdown) — browsing Options should never silently change what's on
  // screen mid-session, see the shared hint text under each row.
  const viewRow = document.createElement('div');
  viewRow.className = 'modal-row';
  const viewLabel = document.createElement('span');
  viewLabel.textContent = t('dialog.options.defaultView');
  viewRow.appendChild(viewLabel);
  const viewSelect = document.createElement('select');
  viewSelect.id = 'options-view-select';
  const canvasOption = document.createElement('option');
  canvasOption.value = 'canvas';
  canvasOption.textContent = t('toolbar.canvasView');
  const gridOption = document.createElement('option');
  gridOption.value = 'grid';
  gridOption.textContent = t('toolbar.gridView');
  viewSelect.append(canvasOption, gridOption);
  viewSelect.value = currentSettings.view;
  viewSelect.addEventListener('change', () => saveSettingsPatch({ view: viewSelect.value }));
  viewRow.appendChild(viewSelect);
  dialog.appendChild(viewRow);

  const viewHint = document.createElement('p');
  viewHint.className = 'modal-row-hint';
  viewHint.textContent = t('dialog.options.nextLaunchHint');
  dialog.appendChild(viewHint);

  const columnsRow = document.createElement('div');
  columnsRow.className = 'modal-row';
  const columnsLabel = document.createElement('span');
  columnsLabel.textContent = t('dialog.options.defaultGridColumns');
  columnsRow.appendChild(columnsLabel);
  const columnsSelect = document.createElement('select');
  columnsSelect.id = 'options-grid-columns-select';
  for (const value of GRID_COLUMNS_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = value === 'all' ? '--' : String(value);
    columnsSelect.appendChild(option);
  }
  columnsSelect.value = String(currentSettings.gridColumnsPerRow);
  columnsSelect.addEventListener('change', () => {
    const value = columnsSelect.value === 'all' ? 'all' : Number(columnsSelect.value);
    saveSettingsPatch({ gridColumnsPerRow: value });
  });
  columnsRow.appendChild(columnsSelect);
  dialog.appendChild(columnsRow);

  const columnsHint = document.createElement('p');
  columnsHint.className = 'modal-row-hint';
  columnsHint.textContent = t('dialog.options.nextLaunchHint');
  dialog.appendChild(columnsHint);

  // --- Updates ---
  const updatesHeading = document.createElement('h3');
  updatesHeading.className = 'modal-section-heading';
  updatesHeading.textContent = t('dialog.options.sectionUpdates');
  dialog.appendChild(updatesHeading);

  const autoUpdateRow = document.createElement('div');
  autoUpdateRow.className = 'modal-row';
  const autoUpdateLabel = document.createElement('span');
  autoUpdateLabel.textContent = t('dialog.options.autoUpdate');
  autoUpdateRow.appendChild(autoUpdateLabel);
  const autoUpdateCheckbox = document.createElement('input');
  autoUpdateCheckbox.type = 'checkbox';
  autoUpdateCheckbox.id = 'options-auto-update-checkbox';
  autoUpdateCheckbox.checked = currentSettings.autoUpdateEnabled;
  autoUpdateCheckbox.addEventListener('change', () =>
    saveSettingsPatch({ autoUpdateEnabled: autoUpdateCheckbox.checked }),
  );
  autoUpdateRow.appendChild(autoUpdateCheckbox);
  dialog.appendChild(autoUpdateRow);

  const updatesActions = document.createElement('div');
  updatesActions.className = 'modal-info-actions';
  const checkNowButton = document.createElement('button');
  checkNowButton.type = 'button';
  checkNowButton.id = 'options-check-now-button';
  checkNowButton.textContent = t('dialog.options.checkNow');
  checkNowButton.addEventListener('click', () => handleCheckForUpdates(checkNowButton));
  updatesActions.appendChild(checkNowButton);
  dialog.appendChild(updatesActions);

  // --- Info ---
  const infoHeading = document.createElement('h3');
  infoHeading.className = 'modal-section-heading';
  infoHeading.textContent = t('dialog.options.sectionInfo');
  dialog.appendChild(infoHeading);

  const versionText = document.createElement('p');
  versionText.className = 'modal-row-hint';
  versionText.textContent = t('dialog.options.version', { version: currentSettings.appVersion });
  dialog.appendChild(versionText);

  const infoActions = document.createElement('div');
  infoActions.className = 'modal-info-actions';
  // Hidden while the repository URL is still the placeholder committed
  // before this project had a real GitHub remote (see deriveRepositoryUrl()
  // in main.js) — self-corrects once that's fixed, no code change needed.
  if (currentSettings.repositoryUrl) {
    const githubButton = document.createElement('button');
    githubButton.type = 'button';
    githubButton.textContent = t('dialog.options.viewOnGithub');
    githubButton.addEventListener('click', () => window.api.openExternal(currentSettings.repositoryUrl));
    infoActions.appendChild(githubButton);
  }
  const acknowledgmentsButton = document.createElement('button');
  acknowledgmentsButton.type = 'button';
  acknowledgmentsButton.textContent = t('dialog.options.acknowledgments');
  acknowledgmentsButton.addEventListener('click', showAcknowledgmentsDialog);
  infoActions.appendChild(acknowledgmentsButton);
  dialog.appendChild(infoActions);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = t('dialog.options.close');
  closeButton.classList.add('modal-escape-close');
  closeButton.addEventListener('click', () => overlay.remove());
  actions.appendChild(closeButton);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  setupModalDialog(overlay, dialog, heading);
}

optionsButton.addEventListener('click', showOptionsDialog);

function showAcknowledgmentsDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  const heading = document.createElement('h2');
  heading.textContent = t('dialog.acknowledgments.heading');
  dialog.appendChild(heading);

  for (const entry of ACKNOWLEDGMENTS) {
    const row = document.createElement('div');
    row.className = 'modal-row';

    const nameEl = document.createElement('span');
    nameEl.textContent = entry.noteKey ? `${entry.name} — ${t(entry.noteKey)}` : entry.name;
    row.appendChild(nameEl);

    const licenseLink = document.createElement('a');
    licenseLink.href = entry.licenseUrl;
    licenseLink.textContent = entry.licenseType;
    licenseLink.addEventListener('click', (event) => {
      event.preventDefault();
      window.api.openExternal(entry.licenseUrl);
    });
    row.appendChild(licenseLink);

    dialog.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = t('dialog.acknowledgments.close');
  closeButton.classList.add('modal-escape-close');
  closeButton.addEventListener('click', () => overlay.remove());
  actions.appendChild(closeButton);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  setupModalDialog(overlay, dialog, heading);
}

// --- Close ---------------------------------------------------------------------
// Only removes it from the canvas, never deletes the file. Asks first on
// unsaved changes (save/discard/cancel) — deliberately a different path
// than the delete dialog for empty documents.
async function closeDocument(doc) {
  if (!doc.dirty) {
    store.removeDocument(doc.id);
    return;
  }

  const choice = await window.api.confirmCloseWithUnsavedChanges(doc.displayName);
  if (choice === 'cancel') return;
  if (choice === 'save') {
    await saveDocuments([doc]);
    // The save may have failed, or (for an empty document) been cancelled
    // in the combined dialog — the document is then deliberately kept
    // open instead of closing it anyway.
    if (doc.dirty) return;
  }
  store.removeDocument(doc.id);
}

async function handleDocumentContextMenu(doc, event) {
  event.preventDefault();
  event.stopPropagation(); // avoid also triggering the canvas context menu
  const action = await window.api.showDocumentContextMenu('document');
  if (action === 'save') saveDocuments([doc]);
  else if (action === 'close') closeDocument(doc);
}

// "Save all" also available via right-click on the empty canvas — only
// outside every document container: a right-click on a
// document/page is already handled by their own context menus (see above).
async function handleCanvasContextMenu(event) {
  if (event.target.closest('.document-container')) return;
  event.preventDefault();
  const action = await window.api.showDocumentContextMenu('canvas');
  if (action === 'save-all') saveDocuments(store.documents.filter((doc) => doc.dirty));
}

canvasView.addEventListener('contextmenu', handleCanvasContextMenu);
gridView.addEventListener('contextmenu', handleCanvasContextMenu);

saveAllButton.addEventListener('click', () => saveDocuments(store.documents.filter((doc) => doc.dirty)));

// Zooms so that the point under the cursor stays fixed (instead of
// anchoring top-left): equate the point's screen position before and after
// the zoom change and compensate for the difference via a scroll offset.
// Only works reliably with CSS `zoom` (not `transform: scale`), because
// `zoom` consistently scales layout/scroll extents along with it.
//
// This used to have a separate Y-only anchor lookup for Grid view
// (`findClosestSlotByRow`), because `flex-wrap` could recompute which row a
// page belonged to on every zoom step. Since Grid view now uses a fixed
// column count (CSS Grid instead of flex-wrap, see renderGridView), zooming
// never changes which page sits in which row anymore — the simple
// `elementFromPoint` hit test used in Canvas mode is therefore now
// sufficient here too.

function zoomAtPoint(state, clientX, clientY, factor, findAnchor) {
  const oldZoom = state.zoom;
  const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor));
  if (newZoom === oldZoom) return;

  // Instead of extrapolating linearly, track an anchor element: in both
  // Canvas and Grid mode, the layout can shift non-linearly while zooming
  // (Grid: row wraps) — a pure scaling calculation would be systematically
  // off there.
  //
  // The anchor is determined only **once per continuous zoom gesture** (not
  // freshly on every single wheel tick) and kept for its duration
  // (`state.activeAnchor`, reset once the rebake completes). Especially
  // near the end of a trackpad pinch gesture, the OS often delivers very
  // small, noisy deltaY values; re-searching the anchor on every one of
  // these ticks could make it jump back and forth between two almost
  // equally close elements — with a scroll correction that ended up far too
  // large relative to the actually tiny zoom change, reading as
  // jitter/jumping.
  if (!state.activeAnchor?.el.isConnected) {
    const el = findAnchor(state.container, clientX, clientY);
    if (el) {
      const r = el.getBoundingClientRect();
      state.activeAnchor = {
        el,
        fractionX: r.width > 0 ? (clientX - r.left) / r.width : 0.5,
        fractionY: r.height > 0 ? (clientY - r.top) / r.height : 0.5,
      };
    } else {
      state.activeAnchor = null;
    }
  }
  const anchor = state.activeAnchor;
  const beforeRect = anchor?.el.getBoundingClientRect();

  state.zoom = newZoom;
  // Only the portion since the last sharp render (`bakedZoom`) is visually
  // scaled via CSS — the already-rasterized portion is already contained in
  // the canvas pixels. `state.zoom / state.bakedZoom` is mathematically
  // equivalent to `state.zoom` as long as no rebake has happened yet.
  state.wrapper.style.zoom = String(state.zoom / state.bakedZoom);

  if (anchor) {
    const afterRect = anchor.el.getBoundingClientRect();
    const beforePointX = beforeRect.left + anchor.fractionX * beforeRect.width;
    const beforePointY = beforeRect.top + anchor.fractionY * beforeRect.height;
    const afterPointX = afterRect.left + anchor.fractionX * afterRect.width;
    const afterPointY = afterRect.top + anchor.fractionY * afterRect.height;
    state.container.scrollLeft += afterPointX - beforePointX;
    state.container.scrollTop += afterPointY - beforePointY;
  }

  scheduleRebake(state);
}

// After a brief pause with no further zoom input, sharply re-render all
// currently rendered pages at the actual target resolution (instead of
// permanently leaving them only visually scaled up via CSS, and therefore
// blurry). Runs through the same concurrency-limited queue as the
// virtualization, so it doesn't burden the main process any more
// than the normal loading that happens while scrolling.
function scheduleRebake(state) {
  clearTimeout(state.rebakeTimer);
  state.rebakeTimer = setTimeout(async () => {
    // `rebakeTimer`/`rebakeRunning` together answer "is this view still going
    // to change on its own?". Only isViewIdleForTests() reads them; the app
    // itself doesn't need to know, but a test does — measuring or clicking
    // while a rebake is about to swap every canvas element out produces
    // results that depend purely on timing (a second click landing mid-swap
    // is dropped by the browser, since its target no longer matches the
    // first click's).
    state.rebakeTimer = null;
    state.rebakeRunning = true;
    const slots = [...state.container.querySelectorAll('.page-slot.rendered')];
    const targetZoom = state.zoom; // snapshot: the debounce guarantees stability while the batch runs

    // First fully render ALL pages in the background without touching the
    // DOM — only commit once everything is truly ready. Inserting each page
    // immediately as it finishes (an earlier version did this) would show
    // already-finished pages at their new, sharp target size while their
    // still-waiting neighbors AND the surrounding `gap`/`padding` spacing
    // (properties of the parent element, not correctable per page) stayed
    // at the old, only visually scaled-up size — visible size/spacing
    // flicker while sharpening.
    const results = await Promise.all(
      slots.map(async (slot) => {
        const info = slotRenderInfo.get(slot);
        if (!info || !slot.isConnected) return null;
        try {
          const canvas = await new Promise((resolve, reject) => {
            renderQueue.add(() =>
              computeCanvas(info.page, targetZoom, info.baseScale).then(resolve, reject),
            );
          });
          return { slot, canvas };
        } catch (error) {
          log(`Re-render failed: ${error}`);
          return null;
        }
      }),
    );

    // Synchronous from here on: inserting canvases, resetting the wrapper
    // zoom, and recomputing placeholder/column sizes all happen in one go,
    // without giving the browser a chance for an in-between repaint.
    for (const result of results) {
      if (!result || !result.slot.isConnected) continue;
      result.slot.replaceChildren(result.canvas);
      syncCanvasColumnHeaderWidth(result.slot, result.canvas);
    }
    state.bakedZoom = targetZoom;
    state.wrapper.style.zoom = '1';
    // Still-invisible placeholders and (Canvas) the column width had so far
    // only grown "on loan" via the wrapper's CSS zoom scaling. Once that
    // resets to 1, they need to bring their own pixel size to the newly
    // baked zoom level — otherwise they visibly shrink back ("zoom jumps").
    applyBakedSizes(state);
    // The gesture counts as finished — the next zoom input looks for a
    // fresh anchor at the then-current cursor position again.
    state.activeAnchor = null;
    state.rebakeRunning = false;
  }, 200);
}

// True when neither view still has a re-raster pending or in flight, i.e.
// nothing is going to move or be replaced on its own any more. Used by the
// CDP test harness to wait for a settled view instead of sleeping a fixed
// amount and hoping — see the comment inside scheduleRebake().
function isViewIdleForTests() {
  return [canvasZoomState, gridZoomState]
    .every((state) => !state.rebakeTimer && !state.rebakeRunning);
}

// Manually zooming/panning while in focus mode automatically exits it.
function attachZoomHandler(state, findAnchor) {
  state.container.addEventListener(
    'wheel',
    (event) => {
      if (focusedSlot) exitFocusMode();

      if (!event.ctrlKey) return; // a pinch gesture arrives in Chromium as wheel+ctrlKey
      event.preventDefault();
      // Scale exponentially instead of linearly: guaranteed to stay
      // positive for any deltaY (a single mouse-wheel notch often delivers
      // exactly deltaY = ±100 — with a linear factor like `1 - deltaY *
      // 0.01`, that would tip the multiplier to 0 or negative before
      // clamping).
      const factor = Math.pow(1.002, -event.deltaY);
      zoomAtPoint(state, event.clientX, event.clientY, factor, findAnchor);
    },
    { passive: false },
  );
}

// Both views: a simple hit test at the mouse position as anchor (see
// comment above — only unproblematic for Grid view since the fixed column
// count).
const simplePointAnchor = (container, x, y) => document.elementFromPoint(x, y);
attachZoomHandler(canvasZoomState, simplePointAnchor);
attachZoomHandler(gridZoomState, simplePointAnchor);

let panState = null;

canvasView.addEventListener('mousedown', (event) => {
  // Only pan on empty area, not when clicking on a document column/page
  // (3.1: dragging on empty area moves the canvas).
  if (event.target !== canvasView && event.target !== canvasZoomWrapper) return;

  if (focusedSlot) exitFocusMode();

  panState = {
    startX: event.clientX,
    startY: event.clientY,
    startScrollLeft: canvasView.scrollLeft,
    startScrollTop: canvasView.scrollTop,
  };
  canvasView.classList.add('panning');
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!panState) return;
  canvasView.scrollLeft = panState.startScrollLeft - (event.clientX - panState.startX);
  canvasView.scrollTop = panState.startScrollTop - (event.clientY - panState.startY);
});

window.addEventListener('mouseup', () => {
  if (!panState) return;
  panState = null;
  canvasView.classList.remove('panning');
});

function highlightExistingDocument(existingDoc) {
  const entry = getActiveContainer().querySelector(`[data-document-id="${existingDoc.id}"]`);
  if (!entry) return;
  entry.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  entry.classList.add('highlight');
  setTimeout(() => entry.classList.remove('highlight'), 1200);
}

// pdf.js transfers the given ArrayBuffer to its worker (the buffer becomes
// "detached" afterward). Since `bytes` is identical to the array stored as
// `snapshotBytes` (for "restore original"), a copy must always
// be passed here.
function loadPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}

// Keeps track of how a slot should (re-)render — stays around even after
// the first render (unlike `pendingRenders`), so scheduleRebake() can
// sharply re-draw already-rendered pages at a new zoom level without
// having to look up the document/page reference again.
const slotRenderInfo = new WeakMap(); // page-slot element -> { state, baseScale, doc, page }

// Renders a page into a new (not yet attached) canvas. Deliberately doesn't
// touch the DOM — callers decide when/whether the result is actually
// inserted (see renderPageIntoSlot vs. scheduleRebake).
async function computeCanvas(page, targetZoom, baseScale) {
  const scale = baseScale * targetZoom;
  const pdf = pdfProxies.get(page.source.id);
  const pdfPage = await pdf.getPage(page.sourcePageIndex + 1);
  const viewport = pdfPage.getViewport({ scale, rotation: page.rotation });

  const canvas = document.createElement('canvas');
  canvas.className = 'page-thumb';
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const context = canvas.getContext('2d');
  await pdfPage.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function renderPageIntoSlot(slot) {
  const info = slotRenderInfo.get(slot);
  // May have been removed from the DOM in the meantime by a full re-render
  // (e.g. because another document was opened) while the task was still
  // sitting in the queue.
  if (!info || !slot.isConnected) return;

  const { state, baseScale, page } = info;
  // Deliberately render at `bakedZoom`, not the current `zoom` target: this
  // function handles a page becoming visible for the first time (e.g. while
  // scrolling), even in the middle of an ongoing zoom gesture. If the
  // target resolution were rasterized here already, this one page alone
  // would look different (sharp/correctly sized) than its still blurrily
  // scaled-along siblings AND than the still ambiently scaled `gap`/
  // `padding` of the parent element surrounding it — that can't be
  // corrected per page, because spacing belongs to the container, not the
  // child. The jump to the actual target resolution is
  // handled exclusively by scheduleRebake(), collectively and atomically
  // for all pages and spacing together.
  const canvas = await computeCanvas(page, state.bakedZoom, baseScale);
  if (!slot.isConnected) return;

  slot.replaceChildren(canvas);
  slot.style.width = '';
  slot.style.height = '';
  slot.classList.add('rendered');
  syncCanvasColumnHeaderWidth(slot, canvas);
}

// The sticky label (section header) of a Canvas column should be exactly as
// wide as the actually rendered page below it, not the column itself — the
// column is sized for the largest page across ALL open documents
// (syncDerivedCellSizes), so for any smaller page the label would otherwise
// come out wider than it. Paired with `margin-inline: auto` in the
// stylesheet, which keeps the narrowed label centered over its equally
// centered page. A no-op in Grid view (no `.canvas-column` ancestor there).
function syncCanvasColumnHeaderWidth(slot, canvas) {
  const header = slot.closest('.canvas-column')?.querySelector('.section-header');
  if (header) header.style.width = `${canvas.width}px`;
}

// Placeholder slot: appears exclusively when the entire
// document contains no more pages — not already when individual pages are
// removed (the empty/shorter `doc.pages` loop in renderDocumentPages
// handles that by itself). Dashed border, no text, no click/drag listeners
// (there's no Page behind it). Still rendered at placeholder size (not
// 0×0) — otherwise the hit area for computeDropTarget() when dragging pages
// back onto this document would only be as big as the section header. The
// actual reactivation needs no special case: store.movePages()/
// createDocumentFromPages() insert pages into `doc.pages` completely
// normally, the document itself was never removed from `store.documents`
// (see Document.isEmpty), so the next store change automatically renders
// normal pages again instead of the placeholder.
function createPlaceholderSlot(state) {
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder-slot';
  // No page behind it, so it gets the shared cell — exactly one max-sized
  // page, which is also what makes it a sensible drop target.
  const size = slotSizeFor(state, state.baseScale, null);
  placeholder.style.width = `${size.width * state.bakedZoom}px`;
  placeholder.style.height = `${size.height * state.bakedZoom}px`;
  return placeholder;
}

function renderDocumentPages(state, baseScale, doc, container, observer) {
  if (doc.isEmpty) {
    container.appendChild(createPlaceholderSlot(state));
    return;
  }

  for (const page of doc.pages) {
    const slot = document.createElement('div');
    slot.className = 'page-slot';
    // Sized from this page's own dimensions, so the slot already occupies
    // exactly the space the rasterized page will need and nothing shifts
    // when it lands. Computed for the current (just baked, see
    // resetZoomBaking) zoom level, not the unscaled base size — otherwise a
    // newly opened document would look the wrong size in the middle of an
    // ongoing zoom gesture.
    const slotSize = slotSizeFor(state, baseScale, page);
    slot.style.width = `${slotSize.width * state.bakedZoom}px`;
    slot.style.height = `${slotSize.height * state.bakedZoom}px`;
    slot.dataset.pageId = page.id;
    slot.classList.toggle('selected', selectedPageIds.has(page.id));
    slot.draggable = true;
    slot.addEventListener('click', (event) => handlePageClick(page, event));
    slot.addEventListener('dblclick', () => toggleFocusMode(slot));
    slot.addEventListener('dragstart', (event) => startPageDrag(page, event));
    slot.addEventListener('dragend', cleanupDrag);
    slot.addEventListener('contextmenu', (event) => handlePageContextMenu(page, event));
    container.appendChild(slot);

    slotRenderInfo.set(slot, { state, baseScale, doc, page });
    pendingRenders.set(slot, () =>
      renderPageIntoSlot(slot).catch((error) => {
        log(`Rendering failed (${doc.displayName}): ${error}`);
      }),
    );
    observer.observe(slot);
  }
}

// Section header: one component, built identically in both views (filename,
// unsaved dot, save button, close button) — only the placement (see CSS)
// differs.
function createSectionHeader(doc) {
  const header = document.createElement('div');
  header.className = 'section-header';
  // Reorder the whole document by dragging the header — in
  // Canvas left/right between document columns, in Grid up/down between
  // sections. A separate drag mechanism (documentDragPayload) alongside the
  // page drag, see startDocumentDrag().
  header.draggable = true;
  header.addEventListener('dragstart', (event) => startDocumentDrag(doc.id, event));
  header.addEventListener('dragend', cleanupDocumentDrag);
  // Save/close also available via right-click, not only
  // via the icon buttons.
  header.addEventListener('contextmenu', (event) => handleDocumentContextMenu(doc, event));

  const name = document.createElement('span');
  name.className = 'section-header-name';
  name.textContent = doc.displayName;
  header.appendChild(name);

  if (doc.dirty) {
    const dot = document.createElement('span');
    dot.className = 'dirty-dot';
    dot.textContent = '●';
    dot.title = t('sectionHeader.unsavedTitle');
    header.appendChild(dot);
  }

  // Directly after the filename/dot, not right-aligned — the spacer comes
  // after this and fills the remaining space (if the header is wider than
  // its content), instead of pushing the icons to the right edge.
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'icon-button save-button';
  saveButton.appendChild(createIcon('device-floppy', { size: 14 }));
  saveButton.title = doc.dirty ? t('sectionHeader.saveTitle') : t('sectionHeader.saveDisabledTitle');
  saveButton.disabled = !doc.dirty;
  saveButton.addEventListener('click', () => saveDocuments([doc]));
  header.appendChild(saveButton);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-button';
  closeButton.appendChild(createIcon('x', { size: 14 }));
  closeButton.title = t('sectionHeader.closeTitle');
  closeButton.addEventListener('click', () => closeDocument(doc));
  header.appendChild(closeButton);

  const spacer = document.createElement('span');
  spacer.className = 'section-header-spacer';
  header.appendChild(spacer);

  return header;
}

// A full rebuild (every store change rebuilds everything, see
// renderActiveView) produces all-fresh slots, which get rasterized at the
// current zoom level on their first render anyway — the still-pending CSS
// scale-up left over from an ongoing zoom gesture (if one was in progress)
// therefore needs to be reset, otherwise the new, already correctly
// resolved pages would get scaled up an extra time.
function resetZoomBaking(state) {
  clearTimeout(state.rebakeTimer);
  state.bakedZoom = state.zoom;
  state.wrapper.style.zoom = '1';
  applyBakedSizes(state);
}

function renderCanvasView() {
  resetZoomBaking(canvasZoomState);
  canvasZoomWrapper.innerHTML = '';
  const observer = createViewObserver(canvasView);
  for (const doc of store.documents) {
    const column = document.createElement('div');
    column.className = 'canvas-column document-container';
    column.dataset.documentId = doc.id;
    column.style.width = `${canvasZoomState.columnWidth * canvasZoomState.bakedZoom}px`;

    column.appendChild(createSectionHeader(doc));

    const pagesWrap = document.createElement('div');
    pagesWrap.className = 'canvas-pages';
    column.appendChild(pagesWrap);

    canvasZoomWrapper.appendChild(column);
    renderDocumentPages(canvasZoomState, BASE_CANVAS_SCALE, doc, pagesWrap, observer);
  }
}

function renderGridView() {
  resetZoomBaking(gridZoomState);
  gridZoomWrapper.innerHTML = '';
  const observer = createViewObserver(gridView);
  store.documents.forEach((doc, index) => {
    const section = document.createElement('div');
    section.className = `grid-section document-container ${index % 2 === 0 ? 'tone-a' : 'tone-b'}`;
    section.dataset.documentId = doc.id;

    section.appendChild(createSectionHeader(doc));

    const grid = document.createElement('div');
    grid.className = 'grid-pages';
    // Fixed column count instead of automatic wrapping: "--"
    // (gridColumnsPerRow === 'all') means "whole document in one row" — set
    // the column count individually to this document's actual page count
    // for that (not e.g. some very large flat number, which would just
    // define unnecessarily many empty grid columns).
    const columns = gridColumnsPerRow === 'all' ? Math.max(1, doc.pages.length) : gridColumnsPerRow;
    // One shared track width (CSS var instead of `max-content`) — see
    // syncDerivedCellSizes: ensures all documents with the same column count
    // have exactly the same total width (and therefore centering),
    // regardless of their respective actual page count.
    grid.style.gridTemplateColumns = `repeat(${columns}, var(--grid-col-width))`;
    section.appendChild(grid);

    gridZoomWrapper.appendChild(section);
    renderDocumentPages(gridZoomState, BASE_GRID_SCALE, doc, grid, observer);
  });
}

function renderActiveView() {
  // Before either view is built: both of them read the derived cell size
  // while laying out (column width, grid track width, slot sizes).
  syncDerivedCellSizes();
  const hasDocuments = store.documents.length > 0;
  emptyState.classList.toggle('hidden', hasDocuments);
  canvasView.classList.toggle('hidden', !hasDocuments || currentView !== 'canvas');
  gridView.classList.toggle('hidden', !hasDocuments || currentView !== 'grid');
  updateSaveAllButtonState();

  if (!hasDocuments) return;

  if (currentView === 'canvas') {
    renderCanvasView();
  } else {
    renderGridView();
  }
}

store.subscribe(renderActiveView);

function setView(view) {
  // Switching views while focus mode (Canvas) is active exits it —
  // otherwise the focused page would remain stuck as a hidden, but still
  // `.focused`-marked full-screen overlay in state, and would unexpectedly
  // pop back up when switching back to Canvas.
  if (focusedSlot) exitFocusMode();
  currentView = view;
  canvasViewButton.classList.toggle('active', view === 'canvas');
  gridViewButton.classList.toggle('active', view === 'grid');
  gridColumnsLabel.classList.toggle('hidden', view !== 'grid');
  renderActiveView();
}

canvasViewButton.addEventListener('click', () => setView('canvas'));
gridViewButton.addEventListener('click', () => setView('grid'));

gridColumnsSelect.addEventListener('change', () => {
  const value = gridColumnsSelect.value;
  gridColumnsPerRow = value === 'all' ? 'all' : Number(value);
  if (currentView === 'grid') renderActiveView();
});

// Central place for every way to open files (dialog, drag & drop, menu):
// detects already-open files and appends new documents in selection
// order to the right (Canvas) or bottom (Grid).
//
// Error handling & robustness: two independent error sources per
// file, neither should abort the rest of the open operation, just skip that
// one file — and both should be visible (not just in the log, which the
// user normally never sees):
// 1. Read error in the main process (missing permissions, externally
//    deleted/very large file) — already comes back as `{ filePath, error }`
//    from the IPC call, see readPdfFile() in main.js.
// 2. Parse/content error (corrupt file, not a valid PDF, password-
//    protected) — thrown while loading with pdf.js. `PasswordException` is
//    detected specifically for a more meaningful message; a dedicated
//    password-entry dialog is deliberately not part of this phase (not
//    called for in the concept, would go beyond its scope).
// Several failures in the same open operation are collected and combined
// into ONE toast at the end instead of shown one after another — the toast
// is a single element with no queue, several rapid showToast() calls in the
// same loop would otherwise overwrite each other and only the last message
// would ever be visible.
async function handleOpenedFiles(fileInfos) {
  const failures = [];

  for (const info of fileInfos) {
    const { filePath } = info;
    const name = filePath.split(/[\\/]/).pop();

    if (info.error) {
      log(`File could not be read (${filePath}): ${info.error}`);
      failures.push(`${name} (${t('toast.reasonUnreadable')})`);
      continue;
    }

    const existingDoc = store.findByFilePath(filePath);
    if (existingDoc) {
      showToast(t('toast.alreadyOpen', { name: existingDoc.displayName }));
      highlightExistingDocument(existingDoc);
      log(`Already open, focused: ${filePath}`);
      continue;
    }

    try {
      const pdf = await loadPdf(info.bytes);
      // A 0-page PDF is technically valid but unusable here — without this
      // explicit check, `doc.pages[0]` below would throw on the empty pages
      // array and get reported via the same catch/reasonCorrupted path
      // anyway, just by accident rather than intent.
      if (pdf.numPages === 0) throw new Error('PDF has no pages');
      // Measured BEFORE addDocument() on purpose, and this ordering has to
      // stay: addDocument() notifies, which rebuilds the view, which derives
      // the shared cell size from these sizes (see syncDerivedCellSizes).
      // Moving the measurement into the background to speed up opening a
      // huge file would mean the first build lays out against an incomplete
      // maximum — that variant needs an explicit re-render once the
      // measurement lands, which is exactly the hook this ordering avoids.
      const pageSizes = await readPageSizes(pdf);
      const doc = createDocumentFromFile(filePath, info.bytes, pdf.numPages);
      pdfProxies.set(doc.pages[0].source.id, pdf);
      pdfPageSizes.set(doc.pages[0].source.id, pageSizes);
      store.addDocument(doc);
      log(`Opened: ${filePath} (${pdf.numPages} pages)`);
    } catch (error) {
      log(`Failed to open ${filePath}: ${error}`);
      const reason = error instanceof pdfjsLib.PasswordException
        ? t('toast.reasonPasswordProtected')
        : t('toast.reasonCorrupted');
      failures.push(`${name} (${reason})`);
    }
  }

  if (failures.length === 1) {
    showToast(t('toast.couldNotBeOpened', { detail: failures[0] }));
  } else if (failures.length > 1) {
    showToast(t('toast.failedToOpenMultiple', { count: failures.length }));
  }
}

async function openViaDialog() {
  const fileInfos = await window.api.openPdfDialog();
  await handleOpenedFiles(fileInfos);
}

openButton.addEventListener('click', openViaDialog);
emptyOpenButton.addEventListener('click', openViaDialog);
window.api.onTriggerOpenDialog(openViaDialog);

// Native Edit menu (macOS — see buildMenu() in main.js): Undo/Redo call this
// app's own page-operation undo stack directly, and the four page-action
// items reuse applyPageAction() with the current selection — the exact same
// calls the keyboard shortcuts already make, just reached via a menu click
// instead of a keydown. Guarded the same way the keydown handler already
// is: a page action on an empty selection would otherwise still push a
// no-op undo snapshot and wipe the redo stack (store.mjs's mutation methods
// don't check for that themselves).
window.api.onTriggerEditAction((action) => {
  if (action === 'undo' || action === 'redo') {
    performUndoOrRedo(action === 'redo');
    return;
  }
  if (selectedPageIds.size === 0) return;
  applyPageAction(action, [...selectedPageIds]);
});

// Drag & drop from outside (Finder/Explorer) onto the whole canvas.
for (const eventName of ['dragover', 'drop']) {
  document.body.addEventListener(eventName, (event) => event.preventDefault());
}

// Visible feedback on the empty starting state while a file dragged in from
// outside hovers over the window. Count `dragenter`/`dragleave` instead of
// relying on `dragleave` alone: the latter also fires when crossing every
// child element (bubbling), so a single `dragleave` would wrongly remove
// the highlight already when hovering over the "Open…" button inside the
// drop zone. `types.includes('Files')` also specifically filters for
// external file drags — an internal page/document drag sets
// its own MIME types, not `Files`, and shouldn't trigger this highlight
// (also only relevant when the empty starting state is even visible in the
// first place).
let externalDragDepth = 0;
document.body.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  externalDragDepth += 1;
  emptyState.classList.add('drag-active');
});
document.body.addEventListener('dragleave', (event) => {
  // Same `types.includes('Files')` filter as dragenter above — without it,
  // an internal page/document drag (which sets its own MIME types, not
  // `Files`) would still decrement this counter, letting an interleaved
  // internal-drag-during-an-external-hover strip the highlight while a file
  // is still actually over the window.
  if (!event.dataTransfer?.types.includes('Files')) return;
  externalDragDepth = Math.max(0, externalDragDepth - 1);
  if (externalDragDepth === 0) emptyState.classList.remove('drag-active');
});

document.body.addEventListener('drop', async (event) => {
  externalDragDepth = 0;
  emptyState.classList.remove('drag-active');

  const files = [...event.dataTransfer.files].filter((file) => file.type === 'application/pdf');
  if (files.length === 0) return;

  const filePaths = files.map((file) => window.api.getPathForFile(file));
  const fileInfos = await window.api.readPdfFiles(filePaths);
  await handleOpenedFiles(fileInfos);
});

// Settings are read once here at startup (top-level `await` — this file is
// an ES module) rather than assumed as hardcoded literals: `currentView`/
// `gridColumnsPerRow` above keep their literal defaults as the fallback
// used before this resolves (and for any code path that could theoretically
// run before it, though none does in practice), but the actual startup
// values always come from here. `settings.locale` wins over the OS-detected
// `settings.systemLocale` once the user has ever picked a language in
// Options; until then, `matchLocale()` maps the OS locale onto one of this
// app's available languages, falling back to English.
currentSettings = await window.api.getSettings();
currentLocale = currentSettings.locale ?? matchLocale(currentSettings.systemLocale);
t = createTranslator(currentLocale);
applyStaticTranslations();
gridColumnsPerRow = currentSettings.gridColumnsPerRow;
gridColumnsSelect.value = String(gridColumnsPerRow);
setView(currentSettings.view); // also calls renderActiveView() internally

// Returns the renderer to its just-started state: no documents, no focus
// mode, no selection, zoom and scroll back at their defaults. Only ever
// called by the CDP test harness (test/helpers/cdp-session.mjs), between
// tests.
//
// It lives here rather than being assembled from the outside because all of
// the state it has to clear is module-private — and getting it complete
// matters: tests in one file share a single running renderer, so anything
// left behind leaks into the next test. A focus mode left active by a failed
// assertion once made the two following tests fail as well, reporting one
// real bug as three red tests.
function resetViewStateForTests() {
  exitFocusMode();

  for (const state of [canvasZoomState, gridZoomState]) {
    // A pending rebake would otherwise fire mid-next-test and re-raster
    // everything at the zoom level this reset is about to discard.
    clearTimeout(state.rebakeTimer);
    state.rebakeTimer = null;
    state.activeAnchor = null;
    state.zoom = 1;
    state.bakedZoom = 1;
    state.wrapper.style.zoom = '1';
    state.container.scrollLeft = 0;
    state.container.scrollTop = 0;
    applyBakedSizes(state);
  }

  selectedPageIds.clear();
  selectionAnchorPageId = null;

  // Removing documents notifies the store, which rebuilds the active view —
  // that rebuild should see the already-reset zoom/spacing values.
  for (const doc of [...store.documents]) store.removeDocument(doc.id);

  // renderActiveView() returns early once the last document is gone (it just
  // shows the empty state), so both view trees keep whatever slots they last
  // held. Harmless for the app, since both are hidden by then — but a test
  // querying `.page-slot` afterwards would still find the previous test's
  // pages. Clear them explicitly.
  canvasZoomWrapper.innerHTML = '';
  gridZoomWrapper.innerHTML = '';
}

// Re-exported for targeted verification (e.g. via the Chrome DevTools
// Protocol console) and automated tests; doesn't change its behavior
// as a page entry point, since browsers ignore a module script's exports as
// long as nobody imports it.
export {
  store,
  handleOpenedFiles,
  setView,
  renderPageIntoSlot,
  applyPageAction,
  saveDocuments,
  closeDocument,
  switchLocale,
  resetViewStateForTests,
  isViewIdleForTests,
};
