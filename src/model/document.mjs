import { Page } from './page.mjs';

let nextDocumentId = 1;

/**
 * A document slot on the canvas. `originalSource` is the PdfSource from the
 * moment of opening (`null` for a document that never had one — e.g. one
 * created by dragging pages to the canvas edge) — needed for
 * "restore original": unlike `pages`, which is freely mutated
 * (moved/deleted/duplicated/rotated), `originalSource` never changes after
 * construction, so it always reflects the true opening state. `isEmpty`
 * (all pages removed) is what triggers the placeholder slot — not
 * individual page removal.
 */
export class Document {
  // `id` is only ever passed by DocumentStore._restore() — see the same
  // note on Page's constructor for why identity has to survive undo/redo.
  constructor({ filePath, displayName, pages, originalSource = null, id = null }) {
    this.id = id ?? `document-${nextDocumentId++}`;
    this.filePath = filePath;
    this.displayName = displayName;
    this.pages = pages;
    this.originalSource = originalSource;
    this.dirty = false;
  }

  get isEmpty() {
    return this.pages.length === 0;
  }

  markDirty() {
    this.dirty = true;
  }

  insertPageAt(index, page) {
    this.pages.splice(index, 0, page);
    this.markDirty();
  }

  removePageAt(index) {
    const [removed] = this.pages.splice(index, 1);
    this.markDirty();
    return removed;
  }

  duplicatePageAt(index) {
    const copy = this.pages[index].clone();
    this.pages.splice(index + 1, 0, copy);
    this.markDirty();
    return copy;
  }

  rotatePageAt(index, degreesDelta) {
    const page = this.pages[index];
    page.rotation = (((page.rotation + degreesDelta) % 360) + 360) % 360;
    this.markDirty();
    return page;
  }

  // Discards all changes since opening and rebuilds `pages` fresh from the
  // source file — relevant e.g. when a document is empty at
  // save time (see renderer.js showEmptyDocumentsDialog). A no-op for
  // virtual documents with no `originalSource`: those never had a
  // file of their own, so there's no state to return to.
  restoreOriginal() {
    if (!this.originalSource) return;
    this.pages = Array.from(
      { length: this.originalSource.pageCount },
      (_, sourcePageIndex) => new Page({ source: this.originalSource, sourcePageIndex }),
    );
    this.dirty = false;
  }
}
