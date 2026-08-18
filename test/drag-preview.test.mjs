import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// Dragging pages used to show a thin bar marking where they would land.
// Dragging a whole document already behaved differently — the document moves
// to the hovered position while the drag is still going — and pages now do the
// same: the other pages get out of the way, so what is on screen during the
// drag is the result, with nothing to translate from a marker into an outcome.
//
// The model stays untouched until the actual drop. That is what these tests
// are mostly about: the preview must be visible in the DOM *before* the drop,
// the store must not have moved anything at that point, and cancelling has to
// put everything back.

const fixture = (dir, file) => path.join(testFilesDir, dir, file);
const DOC_A = fixture('004-pdflatex-4-pages', 'pdflatex-4-pages.pdf');
const DOC_B = fixture('027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf');

let session;

before(async () => {
  session = await startSession({ name: 'drag-preview', port: CDP_PORTS.dragPreview });
});

beforeEach(async () => {
  await session.reset();
  await session.openFiles([DOC_A, DOC_B]);
  await session.waitForIdle();
});

after(async () => {
  await session?.close();
});

const domPageIds = () =>
  session.evaluate(`
    [...document.querySelectorAll('#canvas-view .page-slot')].map((el) => el.dataset.pageId)
  `);

const storePageIds = () =>
  session.evaluate(`__mod.store.documents.flatMap((d) => d.pages.map((p) => p.id))`);

// Starts a drag and hovers it over a target, without dropping. Kept in one
// Runtime.evaluate so no round trip can land between measuring the target and
// dispatching at those coordinates — under load the view can scroll or reflow
// in that gap (an existing CI-only failure mode in drag-and-drop.test.mjs).
function dragOver(sourceSelector, targetSelector, { offsetX = 0, offsetY = 0 } = {}) {
  return session.evaluate(`
    (() => {
      const source = document.querySelector(${JSON.stringify(sourceSelector)});
      const dt = new DataTransfer();
      const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt,
      }));
      const sr = source.getBoundingClientRect();
      fire(source, 'dragstart', sr.left + sr.width / 2, sr.top + sr.height / 2);

      const target = document.querySelector(${JSON.stringify(targetSelector)});
      target.scrollIntoView({ block: 'center', inline: 'center' });
      const tr = target.getBoundingClientRect();
      const x = tr.left + tr.width / 2 + ${offsetX};
      const y = tr.top + tr.height / 2 + ${offsetY};
      fire(document.getElementById('canvas-view'), 'dragover', x, y);
      globalThis.__dragState = { source, dt, x, y };
      return true;
    })()
  `);
}

const finishDrag = (type) =>
  session.evaluate(`
    (() => {
      const { source, dt, x, y } = globalThis.__dragState;
      const fire = (el, t) => el.dispatchEvent(new DragEvent(t, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt,
      }));
      if (${JSON.stringify(type)} === 'drop') fire(document.getElementById('canvas-view'), 'drop');
      fire(source, 'dragend');
      return true;
    })()
  `);

test('the pages rearrange during the drag, before anything is dropped', async () => {
  const originalDom = await domPageIds();
  const originalStore = await storePageIds();
  const dragged = originalDom[3];
  const target = originalDom[0];

  await dragOver(
    `#canvas-view .page-slot[data-page-id="${dragged}"]`,
    `#canvas-view .page-slot[data-page-id="${target}"]`,
    { offsetY: -30 },
  );

  // The DOM has already been rearranged...
  const previewDom = await domPageIds();
  assert.notDeepEqual(previewDom, originalDom, 'the preview should have reordered the pages');
  assert.equal(previewDom[0], dragged, 'the dragged page should already sit at the hovered spot');

  // ...while the model has not been touched at all. This is what makes
  // cancelling free, and what keeps a drag from being an edit until it lands.
  assert.deepEqual(await storePageIds(), originalStore, 'the store must not change before the drop');

  await finishDrag('drop');
  assert.deepEqual(await storePageIds(), previewDom, 'the drop should commit exactly what was previewed');
});

