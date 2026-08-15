import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { startSession, CDP_PORTS } from './helpers/cdp-session.mjs';

// Covers the Options dialog (i18n, default view/grid-columns settings,
// auto-update toggle) end to end. What's deliberately NOT checked here: real
// OS-locale detection (machine-dependent) and actual network-backed
// auto-update outcomes against real GitHub Releases (existing manual-testing
// caveat).

let session;

before(async () => {
  session = await startSession({ name: 'options', port: CDP_PORTS.optionsDialog });
});

after(async () => {
  await session?.close();
});

const evaluate = (expression) => session.evaluate(expression);

async function readSettingsFile() {
  const raw = await fs.readFile(path.join(session.userDataDir, 'settings.json'), 'utf8');
  return JSON.parse(raw);
}

// Settings are written by main.js after an IPC round trip, so the file lags
// the UI action that triggered it by an unpredictable amount. Polling for the
// expected content is both faster than a fixed delay on a quick machine and
// reliable on a loaded one; on failure it reports what the file actually held.
async function waitForSettings(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await readSettingsFile().catch(() => null);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}; settings.json holds ${JSON.stringify(last)}`,
  );
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
// test — no test checked DOM structure like this before.
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
  // saveSettings() is async (IPC round trip), so poll the file until the
  // write has actually landed rather than assuming a fixed delay is enough.
  const settings = await waitForSettings((s) => s.gridColumnsPerRow === 12,
    'gridColumnsPerRow to become 12');
  assert.equal(settings.gridColumnsPerRow, 12);

  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

// Regression test: save-settings() used to return a narrower object than
// get-settings() (missing appVersion/systemLocale/repositoryUrl), and
// saveSettingsPatch() in renderer.js replaces its whole `currentSettings`
// with whatever save-settings returns — so any settings change silently
// dropped those fields, only visible once something re-read them (the
// version text, next time Options was rebuilt).
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
  await waitForSettings((s) => s.gridColumnsPerRow === 5, 'gridColumnsPerRow to become 5');

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
  await waitForSettings((s) => s.locale === 'de', 'locale to become de');

  const shortcutsTitle = await evaluate(`document.getElementById('shortcuts-button').title`);
  assert.equal(shortcutsTitle, 'Tastenkombinationen anzeigen (Strg/Cmd+/)');

  const optionsHeading = await evaluate(`document.querySelector('.options-overlay h2')?.textContent`);
  assert.equal(optionsHeading, 'Optionen');

  // Regression check: the rebuilt dialog's own language <select> must show
  // the new selection too, not just the surrounding text — switchLocale()
  // used to rebuild the dialog before the (deliberately un-awaited) settings
  // save resolved, so the picker briefly kept showing the old language even
  // though everything else had already switched.
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
  await waitForSettings((s) => s.autoUpdateEnabled === false, 'autoUpdateEnabled to become false');

  const settings = await readSettingsFile();
  assert.equal(settings.autoUpdateEnabled, false);

  await evaluate(`(() => { document.querySelector('.options-overlay')?.remove(); return true; })()`);
});

// package.json's repository.url used to be the literal TODO-owner
// placeholder (see deriveRepositoryUrl() in main.js) — the "View
// on GitHub" button stayed hidden until that was fixed, self-correcting
// with no code change needed. Now that a real URL is set, this test flips
// to the opposite assertion: the button appears and points at the real
// repo — this is the flip that was already anticipated when the
// placeholder-hiding behavior was first written.
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
  // written); this test would catch that detail
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
