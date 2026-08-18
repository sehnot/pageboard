import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir, VIEWPORT } from './helpers/cdp-session.mjs';

// Focus mode (reworked based on user feedback after the initial
// implementation) had no automated coverage, even though two of the three
// most recently found bugs there were purely geometric/structural states
// (centered vs. left-aligned, which document is visible after a zoom exit)
// rather than subjective-visual ones. Those are exactly what CAN be asserted
// mechanically, with no pixel/screenshot comparison at all. What's
// deliberately NOT checked here: whether a zoom gesture feels smooth, whether
// sharpness/colors are right — that rightly stays part of the manual test
// checklist.
//
// Three files with genuinely different page dimensions from each other (not
// just different content) — needed to trigger the geometric edge cases this
// test targets. 004 is plain A4 (595x842), 019 is a small non-standard size
// (243x338), 027 has four internally different page sizes of its own
// (384x504/288x378/352x294/352x546).
//
// Those 027 numbers are its CROPBOX sizes, which is what pdf.js lays out
// from (`page.view`) and therefore what the app actually renders. They were
// previously recorded here as 600x720/450x540/550x420/550x780 — that is the
// MediaBox, i.e. the wrong box for this fixture in particular, whose whole
// point is that it is cropped. Re-measured via pdf.js
// (`getViewport({ scale: 1, rotation: 0 })`), the same call renderer.js uses.
const FOCUS_TEST_FILES = [
  ['004-pdflatex-4-pages', 'pdflatex-4-pages.pdf'],
  ['019-grayscale-image', 'grayscale-image.pdf'],
  ['027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf'],
].map(([dir, file]) => path.join(testFilesDir, dir, file));

// renderer.js zooms the focused page to fill this fraction of the window.
// Because the harness pins the viewport (see VIEWPORT), the resulting size is
// a known number rather than something that drifts with the OS's window
// chrome — which is what lets the assertions below be exact instead of the
// "at least 1.15x taller" they had to settle for before.
const FOCUS_MODE_FILL_RATIO = 0.92;
const EXPECTED_FOCUSED_HEIGHT = VIEWPORT.height * FOCUS_MODE_FILL_RATIO;

let session;

before(async () => {
  session = await startSession({ name: 'focus-mode', port: CDP_PORTS.focusMode });
});

// Each test starts from a clean slate. Previously all four shared one
// long-lived state, and a failing assertion left focus mode active — which
// made the following tests fail too, reporting one real bug as three red
// tests.
beforeEach(async () => {
  await session.reset();
  await session.openFiles(FOCUS_TEST_FILES);
});

after(async () => {
  await session?.close();
});

function rectOf(selector) {
  return session.evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()
  `);
}

// Waits until the view has finished re-rasterizing, then returns the
// element's box. Focus mode zooms and then re-rasters behind a 200ms debounce,
// so a rect read the instant the .focused class appears is not yet the final
// one — and clicking during that window is worse than merely imprecise (see
// waitForIdle() in the harness).
async function settledRectOf(selector) {
  await session.waitForIdle();
  return session.evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()
  `);
}

// Horizontal centre of the scroll container's CONTENT area, which is what the
// focused page is actually centred within — deliberately not the window's
// centre.
//
// `clientWidth` excludes a scrollbar; `innerWidth` does not. Where scrollbars
// take up layout space (Windows always, and the macOS CI runners too) the two
// differ by the scrollbar's width, so comparing against the window centre is
// off by half of it. That is precisely what happened: the assertion passed
// locally (macOS overlay scrollbars, centre exactly 500) and failed on both CI
// runners with 492.5 — identically, i.e. a real environment difference rather
// than flakiness. Measuring against the container makes the check
// scrollbar-independent, so the tolerance can stay tight everywhere.
function contentCentreX(view) {
  return session.evaluate(`
    (() => {
      const el = document.getElementById('${view}-view');
      return el.getBoundingClientRect().left + el.clientWidth / 2;
    })()
  `);
}

