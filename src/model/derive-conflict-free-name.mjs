/**
 * Derives a non-conflicting display name for a document freshly created by
 * dragging pages out before the first / after the last document: based on
 * the origin document's name, e.g. "Document.pdf" ->
 * "Document (2).pdf"; on conflict, the next free number is used.
 */
export function deriveConflictFreeName(originalName, existingNames) {
  const match = originalName.match(/^(.*?)(\.[^./\\]+)?$/);
  const stem = match[1];
  const ext = match[2] ?? '';

  let n = 2;
  let candidate = `${stem} (${n})${ext}`;
  while (existingNames.includes(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}
