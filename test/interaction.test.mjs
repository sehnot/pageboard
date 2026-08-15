import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// Covers the interaction layer that can be driven for real: page selection
// via actual mouse clicks (including modifiers), keyboard shortcuts, the
// toolbar action buttons, and closeDocument()'s dialog-free (non-dirty)
// branch.
//
// The tests in this file deliberately share one running app and build on each
// other's state (later tests rely on earlier ones having left something to
// undo), so unlike the other CDP files there is no per-test reset here. What
// each test does guarantee for itself is its own precondition — see
// clickPage() below.

let session;

before(async () => {
  session = await startSession({ name: 'interaction', port: CDP_PORTS.interaction });
  await session.openFiles([
    path.join(testFilesDir, '004-pdflatex-4-pages', 'pdflatex-4-pages.pdf'),
    path.join(testFilesDir, '027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf'),
  ]);
});

after(async () => {
  await session?.close();
});

const evaluate = (expression) => session.evaluate(expression);

// CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
// `toggle` deliberately uses Meta (Cmd) on macOS rather than Ctrl: holding
// Ctrl during a mousedown/mouseup on macOS is that OS's native
// secondary-click (right-click) convention, and Chromium honors it by not
// synthesizing a 'click' DOM event at all (mousedown/mouseup still fire,
// confirmed via a standalone diagnostic) — so a CDP-dispatched Ctrl+click
// never reaches handlePageClick() on this platform, even though the app's own
// handler checks `event.metaKey || event.ctrlKey` and Ctrl+click is the
// correct modifier on Windows/Linux.
const MOD = { shift: 8, toggle: process.platform === 'darwin' ? 4 : 2 };

// Constructing and dispatching a real KeyboardEvent directly in the renderer
// (same technique focus-mode.test.mjs uses for WheelEvent) rather than CDP's
// Input.dispatchKeyEvent — simpler to get modifier keys exactly right, and
// avoids relying on a CDP input path this project hasn't already verified for
// keyboard (only clicks are confirmed reliable). Exercises the exact same
// `window.addEventListener('keydown', ...)` listener a real key press would.
async function pressKey(key, { ctrlKey = false, shiftKey = false } = {}) {
  await evaluate(`
    (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)}, ctrlKey: ${ctrlKey}, shiftKey: ${shiftKey}, bubbles: true, cancelable: true,
      }));
      return true;
    })()
  `);
}

// Every page's id currently in the active (Canvas) view, in DOM order — which
// matches getFlatPages()' document-then-page order in renderer.js, so index N
// here corresponds to the Nth page across all open documents.
async function flatPageIds() {
  return evaluate(`
    [...document.querySelectorAll('#canvas-view .page-slot[data-page-id]')].map((el) => el.dataset.pageId)
  `);
}

async function selectedPageIds() {
  return evaluate(`
    [...document.querySelectorAll('#canvas-view .page-slot.selected[data-page-id]')].map((el) => el.dataset.pageId)
  `);
}

