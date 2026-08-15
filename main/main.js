const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs/promises');
const packageJson = require('../package.json');

// pdf-writer.mjs is ESM (see the comment there: so it's testable via
// node:test without Electron) — main.js deliberately stays CommonJS
// (smallest possible change to an already-running file), so it's loaded via
// dynamic `import()` instead of `require()`. Only actually resolved once;
// Node caches the promise/module itself after that.
const pdfWriterModule = import('./pdf-writer.mjs');
// Shared, framework-free icon path source (see src/icons.mjs) — the same
// source renderer/icons.mjs builds real SVG DOM nodes from. Here it's used
// to build rasterized NativeImages for native context menus, which can't
// embed inline SVG (see rasterizeIconToNativeImage below).
const iconsModule = import('../src/icons.mjs');
// Settings shape/merge logic (see src/settings.mjs) — pure and shared so it
// stays unit-testable without Electron; only the actual file I/O lives here.
const settingsModule = import('../src/settings.mjs');
// Translator (see src/i18n.mjs) — same framework-free module the renderer
// uses, imported here too so native chrome (app menu, context menus, the
// close-confirmation dialog) can be translated, not just the renderer UI.
const i18nModule = import('../src/i18n.mjs');
// https-only allowlist for shell.openExternal() (see src/url-safety.mjs) —
// pure/framework-free for the same unit-testability reason as the modules
// above.
const urlSafetyModule = import('../src/url-safety.mjs');

// `app.name` defaults to package.json's top-level `"name"` field
// ("pageboard", lowercase — the npm package name, not the display name),
// which is what Electron's built-in `role: 'about'`/`role: 'quit'`/etc.
// menu items interpolate into their labels ("About pageboard", "Quit
// pageboard") regardless of the correct, capitalized "PageBoard" the
// packaged app's bundle name (productName) already shows as the menu
// title itself. Must be set before any menu is built. Only affects
// unpackaged dev runs in one other way worth knowing: it also becomes the
// default `userData` folder name for `npm start` (a packaged build's
// `userData` path is derived from the bundle name instead, already
// correct) — harmless here since no real user data exists yet under the
// old lowercase folder.
app.setName('PageBoard');

let mainWindow = null;
let settingsCache = null;
let settingsFilePath = null;
let t = (key) => key; // replaced once loadSettings() resolves the real translator

// Every path (resolved/absolute) this app has itself successfully read —
// populated in readPdfFile() below. save-documents/delete-document-file only
// ever act on a path in this set, so a compromised renderer can't turn those
// two handlers into an arbitrary-write/arbitrary-delete primitive by simply
// sending a different path than one it was actually handed.
const openedPaths = new Set();

