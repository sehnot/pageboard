/**
 * Only https:// URLs are ever safe to hand to shell.openExternal() — a
 * file:// or registered-custom-protocol URL reaches the OS's default
 * handler directly, outside Chromium's sandbox. Framework-free/pure (no
 * Electron import) so this is unit-testable without a running app, same
 * reasoning as src/settings.mjs and src/i18n.mjs.
 *
 * Returns the normalized href to open, or `null` if the URL isn't allowed.
 */
export function getSafeExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' ? parsed.href : null;
}
