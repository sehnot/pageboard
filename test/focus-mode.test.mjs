import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
// The `electron` package's main entry, when required/imported from a plain
// Node context (not Electron's own runtime), resolves to the absolute path
// of the platform binary itself — Electron.app/.../Electron on macOS,
// electron.exe on Windows, no .bin wrapper script or shell involved. Using
// this instead of node_modules/.bin/electron[.cmd] sidesteps a real
// Windows-only bug found via this project's own CI (see LESSONS.md):
// spawning a .cmd file directly (without `shell: true`) fails with
// `spawn EINVAL`, since CreateProcess can't execute a batch script as if it
// were a binary.
import electronBinPath from 'electron';

// Focus mode (reworked based on user feedback after the initial
// implementation, see CLAUDE.md "Renderer internals" and LESSONS.md) had no automated
// coverage, even though two of the three most recently found bugs there
// were purely geometric/structural states (centered vs. left-aligned, which
// document is visible after a zoom exit) rather than subjective-visual
// "does this feel right" questions — cases like that can be checked via the
// exact same CDP technique as in error-handling.test.mjs, with no
// pixel/screenshot comparison at all. What's deliberately NOT checked
// here: whether a zoom gesture feels smooth, whether sharpness/colors are
// right, etc. — that rightly stays part of the manual TESTING.md checklist.

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testFilesDir = path.join(projectRoot, 'pdf-files', 'test-files');
// Three files with genuinely different page dimensions from each other
// (not just different content) — needed to trigger the geometric edge
// cases this test targets (see LESSONS.md history on focus mode). Verified
// via pdf-lib before picking these: 004 is plain A4 (595x842), 019 is a
// small non-standard size (243x338), 027 has four internally different
// page sizes of its own (600x720/450x540/550x420/550x780) — 026 was
// considered but rejected, since it defaults to the exact same A4 size as
// 004 and would have added no real dimensional diversity.
const FOCUS_TEST_FILES = [
  path.join(testFilesDir, '004-pdflatex-4-pages', 'pdflatex-4-pages.pdf'),
  path.join(testFilesDir, '019-grayscale-image', 'grayscale-image.pdf'),
  path.join(testFilesDir, '027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf'),
];
// A separate port — error-handling.test.mjs uses 9422, e2e-critical-path.test.mjs
// uses 9423; node:test can run multiple test files concurrently, each with
// its own Electron process, so a shared port would collide.
const CDP_PORT = 9424;

let electronProcess;
let ws;
let msgId = 0;
let userDataDir;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(msg);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    // Cleared above on a normal response — otherwise this timer keeps
    // Node's event loop alive until it fires, delaying process exit by up
    // to its own delay even though the promise already settled.
    const timer = setTimeout(() => reject(new Error(`CDP timeout on ${method}`)), 15000);
  });
}

async function evaluate(expression) {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (msg.result.exceptionDetails) {
    throw new Error(`Renderer exception: ${JSON.stringify(msg.result.exceptionDetails)}`);
  }
  return msg.result.result?.value;
}

async function waitForDebuggerUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Server not ready yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Electron window did not register for CDP in time');
}

// `node_modules/.bin/electron` is itself a Node wrapper script that spawns
// the real Electron binary as a SEPARATE child process and only relays
// termination signals to it (see LESSONS.md) — a plain `child.kill()` on
// that wrapper doesn't reliably take the real Electron process (and its own
// Renderer/GPU/Utility helper processes) down with it, especially under
// SIGTERM's graceful-shutdown ambiguity. Left unfixed, those orphaned
// processes keep squatting on this file's CDP port, so a later test run's
// `waitForDebuggerUrl()` can attach to a stale, already-exited-code Electron
// window instead of spawning a fresh one. Spawning with `detached: true`
// puts the whole tree in its own POSIX process group; killing the NEGATIVE
// pid (`-child.pid`) sends the signal to every process in that group at
// once. Falls back to a plain kill if that's unavailable (e.g. Windows,
// where process groups work differently) or the process already exited.
function killElectron(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// A double-click as two real mouse clicks (clickCount 1, then 2) instead of
// a synthetic 'dblclick' event — this way it exercises the same
// click/click/dblclick sequence a real double-click triggers in the
// browser.
async function realDoubleClick(x, y) {
  for (let clickCount = 1; clickCount <= 2; clickCount += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
  }
}

// `Input.dispatchMouseEvent` of type 'mouseWheel' reliably hangs over CDP
// against this Electron version (see LESSONS.md) — instead, construct and
// dispatch a real WheelEvent directly in the renderer, which triggers the
// exact same JS listener chain (attachZoomHandler).
async function dispatchCtrlWheel(x, y, deltaY) {
  await evaluate(`
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

async function rectOf(selector) {
  return evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()
  `);
}

function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

before(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // A scratch --user-data-dir isolates this run's settings.json from the
  // real profile and from other CDP test files' Electron instances, which
  // node:test can run concurrently.
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-focus-mode-userdata-'));
  electronProcess = spawn(
    electronBinPath,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    // `detached: true` puts this whole process tree in its own process
    // group — see the comment on killElectron() above for why that matters.
    { cwd: projectRoot, env, stdio: 'ignore', detached: true },
  );

  const wsUrl = await waitForDebuggerUrl(20000);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send('Runtime.enable');

  await evaluate(`
    (async () => {
      globalThis.__mod = await import('./renderer.js');
      return true;
    })()
  `);

  await evaluate(`
    (async () => {
      const fileInfos = await window.api.readPdfFiles(${JSON.stringify(FOCUS_TEST_FILES)});
      await __mod.handleOpenedFiles(fileInfos);
      return true;
    })()
  `);
  // Wait for the first render (virtualization/rasterization of the first pages).
  await new Promise((r) => setTimeout(r, 800));
});