// Derives a usable "View on GitHub" URL from package.json's `repository.url`
// (stripping a `git+` prefix / `.git` suffix, both common in that field but
// not valid to open directly in a browser). Returns `null` while the field
// is still the literal placeholder committed before the repo had a real
// GitHub remote — the renderer hides the link in that case instead of
// shipping a dead one; fixing the placeholder needs no further code change.
function deriveRepositoryUrl() {
  const raw = packageJson.repository?.url;
  if (!raw || raw.includes('TODO-owner')) return null;
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

// Settings persist as plain JSON under Electron's per-user data directory —
// missing/corrupt file degrades to `DEFAULT_SETTINGS` (same
// don't-error-on-ENOENT judgment call as delete-document-file below) rather
// than blocking startup. `mergeSettings()` also drops any invalid/unknown
// field, so a hand-edited or future-version file can't inject garbage.
async function loadSettings() {
  const { DEFAULT_SETTINGS, mergeSettings } = await settingsModule;
  settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
  let saved = null;
  try {
    saved = JSON.parse(await fs.readFile(settingsFilePath, 'utf8'));
  } catch (error) {
    // Missing file (first launch) or invalid JSON — mergeSettings() below
    // falls back to defaults for anything it can't use either way. Only
    // warn for the latter (a real, unexpected problem worth knowing about)
    // — ENOENT on first launch is completely normal and not worth logging.
    if (error.code !== 'ENOENT') {
      console.warn('[Main] Could not read/parse settings.json, falling back to defaults:', error);
    }
  }
  settingsCache = mergeSettings(DEFAULT_SETTINGS, saved);

  const { matchLocale } = await i18nModule;
  await refreshTranslator(settingsCache.locale ?? matchLocale(app.getLocale()));
}

async function refreshTranslator(locale) {
  const { createTranslator } = await i18nModule;
  t = createTranslator(locale);
}

async function writeSettingsFile() {
  await fs.writeFile(settingsFilePath, JSON.stringify(settingsCache, null, 2));
}

// Error handling & robustness: able to fail per file (missing
// read permissions, file deleted/moved externally between dialog selection
// and reading, a file too large for Node's handleable buffer) instead of
// failing the whole `Promise.all` call in open-pdf-dialog/read-pdf-files —
// otherwise a single broken file would also block every other,
// unproblematic file in the same multi-select/drop operation from opening.
// Success/failure is encoded as a shape difference in the return value
// (`bytes` vs. `error`), analogous to the already-existing per-document
// result pattern used by save-documents.
async function readPdfFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    openedPaths.add(path.resolve(filePath));
    return { filePath, bytes: new Uint8Array(buffer) };
  } catch (error) {
    return { filePath, error: String(error?.message ?? error) };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never navigate this window away from its own loaded page, and never let
  // it open a new BrowserWindow for arbitrary content — the only legitimate
  // "open a link" case (Options dialog / Acknowledgments links) already goes
  // through the open-external IPC channel below, which enforces an https-only
  // allowlist. This closes the one other reachable path: a middle-click or
  // Cmd/Ctrl-click on an anchor bypasses that click handler and would
  // otherwise let Chromium's default window.open handling spawn a chromeless
  // Electron window rendering remote content.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Belt-and-suspenders alongside setWindowOpenHandler/will-navigate above —
// applies to any future webContents this app might ever create (e.g. a
// <webview>, which this app doesn't use today, but nothing should silently
// start allowing one later).
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (willAttachEvent) => willAttachEvent.preventDefault());
});

// Native context-menu icons (Tabler Icons, see src/icons.mjs) — Electron's
// `MenuItem.icon` needs a `NativeImage` (bitmap), not inline SVG.
// `nativeImage.createFromDataURL()` can't decode SVG itself (empty 0×0
// image, verified empirically) — instead, the SVG can be rasterized onto a
// hidden `<canvas>` by the already-running renderer page (Chromium's own
// renderer handles SVG just fine) and retrieved back as a PNG.
// `mainWindow.webContents.executeJavaScript` deliberately runs against the
// existing main window instead of opening a separate hidden window just for
// this purpose — saves overhead, since the window already exists at this
// point anyway (after `did-finish-load`, see prewarmMenuIcons).
// `scaleFactor: 2` produces a sharp icon on Retina displays: at the same
// LOGICAL size, twice as much pixel data is supplied.
const MENU_ICON_SIZE = 16;
async function rasterizeIconToNativeImage(name, color) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('No window available for icon rasterization');
  }
  const { buildSvgMarkup } = await iconsModule;
  const svgMarkup = buildSvgMarkup(name, { size: MENU_ICON_SIZE * 2, color });
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgMarkup).toString('base64')}`;

  const pngDataUrl = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${MENU_ICON_SIZE * 2};
        canvas.height = ${MENU_ICON_SIZE * 2};
        canvas.getContext('2d').drawImage(img, 0, 0, ${MENU_ICON_SIZE * 2}, ${MENU_ICON_SIZE * 2});
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Icon rasterization failed: ' + ${JSON.stringify(name)}));
      img.src = ${JSON.stringify(svgDataUrl)};
    })
  `);

  const buffer = Buffer.from(pngDataUrl.split(',')[1], 'base64');
  return nativeImage.createFromBuffer(buffer, { width: MENU_ICON_SIZE, height: MENU_ICON_SIZE, scaleFactor: 2 });
}

