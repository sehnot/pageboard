// Regenerates docs/screenshots/canvas-view.png and grid-view.png by
// actually driving the real app — same CDP technique used by the
// CDP-driven tests under test/. Deliberately file-name-agnostic about what's inside
// pdf-files/screenshot-files/ (see that directory's README.md) — swapping
// in nicer PDFs later needs no change here.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const projectRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pdfsDir = path.join(projectRoot, 'pdf-files', 'screenshot-files');
const outDir = path.join(projectRoot, 'docs', 'screenshots');
const CDP_PORT = 9427;

let msgId = 0;
function send(ws, method, params = {}) {
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

async function evaluate(ws, expression) {
  const msg = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (msg.result.exceptionDetails) {
    throw new Error(`Renderer exception: ${JSON.stringify(msg.result.exceptionDetails)}`);
  }
  return msg.result.result?.value;
}

// Force-renders every currently-present, not-yet-rasterized `.page-slot` by
// calling the exported `renderPageIntoSlot()` directly instead of waiting
// on the IntersectionObserver that normally drives this (see
// createViewObserver() in renderer.js). This headless/backgrounded window
// never gets real OS focus, and Chromium silently pauses
// IntersectionObserver callbacks for an unfocused/occluded window — normal
// scroll-triggered rendering would just never happen here, regardless of
// how long this script waits; renderer.js exports renderPageIntoSlot
// specifically for this bypass.
async function forceRenderAllSlots(ws) {
  await evaluate(
    ws,
    `Promise.all(
      [...document.querySelectorAll('.page-slot:not(.rendered)')].map((slot) => __mod.renderPageIntoSlot(slot)),
    )`,
  );
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
// processes keep squatting on this script's CDP port, so a later run's
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

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-screenshots-userdata-'));
const child = spawn(
  electronBinPath,
  ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--window-size=1280,860'],
  // `detached: true` puts this whole process tree in its own process group
  // — see the comment on killElectron() above for why that matters.
  { cwd: projectRoot, env, stdio: 'inherit', detached: true },
);

try {
  const wsUrl = await waitForDebuggerUrl(20000);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  await evaluate(ws, `(async () => { globalThis.__mod = await import('./renderer.js'); return true; })()`);
  // Deterministic English UI regardless of the host OS's locale, so the
  // screenshots always look the same no matter who regenerates them.
  await evaluate(ws, `__mod.switchLocale('en'); true`);
  await new Promise((r) => setTimeout(r, 300));

  const filePaths = ['screenshot1.pdf', 'screenshot2.pdf', 'screenshot3.pdf'].map((f) => path.join(pdfsDir, f));
  await evaluate(
    ws,
    `(async () => {
      const fileInfos = await window.api.readPdfFiles(${JSON.stringify(filePaths)});
      await __mod.handleOpenedFiles(fileInfos);
      return true;
    })()`,
  );
  await new Promise((r) => setTimeout(r, 1000));

  await fs.mkdir(outDir, { recursive: true });

  await evaluate(ws, `__mod.setView('canvas')`);
  await forceRenderAllSlots(ws);
  await new Promise((r) => setTimeout(r, 300));
  let shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, 'canvas-view.png'), Buffer.from(shot.result.data, 'base64'));

  await evaluate(ws, `__mod.setView('grid')`);
  await forceRenderAllSlots(ws);
  await new Promise((r) => setTimeout(r, 300));
  shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, 'grid-view.png'), Buffer.from(shot.result.data, 'base64'));

  ws.close();
  console.log(`Wrote ${path.join(outDir, 'canvas-view.png')} and grid-view.png`);
} finally {
  killElectron(child);
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
