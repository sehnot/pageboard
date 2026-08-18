import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// The views used to rebuild themselves from scratch (`wrapper.innerHTML = ''`)
// on every store change. That was affordable only because a rebuild produced
// nothing but empty placeholder slots — but it also discarded every ALREADY
// RASTERIZED page, so rotating one page, deleting one page or closing one
// document made the entire view blink and re-render. That blink is the reason
// page drag & drop needed its own {silent: true} bypass, and it makes any
// animation of a layout change pointless: nothing survives to animate from.
//
// The views now reconcile in place, keyed by document and page id. These tests
// pin down the four things that had to change with it and would each fail
// silently — as a performance regression or a stale-state bug, not a crash:
//
//   1. rasterized canvases actually survive an unrelated store change,
//   2. but a canvas whose page was rotated does NOT survive (it would show
//      the old orientation),
//   3. undo/redo keeps document and page ids, without which reconciliation
//      degenerates back into a full rebuild on every undo step,
//   4. header state that a rebuild used to reset by accident (the unsaved
//      dot) is now maintained explicitly, in both directions.
//
// A plain "does the app still work" test cannot see any of this: a full
// rebuild passes all of it except the identity assertions.

const fixture = (dir, file) => path.join(testFilesDir, dir, file);
const A4_FILE = fixture('004-pdflatex-4-pages', 'pdflatex-4-pages.pdf');
const SMALL_FILE = fixture('019-grayscale-image', 'grayscale-image.pdf');

let session;

before(async () => {
  session = await startSession({ name: 'reconciliation', port: CDP_PORTS.reconciliation });
});

beforeEach(async () => {
  await session.reset();
  await session.openFiles([A4_FILE, SMALL_FILE]);
});

after(async () => {
  await session?.close();
});

// Element identity has to be observed indirectly over CDP (nothing but JSON
// crosses the wire). Stamping each canvas and looking for the stamp afterwards
// answers exactly the question that matters: is this the same DOM node, or was
// it thrown away and rebuilt?
async function stampCanvases() {
  return session.evaluate(`
    (() => {
      const slots = [...document.querySelectorAll('#canvas-view .page-slot')];
      slots.forEach((slot, i) => {
        const canvas = slot.querySelector('canvas.page-thumb');
        if (canvas) canvas.dataset.stamp = 'stamp-' + i;
      });
      return slots.length;
    })()
  `);
}

// Per page id: whether that page's canvas still carries the stamp it was
// given. Keyed by page id rather than by position so a test can reorder or
// delete pages without the mapping silently shifting underneath it.
async function survivingStamps() {
  return session.evaluate(`
    Object.fromEntries(
      [...document.querySelectorAll('#canvas-view .page-slot')].map((slot) => [
        slot.dataset.pageId,
        slot.querySelector('canvas.page-thumb')?.dataset.stamp ?? null,
      ]),
    )
  `);
}

const pageIds = () =>
  session.evaluate(`__mod.store.documents.flatMap((d) => d.pages.map((p) => p.id))`);

test('rotating one page leaves every other page\'s rasterized canvas untouched', async () => {
  await stampCanvases();
  const before = await survivingStamps();
  const rotatedId = Object.keys(before)[0];

  await session.evaluate(`__mod.applyPageAction('rotate-right', [${JSON.stringify(rotatedId)}]); true`);
  await session.forceRenderAllSlots();

  const after = await survivingStamps();

  // The rotated page must lose its canvas — keeping it would leave the old
  // orientation on screen until something else happened to re-render it.
  assert.equal(after[rotatedId], null, 'the rotated page should have been re-rasterized');

  // Everything else keeps the exact canvas element it already had. Under the
  // old rebuild every one of these would be null.
  for (const [id, stamp] of Object.entries(after)) {
    if (id === rotatedId) continue;
    assert.equal(stamp, before[id], `page ${id} should have kept its canvas`);
  }
});

test('closing one document leaves the other document\'s canvases untouched', async () => {
  await stampCanvases();
  const before = await survivingStamps();

  await session.evaluate(`
    (() => {
      const doc = __mod.store.documents.find((d) => d.displayName === 'grayscale-image.pdf');
      __mod.closeDocument(doc);
      return true;
    })()
  `);
  await session.waitFor(`__mod.store.documents.length === 1`);
  await session.forceRenderAllSlots();

  const after = await survivingStamps();
  assert.ok(Object.keys(after).length > 0, 'the surviving document should still show pages');
  for (const [id, stamp] of Object.entries(after)) {
    assert.equal(stamp, before[id], `page ${id} should have kept its canvas`);
  }
});

test('deleting a page leaves its neighbours\' canvases untouched', async () => {
  await stampCanvases();
  const before = await survivingStamps();
  const deletedId = Object.keys(before)[1];

  await session.evaluate(`__mod.applyPageAction('delete', [${JSON.stringify(deletedId)}]); true`);
  await session.forceRenderAllSlots();

  const after = await survivingStamps();
  assert.ok(!(deletedId in after), 'the deleted page should be gone from the DOM');
  for (const [id, stamp] of Object.entries(after)) {
    assert.equal(stamp, before[id], `page ${id} should have kept its canvas`);
  }
});