after(async () => {
  ws?.close();
  killElectron(electronProcess);
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('double-click in Canvas mode enlarges the page to fill the frame and centers it horizontally', async () => {
  await evaluate(`__mod.setView('canvas')`);
  await new Promise((r) => setTimeout(r, 300));

  const before_ = await rectOf('#canvas-view .page-slot');
  const c = centerOf(before_);
  await realDoubleClick(c.x, c.y);
  await new Promise((r) => setTimeout(r, 600));

  const focused = await rectOf('.page-slot.focused');
  assert.ok(focused, 'a page should carry the .focused class after the double-click');

  const windowSize = await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`);
  // `.page-slot`'s width is already stretched to the column width via
  // flexbox cross-axis in Canvas mode (already ~380px before, see
  // CANVAS_COLUMN_WIDTH) — a before/after width comparison would therefore
  // be misleading. Height, on the other hand, isn't stretched (the flex
  // main axis, follows the actual render resolution) and is thus the
  // reliable growth signal. The growth ratio is height-bound here (see
  // FOCUS_MODE_FILL_RATIO below) and thus a function of window.innerHeight
  // alone, which isn't this test's to control — a real run measured 1.2
  // (1000x700 CI-like window) up to 1.4 (1200x800 local, minus title-bar
  // chrome eating into innerHeight). 1.15 stays well clear of that observed
  // range on the low end while still catching a real "barely moved" bug
  // (ratio ~1.0), see LESSONS.md.
  assert.ok(focused.height > before_.height * 1.15, 'page should be noticeably taller in focus mode than before');
  // Fill the frame: close to the window size on at least one axis
  // (FOCUS_MODE_FILL_RATIO = 0.92 in renderer.js, tolerated more generously here).
  assert.ok(focused.width >= windowSize.w * 0.6 || focused.height >= windowSize.h * 0.6, 'page should approximately fill the frame');

  const focusedCenter = centerOf(focused);
  assert.ok(
    Math.abs(focusedCenter.x - windowSize.w / 2) < 40,
    `page should be centered horizontally (center at ${focusedCenter.x}, expected near ${windowSize.w / 2})`,
  );

  // Other documents are no longer visible in the meantime (rest of the
  // canvas hidden while focused).
  const otherDocsVisible = await evaluate(`
    [...document.querySelectorAll('#canvas-view .document-container')]
      .filter(el => !el.contains(document.querySelector('.focused')))
      .every(el => getComputedStyle(el).display === 'none')
  `);
  assert.equal(otherDocsVisible, true, 'other documents should be hidden during focus mode');

  // Clean up for the next tests: exit focus mode again.
  const centerFocused = centerOf(focused);
  await realDoubleClick(centerFocused.x, centerFocused.y);
  await new Promise((r) => setTimeout(r, 400));
});

test('double-click in Grid also centers the page (regression test: used to be left-aligned)', async () => {
  await evaluate(`__mod.setView('grid')`);
  await new Promise((r) => setTimeout(r, 400));

  const before_ = await rectOf('#grid-view .page-slot');
  const c = centerOf(before_);
  await realDoubleClick(c.x, c.y);
  await new Promise((r) => setTimeout(r, 600));

  const focused = await rectOf('.page-slot.focused');
  assert.ok(focused, 'a page should carry the .focused class after the double-click');

  const windowSize = await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`);
  const focusedCenter = centerOf(focused);
  assert.ok(
    Math.abs(focusedCenter.x - windowSize.w / 2) < 40,
    `grid page should be centered horizontally, not left-aligned (center at ${focusedCenter.x}, expected near ${windowSize.w / 2})`,
  );

  const centerFocused = centerOf(focused);
  await realDoubleClick(centerFocused.x, centerFocused.y);
  await new Promise((r) => setTimeout(r, 400));
});

test('a second double-click restores the previous zoom level/position', async () => {
  await evaluate(`__mod.setView('canvas')`);
  await new Promise((r) => setTimeout(r, 300));

  const before_ = await rectOf('#canvas-view .page-slot');
  const c = centerOf(before_);
  await realDoubleClick(c.x, c.y);
  await new Promise((r) => setTimeout(r, 600));

  const focused = await rectOf('.page-slot.focused');
  // Compare height instead of width — see the comment (and the threshold
  // rationale) in the first test case.
  assert.ok(focused.height > before_.height * 1.15, 'page should be taller in focus mode');

  const centerFocused = centerOf(focused);
  await realDoubleClick(centerFocused.x, centerFocused.y);
  await new Promise((r) => setTimeout(r, 600));

  const stillFocused = await evaluate(`!!document.querySelector('.page-slot.focused')`);
  assert.equal(stillFocused, false, 'focus mode should have ended after the second double-click');

  const after_ = await rectOf('#canvas-view .page-slot');
  assert.ok(
    Math.abs(after_.width - before_.width) < before_.width * 0.15,
    `page size should be close to the original value again (before ${before_.width}px, after ${after_.width}px)`,
  );

  const otherDocsVisible = await evaluate(`
    [...document.querySelectorAll('#canvas-view .document-container')].every(el => getComputedStyle(el).display !== 'none')
  `);
  assert.equal(otherDocsVisible, true, 'all documents should be visible again after the restore');
});

test('manually zooming in focus mode exits it without jumping to the first page (regression test)', async () => {
  await evaluate(`__mod.setView('canvas')`);
  await new Promise((r) => setTimeout(r, 300));

  // Focus the third (last) document — a jump to the first page would be
  // clearly distinguishable here from correctly "staying in place", unlike
  // with the first document.
  const thirdDocId = await evaluate(`__mod.store.documents[2].id`);
  const before_ = await rectOf(`.document-container[data-document-id="${thirdDocId}"] .page-slot`);
  const c = centerOf(before_);
  await realDoubleClick(c.x, c.y);
  await new Promise((r) => setTimeout(r, 600));

  const focused = await rectOf('.page-slot.focused');
  assert.ok(focused, 'third document should be focused');
  const focusedCenter = centerOf(focused);

  await dispatchCtrlWheel(Math.round(focusedCenter.x), Math.round(focusedCenter.y), -20);
  await new Promise((r) => setTimeout(r, 500));

  const stillFocused = await evaluate(`!!document.querySelector('.page-slot.focused')`);
  assert.equal(stillFocused, false, 'focus mode should have ended due to the manual zoom');

  // Exact centering after the exit isn't always geometrically possible —
  // with few/narrow documents, the scrollable area isn't enough at this
  // zoom level to push the last column all the way to the window center
  // (the scroll then hits its edge, see LESSONS.md). The property actually
  // guaranteed: no jump back to the FIRST document (the reported bug), and
  // the previously focused document stays visible instead of being
  // scrolled out of view.
  const firstDocId = await evaluate(`__mod.store.documents[0].id`);
  const windowSize = await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`);
  const docAtCenter = await evaluate(`
    document.elementFromPoint(${windowSize.w / 2}, ${windowSize.h / 2})?.closest('.document-container')?.dataset.documentId ?? null
  `);
  assert.notEqual(
    docAtCenter,
    firstDocId,
    `screen center should NOT have jumped to the first document (shows: ${docAtCenter})`,
  );

  const thirdDocVisible = await evaluate(`
    (() => {
      const el = document.querySelector('.document-container[data-document-id="${thirdDocId}"]');
      const r = el.getBoundingClientRect();
      return r.right > 0 && r.left < window.innerWidth;
    })()
  `);
  assert.equal(
    thirdDocVisible,
    true,
    'the previously focused (third) document should still be at least partially visible',
  );
});
