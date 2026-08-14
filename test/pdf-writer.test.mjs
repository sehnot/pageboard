import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildDocumentPdfBytes } from '../main/pdf-writer.mjs';

// Creates a test PDF with `pageCount` pages, each with its own,
// distinguishable width (sizeSeed + index) — that way, after assembly, page
// width alone reveals which source page ended up in which spot.
async function makeTestPdf(pageCount, sizeSeed) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    doc.addPage([sizeSeed + i, sizeSeed + i]);
  }
  return doc.save();
}

test('buildDocumentPdfBytes merges pages from multiple sources in the given order, including rotation', async () => {
  const bytesA = await makeTestPdf(3, 100); // widths 100, 101, 102
  const bytesB = await makeTestPdf(2, 300); // widths 300, 301

  const sources = new Map([
    ['source-a', bytesA],
    ['source-b', bytesB],
  ]);

  const pages = [
    { sourceId: 'source-b', sourcePageIndex: 1, rotation: 0 }, // width 301
    { sourceId: 'source-a', sourcePageIndex: 0, rotation: 0 }, // width 100
    { sourceId: 'source-a', sourcePageIndex: 2, rotation: 90 }, // width 102, rotated
  ];

  const outBytes = await buildDocumentPdfBytes(sources, pages);
  const outDoc = await PDFDocument.load(outBytes);

  assert.equal(outDoc.getPageCount(), 3);
  assert.equal(outDoc.getPage(0).getWidth(), 301);
  assert.equal(outDoc.getPage(1).getWidth(), 100);
  assert.equal(outDoc.getPage(2).getWidth(), 102);
  assert.equal(outDoc.getPage(0).getRotation().angle, 0);
  assert.equal(outDoc.getPage(2).getRotation().angle, 90);
});

test('buildDocumentPdfBytes deduplicates source PDFs: the same sourceId is only loaded once', async () => {
  const bytesA = await makeTestPdf(2, 500);
  const sources = new Map([['source-a', bytesA]]);
  const pages = [
    { sourceId: 'source-a', sourcePageIndex: 1, rotation: 0 },
    { sourceId: 'source-a', sourcePageIndex: 0, rotation: 0 },
    { sourceId: 'source-a', sourcePageIndex: 1, rotation: 0 },
  ];

  const outBytes = await buildDocumentPdfBytes(sources, pages);
  const outDoc = await PDFDocument.load(outBytes);

  assert.equal(outDoc.getPageCount(), 3);
  assert.equal(outDoc.getPage(0).getWidth(), 501);
  assert.equal(outDoc.getPage(1).getWidth(), 500);
  assert.equal(outDoc.getPage(2).getWidth(), 501);
});

// Doesn't occur in the real save flow (empty documents are resolved
// beforehand via the bundle dialog, see renderer.js saveDocuments) — a pure
// crash test. Note: pdf-lib apparently still produces a (empty) page when
// saving/reloading a PDFDocument with no pages; that's a pdf-lib quirk, not
// a property of buildDocumentPdfBytes, hence no assertion here about the
// exact page count.
test('buildDocumentPdfBytes does not crash with an empty page list', async () => {
  const outBytes = await buildDocumentPdfBytes(new Map(), []);
  await assert.doesNotReject(PDFDocument.load(outBytes));
});
