import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, DEFAULT_LOCALE, DICTIONARIES, matchLocale, createTranslator } from '../src/i18n.mjs';

test('matchLocale matches the primary language subtag, ignoring region', () => {
  assert.equal(matchLocale('de-CH'), 'de');
  assert.equal(matchLocale('de_DE'), 'de');
  assert.equal(matchLocale('en-US'), 'en');
  assert.equal(matchLocale('DE'), 'de'); // case-insensitive
});

test('matchLocale falls back to the default locale for anything unsupported', () => {
  assert.equal(matchLocale('fr-FR'), DEFAULT_LOCALE);
  assert.equal(matchLocale(undefined), DEFAULT_LOCALE);
  assert.equal(matchLocale(null), DEFAULT_LOCALE);
  assert.equal(matchLocale(''), DEFAULT_LOCALE);
});

test('matchLocale respects a custom available-locales list', () => {
  assert.equal(matchLocale('de-DE', ['en']), 'en');
});

test('every locale in LOCALES has a dictionary', () => {
  for (const locale of LOCALES) {
    assert.ok(DICTIONARIES[locale], `missing dictionary for locale "${locale}"`);
  }
});

test('createTranslator looks up nested keys', () => {
  const t = createTranslator('de');
  assert.equal(t('toolbar.open'), 'Öffnen…');
  assert.equal(t('contextMenu.duplicate'), 'Duplizieren');
});

test('createTranslator interpolates params', () => {
  const t = createTranslator('en');
  assert.equal(t('toast.alreadyOpen', { name: 'invoice.pdf' }), 'invoice.pdf is already open');
  assert.equal(
    t('dialog.options.updateAvailable', { version: '2.0.0' }),
    'A new version (2.0.0) is available',
  );
});

test('createTranslator falls back to the key itself for a totally unknown key', () => {
  const t = createTranslator('en');
  assert.equal(t('nonexistent.key'), 'nonexistent.key');
});

test('createTranslator falls back to an unsupported locale\'s default (en) dictionary', () => {
  const t = createTranslator('fr'); // no French dictionary exists
  assert.equal(t('toolbar.open'), 'Open…');
});

// Flattens a nested dictionary object into { 'a.b.c': 'value' } pairs — used
// below to compare dictionaries structurally instead of just spot-checking
// individual keys, so a key silently dropped from one locale (or a language
// added later that only partially translates) gets caught automatically
// instead of only being noticed by a user actually hitting that string.
function flatten(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result[path] = value;
    } else {
      Object.assign(result, flatten(value, path));
    }
  }
  return result;
}

test('every locale dictionary has exactly the same set of keys', () => {
  const [firstLocale, ...restLocales] = LOCALES;
  const referenceKeys = Object.keys(flatten(DICTIONARIES[firstLocale])).sort();
  for (const locale of restLocales) {
    const keys = Object.keys(flatten(DICTIONARIES[locale])).sort();
    assert.deepEqual(keys, referenceKeys, `"${locale}" dictionary's key set doesn't match "${firstLocale}"'s`);
  }
});

test('every locale translates a given key with the same set of {placeholders}', () => {
  const [firstLocale, ...restLocales] = LOCALES;
  const reference = flatten(DICTIONARIES[firstLocale]);
  const placeholdersOf = (str) => [...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  for (const locale of restLocales) {
    const other = flatten(DICTIONARIES[locale]);
    for (const key of Object.keys(reference)) {
      const referencePlaceholders = placeholdersOf(reference[key]);
      const otherPlaceholders = placeholdersOf(other[key] ?? '');
      assert.deepEqual(
        otherPlaceholders,
        referencePlaceholders,
        `"${locale}"'s translation of "${key}" has different {placeholders} than "${firstLocale}"'s`,
      );
    }
  }
});