test('rendering a slot twice is a no-op, not a second rasterization', async () => {
  await stampCanvases();
  const before = await survivingStamps();

  // Nothing guarantees renderPageIntoSlot() runs once per slot: the
  // IntersectionObserver can still hold a queued task for a slot that a
  // direct call already rendered. Unguarded, that second run swapped in an
  // identical canvas — wasted work in the app, and here it silently replaced
  // the element under observation.
  //
  // This reproduces it deterministically. It surfaced as a Windows-only CI
  // failure of the test below, because the observer stays paused in an
  // unfocused window (macOS) and actually fires in a visible one.
  await session.evaluate(`
    Promise.all(
      [...document.querySelectorAll('#canvas-view .page-slot')]
        .map((slot) => __mod.renderPageIntoSlot(slot)),
    ).then(() => true)
  `);

  assert.deepEqual(
    await survivingStamps(),
    before,
    'a redundant render should have left every canvas exactly as it was',
  );
});

test('undo and redo preserve page identity instead of minting new ids', async () => {
  const originalIds = await pageIds();
  const targetId = originalIds[0];

  await session.evaluate(`__mod.applyPageAction('delete', [${JSON.stringify(targetId)}]); true`);
  await session.evaluate(`__mod.store.undo(); true`);
  await session.forceRenderAllSlots();

  // Restoring rebuilds Document/Page instances from a plain-data snapshot.
  // Without the ids being part of that snapshot every page would come back as
  // a stranger, and reconciliation would discard and re-rasterize the entire
  // view on every single undo step — the exact cost this change removes.
  assert.deepEqual(await pageIds(), originalIds, 'undo should restore the same page ids');

  await session.evaluate(`__mod.store.redo(); true`);
  await session.forceRenderAllSlots();
  assert.deepEqual(
    await pageIds(),
    originalIds.filter((id) => id !== targetId),
    'redo should reapply the deletion without renaming the remaining pages',
  );
});

test('a selection survives an undo', async () => {
  const ids = await pageIds();
  const selected = ids[2];

  await session.evaluate(`
    (() => {
      const slot = document.querySelector('#canvas-view .page-slot[data-page-id="${selected}"]');
      slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()
  `);
  await session.evaluate(`__mod.applyPageAction('rotate-right', [${JSON.stringify(ids[0])}]); true`);
  await session.evaluate(`__mod.store.undo(); true`);
  await session.forceRenderAllSlots();

  // Follows from stable ids: the selection is a Set of page ids, so it used to
  // quietly stop matching anything after any undo.
  const stillSelected = await session.evaluate(`
    [...document.querySelectorAll('#canvas-view .page-slot.selected')].map((s) => s.dataset.pageId)
  `);
  assert.deepEqual(stillSelected, [selected]);
});

test('the unsaved dot disappears again when the document stops being dirty', async () => {
  const ids = await pageIds();
  await session.evaluate(`__mod.applyPageAction('rotate-right', [${JSON.stringify(ids[0])}]); true`);

  const dotsAfterEdit = await session.evaluate(
    `document.querySelectorAll('#canvas-view .dirty-dot').length`,
  );
  assert.equal(dotsAfterEdit, 1, 'editing a page should mark its document unsaved');

  // Undo restores the snapshot's `dirty: false` along with the pages. The
  // header element itself is reused now, so the dot has to be removed
  // explicitly — the old rebuild disposed of it by throwing the header away.
  await session.evaluate(`__mod.store.undo(); true`);
  const dotsAfterUndo = await session.evaluate(
    `document.querySelectorAll('#canvas-view .dirty-dot').length`,
  );
  assert.equal(dotsAfterUndo, 0, 'the unsaved dot should be gone once the document is clean again');
});

test('a store change during a zoom does not reset the baked zoom level', async () => {
  await session.evaluate(`
    (() => {
      const container = document.getElementById('canvas-view');
      container.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -300, ctrlKey: true, bubbles: true, cancelable: true, clientX: 500, clientY: 350,
      }));
      return true;
    })()
  `);
  await session.waitForIdle();
  const zoomedWidth = await session.evaluate(`
    document.querySelector('#canvas-view canvas.page-thumb').getBoundingClientRect().width
  `);

  const ids = await pageIds();
  await session.evaluate(`__mod.applyPageAction('rotate-right', [${JSON.stringify(ids.at(-1))}]); true`);
  await session.forceRenderAllSlots();
  await session.waitForIdle();

  // The render path used to reset bakedZoom to zoom and the wrapper's CSS zoom
  // to 1, which was only correct while every slot was thrown away and would
  // re-rasterize at the current zoom anyway. Surviving slots were rasterized at
  // the OLD baked level, so the same reset would now shrink them back.
  const afterWidth = await session.evaluate(`
    document.querySelector('#canvas-view canvas.page-thumb').getBoundingClientRect().width
  `);
  assert.ok(
    Math.abs(afterWidth - zoomedWidth) < 2,
    `pages should keep their zoomed size across a store change (${zoomedWidth} -> ${afterWidth})`,
  );
});
