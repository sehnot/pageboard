let nextSourceId = 1;

/**
 * Wraps the raw bytes of one opened PDF file. Several Page instances (even
 * across different Document objects, once pages get merged) can reference
 * the same PdfSource instead of copying bytes per page.
 *
 * `pageCount` is supplied by the caller rather than parsed here. The
 * renderer determines it via pdf.js (already loaded there for rendering).
 * pdf-lib is deliberately kept out of this browser-side model: its ESM
 * build pulls in bare-specifier dependencies (pako, @pdf-lib/fontkit, …)
 * and even a Node `fs` import, none of which resolve in an Electron
 * renderer without a bundler. pdf-lib is used exclusively
 * in the main process, where Node module resolution is available, for the
 * actual write/save operations added in later phases.
 */
export class PdfSource {
  constructor(filePath, bytes, pageCount) {
    this.id = `source-${nextSourceId++}`;
    this.filePath = filePath;
    this.bytes = bytes;
    this.pageCount = pageCount;
  }
}
