/**
 * Framework-free translation dictionaries + lookup — importable from both
 * processes (main.js translates native chrome: the app menu, page/document
 * context menus, the close-confirmation dialog; renderer.js translates
 * everything on screen), exactly like `src/icons.mjs` already is.
 *
 * `LOCALES` is the one place to extend when adding a language later.
 * Dictionaries are nested by feature area (not flat) so a ~5-language file
 * stays navigable. A missing key falls back to the `en` dictionary, then to
 * the key itself as a last resort — a partially translated new language
 * degrades string-by-string, not as a whole page.
 */

export const LOCALES = ['en', 'de'];

export const DEFAULT_LOCALE = 'en';

const en = {
  toolbar: {
    open: 'Open…',
    openTitle: 'Open PDFs (Ctrl/Cmd+O)',
    saveAll: 'Save all',
    duplicateTitle: 'Duplicate selected pages (Ctrl/Cmd+D)',
    rotateLeftTitle: 'Rotate selected pages 90° left (Ctrl/Cmd+L)',
    rotateRightTitle: 'Rotate selected pages 90° right (Ctrl/Cmd+R)',
    deleteTitle: 'Delete selected pages (Delete)',
    shortcutsTitle: 'Show keyboard shortcuts (Ctrl/Cmd+/)',
    optionsTitle: 'Options',
    canvasView: 'Canvas',
    canvasViewTitle: 'Canvas mode: documents side by side',
    gridView: 'Grid',
    gridViewTitle: 'Grid view: pages as tiles',
    gridColumnsLabel: 'Pages per row:',
    gridColumnsLabelTitle: 'Number of pages per row in Grid view',
    saveAllTitle: 'Save all unsaved documents',
    saveAllTitleDisabled: 'No unsaved changes',
  },
  emptyState: {
    dragHint: 'Drag PDFs here or',
    openButton: 'Open…',
  },
  drag: {
    pagesBadge: '{count} pages',
    newDocument: 'New document',
  },
  sectionHeader: {
    unsavedTitle: 'Unsaved changes',
    saveTitle: 'Save',
    saveDisabledTitle: 'No unsaved changes',
    closeTitle: 'Close',
  },
  toast: {
    alreadyOpen: '{name} is already open',
    couldNotBeOpened: 'Could not be opened: {detail}',
    failedToOpenMultiple: 'Failed to open {count} files',
    reasonUnreadable: 'unreadable',
    reasonPasswordProtected: 'password-protected',
    reasonCorrupted: 'corrupted or not a valid PDF',
    failedToDeleteOne: 'Failed to delete: {name}',
    failedToDeleteMultiple: 'Failed to delete {count} documents',
    failedToSaveOne: 'Failed to save: {name}',
    failedToSaveMultiple: 'Failed to save {count} documents',
  },
  dialog: {
    openPdf: {
      filterName: 'PDF',
    },
    emptyDocs: {
      heading: 'Empty documents',
      intro: 'These documents no longer contain any pages. Please choose how to handle each one when saving:',
      restoreOriginal: 'Restore original',
      delete: 'Delete',
      cancel: 'Cancel',
      continueButton: 'Continue',
    },
    shortcuts: {
      heading: 'Keyboard shortcuts',
      close: 'Close',
    },
    options: {
      heading: 'Options',
      close: 'Close',
      sectionDisplay: 'Display',
      sectionUpdates: 'Updates',
      sectionInfo: 'Info',
      language: 'Language',
      defaultView: 'Default view',
      defaultGridColumns: 'Default pages per row (Grid)',
      nextLaunchHint: 'Applies the next time PageBoard starts.',
      autoUpdate: 'Automatically check for updates',
      checkNow: 'Check now',
      checking: 'Checking…',
      updateAvailable: 'A new version ({version}) is available',
      upToDate: 'Up to date',
      checkFailed: 'Update check failed: {message}',
      version: 'Version {version}',
      viewOnGithub: 'View on GitHub',
      acknowledgments: 'Licenses & acknowledgments',
    },
    acknowledgments: {
      heading: 'Licenses & acknowledgments',
      close: 'Close',
      notes: {
        pdfLib: 'Used for building/writing PDFs when saving.',
        pdfjsDist: 'Used for rendering/displaying PDFs.',
        electronUpdater: 'Used for the auto-update check.',
        tablerIcons:
          'A handful of icon outlines were hand-copied as path data into src/icons.mjs — see that file for details.',
      },
    },
    closeUnsaved: {
      message: '"{name}" has unsaved changes.',
      detail: 'Save before closing?',
      save: 'Save',
      discard: 'Discard',
      cancel: 'Cancel',
    },
  },
  shortcutsList: {
    openPdfsKeys: 'Ctrl/Cmd+O',
    openPdfs: 'Open PDFs',
    undoKeys: 'Ctrl/Cmd+Z',
    undo: 'Undo',
    redoKeys: 'Ctrl/Cmd+Shift+Z',
    redo: 'Redo',
    deleteKeys: 'Delete / Backspace',
    delete: 'Delete selected pages',
    duplicateKeys: 'Ctrl/Cmd+D',
    duplicate: 'Duplicate selected pages',
    rotateLeftKeys: 'Ctrl/Cmd+L',
    rotateLeft: 'Rotate selected pages 90° left',
    rotateRightKeys: 'Ctrl/Cmd+R',
    rotateRight: 'Rotate selected pages 90° right',
    clickKeys: 'Click',
    click: 'Select page',
    shiftClickKeys: 'Shift+click',
    shiftClick: 'Select range to the last-selected page',
    modClickKeys: 'Ctrl/Cmd+click',
    modClick: 'Add/remove a single page to/from the selection',
    doubleClickKeys: 'Double-click a page',
    doubleClick: 'Toggle focus mode',
    rightClickPageKeys: 'Right-click a page',
    rightClickPage: 'Duplicate / rotate / delete',
    rightClickHeaderKeys: 'Right-click a document header',
    rightClickHeader: 'Save / close',
    showShortcutsKeys: 'Ctrl/Cmd+/',
    showShortcuts: 'Show this overview',
  },
  menu: {
    file: 'File',
    open: 'Open…',
    close: 'Close',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
  },
  contextMenu: {
    duplicate: 'Duplicate',
    rotateLeft: 'Rotate 90° left',
    rotateRight: 'Rotate 90° right',
    delete: 'Delete',
    save: 'Save',
    close: 'Close',
    saveAll: 'Save all',
  },
};

