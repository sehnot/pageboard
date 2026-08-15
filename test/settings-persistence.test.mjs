import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createTranslator } from '../src/i18n.mjs';
import { startSession, CDP_PORTS } from './helpers/cdp-session.mjs';

// Covers "does a setting actually survive an app restart", which the manual
// test checklist previously lumped in with the genuinely-manual
// OS-locale/network-dependent items — it doesn't belong there: whether
// settings.json is read correctly on a fresh launch depends on nothing but
// this app's own code and a real second Electron process against the same
// --user-data-dir, both fully controllable here.

let userDataDir;
let activeSession;

after(async () => {
  await activeSession?.close();
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('locale, default view, and default grid-columns survive a full app restart', async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-settings-persist-userdata-'));

  // First launch: start from a deterministic English UI (the harness forces
  // it via switchLocale(), not window.api.saveSettings(), since the latter
  // only updates main.js's own state and leaves the running renderer's `t`
  // binding untouched), then change every persisted setting this test cares
  // about.
  activeSession = await startSession({
    name: 'settings-persist',
    port: CDP_PORTS.settingsPersistence,
    userDataDir,
  });
  await activeSession.evaluate(`
    (async () => {
      await window.api.saveSettings({ locale: 'de', view: 'grid', gridColumnsPerRow: 12 });
      return true;
    })()
  `);
  await activeSession.close();
  activeSession = null;

  // Confirm what actually landed on disk before trusting the second launch's
  // behavior to it.
  const settingsOnDisk = JSON.parse(await fs.readFile(path.join(userDataDir, 'settings.json'), 'utf8'));
  assert.equal(settingsOnDisk.locale, 'de');
  assert.equal(settingsOnDisk.view, 'grid');
  assert.equal(settingsOnDisk.gridColumnsPerRow, 12);

  // Second launch: a genuinely fresh Electron process/renderer against the
  // SAME --user-data-dir — nothing in memory survives from the first launch,
  // only what's on disk. `locale: null` so the harness does NOT force a
  // language: which one the app picks is exactly what's under test.
  activeSession = await startSession({
    name: 'settings-persist',
    port: CDP_PORTS.settingsPersistence,
    userDataDir,
    locale: null,
  });

  // Settings-driven startup is async (an IPC round trip to main.js), so wait
  // for it to have actually taken effect rather than sleeping a fixed amount
  // and hoping. The Grid button carrying `.active` is the last of the three
  // settings to be applied by that init path.
  await activeSession.waitFor(
    `document.getElementById('grid-view-button').classList.contains('active')`,
    { message: 'saved "grid" default view was never applied on startup' },
  );

  const startupState = await activeSession.evaluate(`({
    shortcutsTitle: document.getElementById('shortcuts-button').title,
    gridButtonActive: document.getElementById('grid-view-button').classList.contains('active'),
    gridColumnsSelectValue: document.getElementById('grid-columns-select').value,
  })`);

  // Compared against the German dictionary rather than a copy-pasted literal:
  // the point of this assertion is that the saved locale was restored, not
  // that a particular sentence still reads exactly as it did. A reworded
  // translation should not fail a persistence test.
  const de = createTranslator('de');
  assert.equal(
    startupState.shortcutsTitle,
    de('toolbar.shortcutsTitle'),
    'locale should have been restored to German',
  );
  assert.equal(startupState.gridButtonActive, true, 'should start in Grid view');
  assert.equal(startupState.gridColumnsSelectValue, '12', 'grid-columns dropdown should reflect the saved setting');
});
