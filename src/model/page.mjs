let nextPageId = 1;

/**
 * A page on the canvas. Points at a source PDF + the page index within it,
 * plus editor-only state (rotation). Pages keep their identity when dragged
 * between documents — only the owning Document's `pages` array changes.
 */
export class Page {
  /**
   * `id` is only ever passed by DocumentStore._restore(), to give an
   * undone/redone page back the identity it had before. Everything else
   * leaves it out and gets a fresh one. Restoring identity matters because
   * the renderer reconciles its DOM by page id: with a fresh id per undo,
   * every page would look new, so every already-rasterized page would be
   * thrown away and re-rendered on each undo step. It also means the
   * current selection survives an undo instead of silently emptying.
   */
  constructor({ source, sourcePageIndex, rotation = 0, id = null }) {
    this.id = id ?? `page-${nextPageId++}`;
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