// German values below reuse the app's original (pre-English-translation)
// German UI text verbatim wherever that text still exists, for continuity
// with the app's established voice — only the newly added Options/
// Acknowledgments/update-check strings are freshly written.
const de = {
  toolbar: {
    open: 'Öffnen…',
    openTitle: 'PDFs öffnen (Strg/Cmd+O)',
    saveAll: 'Alles speichern',
    duplicateTitle: 'Ausgewählte Seiten duplizieren (Strg/Cmd+D)',
    rotateLeftTitle: 'Ausgewählte Seiten 90° nach links drehen (Strg/Cmd+L)',
    rotateRightTitle: 'Ausgewählte Seiten 90° nach rechts drehen (Strg/Cmd+R)',
    deleteTitle: 'Ausgewählte Seiten löschen (Entf)',
    shortcutsTitle: 'Tastenkombinationen anzeigen (Strg/Cmd+/)',
    optionsTitle: 'Optionen',
    canvasView: 'Canvas',
    canvasViewTitle: 'Canvas-Modus: Dokumente nebeneinander',
    gridView: 'Grid',
    gridViewTitle: 'Grid-Ansicht: Seiten in Kacheln',
    gridColumnsLabel: 'Seiten pro Zeile:',
    gridColumnsLabelTitle: 'Anzahl Seiten pro Zeile in der Grid-Ansicht',
    saveAllTitle: 'Alle ungespeicherten Dokumente speichern',
    saveAllTitleDisabled: 'Keine ungespeicherten Änderungen',
  },
  emptyState: {
    dragHint: 'PDFs hierher ziehen oder',
    openButton: 'Öffnen…',
  },
  drag: {
    pagesBadge: '{count} Seiten',
    newDocument: 'Neues Dokument',
  },
  sectionHeader: {
    unsavedTitle: 'Ungespeicherte Änderungen',
    saveTitle: 'Speichern',
    saveDisabledTitle: 'Keine ungespeicherten Änderungen',
    closeTitle: 'Schließen',
  },
  toast: {
    alreadyOpen: '{name} ist bereits geöffnet',
    couldNotBeOpened: 'Konnte nicht geöffnet werden: {detail}',
    failedToOpenMultiple: '{count} Dateien konnten nicht geöffnet werden',
    reasonUnreadable: 'nicht lesbar',
    reasonPasswordProtected: 'passwortgeschützt',
    reasonCorrupted: 'beschädigt oder kein gültiges PDF',
    failedToDeleteOne: 'Löschen fehlgeschlagen: {name}',
    failedToDeleteMultiple: 'Löschen fehlgeschlagen bei {count} Dokumenten',
    failedToSaveOne: 'Speichern fehlgeschlagen: {name}',
    failedToSaveMultiple: 'Speichern fehlgeschlagen bei {count} Dokumenten',
  },
  dialog: {
    openPdf: {
      filterName: 'PDF',
    },
    emptyDocs: {
      heading: 'Leere Dokumente',
      intro: 'Diese Dokumente enthalten keine Seiten mehr. Bitte für jedes festlegen, wie beim Speichern verfahren werden soll:',
      restoreOriginal: 'Original wiederherstellen',
      delete: 'Löschen',
      cancel: 'Abbrechen',
      continueButton: 'Weiter',
    },
    shortcuts: {
      heading: 'Tastenkombinationen',
      close: 'Schließen',
    },
    options: {
      heading: 'Optionen',
      close: 'Schließen',
      sectionDisplay: 'Anzeige',
      sectionUpdates: 'Updates',
      sectionInfo: 'Info',
      language: 'Sprache',
      defaultView: 'Standardansicht',
      defaultGridColumns: 'Standard-Spaltenzahl (Grid)',
      nextLaunchHint: 'Wird erst beim nächsten Start von PageBoard wirksam.',
      autoUpdate: 'Automatisch nach Updates suchen',
      checkNow: 'Jetzt suchen',
      checking: 'Suche läuft…',
      updateAvailable: 'Eine neue Version ({version}) ist verfügbar',
      upToDate: 'Ist aktuell',
      checkFailed: 'Update-Prüfung fehlgeschlagen: {message}',
      version: 'Version {version}',
      viewOnGithub: 'Auf GitHub ansehen',
      acknowledgments: 'Lizenzen & Danksagungen',
    },
    acknowledgments: {
      heading: 'Lizenzen & Danksagungen',
      close: 'Schließen',
      notes: {
        pdfLib: 'Wird beim Speichern zum Erstellen/Schreiben von PDFs verwendet.',
        pdfjsDist: 'Wird zum Rendern/Anzeigen von PDFs verwendet.',
        electronUpdater: 'Wird für die automatische Update-Prüfung verwendet.',
        tablerIcons:
          'Eine Handvoll Icon-Umrisse wurde als Pfaddaten manuell in src/icons.mjs übernommen — Details siehe dort.',
      },
    },
    closeUnsaved: {
      message: '„{name}“ enthält ungespeicherte Änderungen.',
      detail: 'Vor dem Schließen speichern?',
      save: 'Speichern',
      discard: 'Verwerfen',
      cancel: 'Abbrechen',
    },
  },
  shortcutsList: {
    openPdfsKeys: 'Strg/Cmd+O',
    openPdfs: 'PDFs öffnen',
    undoKeys: 'Strg/Cmd+Z',
    undo: 'Rückgängig',
    redoKeys: 'Strg/Cmd+Umschalt+Z',
    redo: 'Wiederholen',
    deleteKeys: 'Entf / Rücktaste',
    delete: 'Ausgewählte Seiten löschen',
    duplicateKeys: 'Strg/Cmd+D',
    duplicate: 'Ausgewählte Seiten duplizieren',
    rotateLeftKeys: 'Strg/Cmd+L',
    rotateLeft: 'Ausgewählte Seiten 90° nach links drehen',
    rotateRightKeys: 'Strg/Cmd+R',
    rotateRight: 'Ausgewählte Seiten 90° nach rechts drehen',
    clickKeys: 'Klick',
    click: 'Seite auswählen',
    shiftClickKeys: 'Umschalt+Klick',
    shiftClick: 'Bereich bis zur zuletzt gewählten Seite auswählen',
    modClickKeys: 'Strg/Cmd+Klick',
    modClick: 'Einzelne Seite zur Auswahl hinzufügen/entfernen',
    doubleClickKeys: 'Doppelklick auf Seite',
    doubleClick: 'Fokus-Modus umschalten',
    rightClickPageKeys: 'Rechtsklick auf Seite',
    rightClickPage: 'Duplizieren / Drehen / Löschen',
    rightClickHeaderKeys: 'Rechtsklick auf Dokument-Kopf',
    rightClickHeader: 'Speichern / Schließen',
    showShortcutsKeys: 'Strg/Cmd+/',
    showShortcuts: 'Diese Übersicht anzeigen',
  },
  menu: {
    file: 'Datei',
    open: 'Öffnen…',
    close: 'Schließen',
    edit: 'Bearbeiten',
    undo: 'Rückgängig',
    redo: 'Wiederholen',
  },
  contextMenu: {
    duplicate: 'Duplizieren',
    rotateLeft: '90° nach links drehen',
    rotateRight: '90° nach rechts drehen',
    delete: 'Löschen',
    save: 'Speichern',
    close: 'Schließen',
    saveAll: 'Alles speichern',
  },
};