// Rasterized once at startup and cached (map key `name:color`), instead of
// on every right-click — `Menu.popup()` is synchronous, so the icons need
// to already be ready before a context-menu template is built. Delete
// deliberately gets its own warning color (red instead of the usual toolbar
// gray) — the same individual color override as the delete icon in the
// toolbar (renderer.js), just rasterized separately again here for the main
// process, since NativeImages can't be shared with the renderer.
const MENU_ICON_GRAY = '#cccccc';
const MENU_ICON_RED = '#e05252';
const menuIconCache = new Map();

async function prewarmMenuIcons() {
  const specs = [
    ['copy', MENU_ICON_GRAY],
    ['rotate', MENU_ICON_GRAY],
    ['rotate-clockwise', MENU_ICON_GRAY],
    ['trash', MENU_ICON_RED],
    ['device-floppy', MENU_ICON_GRAY],
    ['x', MENU_ICON_GRAY],
  ];
  await Promise.all(
    specs.map(async ([name, color]) => {
      try {
        menuIconCache.set(`${name}:${color}`, await rasterizeIconToNativeImage(name, color));
      } catch (error) {
        // No reason to fail the whole startup over this — worst case, this
        // one menu item stays without an icon (menuIcon() below then
        // returns `undefined`, Electron simply shows the entry without an
        // icon instead of crashing).
        console.error(`[Main] Menu icon rasterization failed (${name}):`, error);
      }
    }),
  );
}

function menuIcon(name, color = MENU_ICON_GRAY) {
  return menuIconCache.get(`${name}:${color}`);
}

// Rebuilt (not just built once) whenever the locale changes, so the static
// application menu updates without an app restart — see the `locale` branch
// of the `save-settings` handler below. The `{ role: 'close' }` item gets an
// explicit `label` too: Electron's own built-in label for that role follows
// the OS's system language, not this app's own chosen locale, so leaving it
// unlabeled would go out of sync the moment someone picks an in-app language
// that differs from their OS language. `role` still attaches the native
// close-window behavior/platform accelerator; `label` just overrides the text.
//
// On macOS, `template[0]` is special-cased by Electron as the application
// menu and its own `label` is ignored — without an app-menu entry there,
// this app's File menu silently became macOS's app menu instead (Open/
// Close showing up under "PageBoard").
//
// Deliberately NOT `role: 'appMenu'`/`role: 'editMenu'` wholesale — those
// pull in the OS's default template as-is (Services, and a text-editing
// Cut/Copy/Paste/Select-All Edit menu this app has no use for, since it has
// no free-text editing anywhere), and their labels follow the OS's own
// system language rather than this app's chosen locale, same as the plain
// `role: 'close'` item below. Individual item roles (`role: 'about'`,
// `role: 'hide'`, `role: 'quit'`, ...) are used instead, which keeps their
// standard OS-native behavior/label but lets the surrounding template
// (which items exist, in what order) be chosen deliberately.
function sendEditAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('trigger-edit-action', action);
}

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push({
    label: t('menu.file'),
    submenu: [
      {
        label: t('menu.open'),
        accelerator: 'CmdOrCtrl+O',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('trigger-open-dialog');
        },
      },
      { type: 'separator' },
      { label: t('menu.close'), role: 'close' },
    ],
  });
  // Custom instead of `role: 'editMenu'` — Undo/Redo here call this app's
  // own page-operation undo stack (DocumentStore.undo/redo), not Chromium's
  // built-in text-field undo that `role: 'undo'`/`role: 'redo'` would wire
  // up instead (meaningless for this app, and confusingly labeled the same
  // either way). Deliberately no `accelerator` on any of these six items:
  // Cmd+Z/Shift+Z/D/L/R/Delete are already handled by the renderer's own
  // `keydown` listener (see renderer.js) — a native menu accelerator for
  // the same combination risks double-firing the action if Electron also
  // lets the keydown reach the renderer, which isn't practically verifiable
  // from this sandboxed dev environment (a packaged, launchable build was
  // needed and wasn't available here). These menu items
  // are a mouse-driven alternative path only; the keyboard shortcuts are
  // unaffected.
  template.push({
    label: t('menu.edit'),
    submenu: [
      { label: t('menu.undo'), click: () => sendEditAction('undo') },
      { label: t('menu.redo'), click: () => sendEditAction('redo') },
      { type: 'separator' },
      { label: t('contextMenu.duplicate'), click: () => sendEditAction('duplicate') },
      { label: t('contextMenu.rotateLeft'), click: () => sendEditAction('rotate-left') },
      { label: t('contextMenu.rotateRight'), click: () => sendEditAction('rotate-right') },
      { label: t('contextMenu.delete'), click: () => sendEditAction('delete') },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Shows the native multi-select dialog and reads the chosen files
// directly here in the main process (filesystem access stays here).
ipcMain.handle('open-pdf-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('dialog.openPdf.filterName'), extensions: ['pdf'] }],
  });

  if (result.canceled) {
    return [];
  }

  return Promise.all(result.filePaths.map(readPdfFile));
});

