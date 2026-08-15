import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// Covers native HTML5 drag & drop via real DragEvents with a real
// DataTransfer at explicit clientX/clientY. Two independent drag mechanisms
// are covered: dragging a page (or a multi-selection of pages) between/within
// documents, and dragging a whole document's section header to reorder it
// among its siblings.

const DOC_A = { dir: '004-pdflatex-4-pages', file: 'pdflatex-4-pages.pdf' }; // 4 pages
const DOC_B = { dir: '027-cropped-rotated-scaled', file: 'cropped-rotated-scaled.pdf' }; // 4 pages

let session;

before(async () => {
  session = await startSession({ name: 'dnd', port: CDP_PORTS.dragAndDrop });
});

// Every drag in this file mutates document membership or order, so each test
// starts from a clean slate rather than inheriting the previous one's layout.
beforeEach(async () => {
  await session.reset();
});

after(async () => {
  await session?.close();
});

function openFixtures(names) {
  return session.openFiles(names.map((name) => path.join(testFilesDir, name.dir, name.file)));
}

// Every page's id currently in the active (Canvas) view, in DOM order.
function flatPageIds() {
  return session.evaluate(`
    [...document.querySelectorAll('#canvas-view .page-slot[data-page-id]')].map((el) => el.dataset.pageId)
  `);
}

function documentIdsInDom() {
  return session.evaluate(`
    [...document.querySelectorAll('#canvas-view .document-container[data-document-id]')].map((el) => el.dataset.documentId)
  `);
}

// Builds the source of a zero-arg function that scrolls an element (page slot
// or section header) into view and returns its current center coordinates
// (optionally offset). A document column can be taller than the window, so a
// rect can't be trusted unless it's re-measured right after scrolling. Passed
// to dragAndDrop() so the scroll/measure happens in the same Runtime.evaluate
// call as the drag dispatch itself — see the note on dragAndDrop() for why.
function dropPointAt(selector, { offsetX = 0, offsetY = 0 } = {}) {
  return `() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 + ${offsetX}, y: r.top + r.height / 2 + ${offsetY} };
  }`;
}

// Runs a full dragstart -> dragover -> drop -> dragend sequence against a
// single real DataTransfer, entirely inside one Runtime.evaluate call so
// there's no gap where the app's own dragend/cleanup logic could race against
// a separate round-trip. `computeDropPoint` is the source of a zero-arg
// function returning `{x, y}`, called synchronously right before dragover/drop
// fire — this used to be measured in an earlier, separate evaluate() call
// instead, which left a real round-trip gap between measuring the drop
// target's position and actually dropping onto it; under CI load that gap was
// long enough for the page to scroll/reflow in between, so the drop landed
// slightly off target (observed as an intermittent CI-only failure, not
// reproducible locally).
function dragAndDrop(sourceSelector, computeDropPoint) {
  return session.evaluate(`
    (() => {
      const source = document.querySelector(${JSON.stringify(sourceSelector)});
      const dt = new DataTransfer();
      const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt,
      }));
      const sourceRect = source.getBoundingClientRect();
      fire(source, 'dragstart', sourceRect.left + sourceRect.width / 2, sourceRect.top + sourceRect.height / 2);
      const { x, y } = (${computeDropPoint})();
      // dragover/drop listeners are bound directly to #canvas-view/#grid-view
      // (see renderer.js) — these tests stay in the default Canvas view
      // throughout, so #canvas-view is always the right dispatch target.
      const view = document.getElementById('canvas-view');
      fire(view, 'dragover', x, y);
      fire(view, 'drop', x, y);
      fire(source, 'dragend', x, y);
      return true;
    })()
  `);
}

test('dragging a page within the same document reorders it', async () => {
  await openFixtures([DOC_A]);
  const pageIds = await flatPageIds();
  assert.equal(pageIds.length, 4);
  const [p0, p1, p2, p3] = pageIds;

  // Drag page 0 to before page 2 — expected order: p1, p0, p2, p3.
  await dragAndDrop(
    `.page-slot[data-page-id="${p0}"]`,
    dropPointAt(`.page-slot[data-page-id="${p2}"]`, { offsetY: -5 }),
  );

  const after = await session.evaluate(`__mod.store.documents[0].pages.map((p) => p.id)`);
  assert.deepEqual(after, [p1, p0, p2, p3]);
});

