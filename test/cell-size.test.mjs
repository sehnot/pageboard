import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// The cell a page sits in (grid track / canvas column) used to be a fixed
// constant chosen well above any realistic page size. That left dead space
// around every page — for a corpus of uniformly small pages, far more dead
// space than page, which read as an absurdly airy grid even though the gap
// between cells was only 10px. The cell is now derived from the largest page
// across all open documents (syncDerivedCellSizes in renderer.js).
//
// What these tests pin down, in order of what would actually regress:
//  - the cell really does collapse onto the page (the original complaint),
//  - the maximum is GLOBAL, so documents still line up across sections,
//  - it is recomputed on rotate and on close without any explicit hook,
//  - it is measured from the CropBox, not the MediaBox.
//
// Deliberately not asserted: absolute page sizes. Those belong to the render
// scale, which this change does not touch.

const fixture = (dir, file) => path.join(testFilesDir, dir, file);

// Plain A4 (595.28 x 841.89pt), four pages, no intrinsic /Rotate.
const A4_FILE = fixture('004-pdflatex-4-pages', 'pdflatex-4-pages.pdf');
// One page at a small non-standard size (243 x 337.5pt) — small enough that a
// wrong maximum shows up as a large absolute error rather than a rounding one.
const SMALL_FILE = fixture('019-grayscale-image', 'grayscale-image.pdf');
// Four internally different page sizes, and — the point of using it here —
// a CropBox well inside its MediaBox, plus intrinsic /Rotate values.
const CROPPED_FILE = fixture('027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf');

const BASE_GRID_SCALE = 0.25;
const BASE_CANVAS_SCALE = 0.6;

// Mirrors syncDerivedCellSizes(): the cell is rounded up and gets one extra
// pixel so it can never come out narrower than the page it holds (which
// `max-width: 100%` would answer by scaling that page down).
const cellWidthFor = (pagePoints, scale) => Math.ceil(pagePoints * scale) + 1;

let session;

before(async () => {
  session = await startSession({ name: 'cell-size', port: CDP_PORTS.cellSize });
});

beforeEach(async () => {
  await session.reset();
});

after(async () => {
  await session?.close();
});

// The derived track width, read back the way the layout actually consumes it
// (a custom property on the zoom wrapper, applied by applyBakedSizes()).
async function gridTrackWidth() {
  const raw = await session.evaluate(`
    getComputedStyle(document.getElementById('grid-zoom-wrapper'))
      .getPropertyValue('--grid-col-width')
  `);
  return Number.parseFloat(raw);
}

function rectsOf(selector) {
  return session.evaluate(`
    [...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })
  `);
}

const centreX = (rect) => rect.left + rect.width / 2;

async function showGrid() {
  await session.evaluate(`__mod.setView('grid'); true`);
  await session.forceRenderAllSlots();
}

test('the grid track collapses onto the page instead of leaving dead space', async () => {
  await session.openFiles([A4_FILE]);
  await showGrid();

  const track = await gridTrackWidth();
  assert.equal(track, cellWidthFor(595.28, BASE_GRID_SCALE));

  // The actual complaint, stated as an invariant rather than as a number:
  // whatever the page renders at, the cell around it is at most a rounding
  // artefact wider. Before this change the same corpus gave 180 vs. 148.
  const canvases = await rectsOf('#grid-view canvas.page-thumb');
  const widest = Math.max(...canvases.map((r) => r.width));
  assert.ok(
    track - widest <= 2,
    `expected the track (${track}) to hug the widest page (${widest})`,
  );

  // And the slot hugs its canvas rather than being stretched across the
  // track by CSS Grid's default `justify-items: stretch` — which is what put
  // the dead space visibly to the RIGHT of every page.
  const slots = await rectsOf('#grid-view .page-slot');
  for (const [i, slot] of slots.entries()) {
    assert.ok(
      Math.abs(slot.width - canvases[i].width) <= 1,
      `slot ${i} (${slot.width}) should hug its canvas (${canvases[i].width})`,
    );
  }
});

