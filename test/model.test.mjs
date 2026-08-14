import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentFromFile } from '../src/model/create-document-from-file.mjs';
import { DocumentStore } from '../src/model/store.mjs';
import { deriveConflictFreeName } from '../src/model/derive-conflict-free-name.mjs';

function fakeBytes() {
  return new Uint8Array([1, 2, 3]);
}

test('createDocumentFromFile creates the given number of pages and starts out not dirty', () => {
  const doc = createDocumentFromFile('/tmp/test-a.pdf', fakeBytes(), 3);

  assert.equal(doc.pages.length, 3);
  assert.equal(doc.displayName, 'test-a.pdf');
  assert.equal(doc.dirty, false);
  assert.equal(doc.isEmpty, false);
});

test('removePageAt removes a page, sets dirty, and empties the document on the last page', () => {
  const doc = createDocumentFromFile('/tmp/test-b.pdf', fakeBytes(), 1);

  const removed = doc.removePageAt(0);

  assert.equal(doc.pages.length, 0);
  assert.equal(doc.isEmpty, true);
  assert.equal(doc.dirty, true);
  assert.equal(removed.sourcePageIndex, 0);
});

test('duplicatePageAt inserts an independent copy directly after the original', () => {
  const doc = createDocumentFromFile('/tmp/test-c.pdf', fakeBytes(), 2);

  const copy = doc.duplicatePageAt(0);

  assert.equal(doc.pages.length, 3);
  assert.equal(doc.pages[1], copy);
  assert.notEqual(copy.id, doc.pages[0].id);
  assert.equal(copy.sourcePageIndex, doc.pages[0].sourcePageIndex);
});

test('rotatePageAt adds rotation modulo 360, even for negative deltas', () => {
  const doc = createDocumentFromFile('/tmp/test-d.pdf', fakeBytes(), 1);

  doc.rotatePageAt(0, 90);
  assert.equal(doc.pages[0].rotation, 90);

  doc.rotatePageAt(0, -180);
  assert.equal(doc.pages[0].rotation, 270);
});

test('DocumentStore.movePage moves a page across documents, including dirty flags', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 2);
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 1);
  store.addDocument(docA);
  store.addDocument(docB);

  const movedPage = docA.pages[1];
  store.movePage(docA.id, 1, docB.id, 0);

  assert.equal(docA.pages.length, 1);
  assert.equal(docB.pages.length, 2);
  assert.equal(docB.pages[0], movedPage);
  assert.equal(docA.dirty, true);
  assert.equal(docB.dirty, true);
});

test('DocumentStore.findByFilePath recognizes an already-open file', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/Users/test/Invoice.pdf', fakeBytes(), 1);
  store.addDocument(doc);

  assert.equal(store.findByFilePath('/Users/test/Invoice.pdf'), doc);
  assert.equal(store.findByFilePath('/Users/test/other.pdf'), undefined);
});

test('DocumentStore.movePages moves a multi-selection across documents and preserves relative order', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3); // pages 0,1,2
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 2); // pages 0,1
  store.addDocument(docA);
  store.addDocument(docB);

  const [pageA0, pageA1, pageA2] = docA.pages;
  const [pageB0, pageB1] = docB.pages;

  // Page A2 and A0 (in this order, not their original one) are inserted
  // before page B1 in document B.
  store.movePages([pageA2.id, pageA0.id], docB.id, { beforePageId: pageB1.id });

  assert.deepEqual(docA.pages, [pageA1]);
  assert.deepEqual(docB.pages, [pageB0, pageA2, pageA0, pageB1]);
  assert.equal(docA.dirty, true);
  assert.equal(docB.dirty, true);
});

test('DocumentStore.movePages reorders within the same document (beforePageId, not an index)', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3);
  store.addDocument(doc);
  const [p0, p1, p2] = doc.pages;

  // Drag page 0 behind page 2.
  store.movePages([p0.id], doc.id, { atEnd: true });
  assert.deepEqual(doc.pages, [p1, p2, p0]);

  // Back to the start (before page 1).
  store.movePages([p0.id], doc.id, { beforePageId: p1.id });
  assert.deepEqual(doc.pages, [p0, p1, p2]);
});

test('DocumentStore.createDocumentFromPages creates a new document with a conflict-free name', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/Invoice.pdf', fakeBytes(), 2);
  store.addDocument(doc);
  const [page0, page1] = doc.pages;

  const newDoc = store.createDocumentFromPages([page1.id], 'end');

  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0], page0);
  assert.equal(newDoc.displayName, 'Invoice (2).pdf');
  assert.equal(newDoc.filePath, null);
  assert.equal(newDoc.dirty, true);
  assert.deepEqual(newDoc.pages, [page1]);
  assert.equal(store.documents.at(-1), newDoc);
});

test('DocumentStore.removePages deletes a selection spanning multiple documents', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3);
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 2);
  store.addDocument(docA);
  store.addDocument(docB);
  const [pageA0, pageA1, pageA2] = docA.pages;
  const [pageB0] = docB.pages;

  store.removePages([pageA0.id, pageA2.id, pageB0.id]);

  assert.deepEqual(docA.pages, [pageA1]);
  assert.equal(docB.pages.length, 1);
  assert.equal(docA.dirty, true);
  assert.equal(docB.dirty, true);
});

test('DocumentStore.removePages empties a document completely without removing it', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 1);
  store.addDocument(doc);

  store.removePages([doc.pages[0].id]);

  assert.equal(doc.isEmpty, true);
  assert.equal(store.documents.includes(doc), true);
});

