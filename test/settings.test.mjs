import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings.mjs';

test('mergeSettings returns defaults when nothing was saved', () => {
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, undefined), DEFAULT_SETTINGS);
});

test('mergeSettings applies valid saved values over defaults', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    locale: 'de',
    view: 'grid',
    gridColumnsPerRow: 12,
    autoUpdateEnabled: false,
  });
  assert.deepEqual(merged, {
    locale: 'de',
    view: 'grid',
    gridColumnsPerRow: 12,
    autoUpdateEnabled: false,
  });
});

test('mergeSettings drops invalid/unknown values and falls back to defaults for them', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    view: 'not-a-real-view',
    gridColumnsPerRow: 999,
    autoUpdateEnabled: 'yes', // not a boolean
    someFutureField: 'ignored',
  });
  assert.deepEqual(merged, DEFAULT_SETTINGS);
});

test('mergeSettings accepts the "all" grid-columns option', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, { gridColumnsPerRow: 'all' });
  assert.equal(merged.gridColumnsPerRow, 'all');
});

test('mergeSettings can be used as a patch merge (current settings as defaults)', () => {
  const current = mergeSettings(DEFAULT_SETTINGS, { locale: 'de', gridColumnsPerRow: 12 });
  const patched = mergeSettings(current, { gridColumnsPerRow: 5 });
  assert.equal(patched.locale, 'de'); // untouched field survives
  assert.equal(patched.gridColumnsPerRow, 5); // patched field applies
});

test('mergeSettings ignores a non-object saved value entirely', () => {
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, 'not an object'), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, 42), DEFAULT_SETTINGS);
});
