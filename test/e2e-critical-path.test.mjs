import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { startSession, CDP_PORTS, projectRoot } from './helpers/cdp-session.mjs';

// A single, targeted E2E test for exactly the app's most critical path —
// open → edit → save — which, if broken, would make the app unusable for
// every single user. Uses the shared CDP harness (test/helpers/cdp-session.mjs)
// rather than Playwright: the technique already exists, is proven, and covers
// real main.js behavior (filesystem access) that plain node:test otherwise
// couldn't reach — a second browser-automation library would just add
// maintenance overhead (this is a hobby project — minimal maintenance is a
// stated goal) without covering anything this technique doesn't already cover.
//
// Works on a fresh copy from pdf-files/test-files/ in an mkdtemp scratch
// directory, not pdf-files/test-files-edit/ — per repo conventions, the latter
// is manual-testing scratch space whose contents can be "consumed" at any
// time; an automated test needs a reproducible starting state.

let session;
let tmpDir;

before(async () => {
  session = await startSession({ name: 'e2e', port: CDP_PORTS.e2eCriticalPath });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-e2e-'));
});

after(async () => {
  await session?.close();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('critical path: open → rotate + delete a page → save lands correctly on disk', async () => {
  const filePath = path.join(tmpDir, 'critical-path.pdf');
  await fs.copyFile(
    path.join(projectRoot, 'pdf-files', 'test-files', '027-cropped-rotated-scaled', 'cropped-rotated-scaled.pdf'),
    filePath,
  );
  // fs.copyFile carries over the source's file mode —
  // pdf-files/test-files/ is deliberately chmod 444, so the copy would
  // otherwise also be read-only and the save step below would fail at the
  // filesystem level.
  await fs.chmod(filePath, 0o644);

  // 1. Open
  const openResult = await session.evaluate(`
    (async () => {
      const [fileInfo] = await window.api.readPdfFiles(${JSON.stringify([filePath])});
      const before = __mod.store.documents.length;
      await __mod.handleOpenedFiles([fileInfo]);
      const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
      return { addedCount: __mod.store.documents.length - before, pageCount: doc?.pages.length ?? 0 };
    })()
  `);
  assert.equal(openResult.addedCount, 1, 'Opening should have added exactly one document');
  assert.ok(openResult.pageCount >= 2, 'Fixture needs at least 2 pages for this test');
  const originalPageCount = openResult.pageCount;

  // 2. Edit: rotate the first page, delete the last page (two independent
  // page operations, both must show up in the saved result)
  const editResult = await session.evaluate(`
    (() => {
      const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
      __mod.applyPageAction('rotate-right', [doc.pages[0].id]);
      __mod.applyPageAction('delete', [doc.pages[doc.pages.length - 1].id]);
      return { dirty: doc.dirty, pageCount: doc.pages.length, firstPageRotation: doc.pages[0].rotation };
    })()
  `);
  assert.equal(editResult.dirty, true);
  assert.equal(editResult.pageCount, originalPageCount - 1);
  assert.equal(editResult.firstPageRotation, 90);

  // 3. Save. saveDocuments() itself returns nothing (see renderer.js) —
  // success shows up as `doc.dirty` being false afterward (on failure it
  // stays true, see the saveFailures handling there).
  const saveResult = await session.evaluate(`
    (async () => {
      const doc = __mod.store.documents.find(d => d.filePath === ${JSON.stringify(filePath)});
      await __mod.saveDocuments([doc]);
      return { dirty: doc.dirty };
    })()
  `);
  assert.equal(saveResult.dirty, false, 'Document should no longer be dirty after a successful save');

  // 4. Verification directly on disk, independent of app state — the same
  // library (pdf-lib) that main/pdf-writer.mjs also uses for writing, see
  // test/pdf-writer.test.mjs.
  const savedBytes = await fs.readFile(filePath);
  const savedDoc = await PDFDocument.load(savedBytes);
  assert.equal(savedDoc.getPageCount(), originalPageCount - 1);
  assert.equal(savedDoc.getPage(0).getRotation().angle, 90);
});