test('the maximum is global: a small document keeps the large document\'s track and stays centred in it', async () => {
  await session.openFiles([A4_FILE, SMALL_FILE]);
  await showGrid();

  // Driven by the A4 file, not by each document's own pages.
  assert.equal(await gridTrackWidth(), cellWidthFor(595.28, BASE_GRID_SCALE));

  // Equal total width per section is what keeps every document centred at the
  // same spot; losing it was the original reason for a fixed track width at
  // all (see LESSONS.md, 2026-07-30).
  const grids = await rectsOf('#grid-view .grid-pages');
  assert.equal(grids.length, 2);
  assert.ok(
    Math.abs(grids[0].width - grids[1].width) < 1,
    `both sections should be equally wide (${grids[0].width} vs ${grids[1].width})`,
  );

  // Page 1 of both documents shares a column, so it shares a centre. Note
  // this is the centre, not the left edge: pages are centred in their cell
  // now, so a narrower page is inset by half the leftover room.
  const firstPages = await session.evaluate(`
    [...document.querySelectorAll('#grid-view .document-container')].map((section) => {
      const r = section.querySelector('.page-slot').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })
  `);
  assert.ok(
    Math.abs(centreX(firstPages[0]) - centreX(firstPages[1])) < 1,
    `page 1 of both documents should share a centre (${centreX(firstPages[0])} vs ${centreX(firstPages[1])})`,
  );

  // The smaller document must still render smaller — the dead space is gone,
  // the true size relationship is not.
  assert.ok(
    firstPages[1].width < firstPages[0].width * 0.5,
    'the 243pt-wide page should still render far smaller than the 595pt one',
  );
});

test('rotating one page to landscape raises the shared track width', async () => {
  await session.openFiles([A4_FILE]);
  await showGrid();
  assert.equal(await gridTrackWidth(), cellWidthFor(595.28, BASE_GRID_SCALE));

  await session.evaluate(`
    (() => {
      const page = __mod.store.documents[0].pages[0];
      __mod.applyPageAction('rotate-right', [page.id]);
      return true;
    })()
  `);
  await session.forceRenderAllSlots();

  // A4's height becomes the new maximum width. This is a deliberate
  // consequence of a global maximum, not an oversight: one landscape page
  // widens the cell for every portrait page too. The number is asserted so
  // that trade-off stays visible if anyone revisits it.
  assert.equal(await gridTrackWidth(), cellWidthFor(841.89, BASE_GRID_SCALE));
});

test('closing the document that held the largest page shrinks the track back down', async () => {
  await session.openFiles([A4_FILE, SMALL_FILE]);
  await showGrid();
  assert.equal(await gridTrackWidth(), cellWidthFor(595.28, BASE_GRID_SCALE));

  // Freshly opened, so it is not dirty and closes without a native prompt.
  await session.evaluate(`
    (() => {
      const doc = __mod.store.documents.find((d) => d.displayName === 'pdflatex-4-pages.pdf');
      __mod.closeDocument(doc);
      return true;
    })()
  `);
  await session.waitFor(`__mod.store.documents.length === 1`);
  await session.forceRenderAllSlots();

  // No explicit recomputation hook exists for this — it falls out of the
  // store notifying and the view re-deriving. That is the property under test.
  assert.equal(await gridTrackWidth(), cellWidthFor(243, BASE_GRID_SCALE));
});

test('the canvas column follows the same maximum, and its header stays centred over a narrower page', async () => {
  await session.openFiles([A4_FILE, SMALL_FILE]);
  await session.forceRenderAllSlots();

  const columns = await rectsOf('#canvas-view .canvas-column');
  const expected = cellWidthFor(595.28, BASE_CANVAS_SCALE);
  for (const column of columns) {
    assert.equal(column.width, expected);
  }

  // The header is sized to the page below it (syncCanvasColumnHeaderWidth).
  // Without `margin-inline: auto` it would stay pinned to the left of the
  // column while the page itself is centred — visibly out of line for every
  // document whose pages are narrower than the global maximum.
  const geometry = await session.evaluate(`
    [...document.querySelectorAll('#canvas-view .canvas-column')].map((column) => {
      const header = column.querySelector('.section-header').getBoundingClientRect();
      const page = column.querySelector('canvas.page-thumb').getBoundingClientRect();
      return {
        headerCentre: header.left + header.width / 2,
        pageCentre: page.left + page.width / 2,
      };
    })
  `);
  for (const { headerCentre, pageCentre } of geometry) {
    assert.ok(
      Math.abs(headerCentre - pageCentre) < 1,
      `header (${headerCentre}) should sit over its page (${pageCentre})`,
    );
  }
});

test('page sizes come from the CropBox, not the MediaBox', async () => {
  await session.openFiles([CROPPED_FILE]);
  await showGrid();

  // This fixture's widest page is 384pt after cropping; its MediaBox says
  // 600pt. Reading the MediaBox — or dropping the explicit `rotation: 0` from
  // the measurement, which would let pdf.js apply the intrinsic /Rotate and
  // report swapped dimensions — both land far outside this assertion.
  assert.equal(await gridTrackWidth(), cellWidthFor(384, BASE_GRID_SCALE));
});
