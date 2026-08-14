import { Document } from './document.mjs';
import { Page } from './page.mjs';
import { deriveConflictFreeName } from './derive-conflict-free-name.mjs';

/**
 * Central in-renderer state: the list of open Document instances. Deliberately
 * a plain pub/sub, not a framework store — matches this project's "minimal
 * maintenance" principle.
 */
export class DocumentStore {
  constructor() {
    this.documents = [];
    this._listeners = new Set();
    // Stays around for the whole session, even once no single page still
    // references a given PdfSource anymore in the meantime (e.g. after a
    // document was closed) — undo/redo (see below) must be able to resolve
    // a `sourceId` from an older snapshot back to the real PdfSource (bytes
    // + page count) at any time.
    this._sourceRegistry = new Map();
    this._undoStack = [];
    this._redoStack = [];
  }

  registerSource(source) {
    this._sourceRegistry.set(source.id, source);
  }

  addDocument(document) {
    for (const page of document.pages) this.registerSource(page.source);
    if (document.originalSource) this.registerSource(document.originalSource);
    this.documents.push(document);
    this._notify();
  }

  removeDocument(documentId) {
    this.documents = this.documents.filter((doc) => doc.id !== documentId);
    this._notify();
  }

  getDocument(documentId) {
    return this.documents.find((doc) => doc.id === documentId);
  }

  findByFilePath(filePath) {
    return this.documents.find((doc) => doc.filePath === filePath);
  }

  // Reorders whole documents, referencing the target position
  // the same way movePages/movePagesInDom does — via the stable
  // `Document.id` of an existing document (`{ beforeDocumentId }`) instead
  // of an index — for the same reason: removing the moved document would
  // otherwise shift later indices. `{ atEnd: true }` appends it at the end.
  // Purely reorders the canvas, no content change — deliberately marks no
  // document as `dirty` (document order isn't persisted anywhere — there's
  // no session persistence at all). `silent`: used the same way as in
  // renderer.js's movePages when the affected DOM nodes there have already
  // been moved directly themselves.
  moveDocument(documentId, insertion, { silent = false } = {}) {
    const index = this.documents.findIndex((doc) => doc.id === documentId);
    if (index === -1) return;
    // Pushed only once the move is actually going to happen — pushing
    // unconditionally before this guard meant a no-op call (documentId not
    // found) still recorded an empty undo snapshot and discarded the entire
    // redo stack for nothing.
    this._pushUndo();
    const [doc] = this.documents.splice(index, 1);

    const foundIndex = insertion.beforeDocumentId
      ? this.documents.findIndex((d) => d.id === insertion.beforeDocumentId)
      : -1;
    const at = foundIndex === -1 ? this.documents.length : foundIndex;
    this.documents.splice(at, 0, doc);

    if (!silent) this._notify();
  }

  movePage(fromDocumentId, fromIndex, toDocumentId, toIndex) {
    const fromDocument = this.getDocument(fromDocumentId);
    const toDocument = this.getDocument(toDocumentId);
    const [page] = fromDocument.pages.splice(fromIndex, 1);
    fromDocument.markDirty();
    toDocument.pages.splice(toIndex, 0, page);
    toDocument.markDirty();
    this._notify();
    return page;
  }

  // Moves one or more pages (across documents) to a new
  // position, in the order given by `pageIds` — for a multi-selection, this
  // preserves the relative order of the dragged pages. `insertion`
  // references the target position via the stable `Page.id` of an existing
  // (non-dragged) page (`{ beforePageId }`) instead of an index: an index
  // would shift once the dragged pages are removed beforehand (e.g. when
  // reordering within the same document) and would need tedious correction
  // — a stable reference page makes that unnecessary. `{ atEnd: true }`
  // appends it to the end of the target document.
  // `silent`: renderer.js uses this for drag & drop (see moveSlotsInDom) —
  // there, the affected DOM nodes have already been moved directly
  // themselves (no flicker of unrelated pages from a full rebuild), an
  // additional `_notify()` rebuild would be redundant there and would undo
  // exactly that.
  movePages(pageIds, toDocumentId, insertion, { silent = false } = {}) {
    this._pushUndo();
    const toDocument = this.getDocument(toDocumentId);
    const removedPages = new Map();
    for (const doc of this.documents) {
      for (const pageId of pageIds) {
        const index = doc.pages.findIndex((p) => p.id === pageId);
        if (index !== -1) removedPages.set(pageId, doc.removePageAt(index));
      }
    }

    const orderedPages = pageIds.map((id) => removedPages.get(id));
    const foundIndex = insertion.beforePageId
      ? toDocument.pages.findIndex((p) => p.id === insertion.beforePageId)
      : -1;
    const at = foundIndex === -1 ? toDocument.pages.length : foundIndex;
    orderedPages.forEach((page, offset) => toDocument.insertPageAt(at + offset, page));

    if (!silent) this._notify();
  }

  // Dropping before the first or after the last document:
  // creates a new document from the dragged pages. The name is derived from
  // the origin document of the first dragged page (see
  // deriveConflictFreeName); the origin document itself stays intact with
  // its remaining pages. `filePath: null`, since there's no associated file
  // on disk yet — it gets one only once the document is first saved.
  createDocumentFromPages(pageIds, position) {
    this._pushUndo();
    const originDocument = this.documents.find((doc) =>
      doc.pages.some((p) => p.id === pageIds[0]),
    );
    const baseName = originDocument.displayName;

    const removedPages = new Map();
    for (const doc of this.documents) {
      for (const pageId of pageIds) {
        const index = doc.pages.findIndex((p) => p.id === pageId);
        if (index !== -1) removedPages.set(pageId, doc.removePageAt(index));
      }
    }
    const orderedPages = pageIds.map((id) => removedPages.get(id));

    const displayName = deriveConflictFreeName(
      baseName,
      this.documents.map((doc) => doc.displayName),
    );
    const newDocument = new Document({
      filePath: null,
      displayName,
      pages: orderedPages,
    });
    newDocument.markDirty();

    if (position === 'start') {
      this.documents.unshift(newDocument);
    } else {
      this.documents.push(newDocument);
    }

    this._notify();
    return newDocument;
  }

