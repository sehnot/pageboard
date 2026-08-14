import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

// Covers native HTML5 drag & drop (see CLAUDE.md "Drag & drop
// internals") via real DragEvents with a real DataTransfer — the technique
// CLAUDE.md already names as automatable ("dispatch real DragEvents with a
// new DataTransfer() at the right clientX/clientY") but that had no actual
// test coverage yet. Two independent drag mechanisms are covered: dragging
// a page (or a multi-selection of pages) between/within documents, and
// dragging a whole document's section header to reorder it among its
// siblings.

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testFilesDir = path.join(projectRoot, 'pdf-files', 'test-files');
// A separate port from every other CDP test file (9422-9429).
const CDP_PORT = 9430;

let electronProcess;
let ws;
let msgId = 0;
let userDataDir;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(msg);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    const timer = setTimeout(() => reject(new Error(`CDP timeout on ${method}`)), 15000);
  });
}

async function evaluate(expression) {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (msg.result.exceptionDetails) {
    throw new Error(`Renderer exception: ${JSON.stringify(msg.result.exceptionDetails)}`);
  }
  return msg.result.result?.value;
}

async function waitForDebuggerUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Server not ready yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Electron window did not register for CDP in time');
}

// See LESSONS.md — node_modules/.bin/electron is itself a wrapper that
// spawns the real Electron binary as a separate child process; a plain
// .kill() doesn't reliably take the whole tree down with it.
function killElectron(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Every page's id currently in the active (Canvas) view, in DOM order — see
// the identical helper/comment in interaction.test.mjs.
async function flatPageIds() {
  return evaluate(`
    [...document.querySelectorAll('#canvas-view .page-slot[data-page-id]')].map((el) => el.dataset.pageId)
  `);
}

async function documentIdsInDom() {
  return evaluate(`
    [...document.querySelectorAll('#canvas-view .document-container[data-document-id]')].map((el) => el.dataset.documentId)
  `);
}

// Scrolls an element (page slot or section header) into view and returns
// its current center coordinates — same rationale as clickPage() in
// interaction.test.mjs: a document column can be taller than the Electron
// window, so a rect can't be trusted unless it's re-measured right after
// scrolling.
async function centerOfScrolledIntoView(selector) {
  return evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
}

// Runs a full dragstart -> dragover -> drop -> dragend sequence against a
// single real DataTransfer, entirely inside one Runtime.evaluate call so
// there's no gap where the app's own dragend/cleanup logic could race
// against a separate round-trip. Mirrors CLAUDE.md's documented technique:
// real DragEvents with a real DataTransfer at explicit clientX/clientY.
async function dragAndDrop(sourceSelector, dropClientX, dropClientY) {
  return evaluate(`
    (() => {
      const source = document.querySelector(${JSON.stringify(sourceSelector)});
      const dt = new DataTransfer();
      const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt,
      }));
      const sourceRect = source.getBoundingClientRect();
      fire(source, 'dragstart', sourceRect.left + sourceRect.width / 2, sourceRect.top + sourceRect.height / 2);
      // dragover/drop listeners are bound directly to #canvas-view/#grid-view
      // (see renderer.js) — these tests stay in the default Canvas view
      // throughout, so #canvas-view is always the right dispatch target.
      const view = document.getElementById('canvas-view');
      fire(view, 'dragover', ${dropClientX}, ${dropClientY});
      fire(view, 'drop', ${dropClientX}, ${dropClientY});
      fire(source, 'dragend', ${dropClientX}, ${dropClientY});
      return true;
    })()
  `);
}

before(async () => {
  const electronBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pageboard-dnd-userdata-'));
  electronProcess = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    { cwd: projectRoot, env, stdio: 'ignore', detached: true },
  );

  const wsUrl = await waitForDebuggerUrl(20000);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send('Runtime.enable');

  await evaluate(`(async () => { globalThis.__mod = await import('./renderer.js'); return true; })()`);
  await evaluate(`__mod.switchLocale('en'); true`);
});

