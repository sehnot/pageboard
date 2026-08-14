# screenshot-files/

The three PDFs opened by `scripts/generate-screenshots.mjs` (`npm run
screenshots`) to produce `docs/screenshots/canvas-view.png` and
`grid-view.png`.

`screenshot1.pdf`/`screenshot2.pdf`/`screenshot3.pdf` currently hold
synthetic placeholder content (see `scripts/generate-placeholder-pdfs.mjs`)
— no real text/images, purely so the screenshots show *something* plausible
without borrowing real/third-party content. An earlier attempt used real
sample PDFs and had to be discarded once they turned out to contain
copyrighted/personal content unsuitable for a public screenshot — synthetic
placeholders sidestep that risk entirely.

These filenames are expected to stay the same even once nicer, more
polished PDFs replace the placeholders — `scripts/generate-screenshots.mjs`
doesn't care what's actually inside them, only that exactly these three
files exist here.