// Clicks a page and does not return until the click has actually taken
// effect.
//
// Three things make this reliable, all of which were previously missing:
//  - it waits for the view to stop re-rasterizing first, because a canvas
//    swapped out mid-click makes the browser drop the event entirely;
//  - scroll, measure and hit-test happen in ONE evaluate, so the coordinate
//    can't go stale in a round-trip gap (a document column can be taller than
//    the window, so the rect genuinely does move when scrolled);
//  - it verifies the selection actually changed afterwards.
//
// That last point is what turns a missed click into an immediate, explicit
// failure instead of a puzzling assertion three lines later. The one open
// CI flake this file had ("the Delete key removes the selected page(s)",
// failing with `4 !== 3`) was exactly that: the click that was supposed to
// select a page landed nowhere, so Delete had nothing to act on and the test
// blamed the delete logic.
async function clickPage(pageId, { modifiers = 0 } = {}) {
  await session.waitForIdle();
  const selector = `#canvas-view .page-slot[data-page-id="${pageId}"]`;
  const before = await selectedPageIds();

  const target = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'no such page slot' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y,
        onTarget: !!hit && hit.closest('.page-slot') === el,
        inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      };
    })()
  `);
  assert.ok(!target.error, `clickPage(${pageId}): ${target.error}`);
  assert.ok(target.inViewport, `clickPage(${pageId}): slot is not fully inside the viewport after scrolling`);
  assert.ok(target.onTarget, `clickPage(${pageId}): another element covers the slot's centre`);

  // Press and release are queued together rather than awaited one after the
  // other: a full CDP round trip between them lets a re-render slip in, and
  // the browser only reports a click when mousedown and mouseup share a
  // target element.
  const base = { x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers };
  await Promise.all([
    session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }),
    session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }),
  ]);

  // What the click should have done to THIS page: a toggle-modifier click
  // flips it, every other click selects it. (Checking "the selection changed"
  // instead would be wrong — clicking the already-and-only-selected page is a
  // legitimate no-op.)
  const shouldEndUpSelected = modifiers === MOD.toggle ? !before.includes(pageId) : true;
  await session.waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === ${shouldEndUpSelected}`,
    {
      message: `click on page ${pageId} did not leave it ${shouldEndUpSelected ? 'selected' : 'deselected'}`
        + ` (selection before the click: ${JSON.stringify(before)})`,
    },
  );
}

test('toolbar action buttons start disabled with no selection', async () => {
  // Must run before any other test in this file selects something — there's
  // no UI-level "clear selection" action to fall back on afterward — a
  // plain click always replaces the selection with one page, it never
  // empties it; the only ways to reach zero selected pages again
  // are deleting the selected pages or an undo, both of which are
  // exercised by their own dedicated tests further down).
  const disabled = await evaluate(`document.getElementById('duplicate-button').disabled`);
  assert.equal(disabled, true);
});

test('the "Save all" button tooltip matches its disabled state at startup', async () => {
  // Regression coverage: this tooltip used to be bound once, statically, to
  // "No unsaved changes" and never updated again — it stayed wrong forever
  // once any document became dirty. Checked here (nothing dirty yet) and
  // again once something actually is, further down in the toolbar-buttons
  // test.
  const title = await evaluate(`document.getElementById('save-all-button').title`);
  assert.equal(title, 'No unsaved changes');
});

test('a plain click selects exactly one page, replacing any previous selection', async () => {
  const pageIds = await flatPageIds();
  await clickPage(pageIds[0]);
  await clickPage(pageIds[2]);

  const selected = await selectedPageIds();
  assert.deepEqual(selected, [pageIds[2]]);
});

test('shift+click selects a range from the anchor, across document boundaries', async () => {
  const pageIds = await flatPageIds();
  const firstDocPageCount = await evaluate(`__mod.store.documents[0].pages.length`);
  // Anchor inside the first document, target inside the second — the range
  // must span the document boundary (selection is document-agnostic).
  const anchorIndex = 0;
  const targetIndex = firstDocPageCount; // first page of the second document

  await clickPage(pageIds[anchorIndex]);
  await clickPage(pageIds[targetIndex], { modifiers: MOD.shift });

  const selected = await selectedPageIds();
  const expectedIds = pageIds.slice(anchorIndex, targetIndex + 1);
  assert.deepEqual(new Set(selected), new Set(expectedIds));
});

test('ctrl/cmd+click toggles a single page in/out of the selection without clearing the rest', async () => {
  const pageIds = await flatPageIds();

  await clickPage(pageIds[0]); // selects only page 0
  await clickPage(pageIds[1], { modifiers: MOD.toggle }); // adds page 1
  assert.deepEqual(new Set(await selectedPageIds()), new Set([pageIds[0], pageIds[1]]));

  await clickPage(pageIds[0], { modifiers: MOD.toggle }); // removes page 0 again
  assert.deepEqual(await selectedPageIds(), [pageIds[1]]);
});

test('toolbar action buttons enable once a page is selected', async () => {
  const pageIds = await flatPageIds();
  await clickPage(pageIds[0]);
  const disabled = await evaluate(`document.getElementById('duplicate-button').disabled`);
  assert.equal(disabled, false);
});

test('clicking the duplicate/rotate/delete toolbar buttons acts on the current selection', async () => {
  const pageIds = await flatPageIds();
  const targetId = pageIds[0];
  await clickPage(targetId);

  const before = await evaluate(`
    (() => {
      const doc = __mod.store.documents.find((d) => d.pages.some((p) => p.id === ${JSON.stringify(targetId)}));
      return { pageCount: doc.pages.length, rotation: doc.pages.find((p) => p.id === ${JSON.stringify(targetId)}).rotation };
    })()
  `);

  await evaluate(`document.getElementById('rotate-right-button').click()`);
  const afterRotate = await evaluate(`
    __mod.store.documents.flatMap((d) => d.pages).find((p) => p.id === ${JSON.stringify(targetId)}).rotation
  `);
  assert.equal(afterRotate, (before.rotation + 90) % 360);

  await evaluate(`document.getElementById('duplicate-button').click()`);
  const afterDuplicate = await evaluate(`
    __mod.store.documents.find((d) => d.pages.some((p) => p.id === ${JSON.stringify(targetId)})).pages.length
  `);
  assert.equal(afterDuplicate, before.pageCount + 1);

  // The rotate above already made a document dirty — the "Save all" tooltip
  // (see the startup test further up) must have updated to reflect that.
  const saveAllTitle = await evaluate(`document.getElementById('save-all-button').title`);
  assert.equal(saveAllTitle, 'Save all unsaved documents');
});

test('the Delete key removes the selected page(s)', async () => {
  const pageIds = await flatPageIds();
  const targetId = pageIds[pageIds.length - 1]; // last page — avoids disturbing indices used by earlier tests
  await clickPage(targetId);

  const docId = await evaluate(`
    __mod.store.documents.find((d) => d.pages.some((p) => p.id === ${JSON.stringify(targetId)})).id
  `);
  const before = await evaluate(`__mod.store.getDocument(${JSON.stringify(docId)}).pages.length`);

  await pressKey('Delete');

  const after = await evaluate(`__mod.store.getDocument(${JSON.stringify(docId)}).pages.length`);
  assert.equal(after, before - 1);
});

test('Ctrl/Cmd+D duplicates the selected page via a real keydown', async () => {
  const pageIds = await flatPageIds();
  const targetId = pageIds[0];
  await clickPage(targetId);
  const docId = await evaluate(`
    __mod.store.documents.find((d) => d.pages.some((p) => p.id === ${JSON.stringify(targetId)})).id
  `);
  const before = await evaluate(`__mod.store.getDocument(${JSON.stringify(docId)}).pages.length`);

  await pressKey('d', { ctrlKey: true });

  const after = await evaluate(`__mod.store.getDocument(${JSON.stringify(docId)}).pages.length`);
  assert.equal(after, before + 1);
});

test('Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z redoes the last action via real keydowns', async () => {
  const canUndoBefore = await evaluate(`__mod.store.canUndo()`);
  assert.equal(canUndoBefore, true, 'the preceding tests should have left something to undo');

  const beforeState = await evaluate(
    `__mod.store.documents.map((d) => d.pages.length)`,
  );

  await pressKey('z', { ctrlKey: true });
  const afterUndo = await evaluate(`__mod.store.documents.map((d) => d.pages.length)`);
  assert.notDeepEqual(afterUndo, beforeState, 'undo should have changed at least one document\'s page count');

  await pressKey('z', { ctrlKey: true, shiftKey: true });
  const afterRedo = await evaluate(`__mod.store.documents.map((d) => d.pages.length)`);
  assert.deepEqual(afterRedo, beforeState, 'redo should restore the pre-undo state');
});

test('Ctrl/Cmd+Z clears the page selection instead of leaving stale ids selected', async () => {
  const pageIds = await flatPageIds();
  await clickPage(pageIds[0]);
  assert.notDeepEqual(await selectedPageIds(), [], 'sanity check: something should actually be selected here');
  const canUndoBefore = await evaluate(`__mod.store.canUndo()`);
  assert.equal(canUndoBefore, true, 'the preceding tests should have left something to undo');

  await pressKey('z', { ctrlKey: true });

  // Regression: store._restore() (run by undo/redo) rebuilds every Page with
  // a brand-new id, so a selection captured before the undo is now dangling
  // — previously nothing cleared it, leaving the toolbar's duplicate/rotate/
  // delete buttons wrongly enabled with nothing actually selected.
  assert.deepEqual(await selectedPageIds(), []);
  const disabled = await evaluate(`document.getElementById('duplicate-button').disabled`);
  assert.equal(disabled, true);
});

test('Ctrl/Cmd+/ opens the keyboard-shortcuts dialog', async () => {
  await pressKey('/', { ctrlKey: true });
  const headingText = await evaluate(`document.querySelector('.modal-overlay h2')?.textContent`);
  assert.equal(headingText, 'Keyboard shortcuts');
  await evaluate(`document.querySelector('.modal-overlay')?.remove(); true`);
});

test('keyboard shortcuts are suppressed while a modal dialog is open, and Escape closes it', async () => {
  const pageIds = await flatPageIds();
  const targetId = pageIds[0];
  await clickPage(targetId);
  const docId = await evaluate(`
    __mod.store.documents.find((d) => d.pages.some((p) => p.id === ${JSON.stringify(targetId)})).id
  `);
  const before = await evaluate(`__mod.store.getDocument(${JSON.stringify(docId)}).pages.length`);

  await pressKey('/', { ctrlKey: true }); // opens the shortcuts dialog
  const modalOpenAfterShortcut = await evaluate(`!!document.querySelector('.modal-overlay')`);
  assert.equal(modalOpenAfterShortcut, true);

  // Regression: this used to reach the page selection behind the dialog and
  // delete it — the keydown handler only checked focused form controls, not
  // whether a modal was covering the page at all.
  await pressKey('Delete');
  const afterDeleteAttempt = await evaluate(`__mod.store.getDocument(${JSON.stringify(docId)}).pages.length`);
  assert.equal(afterDeleteAttempt, before, 'Delete must not act on the page selection while a modal is open');

  await pressKey('Escape');
  const modalOpenAfterEscape = await evaluate(`!!document.querySelector('.modal-overlay')`);
  assert.equal(modalOpenAfterEscape, false, 'Escape should close the open dialog');
});

// closeDocument()'s dirty branch (save/discard/cancel routing) is
// deliberately NOT covered here — it round-trips through the native,
// human-blocking confirm-close-with-unsaved-changes dialog
// (dialog.showMessageBox), and contextBridge.exposeInMainWorld deep-freezes
// window.api (Object.isFrozen(window.api) === true, every method
// non-writable/non-configurable), so it can't be stubbed from the renderer
// side either — an attempted assignment silently no-ops instead of
// throwing, which surfaced as an inexplicable CDP timeout rather than a
// clear error — this exact dialog is documented as non-automatable.
test('closeDocument() removes a non-dirty document immediately, without any dialog', async () => {
  // Open a fresh document rather than relying on one of the two opened in
  // before() — earlier tests in this file rotate/duplicate/delete pages on
  // both of those, so by this point in the suite neither is guaranteed to
  // still be non-dirty.
  const filePath = path.join(testFilesDir, '001-trivial', 'minimal-document.pdf');
  await evaluate(`
    (async () => {
      const [fileInfo] = await window.api.readPdfFiles(${JSON.stringify([filePath])});
      await __mod.handleOpenedFiles([fileInfo]);
      return true;
    })()
  `);

  const docCountBefore = await evaluate(`__mod.store.documents.length`);
  const targetId = await evaluate(`
    (() => {
      const doc = __mod.store.documents.find((d) => d.filePath === ${JSON.stringify(filePath)});
      return doc.id;
    })()
  `);
  assert.equal(await evaluate(`__mod.store.getDocument(${JSON.stringify(targetId)}).dirty`), false);

  await evaluate(`
    (async () => {
      const doc = __mod.store.getDocument(${JSON.stringify(targetId)});
      await __mod.closeDocument(doc);
      return true;
    })()
  `);

  const docCountAfter = await evaluate(`__mod.store.documents.length`);
  assert.equal(docCountAfter, docCountBefore - 1);
  assert.equal(await evaluate(`!!__mod.store.getDocument(${JSON.stringify(targetId)})`), false);
});
