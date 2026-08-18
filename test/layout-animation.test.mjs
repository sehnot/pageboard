import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// When the shared cell size changes — the document holding the largest page
// is closed, or a page is rotated into landscape — every page keeps its size
// but moves to a new position. That movement is animated (FLIP: the moved
// elements are offset back to where they were, then released) so it reads as
// "the pages moved closer together" rather than as an unexplained jump.
//
// The second test is the important one. The same values this animates are
// also rewritten on every zoom rebake, and animating there would put back
// exactly the flicker that several rounds of work removed (see the zoom
// entries in LESSONS.md). Nothing in the animation's own code says which
// caller it runs for, so that boundary needs a test rather than a comment.
//
// Note on how this is observed: `style.transform` is useless as a signal.
// FLIP sets the offset and releases it on the very next frame, so it is
// visible for exactly one frame — a test polling it would pass or fail on
// timing alone. The renderer exposes isLayoutAnimatingForTests() instead,
// which is true for the animation's whole duration.

const fixture = (dir, file) => path.join(testFilesDir, dir, file);
const A4_FILE = fixture('004-pdflatex-4-pages', 'pdflatex-4-pages.pdf');
const SMALL_FILE = fixture('019-grayscale-image', 'grayscale-image.pdf');

let session;

before(async () => {
  session = await startSession({ name: 'layout-animation', port: CDP_PORTS.layoutAnimation });
});

beforeEach(async () => {
  await session.reset();
  await session.openFiles([A4_FILE, SMALL_FILE]);
  await session.evaluate(`__mod.setView('grid'); true`);
  await session.forceRenderAllSlots();
  // Every test here asserts on whether an animation is running RIGHT NOW, so
  // each has to start from a settled view. Without this, opening the files
  // (or whatever a previously failed test left behind) can still be
  // animating when the test looks — which reports as "this action animated"
  // no matter what the action did.
  await session.waitForIdle();
});

after(async () => {
  await session?.close();
});

const animating = () => session.evaluate('__mod.isLayoutAnimatingForTests()');

const slotLefts = () =>
  session.evaluate(`
    [...document.querySelectorAll('#grid-view .page-slot')].map((el) => el.getBoundingClientRect().left)
  `);

test('closing the document with the largest page animates the rest into their new positions', async () => {
  const settledBefore = await slotLefts();

  // One round trip, so the "is it animating" answer and the positions it
  // describes come from the same moment.
  const midFlight = await session.evaluate(`
    (() => {
      const doc = __mod.store.documents.find((d) => d.displayName === 'pdflatex-4-pages.pdf');
      __mod.closeDocument(doc);
      return {
        animating: __mod.isLayoutAnimatingForTests(),
        lefts: [...document.querySelectorAll('#grid-view .page-slot')]
          .map((el) => el.getBoundingClientRect().left),
      };
    })()
  `);

  assert.equal(midFlight.animating, true, 'closing should have started a layout animation');
  assert.equal(midFlight.lefts.length, 1, 'only the small document should be left');

  // Still standing where it was, not already teleported to its new spot —
  // that is what makes this an animation rather than a jump.
  assert.ok(
    Math.abs(midFlight.lefts[0] - settledBefore.at(-1)) < 1,
    `expected the surviving page to start from its old position (${midFlight.lefts[0]} vs ${settledBefore.at(-1)})`,
  );

  await session.waitForIdle();
  assert.equal(await animating(), false, 'the animation should have finished');

  // And it must land on the real layout rather than near it: with the A4
  // document gone the cell shrinks, so the page ends up somewhere else.
  const settledAfter = await slotLefts();
  assert.ok(
    Math.abs(settledAfter[0] - midFlight.lefts[0]) > 1,
    'the page should have actually moved by the end',
  );

  const leftovers = await session.evaluate(`
    [...document.querySelectorAll('#grid-view .page-slot')]
      .filter((el) => el.style.transform || el.style.transition).length
  `);
  assert.equal(leftovers, 0, 'no inline transform/transition should be left behind');
});

test('a zoom rebake changes the same values but must NOT animate', async () => {
  await session.evaluate(`
    (() => {
      const container = document.getElementById('grid-view');
      container.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -300, ctrlKey: true, bubbles: true, cancelable: true, clientX: 500, clientY: 350,
      }));
      return true;
    })()
  `);

  // The rebake is debounced 200ms and then swaps every canvas plus all
  // spacing in one synchronous commit. Watch across that entire window — an
  // animation starting at any point in it is the regression — and bound the
  // watch by elapsed time rather than by a poll count, since how many polls
  // fit into 200ms depends entirely on how fast the CDP round trips are.
  const deadline = Date.now() + 5000;
  let sawRebakeFinish = false;
  while (Date.now() < deadline) {
    const stateNow = await session.evaluate(`
      ({ animating: __mod.isLayoutAnimatingForTests(), idle: __mod.isViewIdleForTests() })
    `);
    assert.equal(stateNow.animating, false, 'a zoom rebake must not animate page positions');
    if (stateNow.idle) {
      sawRebakeFinish = true;
      break;
    }
  }
  assert.ok(sawRebakeFinish, 'the rebake never settled — the assertion above never saw its commit');
});

test('rotating a page into landscape animates the pages that have to make room', async () => {
  const pageId = await session.evaluate(`__mod.store.documents[0].pages[0].id`);

  const midFlight = await session.evaluate(`
    (() => {
      __mod.applyPageAction('rotate-right', [${JSON.stringify(pageId)}]);
      return __mod.isLayoutAnimatingForTests();
    })()
  `);
  assert.equal(midFlight, true, 'widening the shared cell should push the other pages apart visibly');

  await session.waitForIdle();
  assert.equal(await animating(), false);
});

test('nothing animates when a change leaves the cell size alone', async () => {
  // Deleting a page from the small document cannot change the maximum, which
  // the A4 file sets. Without the guard this would animate on every single
  // store change, including ones where nothing moved at all.
  const pageId = await session.evaluate(`
    __mod.store.documents.find((d) => d.displayName === 'grayscale-image.pdf').pages[0].id
  `);
  const started = await session.evaluate(`
    (() => {
      __mod.applyPageAction('delete', [${JSON.stringify(pageId)}]);
      return __mod.isLayoutAnimatingForTests();
    })()
  `);
  assert.equal(started, false, 'an unchanged cell size should not trigger an animation');
});