test('DocumentStore.duplicatePages duplicates several pages independently, right at their position', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3);
  store.addDocument(doc);
  const [p0, p1, p2] = doc.pages;

  const duplicates = store.duplicatePages([p0.id, p2.id]);

  assert.equal(doc.pages.length, 5);
  assert.equal(doc.pages[0], p0);
  assert.equal(doc.pages[1], duplicates.find((d) => d.sourcePageIndex === p0.sourcePageIndex));
  assert.equal(doc.pages[2], p1);
  assert.equal(doc.pages[3], p2);
  assert.notEqual(doc.pages[4].id, p2.id);
  assert.equal(doc.pages[4].sourcePageIndex, p2.sourcePageIndex);
});

test('DocumentStore.rotatePages rotates a selection spanning multiple documents together', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 2);
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 1);
  store.addDocument(docA);
  store.addDocument(docB);

  store.rotatePages([docA.pages[0].id, docB.pages[0].id], 90);

  assert.equal(docA.pages[0].rotation, 90);
  assert.equal(docA.pages[1].rotation, 0);
  assert.equal(docB.pages[0].rotation, 90);
});

test('DocumentStore.moveDocument reorders documents without marking them dirty', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 1);
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 1);
  const docC = createDocumentFromFile('/tmp/c.pdf', fakeBytes(), 1);
  store.addDocument(docA);
  store.addDocument(docB);
  store.addDocument(docC);

  // Drag C before A.
  store.moveDocument(docC.id, { beforeDocumentId: docA.id });
  assert.deepEqual(store.documents, [docC, docA, docB]);

  // Drag A to the end.
  store.moveDocument(docA.id, { atEnd: true });
  assert.deepEqual(store.documents, [docC, docB, docA]);

  assert.equal(docA.dirty, false);
  assert.equal(docB.dirty, false);
  assert.equal(docC.dirty, false);
});

test('Document.restoreOriginal rebuilds pages from the source file and resets dirty', () => {
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3);
  doc.removePageAt(0);
  doc.removePageAt(0);
  doc.rotatePageAt(0, 90);
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.dirty, true);

  doc.restoreOriginal();

  assert.equal(doc.pages.length, 3);
  assert.equal(doc.pages.every((p) => p.rotation === 0), true);
  assert.deepEqual(
    doc.pages.map((p) => p.sourcePageIndex),
    [0, 1, 2],
  );
  assert.equal(doc.dirty, false);
});

test('Document.restoreOriginal is a no-op without originalSource (virtual document)', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 2);
  store.addDocument(doc);
  const newDoc = store.createDocumentFromPages([doc.pages[0].id], 'end');

  newDoc.restoreOriginal();

  assert.equal(newDoc.pages.length, 1); // unchanged, no crash
  assert.equal(newDoc.originalSource, null);
});

// On restore, undo/redo deliberately builds entirely new Document/Page
// instances (see the comment above DocumentStore._restore) — `doc.id` from
// BEFORE an undo/redo is no longer valid afterward. Tests therefore access
// documents via their (unchanged) position in `store.documents` after every
// undo()/redo(), never via a previously remembered `id`.
test('DocumentStore.undo/redo undo and redo a page deletion', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3);
  store.addDocument(doc);
  const originalIndices = doc.pages.map((p) => p.sourcePageIndex);

  assert.equal(store.canUndo(), false);
  store.removePages([doc.pages[1].id]);
  assert.equal(store.documents[0].pages.length, 2);

  store.undo();
  assert.deepEqual(
    store.documents[0].pages.map((p) => p.sourcePageIndex),
    originalIndices,
  );
  assert.equal(store.canRedo(), true);

  store.redo();
  assert.equal(store.documents[0].pages.length, 2);
  assert.equal(store.canRedo(), false);
});

test('DocumentStore.undo correctly restores a page move across documents', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 2);
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 1);
  store.addDocument(docA);
  store.addDocument(docB);
  const movedSourceIndex = docA.pages[0].sourcePageIndex;

  store.movePages([docA.pages[0].id], docB.id, { atEnd: true });
  assert.equal(store.documents[0].pages.length, 1);
  assert.equal(store.documents[1].pages.length, 2);

  store.undo();
  assert.deepEqual(
    store.documents[0].pages.map((p) => p.sourcePageIndex),
    [movedSourceIndex, 1],
  );
  assert.equal(store.documents[1].pages.length, 1);
});

test('DocumentStore.undo also works after a silent:true mutation (drag & drop)', () => {
  const store = new DocumentStore();
  const docA = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 2);
  const docB = createDocumentFromFile('/tmp/b.pdf', fakeBytes(), 1);
  store.addDocument(docA);
  store.addDocument(docB);

  // silent:true only suppresses _notify() (renderer.js handles the DOM
  // itself) — the undo stack still needs to be fed.
  store.movePages([docA.pages[0].id], docB.id, { atEnd: true }, { silent: true });
  assert.equal(store.documents[0].pages.length, 1);

  store.undo();
  assert.equal(store.documents[0].pages.length, 2);
});

test('A new action after undo discards the redo history', () => {
  const store = new DocumentStore();
  const doc = createDocumentFromFile('/tmp/a.pdf', fakeBytes(), 3);
  store.addDocument(doc);

  store.removePages([doc.pages[0].id]);
  store.undo();
  assert.equal(store.canRedo(), true);

  store.removePages([store.documents[0].pages[0].id]);
  assert.equal(store.canRedo(), false);
});

test('deriveConflictFreeName finds the next free number', () => {
  assert.equal(deriveConflictFreeName('Document.pdf', []), 'Document (2).pdf');
  assert.equal(
    deriveConflictFreeName('Document.pdf', ['Document.pdf', 'Document (2).pdf']),
    'Document (3).pdf',
  );
  assert.equal(deriveConflictFreeName('NoExtension', []), 'NoExtension (2)');
});
