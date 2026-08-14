# PageBoard Documentation

PageBoard is a local desktop app (Mac & Windows) for organizing multiple PDF
files at once: reorder, delete, rotate, duplicate, and merge pages — across
documents on a shared canvas, as if all the PDFs you have open were one
single large document.

It's built for people who regularly need to sort or assemble several PDFs
together (scanned chapters, invoices, forms from different sources) rather
than editing one PDF at a time — for a single-document tweak, any of the
usual tools (Preview, Acrobat, a web PDF editor) will do. PageBoard's whole
point is what happens once you have more than one PDF open simultaneously.

Everything here documents how to actually use the app. If you're looking
for build instructions, the technology it's built on, or how to contribute,
see the [project README](../README.md) instead.

## Contents

- **[Getting Started](getting-started.md)** — opening PDFs, the empty
  starting state, what happens when you open a file that's already open.
- **[View Modes](view-modes.md)** — Canvas mode vs. Grid view, zooming and
  panning, focus mode.
- **[Organizing Pages](organizing-pages.md)** — selecting pages, drag &
  drop within and across documents, reordering whole documents, rotating/
  duplicating/deleting pages.
- **[Saving & Undo](saving-and-undo.md)** — how saving works, the
  unsaved-changes indicator, what happens to emptied-out documents, undo/
  redo, closing a document.
- **[Keyboard Shortcuts](keyboard-shortcuts.md)** — the full shortcut
  reference, matching the app's own "Show keyboard shortcuts" dialog.

## The core idea

Open several PDFs and they all land together on one canvas. Drag a page
from one document into another, drag it to the very edge to spin off a new
document, select pages across document boundaries and act on all of them at
once — pages stop "belonging" to their original file the moment they're on
the canvas together. Nothing is written back to disk until you explicitly
save, and saving always overwrites the original file directly (no "Save
As", no copies left behind).