  // Deletes one or more pages, including across
  // documents. Removed per affected document in descending index order, so
  // removing a page doesn't shift the still-pending indices of the same
  // operation. If this empties a document completely, it remains as an
  // empty slot (shown with placeholder visuals) instead of being
  // removed automatically.
  removePages(pageIds) {
    this._pushUndo();
    const idSet = new Set(pageIds);
    for (const doc of this.documents) {
      const indices = doc.pages
        .map((page, index) => (idSet.has(page.id) ? index : -1))
        .filter((index) => index !== -1)
        .sort((a, b) => b - a);
      for (const index of indices) doc.removePageAt(index);
    }
    this._notify();
  }

  // Duplicates one or more pages directly at their respective position
  // (Document.duplicatePageAt inserts the copy right after it). Descending
  // order here too: inserting a copy after a page with a higher index
  // doesn't shift any still-unprocessed (lower) indices in the same
  // operation.
  duplicatePages(pageIds) {
    this._pushUndo();
    const idSet = new Set(pageIds);
    const duplicates = [];
    for (const doc of this.documents) {
      const indices = doc.pages
        .map((page, index) => (idSet.has(page.id) ? index : -1))
        .filter((index) => index !== -1)
        .sort((a, b) => b - a);
      for (const index of indices) duplicates.push(doc.duplicatePageAt(index));
    }
    this._notify();
    return duplicates;
  }

  // Rotates one or more pages by the same delta. Order doesn't matter
  // here — rotation changes neither the length nor the order of the
  // `pages` array, so other indices stay valid throughout the operation.
  rotatePages(pageIds, degreesDelta) {
    this._pushUndo();
    const idSet = new Set(pageIds);
    for (const doc of this.documents) {
      doc.pages.forEach((page, index) => {
        if (idSet.has(page.id)) doc.rotatePageAt(index, degreesDelta);
      });
    }
    this._notify();
  }

  // Restore original — only relevant for a document that is
  // empty at save time (see renderer.js showEmptyDocumentsDialog); still
  // offered here as a generic store method rather than directly on
  // Document, so it (like the other mutations) feeds the undo stack.
  restoreOriginal(documentId, { silent = false } = {}) {
    this._pushUndo();
    this.getDocument(documentId)?.restoreOriginal();
    if (!silent) this._notify();
  }

  // --- Undo/redo -----------------------------------------------------------
  // Deliberately state-based (the whole canvas structure as a snapshot), no
  // command pattern with individually written undo functions per action —
  // given the already fairly large number of mutation kinds (move, delete,
  // rotate, duplicate, new document, reorder documents, restore original),
  // a single generic snapshot/restore mechanism is significantly less code
  // and less error-prone than maintaining a separate, exact inverse
  // operation for each action (hobby-project principle: minimal maintenance
  // overhead).
  // Snapshots reference pages only via `sourceId` + `sourcePageIndex` +
  // `rotation` (not object references) and build entirely new Document/Page
  // instances on restore — Document/Page `id`s are therefore NOT the same
  // objects as before after an undo/redo (an active page selection, for
  // example, automatically becomes empty as a result, instead of pointing
  // at the wrong pages). This is deliberately accepted: a full rebuild of
  // the active view (like for every other normal store mutation) happens
  // here anyway, and undo/redo is also a comparatively rare action — the
  // effort spent elsewhere in this codebase avoiding flicker via targeted
  // DOM surgery isn't worth it here.
  //
  // Opening/closing documents is deliberately NOT part of the undo stack
  // (only page operations and move actions are) —
  // both already have their own safety nets (closing asks first on unsaved
  // changes, opening simply reads from disk again).
  // Capped rather than left unbounded — each entry is a full snapshot of
  // every open document's page list, so a very long editing session could
  // otherwise grow this indefinitely. 50 undo steps is far more than a user
  // would realistically want to step back through anyway.
  static MAX_UNDO_STACK = 50;

  _pushUndo() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > DocumentStore.MAX_UNDO_STACK) this._undoStack.shift();
    this._redoStack = []; // a new action discards any existing redo history
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return;
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
    this._notify();
  }

  redo() {
    if (!this.canRedo()) return;
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
    this._notify();
  }

  _snapshot() {
    return this.documents.map((doc) => ({
      filePath: doc.filePath,
      displayName: doc.displayName,
      dirty: doc.dirty,
      originalSourceId: doc.originalSource?.id ?? null,
      pages: doc.pages.map((page) => ({
        sourceId: page.source.id,
        sourcePageIndex: page.sourcePageIndex,
        rotation: page.rotation,
      })),
    }));
  }

  _restore(snapshot) {
    this.documents = snapshot.map((entry) => {
      const pages = entry.pages.map(
        (p) =>
          new Page({
            source: this._sourceRegistry.get(p.sourceId),
            sourcePageIndex: p.sourcePageIndex,
            rotation: p.rotation,
          }),
      );
      const doc = new Document({
        filePath: entry.filePath,
        displayName: entry.displayName,
        pages,
        originalSource: entry.originalSourceId ? this._sourceRegistry.get(entry.originalSourceId) : null,
      });
      doc.dirty = entry.dirty;
      return doc;
    });
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    for (const listener of this._listeners) {
      listener(this);
    }
  }
}
