import { test, after } from 'node:test';
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

// Covers "does a setting actually survive an app restart", which the
// manual test checklist previously lumped in with the genuinely-manual
// OS-locale/network-dependent items — it doesn't belong there: whether
// settings.json is read correctly on a fresh launch depends on nothing
// but this app's own code and a real second Electron process against the
// same --user-data-dir, both fully controllable here. Every CDP test file
// needs its own port, and process cleanup uses killElectron() (detached
// process group) rather than a plain .kill().

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
// A separate port from the other CDP test files (9422-9426) — node:test
// can run multiple test files concurrently, each with its own Electron
// process, so a shared port would collide.
const CDP_PORT = 9428;

let userDataDir;
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

// node_modules/.bin/electron is itself a wrapper that
// spawns the real Electron binary as a separate child process; a plain
// .kill() doesn't reliably take the whole tree down with it.
function killElectron(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function launchPageBoard() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronProcess = spawn(
    electronBinPath,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    { cwd: projectRoot, env, stdio: 'ignore', detached: true },
  );

  const wsUrl = await waitForDebuggerUrl(20000);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send(ws, 'Runtime.enable');
  await evaluate(ws, `(async () => { globalThis.__mod = await import('./renderer.js'); return true; })()`);

  return { electronProcess, ws };
}

async function shutdown({ electronProcess, ws }) {
  ws?.close();
  killElectron(electronProcess);
  // Give the OS a moment to actually release the CDP port before the next
  // launchPageBoard() in the same test polls for it again.
  await new Promise((r) => setTimeout(r, 300));
}

let activeSession;
after(async () => {
  if (activeSession) await shutdown(activeSession);
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('locale, default view, and default grid-columns survive a full app restart', async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-settings-persist-userdata-'));

  // First launch: force English deterministically (this goes through
  // switchLocale(), not window.api.saveSettings() directly, since the
  // latter only updates main.js's own state, not the already-running
  // renderer's `t` binding), then change every persisted setting this test
  // cares about.
  activeSession = await launchPageBoard();
  await evaluate(activeSession.ws, `__mod.switchLocale('en'); true`);
  await evaluate(
    activeSession.ws,
    `(async () => {
      await window.api.saveSettings({ locale: 'de', view: 'grid', gridColumnsPerRow: 12 });
      return true;
    })()`,
  );
  await shutdown(activeSession);
  activeSession = null;

  // Confirm what actually landed on disk before trusting the second
  // launch's behavior to it.
  const settingsOnDisk = JSON.parse(await fs.readFile(path.join(userDataDir, 'settings.json'), 'utf8'));
  assert.equal(settingsOnDisk.locale, 'de');
  assert.equal(settingsOnDisk.view, 'grid');
  assert.equal(settingsOnDisk.gridColumnsPerRow, 12);

  // Second launch: a genuinely fresh Electron process/renderer against the
  // SAME --user-data-dir — nothing in memory survives from the first
  // launch, only what's on disk.
  activeSession = await launchPageBoard();
  await new Promise((r) => setTimeout(r, 500)); // let the async settings-driven startup init finish

  const startupState = await evaluate(
    activeSession.ws,
    `({
      shortcutsTitle: document.getElementById('shortcuts-button').title,
      gridButtonActive: document.getElementById('grid-view-button').classList.contains('active'),
      gridColumnsSelectValue: document.getElementById('grid-columns-select').value,
    })`,
  );

  assert.equal(startupState.shortcutsTitle, 'Tastenkombinationen anzeigen (Strg/Cmd+/)', 'locale should be German');
  assert.equal(startupState.gridButtonActive, true, 'should start in Grid view');
  assert.equal(startupState.gridColumnsSelectValue, '12', 'grid-columns dropdown should reflect the saved setting');
});