// Reads files whose paths the renderer already knows (drag & drop from
// outside — the path is determined there via webUtils.getPathForFile). Unlike
// open-pdf-dialog's result.filePaths (which come straight from Electron's own
// native dialog and are inherently trusted), these paths originate from the
// renderer, so they're validated before ever reaching the filesystem: must be
// an array of absolute .pdf paths, capped at a sane batch size. This doesn't
// stop a compromised renderer from reading any *.pdf file it can name, but it
// removes the "read literally any file by path" primitive that no validation
// at all would leave in place.
ipcMain.handle('read-pdf-files', async (event, filePaths) => {
  if (!Array.isArray(filePaths)) return [];
  const safePaths = filePaths
    .filter((p) => typeof p === 'string' && path.isAbsolute(p) && path.extname(p).toLowerCase() === '.pdf')
    .slice(0, 200);
  return Promise.all(safePaths.map(readPdfFile));
});

// A thin log channel from the renderer to the main-process console, among
// other things for tracing the open flow while testing. `ipcMain.on` (unlike
// `.handle`) has no promise to reject into — a malformed payload thrown here
// uncaught would take down the whole main process, not just this call.
ipcMain.on('log', (event, payload) => {
  const { level, message } = payload ?? {};
  const log = level === 'error' ? console.error : console.log;
  log(`[Renderer] ${message}`);
});

// A native context menu instead of a self-built HTML dropdown — looks
// native on both Mac and Windows, with no custom code for it. The renderer
// knows nothing about `Menu`; it just gets the chosen action name back (or
// `null` on cancel/clicking elsewhere). `template` uses `action` instead of
// `click`, so a single, shared resolve mechanism applies here for every
// context menu in the app (the page menu, the document/canvas
// menu below).
function popupMenuForChoice(event, template) {
  return new Promise((resolve) => {
    let resolved = false;
    const resolveOnce = (action) => {
      if (resolved) return;
      resolved = true;
      resolve(action);
    };

    const resolvedTemplate = template.map((item) =>
      item.type === 'separator'
        ? item
        : { label: item.label, icon: item.icon, click: () => resolveOnce(item.action) },
    );

    Menu.buildFromTemplate(resolvedTemplate).popup({
      window: BrowserWindow.fromWebContents(event.sender),
      // Also fires when no item was clicked (menu closed by clicking
      // elsewhere or Esc) — resolveOnce() is then already a no-op if an
      // item click resolved it first instead.
      callback: () => resolveOnce(null),
    });
  });
}

// Page operations: right-click on a page. Template is rebuilt
// fresh on every right-click (no caching, unlike the icons above), so it
// always reflects whatever locale is currently active — no extra rebuild
// plumbing needed when the user switches language.
ipcMain.handle('show-page-context-menu', (event) =>
  popupMenuForChoice(event, [
    { label: t('contextMenu.duplicate'), action: 'duplicate', icon: menuIcon('copy') },
    { label: t('contextMenu.rotateLeft'), action: 'rotate-left', icon: menuIcon('rotate') },
    { label: t('contextMenu.rotateRight'), action: 'rotate-right', icon: menuIcon('rotate-clockwise') },
    { type: 'separator' },
    { label: t('contextMenu.delete'), action: 'delete', icon: menuIcon('trash', MENU_ICON_RED) },
  ]),
);

