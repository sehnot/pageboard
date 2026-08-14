let nextPageId = 1;

/**
 * A page on the canvas. Points at a source PDF + the page index within it,
 * plus editor-only state (rotation). Pages keep their identity when dragged
 * between documents — only the owning Document's `pages` array changes.
 */
export class Page {
  constructor({ source, sourcePageIndex, rotation = 0 }) {
    this.id = `page-${nextPageId++}`;
    this.source = source;
    this.sourcePageIndex = sourcePageIndex;
    this.rotation = rotation;
  }

  clone() {
    return new Page({
      source: this.source,
      sourcePageIndex: this.sourcePageIndex,
      rotation: this.rotation,
    });
  }
}