function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// A double-click as two real mouse clicks (clickCount 1, then 2) instead of a
// synthetic 'dblclick' event — this way it exercises the same
// click/click/dblclick sequence a real double-click triggers in the browser.
//
// All four events are written to the CDP socket before awaiting any of the
// replies. Awaiting each one individually (as this did originally) puts a full
// round trip between the first and second click, and under heavy CPU load that
// gap can exceed Chromium's double-click interval — the two clicks are then
// treated as unrelated single clicks, no dblclick is synthesized, and focus
// mode never opens. Reproduced by running the suite with twice as many busy
// processes as cores. Order is preserved: `send()` writes to the socket
// synchronously, and CDP processes messages in the order they arrive.
async function realDoubleClick(x, y) {
  const base = { x, y, button: 'left' };
  await Promise.all([
    session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount: 1 }),
    session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount: 1 }),
    session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount: 2 }),
    session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount: 2 }),
  ]);
}

// Double-clicks the given slot and waits until focus mode is actually active,
// rather than assuming the click landed. If it ever doesn't, the failure says
// so directly instead of surfacing as a confusing geometry assertion later.
async function focusByDoubleClick(selector) {
  const rect = await settledRectOf(selector);
  const c = centerOf(rect);
  await realDoubleClick(c.x, c.y);
  await session.waitFor(`!!document.querySelector('.page-slot.focused')`, {
    message: `double-click at (${Math.round(c.x)}, ${Math.round(c.y)}) did not enter focus mode`,
  });
  return rect;
}

async function exitFocusByDoubleClick() {
  const focused = await settledRectOf('.page-slot.focused');
  const c = centerOf(focused);
  await realDoubleClick(c.x, c.y);
  await session.waitFor(`!document.querySelector('.page-slot.focused')`, {
    message: 'second double-click did not leave focus mode',
  });
}

// `Input.dispatchMouseEvent` of type 'mouseWheel' reliably hangs over CDP
// against this Electron version — instead, construct and dispatch a real
// WheelEvent directly in the renderer, which triggers the exact same JS
// listener chain (attachZoomHandler).
async function dispatchCtrlWheel(x, y, deltaY) {
  await session.evaluate(`
    (() => {
      const container = document.getElementById('canvas-view').classList.contains('hidden')
        ? document.getElementById('grid-view')
        : document.getElementById('canvas-view');
      const event = new WheelEvent('wheel', {
        deltaY: ${deltaY}, ctrlKey: true, bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y},
      });
      container.dispatchEvent(event);
      return true;
    })()
  `);
}

// Switching views rebuilds the target view's DOM from scratch; its slots then
// need rasterizing before anything can be measured against them.
async function switchToView(view) {
  await session.evaluate(`__mod.setView('${view}')`);
  await session.waitFor(
    `document.querySelectorAll('#${view}-view .page-slot').length > 0`,
    { message: `${view} view never rendered any page slots` },
  );
  await session.forceRenderAllSlots();
}

test('double-click in Canvas mode enlarges the page to fill the frame and centers it horizontally', async () => {
  await switchToView('canvas');
  const before = await focusByDoubleClick('#canvas-view .page-slot');
  const focused = await settledRectOf('.page-slot.focused');

  // The page is zoomed to fill FOCUS_MODE_FILL_RATIO of the window on its
  // limiting axis — for these fixtures that's the height. With a pinned
  // viewport this is an exact expected number, so the assertion states the
  // actual contract ("fills 92% of the window") instead of the vague "grew a
  // bit" it had to use when the window size was unpredictable.
  assert.ok(
    Math.abs(focused.height - EXPECTED_FOCUSED_HEIGHT) < EXPECTED_FOCUSED_HEIGHT * 0.02,
    `focused page should fill ~${EXPECTED_FOCUSED_HEIGHT}px of height, got ${focused.height}`,
  );
  assert.ok(
    focused.height > before.height * 1.2,
    `page should be noticeably taller in focus mode (before ${before.height}, after ${focused.height})`,
  );

  const canvasCentre = await contentCentreX('canvas');
  assert.ok(
    Math.abs(centerOf(focused).x - canvasCentre) < 5,
    `page should be centered horizontally (center at ${centerOf(focused).x}, expected ${canvasCentre})`,
  );

  // Other documents are no longer visible in the meantime (rest of the canvas
  // hidden while focused).
  const otherDocsHidden = await session.evaluate(`
    [...document.querySelectorAll('#canvas-view .document-container')]
      .filter(el => !el.contains(document.querySelector('.focused')))
      .every(el => getComputedStyle(el).display === 'none')
  `);
  assert.equal(otherDocsHidden, true, 'other documents should be hidden during focus mode');
});