// Save/close — also available via right-click
// context menu: right-clicking a document's section header ('document')
// shows save/close for exactly that document; right-clicking the empty
// canvas ('canvas') shows "save all".
ipcMain.handle('show-document-context-menu', (event, { scope }) =>
  popupMenuForChoice(
    event,
    scope === 'document'
      ? [
          { label: t('contextMenu.save'), action: 'save', icon: menuIcon('device-floppy') },
          { label: t('contextMenu.close'), action: 'close', icon: menuIcon('x') },
        ]
      : [{ label: t('contextMenu.saveAll'), action: 'save-all', icon: menuIcon('device-floppy') }],
  ),
);

// Writes to a temp file in the same directory first, then renames it into
// place — `rename` is atomic on the same filesystem, so a crash/power
// loss/full disk mid-write leaves the original untouched instead of a
// truncated, corrupted file. Without this, `fs.writeFile` truncates the
// target *before* writing the new bytes, so any failure partway through
// destroys the user's only copy of the file — for an app whose entire save
// model is "overwrite the original", that's the single most realistic way a
// user could actually lose data, no attacker required.
async function writeFileAtomic(filePath, bytes) {
  const tmpPath = `${filePath}.pageboard-tmp`;
  try {
    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

// Save: assembles a fresh PDF file per document via
// pdf-lib (see pdf-writer.mjs) and overwrites the target file directly — no
// "save as", no copy. `sources` contains each involved PdfSource's raw
// bytes ONCE (deduplicated in the renderer, see saveDocuments()),
// `documents` only references them via `sourceId`. Result is per document
// (not "all or nothing") — if one file fails (e.g. missing write
// permissions), the others should still be saved.
//
// `doc.filePath` is only ever trusted if it's a path this app itself
// actually opened (see openedPaths) — a `Document`'s `filePath` is set once
// in its constructor and never reassigned (verified: the only other value it
// ever takes is `null`, for a virtual document born from an edge-drop that
// was never opened from disk in the first place), so every legitimately
// saveable document is already in that set by the time this handler runs.
ipcMain.handle('save-documents', async (event, { sources, documents }) => {
  const { buildDocumentPdfBytes } = await pdfWriterModule;
  const sourceBytesById = new Map(sources.map(({ id, bytes }) => [id, bytes]));

  const results = [];
  for (const doc of documents) {
    try {
      if (typeof doc.filePath !== 'string' || !openedPaths.has(path.resolve(doc.filePath))) {
        throw new Error('Refusing to save to a path this app did not open');
      }
      const outBytes = await buildDocumentPdfBytes(sourceBytesById, doc.pages);
      await writeFileAtomic(doc.filePath, outBytes);
      results.push({ documentId: doc.documentId });
    } catch (error) {
      results.push({ documentId: doc.documentId, error: String(error?.message ?? error) });
    }
  }
  return results;
});

// "Delete" in the combined empty-documents dialog: removes
// the original file from disk. `filePath` is `null` for a virtual,
// never-saved document (dropped at the canvas edge) — then there's
// nothing to delete. A missing file (already deleted from outside the app)
// is deliberately ignored instead of passed through to the renderer as an
// error — checked explicitly via fs.access rather than by inspecting
// shell.trashItem()'s rejection shape, since that isn't guaranteed to carry
// the same `code: 'ENOENT'` Node's own fs errors do. Same
// only-a-path-this-app-opened restriction as save-documents above, and
// `shell.trashItem()` instead of a hard `fs.unlink` — same user-facing
// result (the file's original location no longer has it), but recoverable
// from the OS trash instead of an unwitnessed permanent delete, both for a
// hypothetical malicious renderer and for an ordinary bug in this app's own
// code.
ipcMain.handle('delete-document-file', async (event, filePath) => {
  if (!filePath) return;
  if (typeof filePath !== 'string' || !openedPaths.has(path.resolve(filePath))) {
    throw new Error('Refusing to delete a path this app did not open');
  }
  try {
    await fs.access(filePath);
  } catch {
    return; // already gone — nothing to do
  }
  await shell.trashItem(filePath);
});

// Closing a document with unsaved changes —
// analogous to closing an unsaved editor tab. A native `showMessageBox` is
// enough here (unlike the empty-documents dialog, which needs a list with a
// per-document choice, see showEmptyDocumentsDialog in renderer.js), since
// there are only three simple, mutually exclusive options for exactly one
// document.
ipcMain.handle('confirm-close-with-unsaved-changes', async (event, displayName) => {
  const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: 'question',
    message: t('dialog.closeUnsaved.message', { name: displayName }),
    detail: t('dialog.closeUnsaved.detail'),
    buttons: [t('dialog.closeUnsaved.save'), t('dialog.closeUnsaved.discard'), t('dialog.closeUnsaved.cancel')],
    defaultId: 0,
    cancelId: 2,
  });
  return ['save', 'discard', 'cancel'][result.response];
});

