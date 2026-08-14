# Organizing Pages

## Selecting pages

- **Click** a page to select it, replacing any previous selection.
- **Shift+click** selects a range from your last-selected page to the one
  you clicked.
- **Cmd/Ctrl+click** adds or removes a single page from the current
  selection without clearing the rest.

Selection works **across document boundaries** — you can Shift+click from
a page in one document to a page in another, or Cmd/Ctrl+click pages from
several documents into one selection. Whatever you select stays selected
when you switch between Canvas and Grid view.

## Dragging pages

Drag any selected page(s) to move them — this works identically whether
you're reordering within one document or moving pages into a different
document, there's no separate mode for either. If you drag a page that's
part of a multi-selection, the **whole selection** moves together, keeping
its relative order.

A thin indicator bar shows exactly where a page will land as you drag.

- **Dropping between two existing documents** (in the gap that separates
  them) isn't a valid target — no indicator appears there, and releasing
  the page just drops it back where it came from.
- **Dropping before the first document or after the last one** creates a
  **new document** out of the dragged page(s). Its filename is derived from
  the page's original document (e.g. `invoice.pdf` → `invoice (2).pdf`,
  incrementing further on a name clash).
- **Dropping onto an empty document** (see [Saving & Undo](saving-and-undo.md)
  for how a document becomes empty) brings it back to life — the
  placeholder is highlighted as the drop target, and the document simply
  continues under its original name.

## Reordering whole documents

Drag a document's header (the title bar above its pages) to move the
entire document to a new position — left/right in Canvas mode, up/down in
Grid view. You'll see a live preview of the new order as you drag; release
to commit it, or press <kbd>Esc</kbd> to cancel.

## Rotating, duplicating, and deleting pages

Act on the current selection via any of:

- **Right-click** a page for a context menu (Duplicate, Rotate left, Rotate
  right, Delete).
- **Toolbar buttons** — enabled once at least one page is selected.
- **Keyboard shortcuts** — see [Keyboard Shortcuts](keyboard-shortcuts.md).

Deleting every page in a document doesn't remove the document itself — it
stays on the canvas as an empty, dashed placeholder. See
[Saving & Undo](saving-and-undo.md) for what happens to it when you save.
