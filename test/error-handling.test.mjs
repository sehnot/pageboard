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

// Error handling & robustness lives mostly in main.js (IPC,
// filesystem) and renderer.js (pdf.js parsing, toast UI) — neither
// importable under plain node:test (main.js needs real Electron,
// renderer.js expects a browser context with window.api from the preload).
// This test therefore launches the real app and drives it via the Chrome
// DevTools Protocol — the same technique the fixes were originally verified
// with manually, here turned into a permanent regression test.

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const errorCasesDir = path.join(projectRoot, 'pdf-files', 'error-cases');
const fixtureA = path.join(projectRoot, 'pdf-files', 'test-files', '004-pdflatex-4-pages', 'pdflatex-4-pages.pdf');
const fixtureC = path.join(projectRoot, 'pdf-files', 'test-files', '027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf');
const CDP_PORT = 9422;

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

// Runs `expression` in the renderer and returns the value (structured via
// JSON, see returnByValue) — throws if the evaluation itself threw a JS
// exception, so a test failure doesn't silently slip through as `undefined`
// (CDP's Runtime.evaluate response nests exceptionDetails oddly enough that
// it must always be checked explicitly).
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
  // Explicitly remove ELECTRON_RUN_AS_NODE instead of just trusting the
  // ambient environment — if the variable is set in the calling shell (e.g.
  // a VS Code integrated terminal), Electron would
  // otherwise start as a plain Node process with no window/ipcMain and
  // never load the app logic.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // A scratch --user-data-dir isolates this run's settings.json from the
  // real profile (and from other CDP test files' Electron instances, which
  // node:test can run concurrently — sharing the default profile would let
  // them race on the same settings.json).
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-error-cases-userdata-'));
  electronProcess = spawn(
    electronBinPath,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    // `detached: true` puts this whole process tree in its own process
    // group — see the comment on killElectron() below for why that matters.
    { cwd: projectRoot, env, stdio: 'ignore', detached: true },
  );

  const wsUrl = await waitForDebuggerUrl(20000);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send('Runtime.enable');

  // renderer.js re-exports store/handleOpenedFiles/saveDocuments etc.
  // specifically for test sessions like this — import it
  // once here and anchor it on the page's globalThis, so all tests in this
  // file share the same running store (no Electron restart needed between
  // individual test cases).
  await evaluate(`
    (async () => {
      globalThis.__mod = await import('./renderer.js');
      return true;
    })()
  `);

  // Force English regardless of the host OS's locale (the app now defaults
  // to the OS-detected language, see src/i18n.mjs matchLocale() — without
  // this, the toast/dialog assertions below would fail on any machine whose
  // system language isn't English). Goes through the renderer's own
  // switchLocale() (same function the Options dialog's language picker
  // calls), not window.api.saveSettings() directly — the latter only
  // updates main.js's own state, it doesn't tell the already-running
  // renderer to re-point its own `t` binding.
  await evaluate(`__mod.switchLocale('en'); true`);

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-error-cases-'));
});

