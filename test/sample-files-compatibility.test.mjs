import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { startSession, CDP_PORTS, testFilesDir } from './helpers/cdp-session.mjs';

// Broad compatibility smoke test for the sample-file corpus mirrored from
// py-pdf/sample-files under pdf-files/test-files/ (see NOTICE.md there for
// licensing — CC-BY-SA-4.0, distinct from this repo's own MIT code). These
// files exist specifically as real-world PDF edge cases (unusual metadata,
// encryption, CMYK/grayscale color spaces, forms, attachments, ...), so the
// bar here is deliberately "PageBoard doesn't crash on any of them", not
// "every single one opens successfully" — some are edge cases by design and
// may legitimately hit the existing corrupted/unreadable failure path
// instead of opening. A real crash (an uncaught renderer exception) still
// fails this test, via the same evaluate()-throws-on-exceptionDetails
// mechanism the shared harness gives every CDP test file in this project.
//
// The file list is read from disk at test time rather than hardcoded, so
// this test keeps covering the actual corpus if it's ever extended.

// Longer than the harness default — this file's one real evaluate() call
// opens ~30 real PDFs in a single batch (matching a real multi-select open),
// which legitimately takes longer than a typical single-action call elsewhere,
// and longer still on a busy machine.
const CDP_TIMEOUT_MS = 180000;

let session;

before(async () => {
  session = await startSession({
    name: 'sample-files',
    port: CDP_PORTS.sampleFilesCompatibility,
    callTimeoutMs: CDP_TIMEOUT_MS,
  });
});

after(async () => {
  await session?.close();
});

async function findAllPdfPaths(dir) {
  const results = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findAllPdfPaths(full)));
    } else if (entry.isFile() && entry.name.endsWith('.pdf')) {
      results.push(full);
    }
  }
  return results;
}

test('every PDF under pdf-files/test-files/ opens without crashing PageBoard', async () => {
  const filePaths = (await findAllPdfPaths(testFilesDir)).sort();
  assert.ok(filePaths.length > 0, 'expected at least one sample PDF to test against');

  const result = await session.evaluate(`
    (async () => {
      const filePaths = ${JSON.stringify(filePaths)};
      const fileInfos = await window.api.readPdfFiles(filePaths);
      const before = __mod.store.documents.length;
      await __mod.handleOpenedFiles(fileInfos);
      const after = __mod.store.documents.length;
      const openedNames = __mod.store.documents.slice(before).map((d) => d.displayName);
      return { addedCount: after - before, openedNames };
    })()
  `);

  // Two samples are expected to NOT open as documents, both for reasons
  // that are the whole point of those upstream fixtures, not a bug here:
  // - 005-libreoffice-writer-password: encrypted, hits the existing
  //   password-protected failure path (same as error-handling.test.mjs's
  //   dedicated password-protected scenario).
  // - 017-unreadable-meta-data: deliberately malformed metadata (per its
  //   own name upstream), hits pdf.js's generic parse-failure path — same
  //   "corrupted or not a valid PDF" outcome error-handling.test.mjs
  //   already covers for corrupt.pdf, just triggered by a different kind of
  //   malformed input.
  const expectedNonOpeners = ['libreoffice-writer-password.pdf', 'unreadablemetadata.pdf'];
  assert.equal(
    result.addedCount,
    filePaths.length - expectedNonOpeners.length,
    `expected every sample file except ${JSON.stringify(expectedNonOpeners)} to open (got: ${JSON.stringify(result.openedNames)})`,
  );
  for (const name of expectedNonOpeners) {
    assert.ok(!result.openedNames.includes(name), `${name} should not have opened as a document`);
  }
});
