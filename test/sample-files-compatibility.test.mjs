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

// Broad compatibility smoke test for the sample-file corpus mirrored from
// py-pdf/sample-files under pdf-files/test-files/ (see NOTICE.md there for
// licensing — CC-BY-SA-4.0, distinct from this repo's own MIT code). These
// files exist specifically as real-world PDF edge cases (unusual metadata,
// encryption, CMYK/grayscale color spaces, forms, attachments, ...), so the
// bar here is deliberately "PageBoard doesn't crash on any of them", not
// "every single one opens successfully" — some are edge cases by design and
// may legitimately hit the existing corrupted/unreadable failure path
// instead of opening. A real crash (an uncaught renderer exception) still
// fails this test, via the same evaluate()-throws-on-exceptionDetails
// mechanism every other CDP test file in this project uses.
//
// The file list is read from disk at test time rather than hardcoded, so
// this test keeps covering the actual corpus if it's ever extended.

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testFilesDir = path.join(projectRoot, 'pdf-files', 'test-files');
// A separate port from the other CDP test files (9422-9425) — node:test can
// run multiple test files concurrently, each with its own Electron process.
const CDP_PORT = 9426;

let electronProcess;
let ws;
let msgId = 0;
let userDataDir;

// Longer than the 15s used in the other CDP test files — this file's one
// real evaluate() call opens ~30 real PDFs in a single batch (matching a
// real multi-select open), which legitimately takes longer than a typical
// single-action call elsewhere.
const CDP_TIMEOUT_MS = 60000;

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
    const timer = setTimeout(() => reject(new Error(`CDP timeout on ${method}`)), CDP_TIMEOUT_MS);
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

async function findAllPdfPaths(dir) {
  const results = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findAllPdfPaths(full)));
    } else if (entry.isFile() && entry.name.endsWith('.pdf')) {
      results.push(full);
    }
  }
  return results;
}

before(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-sample-files-userdata-'));
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
});

after(async () => {
  ws?.close();
  killElectron(electronProcess);
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('every PDF under pdf-files/test-files/ opens without crashing PageBoard', async () => {
  const filePaths = (await findAllPdfPaths(testFilesDir)).sort();
  assert.ok(filePaths.length > 0, 'expected at least one sample PDF to test against');

  const result = await evaluate(`
    (async () => {
      const filePaths = ${JSON.stringify(filePaths)};
      const fileInfos = await window.api.readPdfFiles(filePaths);
      const before = __mod.store.documents.length;
      await __mod.handleOpenedFiles(fileInfos);
      const after = __mod.store.documents.length;
      const openedNames = __mod.store.documents.slice(before).map((d) => d.displayName);
      return { addedCount: after - before, openedNames };
    })()
  `);

  // Two samples are expected to NOT open as documents, both for reasons
  // that are the whole point of those upstream fixtures, not a bug here:
  // - 005-libreoffice-writer-password: encrypted, hits the existing
  //   password-protected failure path (same as error-handling.test.mjs's
  //   dedicated password-protected scenario).
  // - 017-unreadable-meta-data: deliberately malformed metadata (per its
  //   own name upstream), hits pdf.js's generic parse-failure path — same
  //   "corrupted or not a valid PDF" outcome error-handling.test.mjs
  //   already covers for corrupt.pdf, just triggered by a different kind of
  //   malformed input.
  const expectedNonOpeners = ['libreoffice-writer-password.pdf', 'unreadablemetadata.pdf'];
  assert.equal(
    result.addedCount,
    filePaths.length - expectedNonOpeners.length,
    `expected every sample file except ${JSON.stringify(expectedNonOpeners)} to open (got: ${JSON.stringify(result.openedNames)})`,
  );
  for (const name of expectedNonOpeners) {
    assert.ok(!result.openedNames.includes(name), `${name} should not have opened as a document`);
  }
});