test('double-click in Grid also centers the page (regression test: used to be left-aligned)', async () => {
  await switchToView('grid');
  await focusByDoubleClick('#grid-view .page-slot');
  const focused = await settledRectOf('.page-slot.focused');

  // The bug this guards against left the page in column 1 of a still-N-columns
  // wide grid, i.e. far left rather than centered.
  const gridCentre = await contentCentreX('grid');
  assert.ok(
    Math.abs(centerOf(focused).x - gridCentre) < 5,
    `grid page should be centered horizontally, not left-aligned (center at ${centerOf(focused).x}, expected ${gridCentre})`,
  );
  assert.ok(
    Math.abs(focused.height - EXPECTED_FOCUSED_HEIGHT) < EXPECTED_FOCUSED_HEIGHT * 0.02,
    `focused page should fill ~${EXPECTED_FOCUSED_HEIGHT}px of height, got ${focused.height}`,
  );
});

test('a second double-click restores the previous zoom level/position', async () => {
  await switchToView('canvas');
  const before = await focusByDoubleClick('#canvas-view .page-slot');

  const focused = await settledRectOf('.page-slot.focused');
  assert.ok(focused.height > before.height * 1.2, 'page should be taller in focus mode');

  await exitFocusByDoubleClick();

  const after = await settledRectOf('#canvas-view .page-slot');
  assert.ok(
    Math.abs(after.width - before.width) < before.width * 0.15,
    `page size should be close to the original value again (before ${before.width}px, after ${after.width}px)`,
  );

  const allDocsVisible = await session.evaluate(`
    [...document.querySelectorAll('#canvas-view .document-container')].every(el => getComputedStyle(el).display !== 'none')
  `);
  assert.equal(allDocsVisible, true, 'all documents should be visible again after the restore');
});

test('manually zooming in focus mode exits it without jumping to the first page (regression test)', async () => {
  await switchToView('canvas');

  // Focus the third (last) document — a jump to the first page would be
  // clearly distinguishable here from correctly "staying in place", unlike
  // with the first document. Unlike the earlier tests in this file (which all
  // target the FIRST page-slot, already visible at scrollLeft 0), the third
  // document's column isn't guaranteed to be scrolled into view — scroll to it
  // first, otherwise its computed "center" coordinate could fall outside the
  // viewport and a real click dispatched there would hit nothing.
  const thirdDocId = await session.evaluate(`__mod.store.documents[2].id`);
  const thirdSlot = `.document-container[data-document-id="${thirdDocId}"] .page-slot`;
  await session.evaluate(`
    document.querySelector(${JSON.stringify(thirdSlot)})
      .scrollIntoView({ block: 'center', inline: 'center' });
    true;
  `);
  await focusByDoubleClick(thirdSlot);

  const focused = await settledRectOf('.page-slot.focused');
  const focusedCenter = centerOf(focused);

  await dispatchCtrlWheel(Math.round(focusedCenter.x), Math.round(focusedCenter.y), -20);
  await session.waitFor(`!document.querySelector('.page-slot.focused')`, {
    message: 'manual zoom should have ended focus mode',
  });

  // Exact centering after the exit isn't always geometrically possible — with
  // few/narrow documents, the scrollable area isn't enough at this zoom level
  // to push the last column all the way to the window center (the scroll then
  // hits its edge). The property actually guaranteed: no jump back to the
  // FIRST document (the reported bug), and the previously focused document
  // stays visible instead of being scrolled out of view.
  const firstDocId = await session.evaluate(`__mod.store.documents[0].id`);
  const docAtCenter = await session.evaluate(`
    document.elementFromPoint(${VIEWPORT.width / 2}, ${VIEWPORT.height / 2})?.closest('.document-container')?.dataset.documentId ?? null
  `);
  assert.notEqual(
    docAtCenter,
    firstDocId,
    `screen center should NOT have jumped to the first document (shows: ${docAtCenter})`,
  );

  const thirdDocVisible = await session.evaluate(`
    (() => {
      const el = document.querySelector('.document-container[data-document-id="${thirdDocId}"]');
      const r = el.getBoundingClientRect();
      return r.right > 0 && r.left < window.innerWidth;
    })()
  `);
  assert.equal(
    thirdDocVisible,
    true,
    'the previously focused document should still be at least partially visible',
  );
});
