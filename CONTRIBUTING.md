# Contributing

Thanks for your interest! This is a hobby project with the explicit goal of
keeping maintenance overhead low — these notes stay just as lean.

## Setup

```bash
npm install
npm start   # launch the Electron app
npm test    # run the tests (node:test)
```

Details on debugging, known environment gotchas (e.g.
`ELECTRON_RUN_AS_NODE`), and the project architecture live in `README.md`.

You may notice source comments referencing `CLAUDE.md`, `LESSONS.md`, or
`TESTING.md` — these are the maintainer's own local working notes
(architecture history, a running incident log, a manual test checklist) and
are intentionally not part of this repo (see `.gitignore`). Where a comment
points at one of them for "more detail," that detail just isn't available
externally — the comment itself should still stand on its own.

## Before proposing a change

- **Small fixes/improvements**: just open a pull request.
- **Larger changes** (new features, architecture decisions): please open an
  issue first to align on the approach — saves work on a PR that doesn't fit
  for conceptual reasons.

## Tests

- `npm test` must be green before a PR.
- New logic in the document model (`src/model/`) or PDF generation
  (`main/pdf-writer.mjs`) gets a unit test under `test/` (`node:test`, no
  additional test framework).
- Changes to zoom, drag & drop, or the view modes should additionally be
  checked manually once in both **Canvas and Grid view** (zoom anchor, drop
  indicator, live preview when reordering documents) — this part of the app
  is deliberately not covered by automated tests.

## Style

- Comments and documentation in this repo are in English — please keep it
  that way.
- No bundler, no framework in the renderer (see README/architecture) —
  please avoid new dependencies there unless truly necessary.

## Scope

The app's focus is deliberately narrow: organizing the page structure of
multiple PDFs across documents (reorder, delete, rotate, duplicate). No
editing of content, forms, or annotations — feature suggestions outside this
scope will likely be declined, not because the idea is bad, but because it
doesn't fit the project's goal.

## License

By contributing, you agree that your contribution is published under the
project's license (MIT, see `LICENSE`).
