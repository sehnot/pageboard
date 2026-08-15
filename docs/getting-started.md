# Getting Started

## First launch: security warnings on a downloaded build

PageBoard's macOS and Windows builds aren't code-signed yet, so the first
time you launch a downloaded copy, your OS will flag it as coming from an
unidentified source. This is expected — it's not a corrupted download —
and only needs to be dealt with once per installed copy.

- **macOS**: if you see "'PageBoard.app' is damaged and can't be opened,"
  that's Gatekeeper's standard message for any unsigned, downloaded app —
  not a real integrity problem. Open Terminal and run:
  ```bash
  xattr -cr /Applications/PageBoard.app
  ```
  Then launch it normally.
- **Windows**: if SmartScreen shows "Windows protected your PC," click
  **More info**, then **Run anyway**. If you'd rather clear the warning
  before running the installer at all, right-click it → Properties → check
  **Unblock** → OK.

## Opening PDFs

There are three ways to open PDFs in PageBoard:

- **File dialog**: click the **Open…** button in the toolbar, use the
  **File → Open…** menu, or press <kbd>Ctrl/Cmd+O</kbd>. The dialog
  supports selecting multiple PDFs at once.
- **Drag & drop from outside**: drag one or more PDFs from Finder (Mac) or
  Explorer (Windows) straight onto the PageBoard window.
- **The empty starting state**: when nothing is open yet, the window shows
  a drop zone with an **Open…** button in the middle — drag files onto it
  or click the button.

When you open several PDFs at once, they appear on the canvas in the order
you selected them. Newly opened documents are always added at the end
(right-most in Canvas mode, bottom-most in Grid view) — where you happened
to drop them doesn't affect where they land.

## Opening a file that's already open

If you try to open a PDF that's already on the canvas, PageBoard doesn't
load it a second time — loading the same file twice would create two
independent, diverging copies of it in memory, which would be dangerous
once you save (whichever one you save last would silently overwrite the
other's changes). Instead, PageBoard scrolls to and briefly highlights the
already-open document, along with a small toast notification confirming
what happened.

## Starting fresh each time

PageBoard always starts empty — there's no session that gets restored from
your last visit. This follows directly from how saving works (see
[Saving & Undo](saving-and-undo.md)): since nothing is auto-saved, there's
never an in-progress editing state that would make sense to restore. Every
session starts by opening the files you want to work on.
