// One-off generator for pdf-files/screenshot-files/screenshot{1,2,3}.pdf —
// not invoked by scripts/generate-screenshots.mjs itself, since those are
// meant to be stable, checked-in fixtures (see pdf-files/screenshot-files/README.md).
// Kept around only so a 4th placeholder or a regeneration is easy later.
// Deliberately synthetic content (colored header + gray text-placeholder
// bars, no real text/images) — an earlier attempt used real sample PDFs for
// screenshots and had to be discarded once they turned out to contain
// copyrighted/personal content, so real/borrowed content isn't safe to use
// for anything that ends up in public screenshots.
import { PDFDocument, rgb } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'pdf-files', 'screenshot-files');

const COLORS = [
  { header: rgb(0.29, 0.56, 0.89) },
  { header: rgb(0.35, 0.72, 0.45) },
  { header: rgb(0.87, 0.55, 0.24) },
];

async function makePdf(outPath, pageCount, colorIndex) {
  const doc = await PDFDocument.create();
  const color = COLORS[colorIndex % COLORS.length].header;
  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.addPage([420, 594]);
    page.drawRectangle({ x: 0, y: 534, width: 420, height: 60, color });
    page.drawRectangle({ x: 40, y: 460, width: 340, height: 14, color: rgb(0.8, 0.8, 0.8) });
    page.drawRectangle({ x: 40, y: 430, width: 300, height: 14, color: rgb(0.8, 0.8, 0.8) });
    page.drawRectangle({ x: 40, y: 400, width: 320, height: 14, color: rgb(0.8, 0.8, 0.8) });
    page.drawRectangle({ x: 40, y: 370, width: 260, height: 14, color: rgb(0.8, 0.8, 0.8) });
  }
  await fs.writeFile(outPath, await doc.save());
}

await makePdf(path.join(outDir, 'screenshot1.pdf'), 6, 0);
await makePdf(path.join(outDir, 'screenshot2.pdf'), 4, 1);
await makePdf(path.join(outDir, 'screenshot3.pdf'), 8, 2);
console.log(`Wrote screenshot1.pdf, screenshot2.pdf, screenshot3.pdf to ${outDir}`);
