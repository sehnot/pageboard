# Saving & Undo

## How saving works

Nothing is written to disk automatically. Every change — moving, deleting,
rotating, duplicating pages — happens only in memory until you explicitly
save. There's no "Save As" and no copies are made: saving **overwrites the
original file directly**.

You can save:

- **One document** — the save button in its section header, or right-click
  the header for the same option in a context menu.
- **Everything at once** — the "Save all" button in the toolbar, or
  right-click empty canvas space.

Any document with unsaved changes shows a small dot next to its filename in
the section header.

### A trade-off worth knowing about

Since documents save independently, this scenario is possible: you move a
page from document A to document B, then only save B. The page now exists
in both places — still in A on disk (A was never saved), and newly present
in B. This is accepted as a reasonable trade-off rather than something
PageBoard tries to prevent. If you want to avoid it, either use
**Duplicate** explicitly before moving a copy elsewhere, or get in the
habit of using **Save all**.

## Emptied-out documents

If you remove every page from a document (it now shows as a dashed
placeholder), saving doesn't happen silently. Instead, a single dialog
lists every such document and lets you choose, per document:

- **Restore original** — brings back the state the document was in when
  you first opened it.
- **Delete** — removes the file from disk.

This dialog only appears at save time, never while you're still editing.

## Undo & redo

<kbd>Ctrl/Cmd+Z</kbd> to undo, <kbd>Ctrl/Cmd+Shift+Z</kbd> to redo — this
covers page operations (rotate, delete, duplicate) and move actions
(drag & drop, reordering documents). Undo works purely in memory for the
current session:

- It's **not** reset by saving — you can undo a change even after saving
  it (though naturally not back past the point where the file was first
  opened; for that, use "Restore original" above).
- It does **not** persist across an app restart.

## Closing a document

Click the **×** in a document's section header to remove it from the
canvas. If it has no unsaved changes, it closes immediately. If it does,
you'll be asked whether to save, discard the changes, or cancel — closing
**never** deletes the file itself, regardless of your choice (that's what
the empty-document dialog above is for).
