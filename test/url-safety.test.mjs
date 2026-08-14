import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSafeExternalUrl } from '../src/url-safety.mjs';

// Regression coverage for the open-external IPC handler in main.js — a
// compromised renderer previously could pass any URL straight to
// shell.openExternal(), including file:///custom-protocol URLs that reach
// the OS launcher outside Chromium's sandbox. Extracted into this pure
// module specifically so the check itself is unit-testable without a
// running Electron app (main.js can't be required under plain node:test,
// see CLAUDE.md).

test('accepts a well-formed https URL, unchanged', () => {
  assert.equal(getSafeExternalUrl('https://github.com/foo/bar'), 'https://github.com/foo/bar');
});

test('rejects a file:// URL', () => {
  assert.equal(getSafeExternalUrl('file:///etc/passwd'), null);
});

test('rejects a custom/registered protocol', () => {
  assert.equal(getSafeExternalUrl('myapp://payload'), null);
});

test('rejects plain http (only https is allowed)', () => {
  assert.equal(getSafeExternalUrl('http://example.com'), null);
});

test('rejects a malformed URL string instead of throwing', () => {
  assert.equal(getSafeExternalUrl('not a url'), null);
});

test('rejects non-string input instead of throwing', () => {
  assert.equal(getSafeExternalUrl(null), null);
  assert.equal(getSafeExternalUrl(undefined), null);
  assert.equal(getSafeExternalUrl(42), null);
});
