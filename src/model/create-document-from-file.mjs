import { PdfSource } from './pdf-source.mjs';
import { Page } from './page.mjs';
import { Document } from './document.mjs';

/**
 * Builds a Document + its initial Pages from raw PDF bytes read by the main
 * process. `pageCount` is determined by the caller (renderer.js uses pdf.js
 * for this) so the model itself stays free of any specific PDF library.
 */
export function createDocumentFromFile(filePath, bytes, pageCount) {
  const source = new PdfSource(filePath, bytes, pageCount);

  const pages = Array.from(
    { length: pageCount },
    (_, sourcePageIndex) => new Page({ source, sourcePageIndex }),
  );

  const displayName = filePath.split(/[\\/]/).pop();

  return new Document({ filePath, displayName, pages, originalSource: source });
}