// Read by the Options dialog on open, and once at renderer startup to pick
// the initial locale/view/grid-columns/auto-update state. `systemLocale`
// and `appVersion` are live OS/package values, not persisted settings —
// sent alongside so the renderer doesn't need a second round trip for them.
// Both handlers return the same enriched shape (persisted settings plus the
// live systemLocale/appVersion/repositoryUrl) — the renderer's
// saveSettingsPatch() replaces its whole `currentSettings` with whatever
// save-settings returns (see renderer.js), so a narrower response here would
// silently drop those fields from an already-open Options dialog after any
// change (found via manual smoke-testing: the Info section's version text
// went blank/"undefined" after switching language, since that's also a
// save-settings round trip).
function enrichedSettings() {
  return {
    ...settingsCache,
    systemLocale: app.getLocale(),
    appVersion: app.getVersion(),
    repositoryUrl: deriveRepositoryUrl(),
  };
}

ipcMain.handle('get-settings', () => enrichedSettings());

// Accepts a partial patch (e.g. `{ gridColumnsPerRow: 10 }`) rather than a
// full settings object — simpler for the renderer, which then doesn't need
// to know or reconstruct the whole settings shape for a single-field change
// (matches the live-autosave-per-control design of the Options dialog).
//
// Queued rather than handled inline: switchLocale() in renderer.js
// deliberately fires its own save-settings call without awaiting it (for UI
// responsiveness — see the comment there), so a second save-settings call
// (e.g. from an Options-dialog control) can arrive while the first is still
// in flight. Two concurrent invocations of this handler would both read the
// same settingsCache, merge their own patch onto it independently, and then
// both call writeSettingsFile() — two overlapping fs.writeFile calls to the
// same path, which can interleave at the OS level and leave settings.json
// with trailing garbage from whichever write was longer (observed as a real
// "Unexpected non-whitespace character after JSON" parse failure on a
// windows-latest CI run). Chaining every call onto settingsWriteQueue
// serializes the whole merge-then-write cycle, so a later patch always
// merges onto the result of the previous write instead of racing it.
let settingsWriteQueue = Promise.resolve();
ipcMain.handle('save-settings', (event, patch) => {
  settingsWriteQueue = settingsWriteQueue.catch(() => {}).then(async () => {
    const { mergeSettings } = await settingsModule;
    settingsCache = mergeSettings(settingsCache, patch);
    await writeSettingsFile();
    // Locale also drives native chrome (menu/context menus/close dialog,
    // see buildMenu() and the `t()` calls throughout this file) — a
    // settings-only update wouldn't be enough, the static app menu needs an
    // explicit rebuild to pick up the new strings without an app restart.
    if (patch.locale) {
      await refreshTranslator(settingsCache.locale);
      buildMenu();
    }
    return enrichedSettings();
  });
  return settingsWriteQueue;
});