after(async () => {
  ws?.close();
  killElectron(electronProcess);
  if (tmpDir) {
    // Reset chmod before cleanup — one test case deliberately makes the
    // directory read-only (no delete permission left), otherwise our own
    // cleanup here would fail for the same reason.
    await fs.chmod(tmpDir, 0o755).catch(() => {});
    for (const entry of await fs.readdir(tmpDir).catch(() => [])) {
      await fs.chmod(path.join(tmpDir, entry), 0o644).catch(() => {});
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function readToast() {
  return evaluate(`
    (() => {
      const toast = document.getElementById('toast');
      return { text: toast.textContent, visible: toast.classList.contains('visible') };
    })()
  `);
}

async function openFiles(filePaths) {
  return evaluate(`
    (async () => {
      const fileInfos = await window.api.readPdfFiles(${JSON.stringify(filePaths)});
      const before = __mod.store.documents.length;
      await __mod.handleOpenedFiles(fileInfos);
      return { addedCount: __mod.store.documents.length - before };
    })()
  `);
}

test('corrupt PDF file: toast instead of a crash, no document opened', async () => {
  const result = await openFiles([path.join(errorCasesDir, 'corrupt.pdf')]);
  const toast = await readToast();

  assert.equal(result.addedCount, 0);
  assert.match(toast.text, /corrupted or not a valid PDF/);
  assert.equal(toast.visible, true);
});

test('password-protected PDF file: toast points out the password protection, no document opened', async () => {
  const result = await openFiles([path.join(errorCasesDir, 'password-protected.pdf')]);
  const toast = await readToast();

  assert.equal(result.addedCount, 0);
  assert.match(toast.text, /password-protected/);
});

test('several bad files in the same open operation: one combined toast instead of several overwriting each other', async () => {
  const result = await openFiles([
    path.join(errorCasesDir, 'corrupt.pdf'),
    path.join(errorCasesDir, 'password-protected.pdf'),
  ]);
  const toast = await readToast();

  assert.equal(result.addedCount, 0);
  assert.match(toast.text, /^Failed to open 2 files$/);
});

test('mixed open operation: a valid file opens despite a bad file in the same batch', async () => {
  const result = await openFiles([path.join(errorCasesDir, 'corrupt.pdf'), fixtureA]);

  // pdflatex-4-pages.pdf may already be open from an earlier test run (the
  // same store runs through the whole test file) — then handleOpenedFiles
  // reports "already open" instead of opening it anew. All this test cares
  // about is that the broken file didn't prevent the valid part of the
  // batch from opening.
  const opened = await evaluate(`__mod.store.documents.some(d => d.displayName === 'pdflatex-4-pages.pdf')`);
  assert.equal(opened, true);
  assert.equal(result.addedCount <= 1, true);
});

test(
  'unreadable file (missing read permissions): toast instead of a silent failure',
  // chmod-based read-permission denial is POSIX-specific — Windows instead
  // uses an ACL model that can't be reproduced with a simple chmod call.
  // The main.js-side fix (readPdfFile() catches EVERY read error, not just
  // EACCES) is platform-independent; only this one test case for triggering
  // the error is not.
  { skip: process.platform === 'win32' },
  async () => {
    const filePath = path.join(tmpDir, 'unreadable.pdf');
    await fs.copyFile(fixtureC, filePath);
    await fs.chmod(filePath, 0o000);

    const result = await openFiles([filePath]);
    const toast = await readToast();

    await fs.chmod(filePath, 0o644); // make it readable again before the rest of cleanup

    assert.equal(result.addedCount, 0);
    assert.match(toast.text, /unreadable/);
  },
);

test(
  'saving to a read-only directory: toast, document stays marked as unsaved',
  // Git tracks only the executable bit, not full permission modes — a
  // chmod 444 set locally on pdf-files/test-files/ (a repo convention)
  // does not survive `actions/checkout` on CI, so this test
  // used to rely on repo-fixture permissions that only actually held on a
  // machine where someone had chmod'd them by hand. Locks its own scratch
  // copy instead, same pattern as the "undeletable" directory test below.
  // Directory write-permission via chmod is POSIX-specific (see the
  // read-permission test above for the same Windows-ACL reasoning).
  { skip: process.platform === 'win32' },
  async () => {
    const lockedDir = path.join(tmpDir, 'readonly-save');
    await fs.mkdir(lockedDir);
    const filePath = path.join(lockedDir, 'pdflatex-4-pages.pdf');
    await fs.copyFile(fixtureA, filePath);

    const result = await openFiles([filePath]);
    assert.equal(result.addedCount, 1);

    const originalBytesBefore = await fs.readFile(filePath);

    await fs.chmod(lockedDir, 0o555); // read+execute, no write — locks after the copy/open above

    // Matched by exact filePath, not displayName: fixtureA (same basename,
    // different — unlocked — path) is already open in the shared store from
    // an earlier test in this file ("mixed open operation"), so a
    // displayName match could silently grab that wrong, unlocked document
    // instead of this test's own scratch copy. That mismatch was invisible
    // locally, where pdf-files/test-files/ also happens to be chmod 444 by
    // hand, but surfaced for real on CI, where it isn't.
    const outcome = await evaluate(`
      (async () => {
        const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
        __mod.applyPageAction('rotate-right', [doc.pages[0].id]); // forces dirty
        await __mod.saveDocuments([doc]);
        return { dirty: doc.dirty };
      })()
    `);
    const toast = await readToast();

    await fs.chmod(lockedDir, 0o755); // hand it back for cleanup in after()

    assert.equal(outcome.dirty, true);
    assert.match(toast.text, /^Failed to save: pdflatex-4-pages\.pdf$/);

    // Regression coverage for the atomic write (main.js writeFileAtomic()):
    // main.js writes to a `.pageboard-tmp` sibling first, then renames it
    // into place — a failure at either step must leave the original
    // completely untouched and not leak a stray temp file into the
    // directory.
    const dirEntries = await fs.readdir(lockedDir);
    assert.equal(
      dirEntries.some((name) => name.endsWith('.pageboard-tmp')),
      false,
      'no leftover .pageboard-tmp file should remain after a failed save',
    );
    const originalBytesAfter = await fs.readFile(filePath);
    assert.deepEqual(originalBytesAfter, originalBytesBefore, 'the original file must be byte-for-byte unchanged');
  },
);

test(
  'deleting an empty document with no write permission on the directory: toast, document stays in the store',
  // See the comment on the read-permission test above — the same
  // POSIX-vs-Windows limitation applies here for delete permission on the
  // parent directory.
  { skip: process.platform === 'win32' },
  async () => {
    const lockedDir = path.join(tmpDir, 'undeletable');
    await fs.mkdir(lockedDir);
    const filePath = path.join(lockedDir, 'empty-after-delete.pdf');
    await fs.copyFile(fixtureC, filePath);

    const result = await openFiles([filePath]);
    assert.equal(result.addedCount, 1);

    // Deleting every page empties the document — saving an
    // empty document shows the empty-documents dialog, here
    // "Delete" is chosen.
    await evaluate(`
      (() => {
        const doc = __mod.store.documents.find(d => d.displayName === 'empty-after-delete.pdf');
        __mod.applyPageAction('delete', doc.pages.map(p => p.id));
        return doc.isEmpty;
      })()
    `);

    // unlink requires write permission on the PARENT DIRECTORY, not on the
    // file itself — so only lock it now (the file still had to be
    // copyable/readable before this).
    await fs.chmod(lockedDir, 0o555);

    // saveDocuments() blocks on the empty-documents dialog (a custom HTML
    // overlay, not native UI, hence controllable via the
    // DOM) — deliberately not awaited right away, only after the dialog
    // interaction further below.
    await evaluate(`
      (() => {
        const doc = __mod.store.documents.find(d => d.displayName === 'empty-after-delete.pdf');
        globalThis.__saveResultPromise = __mod.saveDocuments([doc]);
        return true;
      })()
    `);

    await new Promise((r) => setTimeout(r, 300));

    const outcome = await evaluate(`
      (async () => {
        const overlay = document.querySelector('.modal-overlay');
        const select = overlay.querySelector('select');
        select.value = 'delete';
        select.dispatchEvent(new Event('change'));
        const confirmBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Continue');
        confirmBtn.click();
        await globalThis.__saveResultPromise;
        const stillThere = __mod.store.documents.some((d) => d.displayName === 'empty-after-delete.pdf');
        return { stillThere };
      })()
    `);
    const toast = await readToast();

    await fs.chmod(lockedDir, 0o755); // hand it back for cleanup in after()

    assert.equal(outcome.stillThere, true);
    assert.match(toast.text, /^Failed to delete: empty-after-delete\.pdf$/);
  },
);

// The empty-documents dialog's other branch — "Restore original" — was
// only ever exercised via the "Delete" option above (the undeletable-
// directory test needs a deletable-vs-not distinction; "restore" has no
// such distinction to test against, so it was simply never covered).
test('emptying a document and choosing "Restore original" on save brings its pages back', async () => {
  const filePath = path.join(tmpDir, 'restore-original.pdf');
  await fs.copyFile(fixtureA, filePath);
  await fs.chmod(filePath, 0o644); // writable copy — restoring still needs a normal save afterward

  const openResult = await openFiles([filePath]);
  assert.equal(openResult.addedCount, 1);

  const isEmptyAfterDelete = await evaluate(`
    (() => {
      const doc = __mod.store.documents.find(d => d.displayName === 'restore-original.pdf');
      __mod.applyPageAction('delete', doc.pages.map(p => p.id));
      return doc.isEmpty;
    })()
  `);
  assert.equal(isEmptyAfterDelete, true, 'document should be empty after deleting all its pages');

  await evaluate(`
    (() => {
      const doc = __mod.store.documents.find(d => d.displayName === 'restore-original.pdf');
      globalThis.__saveResultPromise = __mod.saveDocuments([doc]);
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  const outcome = await evaluate(`
    (async () => {
      const overlay = document.querySelector('.modal-overlay');
      const select = overlay.querySelector('select');
      select.value = 'restore';
      select.dispatchEvent(new Event('change'));
      const confirmBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Continue');
      confirmBtn.click();
      await globalThis.__saveResultPromise;
      const doc = __mod.store.documents.find((d) => d.displayName === 'restore-original.pdf');
      return { stillThere: !!doc, isEmpty: doc?.isEmpty, pageCount: doc?.pages.length, dirty: doc?.dirty };
    })()
  `);

  assert.equal(outcome.stillThere, true, 'restored document should still be in the store, not deleted');
  assert.equal(outcome.isEmpty, false);
  assert.ok(outcome.pageCount > 0, 'restored document should have its original pages back');
  assert.equal(outcome.dirty, false, 'a successful restore+save should leave the document clean');

  // The file itself must still exist on disk (restore is not delete).
  await fs.access(filePath);
});