test('dragging a page onto another document moves it across documents', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const docIds = await session.evaluate(`__mod.store.documents.map((d) => d.id)`);
  const [docAId, docBId] = docIds;
  const pageIds = await flatPageIds();
  const lastOfA = pageIds[3]; // doc A's last page
  const firstOfB = pageIds[4]; // doc B's first page

  await dragAndDrop(
    `.page-slot[data-page-id="${lastOfA}"]`,
    dropPointAt(`.page-slot[data-page-id="${firstOfB}"]`, { offsetY: -5 }),
  );

  const state = await session.evaluate(`
    ({
      aIds: __mod.store.getDocument(${JSON.stringify(docAId)}).pages.map((p) => p.id),
      bIds: __mod.store.getDocument(${JSON.stringify(docBId)}).pages.map((p) => p.id),
    })
  `);
  assert.equal(state.aIds.length, 3, 'doc A should have lost the dragged page');
  assert.equal(state.bIds.length, 5, 'doc B should have gained the dragged page');
  assert.equal(state.bIds[0], lastOfA, 'the dragged page should be inserted before the drop target');
});

test('dragging a page past the last document creates a new document', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const docCountBefore = await session.evaluate(`__mod.store.documents.length`);
  const pageIds = await flatPageIds();
  const lastPage = pageIds[pageIds.length - 1]; // doc B's last page

  // The drop-edge zone is beyond the last document container's right edge in
  // Canvas view (findDropEdgeZone) — scroll the last container into view
  // first, then aim well past its right edge.
  await dragAndDrop(
    `.page-slot[data-page-id="${lastPage}"]`,
    `() => {
      const containers = document.querySelectorAll('#canvas-view .document-container');
      const el = containers[containers.length - 1];
      el.scrollIntoView({ block: 'center', inline: 'end' });
      const r = el.getBoundingClientRect();
      return { x: r.right + 200, y: (r.top + r.bottom) / 2 };
    }`,
  );

  const docCountAfter = await session.evaluate(`__mod.store.documents.length`);
  assert.equal(docCountAfter, docCountBefore + 1, 'dropping past the edge should create a new document');
  const newDoc = await session.evaluate(`__mod.store.documents[__mod.store.documents.length - 1]`);
  assert.deepEqual(newDoc.pages.map((p) => p.id), [lastPage]);
});

test('dropping in the gap between two documents is a no-op — the page stays put', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const before = await session.evaluate(`__mod.store.documents.map((d) => d.pages.map((p) => p.id))`);
  const pageIds = await flatPageIds();
  const firstOfB = pageIds[4];

  // The gap is the vertical strip between the end of doc A's column and the
  // start of doc B's column in Canvas view — computed from both containers'
  // rects, not guessed, so it stays correct regardless of gap width. The y
  // coordinate comes from doc B's first page, scrolled into view.
  await dragAndDrop(
    `.page-slot[data-page-id="${pageIds[0]}"]`,
    `() => {
      const containers = document.querySelectorAll('#canvas-view .document-container');
      const a = containers[0].getBoundingClientRect();
      const b = containers[1].getBoundingClientRect();
      const target = document.querySelector(${JSON.stringify(`.page-slot[data-page-id="${firstOfB}"]`)});
      target.scrollIntoView({ block: 'center', inline: 'center' });
      const r = target.getBoundingClientRect();
      return { x: (a.right + b.left) / 2, y: r.top + r.height / 2 };
    }`,
  );

  const after = await session.evaluate(`__mod.store.documents.map((d) => d.pages.map((p) => p.id))`);
  assert.deepEqual(after, before, 'no document should have changed');
});

test('dragging a document\'s section header reorders it among its siblings', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const docIdsBefore = await session.evaluate(`__mod.store.documents.map((d) => d.id)`);
  const [docAId, docBId] = docIdsBefore;
  assert.deepEqual(await documentIdsInDom(), [docAId, docBId]);

  // Drag doc B's header to before doc A's header — expected final order:
  // [docB, docA].
  await dragAndDrop(
    `.document-container[data-document-id="${docBId}"] .section-header`,
    dropPointAt(`.document-container[data-document-id="${docAId}"] .section-header`),
  );

  const docIdsAfter = await session.evaluate(`__mod.store.documents.map((d) => d.id)`);
  assert.deepEqual(docIdsAfter, [docBId, docAId]);
  assert.deepEqual(await documentIdsInDom(), [docBId, docAId], 'DOM order should match the model order');
});
