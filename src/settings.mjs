/**
 * Framework-free settings shape and merge logic — importable from both the
 * main process (which owns the actual file I/O, see main.js) and, if ever
 * needed, the renderer (e.g. for unit tests), analogous to `src/model/` and
 * `src/icons.mjs`.
 *
 * `mergeSettings()` is intentionally pure and defensive: a hand-edited or
 * corrupted `settings.json`, or one written by a future version with
 * different valid values, must never crash the app on startup — an unknown
 * or invalid field is just dropped in favor of the default instead of
 * propagating garbage into the renderer.
 */

import { LOCALES } from './i18n.mjs';

export const GRID_COLUMNS_OPTIONS = [5, 8, 10, 12, 15, 'all'];

export const VIEW_OPTIONS = ['canvas', 'grid'];

export const DEFAULT_SETTINGS = {
  // `null` means "no explicit choice yet" — the renderer falls back to the
  // OS-detected locale in that case (see src/i18n.mjs matchLocale()).
  // Once the user picks a language, that choice always wins over the OS
  // locale on every later launch.
  locale: null,
  view: 'canvas',
  gridColumnsPerRow: 8,
  autoUpdateEnabled: true,
};

export function mergeSettings(defaults, saved) {
  const merged = { ...defaults };
  if (!saved || typeof saved !== 'object') return merged;

  if (LOCALES.includes(saved.locale)) {
    merged.locale = saved.locale;
  }
  if (VIEW_OPTIONS.includes(saved.view)) {
    merged.view = saved.view;
  }
  if (GRID_COLUMNS_OPTIONS.includes(saved.gridColumnsPerRow)) {
    merged.gridColumnsPerRow = saved.gridColumnsPerRow;
  }
  if (typeof saved.autoUpdateEnabled === 'boolean') {
    merged.autoUpdateEnabled = saved.autoUpdateEnabled;
  }
  return merged;
}