export const DICTIONARIES = { en, de };

/**
 * Resolves a raw locale string (e.g. from `app.getLocale()` or
 * `navigator.language`, both of which can return forms like `de-CH`,
 * `en-US`, or something entirely unsupported) to one of `available` —
 * matching only the primary language subtag, since none of this app's
 * dictionaries are region-specific. Falls back to `DEFAULT_LOCALE` for
 * anything unmatched (including `null`/`undefined`).
 */
export function matchLocale(rawLocale, available = LOCALES) {
  if (!rawLocale) return DEFAULT_LOCALE;
  const primary = String(rawLocale).toLowerCase().split(/[-_]/)[0];
  return available.includes(primary) ? primary : DEFAULT_LOCALE;
}

function lookup(dictionary, key) {
  let value = dictionary;
  for (const segment of key.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[segment];
  }
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * Returns a `t(key, params)` function bound to `locale`. A key missing from
 * `locale`'s dictionary falls back to `DEFAULT_LOCALE`'s (so a partially
 * translated language degrades string-by-string), and a key missing from
 * both falls back to the key itself (visible-but-non-crashing, easy to spot
 * during development instead of silently rendering blank).
 */
export function createTranslator(locale) {
  const dictionary = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
  const fallbackDictionary = DICTIONARIES[DEFAULT_LOCALE];
  return function t(key, params) {
    const fromLocale = lookup(dictionary, key);
    const fromFallback = fromLocale === undefined ? lookup(fallbackDictionary, key) : undefined;
    if (fromLocale === undefined && fromFallback === undefined) {
      console.warn(`[i18n] missing translation key: ${key}`);
    }
    return interpolate(fromLocale ?? fromFallback ?? key, params);
  };
}
