import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

// Covers the Options dialog (i18n, default view/grid-columns settings,
// auto-update toggle) end to end via the same CDP technique as
// error-handling.test.mjs/focus-mode.test.mjs — see CLAUDE.md "Headless UI
// verification". What's deliberately NOT checked here: real OS-locale
// detection (machine-dependent, see TESTING.md) and actual network-backed
// auto-update outcomes against real GitHub Releases (existing manual
// caveat — see TESTING.md).

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
// A separate port from the other CDP test files (9422/9423/9424) — node:test
// can run multiple test files concurrently, each with its own Electron
// process, so a shared port would collide.
const CDP_PORT = 9425;

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

before(async () => {
  const electronBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // A scratch --user-data-dir both isolates settings.json from the real
  // profile/other concurrent test files, and gives this file direct
  // filesystem access to assert on the persisted settings, not just what
  // the renderer reports about itself.
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-options-userdata-'));
  electronProcess = spawn(
    electronBin,
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
  // Deterministic starting language regardless of the host OS's locale —
  // see LESSONS.md for why this has to go through the renderer's own
  // switchLocale(), not window.api.saveSettings() directly.
  await evaluate(`__mod.switchLocale('en'); true`);
});

after(async () => {
  ws?.close();
  killElectron(electronProcess);
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function readSettingsFile() {
  const raw = await fs.readFile(path.join(userDataDir, 'settings.json'), 'utf8');
  return JSON.parse(raw);
}

// Every one of these toolbar buttons gets an icon injected via
// createIcon() in renderer.js (see the block right after the element refs)
// — independent of applyStaticTranslations()/switchLocale(), which must
// never wipe it back out. This list is exactly the icon-bearing button ids
// (not e.g. #empty-open-button, which deliberately has no icon).
const ICON_BUTTON_IDS = [
  'open-button',
  'save-all-button',
  'duplicate-button',
  'rotate-left-button',
  'rotate-right-button',
  'delete-button',
  'shortcuts-button',
  'options-button',
  'canvas-view-button',
  'grid-view-button',
];

async function iconButtonsWithoutSvg() {
  return evaluate(`
    ${JSON.stringify(ICON_BUTTON_IDS)}.filter((id) => !document.getElementById(id)?.querySelector('svg'))
  `);
}

// Regression test: applyStaticTranslations() used to set `el.textContent`
// directly on button elements that also had an icon prepended as a DOM
// child — textContent assignment replaces ALL child nodes, so the icon
// silently disappeared on every app startup (any button whose translatable
// text sat directly on the <button> rather than a wrapping <span>). Found
// via a user report ("icons seem to be missing"), not by any existing
// test — no test checked DOM structure like this before. See LESSONS.md.
test('every icon-bearing toolbar button still has its icon after startup', async () => {
  assert.deepEqual(await iconButtonsWithoutSvg(), []);
});

test('every icon-bearing toolbar button still has its icon after switching language', async () => {
  await evaluate(`__mod.switchLocale('de'); true`);
  assert.deepEqual(await iconButtonsWithoutSvg(), []);
  await evaluate(`__mod.switchLocale('en'); true`); // restore for later tests in this file
});

test('#options-button opens the Options dialog', async () => {
  const opened = await evaluate(`
    (() => {
      document.getElementById('options-button').click();
      return !!document.querySelector('.options-overlay');
    })()
  `);
  assert.equal(opened, true);

  await evaluate(`(() => { document.querySelector('.options-overlay').remove(); return true; })()`);
});

test('Escape closes the Options dialog (regression: the global keydown handler bailed out on a focused <select> before ever checking for an open modal)', async () => {
  // setupModalDialog() focuses the dialog's first focusable control on
  // open — for Options that's the language <select>, which is exactly the
  // element type the keydown handler's activeTag guard (INPUT/SELECT/
  // TEXTAREA) is meant to suppress *other* shortcuts for. That guard used
  // to run before the "is a modal open" check, so Escape never reached the
  // modal-closing branch at all whenever a <select> happened to be focused
  // — caught via manual smoke-testing, not by the original interaction.
  // test.mjs regression test (which happened to only exercise the
  // Shortcuts dialog, whose first focusable element is a <button>, not a
  // <select>, so it never hit this path).
  await evaluate(`(() => { document.getElementById('options-button').click(); return true; })()`);
  const activeIsSelect = await evaluate(`document.activeElement?.id === 'options-language-select'`);
  assert.equal(activeIsSelect, true, 'sanity check: focus should have landed on the language select');

  await evaluate(`
    (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()
  `);
  const stillOpen = await evaluate(`!!document.querySelector('.options-overlay')`);
  assert.equal(stillOpen, false);
});

test('changing the default grid-columns setting round-trips into settings.json', async () => {
  await evaluate(`
    (() => {
      document.getElementById('options-button').click();
      const select = document.getElementById('options-grid-columns-select');
      select.value = '12';
      select.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  // saveSettings() is async (IPC round trip) — give it a moment before
  // reading the file back from disk.
  await new Promise((r) => setTimeout(r, 300));

  const settings = await readSettingsFile();
  assert.equal(settings.gridColumnsPerRow, 12);

  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

// Regression test: save-settings() used to return a narrower object than
// get-settings() (missing appVersion/systemLocale/repositoryUrl), and
// saveSettingsPatch() in renderer.js replaces its whole `currentSettings`
// with whatever save-settings returns — so any settings change silently
// dropped those fields, only visible once something re-read them (the
// version text, next time Options was rebuilt). See LESSONS.md.
test('the version text survives a settings change (regression: save-settings used to drop it)', async () => {
  await evaluate(`
    (() => {
      document.getElementById('options-button').click();
      const select = document.getElementById('options-grid-columns-select');
      select.value = '5';
      select.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  const versionText = await evaluate(`
    [...document.querySelectorAll('.options-overlay p')].find((p) => p.textContent.startsWith('Version'))?.textContent
  `);
  assert.match(versionText, /^Version \d+\.\d+\.\d+$/);

  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

test('switching language in Options changes both the dialog itself and static toolbar text', async () => {
  await evaluate(`
    (() => {
      document.getElementById('options-button').click();
      const languageSelect = document.getElementById('options-language-select');
      languageSelect.value = 'de';
      languageSelect.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  const shortcutsTitle = await evaluate(`document.getElementById('shortcuts-button').title`);
  assert.equal(shortcutsTitle, 'Tastenkombinationen anzeigen (Strg/Cmd+/)');

  const optionsHeading = await evaluate(`document.querySelector('.options-overlay h2')?.textContent`);
  assert.equal(optionsHeading, 'Optionen');

  // Regression check: the rebuilt dialog's own language <select> must show
  // the new selection too, not just the surrounding text — switchLocale()
  // used to rebuild the dialog before the (deliberately un-awaited) settings
  // save resolved, so the picker briefly kept showing the old language even
  // though everything else had already switched. See LESSONS.md.
  const selectedLanguage = await evaluate(`document.getElementById('options-language-select')?.value`);
  assert.equal(selectedLanguage, 'de');

  const settings = await readSettingsFile();
  assert.equal(settings.locale, 'de');

  // Restore English for any later tests in this file / re-runs.
  await evaluate(`__mod.switchLocale('en'); true`);
  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

test('the auto-update toggle persists to settings.json', async () => {
  await evaluate(`
    (() => {
      document.getElementById('options-button').click();
      const checkbox = document.getElementById('options-auto-update-checkbox');
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  const settings = await readSettingsFile();
  assert.equal(settings.autoUpdateEnabled, false);

  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

// package.json's repository.url used to be the literal TODO-owner
// placeholder (see CLAUDE.md/deriveRepositoryUrl() in main.js) — the "View
// on GitHub" button stayed hidden until that was fixed, self-correcting
// with no code change needed. Now that a real URL is set, this test flips
// to the opposite assertion: the button appears and points at the real
// repo. (This is the flip that comment predicted — see GITHUB.md.)
test('the "View on GitHub" button appears and links to the real repository once repository.url is a real URL', async () => {
  const settings = await evaluate(`window.api.getSettings()`);
  assert.equal(settings.repositoryUrl, 'https://github.com/sehnot/pageboard');

  await evaluate(`(() => { document.getElementById('options-button').click(); return true; })()`);

  const githubButtonExists = await evaluate(`
    [...document.querySelectorAll('.options-overlay .modal-info-actions button')]
      .some((b) => b.textContent === 'View on GitHub')
  `);
  assert.equal(githubButtonExists, true);

  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

test('"Licenses & acknowledgments" opens a dialog listing all dependencies with their license type', async () => {
  await evaluate(`
    (() => {
      document.getElementById('options-button').click();
      const button = [...document.querySelectorAll('.options-overlay .modal-info-actions button')]
        .find((b) => b.textContent === 'Licenses & acknowledgments');
      button.click();
      return true;
    })()
  `);

  const entries = await evaluate(`
    [...document.querySelectorAll('.modal-overlay:not(.options-overlay) .modal-row')].map((row) => ({
      name: row.querySelector('span')?.textContent,
      license: row.querySelector('a')?.textContent,
      href: row.querySelector('a')?.getAttribute('href'),
    }))
  `);

  // Matches src/acknowledgments.mjs — pdfjs-dist is Apache-2.0, not MIT like
  // the rest (verified against its actual package.json when the module was
  // written, see CLAUDE.md/LESSONS.md); this test would catch that detail
  // silently regressing to "MIT" by copy-paste later.
  assert.equal(entries.length, 5);
  assert.ok(entries.every((e) => e.href?.startsWith('https://')), 'every entry should link somewhere real');
  const byName = Object.fromEntries(entries.map((e) => [e.name.split(' —')[0], e.license]));
  assert.equal(byName['PageBoard'], 'MIT');
  assert.equal(byName['pdf-lib'], 'MIT');
  assert.equal(byName['pdfjs-dist (pdf.js)'], 'Apache-2.0');
  assert.equal(byName['electron-updater'], 'MIT');
  assert.equal(byName['@tabler/icons'], 'MIT');

  await evaluate(`
    (() => {
      document.querySelector('.modal-overlay:not(.options-overlay)')?.remove();
      document.querySelector('.options-overlay')?.remove();
      return true;
    })()
  `);
});