after(async () => {
  ws?.close();
  killElectron(electronProcess);
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Each test opens exactly the documents it needs and closes them again at
// the end, so tests don't leak state (dragged pages, reordered documents)
// into each other — drag & drop mutates document membership/order, unlike
// most of interaction.test.mjs's actions which stay within one document.
async function openFixtures(names) {
  const filePaths = names.map((name) => path.join(testFilesDir, name.dir, name.file));
  await evaluate(`
    (async () => {
      const fileInfos = await window.api.readPdfFiles(${JSON.stringify(filePaths)});
      await __mod.handleOpenedFiles(fileInfos);
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
}

// Unconditional — every drag/drop mutation in this file leaves the
// affected document(s) dirty, so gating on `!doc.dirty` (as
// interaction.test.mjs's closeDocument() tests intentionally do) would
// leave documents from an earlier test still open for the next one.
// Nothing here exercises save/close confirmation, so discarding freely is
// fine.
async function closeAllDocuments() {
  await evaluate(`
    (async () => {
      for (const doc of [...__mod.store.documents]) {
        __mod.store.removeDocument(doc.id);
      }
      return true;
    })()
  `);
}

const DOC_A = { dir: '004-pdflatex-4-pages', file: 'pdflatex-4-pages.pdf' }; // 4 pages
const DOC_B = { dir: '027-cropped-rotated-scaled', file: 'cropped-rotated-scaled.pdf' }; // 4 pages

test('dragging a page within the same document reorders it', async () => {
  await openFixtures([DOC_A]);
  const pageIds = await flatPageIds();
  assert.equal(pageIds.length, 4);
  const [p0, p1, p2, p3] = pageIds;

  // Drag page 0 to before page 2 — expected order: p1, p0, p2, p3.
  const target = await centerOfScrolledIntoView(`.page-slot[data-page-id="${p2}"]`);
  await dragAndDrop(`.page-slot[data-page-id="${p0}"]`, target.x, target.y - 5);

  const after = await evaluate(`__mod.store.documents[0].pages.map((p) => p.id)`);
  assert.deepEqual(after, [p1, p0, p2, p3]);

  await closeAllDocuments();
});

test('dragging a page onto another document moves it across documents', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const docIds = await evaluate(`__mod.store.documents.map((d) => d.id)`);
  const [docAId, docBId] = docIds;
  const pageIds = await flatPageIds();
  const lastOfA = pageIds[3]; // doc A's last page
  const firstOfB = pageIds[4]; // doc B's first page

  const target = await centerOfScrolledIntoView(`.page-slot[data-page-id="${firstOfB}"]`);
  await dragAndDrop(`.page-slot[data-page-id="${lastOfA}"]`, target.x, target.y - 5);

  const state = await evaluate(`
    ({
      aIds: __mod.store.getDocument(${JSON.stringify(docAId)}).pages.map((p) => p.id),
      bIds: __mod.store.getDocument(${JSON.stringify(docBId)}).pages.map((p) => p.id),
    })
  `);
  assert.equal(state.aIds.length, 3, 'doc A should have lost the dragged page');
  assert.equal(state.bIds.length, 5, 'doc B should have gained the dragged page');
  assert.equal(state.bIds[0], lastOfA, 'the dragged page should be inserted before the drop target');

  await closeAllDocuments();
});

test('dragging a page past the last document creates a new document', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const docCountBefore = await evaluate(`__mod.store.documents.length`);
  const pageIds = await flatPageIds();
  const lastPage = pageIds[pageIds.length - 1]; // doc B's last page

  // The drop-edge zone is beyond the last document container's right edge
  // in Canvas view (findDropEdgeZone) — scroll the last container into view
  // first, then aim well past its right edge.
  const lastContainerRect = await evaluate(`
    (() => {
      const containers = document.querySelectorAll('#canvas-view .document-container');
      const el = containers[containers.length - 1];
      el.scrollIntoView({ block: 'center', inline: 'end' });
      const r = el.getBoundingClientRect();
      return { right: r.right, top: r.top, bottom: r.bottom };
    })()
  `);
  const dropX = lastContainerRect.right + 200;
  const dropY = (lastContainerRect.top + lastContainerRect.bottom) / 2;

  await dragAndDrop(`.page-slot[data-page-id="${lastPage}"]`, dropX, dropY);

  const docCountAfter = await evaluate(`__mod.store.documents.length`);
  assert.equal(docCountAfter, docCountBefore + 1, 'dropping past the edge should create a new document');
  const newDoc = await evaluate(`__mod.store.documents[__mod.store.documents.length - 1]`);
  assert.deepEqual(newDoc.pages.map((p) => p.id), [lastPage]);

  await closeAllDocuments();
});

test('dropping in the gap between two documents is a no-op — the page stays put', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const before = await evaluate(`__mod.store.documents.map((d) => d.pages.map((p) => p.id))`);
  const pageIds = await flatPageIds();
  const firstOfB = pageIds[4];

  // The gap is the vertical strip between the end of doc A's column and the
  // start of doc B's column in Canvas view — computed from both containers'
  // rects, not guessed, so it stays correct regardless of gap width.
  const gapX = await evaluate(`
    (() => {
      const containers = document.querySelectorAll('#canvas-view .document-container');
      const a = containers[0].getBoundingClientRect();
      const b = containers[1].getBoundingClientRect();
      return (a.right + b.left) / 2;
    })()
  `);
  const targetRect = await centerOfScrolledIntoView(`.page-slot[data-page-id="${firstOfB}"]`);

  await dragAndDrop(`.page-slot[data-page-id="${pageIds[0]}"]`, gapX, targetRect.y);

  const after = await evaluate(`__mod.store.documents.map((d) => d.pages.map((p) => p.id))`);
  assert.deepEqual(after, before, 'no document should have changed');

  await closeAllDocuments();
});

test('dragging a document\'s section header reorders it among its siblings', async () => {
  await openFixtures([DOC_A, DOC_B]);
  const docIdsBefore = await evaluate(`__mod.store.documents.map((d) => d.id)`);
  const [docAId, docBId] = docIdsBefore;
  assert.deepEqual(await documentIdsInDom(), [docAId, docBId]);

  // Drag doc B's header to before doc A's header — expected final order:
  // [docB, docA].
  const target = await centerOfScrolledIntoView(
    `.document-container[data-document-id="${docAId}"] .section-header`,
  );
  await dragAndDrop(`.document-container[data-document-id="${docBId}"] .section-header`, target.x, target.y);

  const docIdsAfter = await evaluate(`__mod.store.documents.map((d) => d.id)`);
  assert.deepEqual(docIdsAfter, [docBId, docAId]);
  assert.deepEqual(await documentIdsInDom(), [docBId, docAId], 'DOM order should match the model order');

  await closeAllDocuments();
});
