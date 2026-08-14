import { PDFDocument, degrees } from 'pdf-lib';

/**
 * Assembles the final PDF bytes for one document from its current page
 * list. Pure logic, no filesystem access — kept separate from main.js so it
 * is testable under plain Node (`test/pdf-writer.test.mjs`), without an
 * Electron runtime.
 *
 * `sources` maps `sourceId -> raw PDF bytes`. These must be the bytes from
 * the moment each source PDF was first opened (`PdfSource.bytes`), not a
 * fresh read of whatever currently sits on disk at that source's path — an
 * earlier save in the same session may already have overwritten that file
 * with different content, while a still-open Document elsewhere may
 * reference a page index into the *original* content (see renderer.js
 * saveDocuments()).
 *
 * `pages` is the ordered list of `{ sourceId, sourcePageIndex, rotation }`
 * to assemble into the output PDF. `rotation` is applied as the page's
 * absolute rotation (matching how pdf.js renders `page.rotation` on-screen,
 * see renderer.js computeCanvas) — not added to whatever rotation the
 * source page already had.
 */
export async function buildDocumentPdfBytes(sources, pages) {
  const pdfLibDocsBySource = new Map();
  const outDoc = await PDFDocument.create();

  for (const page of pages) {
    let sourceDoc = pdfLibDocsBySource.get(page.sourceId);
    if (!sourceDoc) {
      sourceDoc = await PDFDocument.load(sources.get(page.sourceId));
      pdfLibDocsBySource.set(page.sourceId, sourceDoc);
    }
    const [copiedPage] = await outDoc.copyPages(sourceDoc, [page.sourcePageIndex]);
    if (page.rotation) copiedPage.setRotation(degrees(page.rotation));
    outDoc.addPage(copiedPage);
  }

  return outDoc.save();
}