// Both real callers (the "View on GitHub" link and the Acknowledgments
// dialog's license links) only ever pass an https:// URL — restricting to
// that protocol closes off shell.openExternal()'s well-known escape hatch
// (a file:// or registered-custom-protocol URL reaching the OS launcher
// directly, outside Chromium's sandbox) without changing behavior for either
// legitimate call site.
ipcMain.handle('open-external', async (event, url) => {
  const { getSafeExternalUrl } = await urlSafetyModule;
  const safeUrl = getSafeExternalUrl(url);
  if (!safeUrl) return;
  return shell.openExternal(safeUrl);
});

// Manual "check now" (Options dialog), distinct from the silent startup
// check below: `checkForUpdatesAndNotify()` only shows an OS notification on
// success and nothing at all for "already up to date" or a transient error —
// fine for an unattended background check, but poor feedback for something
// the user just explicitly clicked. `checkForUpdates()` alone doesn't
// reliably distinguish those outcomes across electron-updater versions
// either, so this listens for the underlying events directly, once each,
// mirroring the same resolve-once pattern popupMenuForChoice already uses
// above — the renderer turns the result into a translated toast.
function checkForUpdatesOnce() {
  return new Promise((resolve) => {
    const cleanup = () => {
      autoUpdater.off('update-available', onAvailable);
      autoUpdater.off('update-not-available', onNotAvailable);
      autoUpdater.off('error', onError);
      clearTimeout(timeoutId);
    };
    const onAvailable = (info) => {
      cleanup();
      resolve({ status: 'available', version: info.version });
    };
    const onNotAvailable = () => {
      cleanup();
      resolve({ status: 'not-available' });
    };
    const onError = (error) => {
      cleanup();
      resolve({ status: 'error', message: String(error?.message ?? error) });
    };
    // If none of the three events ever fires (electron-updater version
    // quirk, or a background check racing this manual one and consuming the
    // event first — see the comment on the background check below), this
    // promise previously never settled, leaving the "Check now" button
    // stuck showing "Checking…" for the rest of the session.
    const timeoutId = setTimeout(() => onError(new Error('Update check timed out')), 30000);
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    autoUpdater.checkForUpdates().catch(onError);
  });
}

ipcMain.handle('check-for-updates', () => checkForUpdatesOnce());

app.whenReady().then(async () => {
  // Populates the native "About PageBoard" panel (role: 'about' above) —
  // without this, macOS falls back to reading Info.plist's copyright field,
  // which electron-builder derives from package.json's `author` (currently
  // the public GitHub handle, not a real name — deliberately kept that way
  // in package.json itself, since that field is published; the About panel
  // is a separate, explicit override, only ever seen by someone actually
  // running the app).
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'PageBoard',
      copyright: `Copyright © ${new Date().getFullYear()} Stephan Otto`,
    });
  }
  await loadSettings();
  buildMenu();
  createWindow();
  // Only rasterize once the page has fully loaded (Image/Canvas need to be
  // available in the renderer) — runs in the background, doesn't block the
  // window; a right-click shortly after startup shows menu items briefly
  // without an icon at worst (menuIcon() then returns `undefined`, no
  // error), until rasterization finishes — barely noticeable in practice
  // given how few/small the icons are.
  mainWindow.webContents.once('did-finish-load', () => {
    prewarmMenuIcons();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Auto-update via electron-updater, against GitHub Releases
  // (see "publish" in package.json). Only relevant in a packaged build —
  // `app.isPackaged` is always `false` in dev (`npm start`), and
  // autoUpdater would need an app-update.yml there anyway, which only an
  // electron-builder build produces. checkForUpdatesAndNotify() is enough
  // for this hobby project's ambitions (5.1, minimal maintenance overhead):
  // shows a native OS notification when an update is found, installs on the
  // app's next restart — no custom progress UI needed. Also gated on the
  // user's own auto-update setting now (Options dialog) — previously
  // unconditional whenever packaged.
  if (app.isPackaged && settingsCache.autoUpdateEnabled) {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.error('[Main] Auto-update check failed:', error);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
