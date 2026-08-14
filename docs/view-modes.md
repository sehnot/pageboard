# View Modes

PageBoard has two view modes, switchable at any time via the toolbar
buttons. Your selection, scroll position, and zoom level are kept
independently for each view, so switching back and forth doesn't lose your
place.

## Canvas mode

The default view: pages scroll vertically within each document, like a
normal PDF reader. With several documents open, they sit **side by side**,
each scrollable on its own — the whole thing behaves like one large canvas:

- Zoom applies to the entire canvas at once (all documents together), not
  per document.
- Vertical scrolling moves all documents together by default.
- Scrolling/dragging horizontally moves between documents.
- Dragging on empty space **pans** the canvas.
- If the whole row of documents is narrower than the window, it's centered
  rather than pinned to the left.

## Grid view

A slide-sorter-style overview: pages are shown small, in rows. Each
document forms its own section (with the filename as a header), and
sections are stacked vertically — grayscale banding alternates between
sections so it's easy to tell where one document ends and the next begins.

The number of pages per row is controlled by a dropdown in the toolbar
(only visible in Grid view), next to the view switcher: **5, 8 (default),
10, 12, 15**, or **"--"** for the whole document in a single row. This is a
global setting — it applies to every open document at once. Changing zoom
never changes how many pages fit per row; it only changes tile size.

## Zoom, pan, and focus mode

- **Zoom**: <kbd>Ctrl/Cmd</kbd> + scroll wheel, or a trackpad pinch gesture,
  in **both** views. Zoom is anchored to your cursor position — whatever is
  under the pointer stays under the pointer as you zoom in or out.
- **Pan**: dragging on empty canvas space moves the view — Canvas mode
  only (Grid view uses ordinary scrolling instead).
- **Focus mode**: double-click any page to zoom it to fill the window,
  hiding everything else. Double-click again (or manually zoom/pan) to
  return to your previous view.
