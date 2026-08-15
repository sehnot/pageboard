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
// Windows-only bug found via this project's own CI:
// spawning a .cmd file directly (without `shell: true`) fails with
// `spawn EINVAL`, since CreateProcess can't execute a batch script as if it
// were a binary.
import electronBinPath from 'electron';
import { PDFDocument } from 'pdf-lib';

// A single, targeted E2E test for exactly the
// app's most critical path — open → edit → save — which, if broken, would
// make the app unusable for every single user. Uses the same spawn-+-CDP
// technique as test/error-handling.test.mjs instead of Playwright: the
// technique already exists, is proven, and covers real main.js behavior
// (filesystem access) that plain node:test otherwise couldn't reach — a
// second browser-automation library would just add maintenance overhead
// (this is a hobby project — minimal maintenance is a stated goal) without
// covering anything this technique doesn't already cover.
//
// Works on a fresh copy from pdf-files/test-files/ in an mkdtemp scratch
// directory, not pdf-files/test-files-edit/ — per repo
// conventions, the latter is manual-testing scratch space whose contents
// can be "consumed" at any time; an automated test needs a reproducible
// starting state.

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
// A separate port from the 9422 used in error-handling.test.mjs — node:test
// can run multiple test files concurrently, each in its own process, so a
// shared port would collide.
const CDP_PORT = 9423;

let electronProcess;
let ws;
let msgId = 0;
let tmpDir;
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
// termination signals to it — a plain `child.kill()` on
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

before(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // A scratch --user-data-dir isolates this run's settings.json from the
  // real profile and from other CDP test files' Electron instances, which
  // node:test can run concurrently.
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-e2e-userdata-'));
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

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-e2e-'));
});

after(async () => {
  ws?.close();
  killElectron(electronProcess);
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('critical path: open → rotate + delete a page → save lands correctly on disk', async () => {
  const filePath = path.join(tmpDir, 'critical-path.pdf');
  await fs.copyFile(
    path.join(projectRoot, 'pdf-files', 'test-files', '027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf'),
    filePath,
  );
  // fs.copyFile carries over the source's file mode —
  // pdf-files/test-files/ is deliberately chmod 444, so the copy would
  // otherwise also be read-only and the save step below would fail at the
  // filesystem level.
  await fs.chmod(filePath, 0o644);

  // 1. Open
  const openResult = await evaluate(`
    (async () => {
      const [fileInfo] = await window.api.readPdfFiles(${JSON.stringify([filePath])});
      const before = __mod.store.documents.length;
      await __mod.handleOpenedFiles([fileInfo]);
      const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
      return { addedCount: __mod.store.documents.length - before, pageCount: doc?.pages.length ?? 0 };
    })()
  `);
  assert.equal(openResult.addedCount, 1, 'Opening should have added exactly one document');
  assert.ok(openResult.pageCount >= 2, 'Fixture needs at least 2 pages for this test');
  const originalPageCount = openResult.pageCount;

  // 2. Edit: rotate the first page, delete the last page (two independent
  // page operations, both must show up in the saved result)
  const editResult = await evaluate(`
    (() => {
      const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
      __mod.applyPageAction('rotate-right', [doc.pages[0].id]);
      __mod.applyPageAction('delete', [doc.pages[doc.pages.length - 1].id]);
      return { dirty: doc.dirty, pageCount: doc.pages.length, firstPageRotation: doc.pages[0].rotation };
    })()
  `);
  assert.equal(editResult.dirty, true);
  assert.equal(editResult.pageCount, originalPageCount - 1);
  assert.equal(editResult.firstPageRotation, 90);

  // 3. Save. saveDocuments() itself returns nothing (see renderer.js) —
  // success shows up as `doc.dirty` being false afterward (on failure it
  // stays true, see the saveFailures handling there).
  const saveResult = await evaluate(`
    (async () => {
      const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
      await __mod.saveDocuments([doc]);
      return { dirty: doc.dirty };
    })()
  `);
  assert.equal(saveResult.dirty, false, 'Document should no longer be dirty after a successful save');

  // 4. Verification directly on disk, independent of app state — the same
  // library (pdf-lib) that main/pdf-writer.mjs also uses for writing, see
  // test/pdf-writer.test.mjs.
  const savedBytes = await fs.readFile(filePath);
  const savedDoc = await PDFDocument.load(savedBytes);
  assert.equal(savedDoc.getPageCount(), originalPageCount - 1);
  assert.equal(savedDoc.getPage(0).getRotation().angle, 90);
});