test('cancelling a drag puts the previewed pages back', async () => {
  const originalDom = await domPageIds();
  const dragged = originalDom[3];

  await dragOver(
    `#canvas-view .page-slot[data-page-id="${dragged}"]`,
    `#canvas-view .page-slot[data-page-id="${originalDom[0]}"]`,
    { offsetY: -30 },
  );
  assert.notDeepEqual(await domPageIds(), originalDom, 'the preview should have reordered the pages');

  // dragend without a drop is what Esc (or releasing outside a valid target)
  // produces. Nothing was ever committed, so reconciling against the store
  // restores the original order.
  await finishDrag('cancel');
  assert.deepEqual(await domPageIds(), originalDom, 'cancelling should restore the original order');
});

test('there is no drop-indicator bar left anywhere', async () => {
  const originalDom = await domPageIds();
  await dragOver(
    `#canvas-view .page-slot[data-page-id="${originalDom[3]}"]`,
    `#canvas-view .page-slot[data-page-id="${originalDom[0]}"]`,
    { offsetY: -30 },
  );
  assert.equal(
    await session.evaluate(`document.querySelectorAll('.drop-indicator').length`),
    0,
    'the bar was replaced by the live preview and should be gone entirely',
  );
  await finishDrag('cancel');
});

test('holding pages past the last document shows a phantom document', async () => {
  const originalDom = await domPageIds();
  const dragged = originalDom[0];

  // Well past the right edge of the last column — the "new document" zone.
  await dragOver(
    `#canvas-view .page-slot[data-page-id="${dragged}"]`,
    '#canvas-view .document-container:last-of-type',
    { offsetX: 600 },
  );

  const phantom = await session.evaluate(`
    (() => {
      const el = document.querySelector('#canvas-view .drag-phantom');
      if (!el) return null;
      return {
        pageIds: [...el.querySelectorAll('.page-slot')].map((s) => s.dataset.pageId),
        isLast: el === document.querySelector('#canvas-view .document-container:last-child'),
      };
    })()
  `);
  assert.ok(phantom, 'a phantom document should stand in for the one that would be created');
  assert.deepEqual(phantom.pageIds, [dragged], 'the dragged page should preview inside it');
  assert.ok(phantom.isLast, 'it should sit at the edge the pages are being held past');

  // Still nothing in the store — the phantom is pure preview.
  assert.equal(await session.evaluate(`__mod.store.documents.length`), 2);

  await finishDrag('cancel');
  assert.equal(
    await session.evaluate(`document.querySelectorAll('.drag-phantom').length`),
    0,
    'the phantom must not survive a cancelled drag',
  );
  assert.deepEqual(await domPageIds(), originalDom, 'and the page goes back where it came from');
});

test('dropping onto the phantom creates the real document', async () => {
  const originalDom = await domPageIds();
  const dragged = originalDom[0];

  await dragOver(
    `#canvas-view .page-slot[data-page-id="${dragged}"]`,
    '#canvas-view .document-container:last-of-type',
    { offsetX: 600 },
  );
  await finishDrag('drop');

  assert.equal(await session.evaluate(`__mod.store.documents.length`), 3);
  assert.equal(
    await session.evaluate(`__mod.store.documents.at(-1).pages.map((p) => p.id).join(',')`),
    dragged,
    'the new document should hold exactly the dragged page',
  );
  assert.equal(
    await session.evaluate(`document.querySelectorAll('.drag-phantom').length`),
    0,
    'the phantom should have been replaced by the real container, not left alongside it',
  );
});

test('a drag that never moves far enough does not flicker between two positions', async () => {
  const originalDom = await domPageIds();
  const dragged = originalDom[3];

  // Two hovers a couple of pixels apart, straddling a page boundary. Without
  // hysteresis the preview adopts a new target on each one and the pages
  // visibly alternate; the second hover here is inside the dead zone and must
  // be ignored.
  await dragOver(
    `#canvas-view .page-slot[data-page-id="${dragged}"]`,
    `#canvas-view .page-slot[data-page-id="${originalDom[1]}"]`,
    { offsetY: -2 },
  );
  const afterFirst = await domPageIds();

  await session.evaluate(`
    (() => {
      const { source, dt, x, y } = globalThis.__dragState;
      document.getElementById('canvas-view').dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, clientX: x, clientY: y + 4, dataTransfer: dt,
      }));
      return true;
    })()
  `);
  assert.deepEqual(
    await domPageIds(),
    afterFirst,
    'a 4px move should not have been enough to rearrange the preview again',
  );

  await finishDrag('cancel');
});
