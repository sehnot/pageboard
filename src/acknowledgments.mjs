/**
 * Third-party license/acknowledgment data — framework-free so it's the
 * single source both the in-app dialog (renderer.js showAcknowledgmentsDialog)
 * and ACKNOWLEDGMENTS.md are meant to stay in sync with (the Markdown file
 * is a hand-maintained mirror of this array for GitHub browsability outside
 * the app; there is no build step that generates one from the other).
 *
 * Verified directly from each dependency's own package.json rather than
 * assumed — pdfjs-dist is Apache-2.0, not MIT like the others.
 */
// `noteKey` (rather than a hardcoded English `note` string) looks up the
// actual text in src/i18n.mjs's `dialog.acknowledgments.notes.*` — this
// dialog previously stayed English even when the rest of the UI switched to
// German, since renderer.js rendered `note` verbatim with no translation
// step. `name`/`licenseType`/`licenseUrl` stay untranslated on purpose:
// they're proper names/identifiers, not UI copy.
export const ACKNOWLEDGMENTS = [
  {
    name: 'PageBoard',
    licenseType: 'MIT',
    licenseUrl: 'https://github.com/sehnot/pageboard/blob/main/LICENSE',
    noteKey: null,
  },
  {
    name: 'pdf-lib',
    licenseType: 'MIT',
    licenseUrl: 'https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md',
    noteKey: 'dialog.acknowledgments.notes.pdfLib',
  },
  {
    name: 'pdfjs-dist (pdf.js)',
    licenseType: 'Apache-2.0',
    licenseUrl: 'https://github.com/mozilla/pdf.js/blob/master/LICENSE',
    noteKey: 'dialog.acknowledgments.notes.pdfjsDist',
  },
  {
    name: 'electron-updater',
    licenseType: 'MIT',
    licenseUrl: 'https://github.com/electron-userland/electron-builder/blob/master/LICENSE',
    noteKey: 'dialog.acknowledgments.notes.electronUpdater',
  },
  {
    name: '@tabler/icons',
    licenseType: 'MIT',
    licenseUrl: 'https://github.com/tabler/tabler-icons/blob/main/LICENSE',
    noteKey: 'dialog.acknowledgments.notes.tablerIcons',
  },
];
