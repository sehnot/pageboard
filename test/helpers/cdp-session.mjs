// Shared harness for every CDP-driven test file: spawns a real Electron
// instance, attaches to it over the Chrome DevTools Protocol, and hands back
// a session object to drive it with.
//
// This used to be ~110 lines copy-pasted into all eight CDP test files. That
// duplication was not cosmetic: three separate infrastructure bugs (Windows
// `spawn EINVAL`, a `setTimeout` that kept the process alive after every CDP
// call, and a module-import race against page navigation) each had to be
// found once and then fixed eight times. Everything below is deliberately the
// single place those fixes live.
//
// The most important thing this module adds over the old copies is
// `waitFor()`. The previous files had no such helper at all, so every wait for
// an app state was a fixed `setTimeout` — a bet that "200ms is enough" which
// loses on a loaded CI runner. See its own comment below.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
// The `electron` package's main entry, when required/imported from a plain
// Node context (not Electron's own runtime), resolves to the absolute path of
// the platform binary itself — Electron.app/.../Electron on macOS,
// electron.exe on Windows, no .bin wrapper script or shell involved. Using
// this instead of node_modules/.bin/electron[.cmd] sidesteps a real
// Windows-only bug found via this project's own CI: spawning a .cmd file
// directly (without `shell: true`) fails with `spawn EINVAL`, since
// CreateProcess can't execute a batch script as if it were a binary.
import electronBinPath from 'electron';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
export const testFilesDir = path.join(projectRoot, 'pdf-files', 'test-files');

// One port per test file. `npm test` runs with --test-concurrency=1 so these
// can't actually collide today, but node:test's default is parallel-per-file
// and a future change back to that must not silently make two Electron
// instances fight over one port. Keeping the assignments in one table (rather
// than as a comment in each file) is also what makes it obvious at a glance
// that a new test file needs a new number.
export const CDP_PORTS = {
  errorHandling: 9422,
  e2eCriticalPath: 9423,
  focusMode: 9424,
  optionsDialog: 9425,
  sampleFilesCompatibility: 9426,
  settingsPersistence: 9428,
  interaction: 9429,
  dragAndDrop: 9430,
  cellSize: 9431,
  reconciliation: 9432,
  layoutAnimation: 9433,
  dragPreview: 9434,
};

// Every CDP-driven test runs against this exact viewport, on every OS.
//
// Without it, the usable viewport differs per platform: main.js creates the
// window with `width: 1200, height: 800`, but that's the OUTER size — the
// title bar eats into it (measured: 768px inner height on macOS), and
// Windows' classic scrollbars additionally reduce the usable width where
// macOS' overlay scrollbars don't. That variance is why a focus-mode
// assertion had to be weakened from "1.3x taller" to "1.15x taller" until it
// barely tested anything, and why a click at a computed coordinate could miss
// its target on Windows but never locally.
//
// Deliberately smaller than the window's own default so it fits inside
// whatever display a CI runner provides.
export const VIEWPORT = { width: 1000, height: 700 };

// These are hang detectors, not pacing. A passing test never waits for them,
// so they are set generously: their only job is to turn "this will never
// finish" into a readable error instead of a stuck job, and the workflow's own
// `timeout-minutes` is the final backstop either way.
//
// They used to be much tighter (15s per call, 10s per wait), which made them
// something else entirely — a bet on machine speed. Running the suite with
// twice as many busy processes as CPU cores pushed a single Runtime.evaluate
// past 15s and failed a test that was working perfectly well, which is exactly
// the "the runner had a bad day" result these changes exist to eliminate.
const CDP_CALL_TIMEOUT_MS = 60000;
const DEBUGGER_URL_TIMEOUT_MS = 30000;
const RENDERER_IMPORT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;
// Upper bound for a single "is anything still listening on this port?" probe
// against localhost. A live listener answers in well under a millisecond, so
// this only ever fires when a connection neither completes nor is refused —
// it exists so one wedged socket cannot hang the whole teardown.
const PORT_PROBE_TIMEOUT_MS = 1000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// `node_modules/.bin/electron` is itself a Node wrapper script that spawns the
// real Electron binary as a SEPARATE child process and only relays termination
// signals to it — a plain `child.kill()` on that wrapper doesn't reliably take
// the real Electron process (and its own Renderer/GPU/Utility helper
// processes) down with it, especially under SIGTERM's graceful-shutdown
// ambiguity. Left unfixed, those orphaned processes keep squatting on the CDP
// port, so a later run's `waitForDebuggerUrl()` can attach to a stale,
// already-exited Electron window instead of spawning a fresh one. Spawning
// with `detached: true` puts the whole tree in its own POSIX process group;
// killing the NEGATIVE pid sends the signal to every process in that group at
// once. Falls back to a plain kill where that's unavailable (e.g. Windows,
// where process groups work differently) or the process already exited.
function killElectron(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Deliberately a raw TCP connect rather than `fetch`, even though the same
// question could be asked over HTTP.
//
// This runs immediately after SIGKILLing Electron, so every attempt races a
// dying listener — exactly the window in which a connection can fail deep
// inside libuv rather than cleanly. `fetch` raises such a failure (observed
// on macOS CI: "setTypeOfService EINVAL") outside its own promise chain, as
// an uncaughtException that no `try`/`catch` around the `await` can see. It
// arrives after the hook has already resolved, so node:test attributes it to
// the whole test FILE and fails it even though every test in it passed.
//
// A socket we own has an explicit 'error' handler, so the same failure is
// just an event, and `destroy()` guarantees nothing is left half-open for
// the process exit to trip over. There is no connection pool involved either
// — `fetch` keeps sockets alive for reuse, which is precisely what outlives
// the hook here.
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
  });
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return; // the instance is really gone
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`CDP port ${port} was still in use ${timeoutMs}ms after killing Electron`);
}

async function waitForDebuggerUrl(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Server not ready yet — keep polling.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Electron window did not register for CDP on port ${port} within ${timeoutMs}ms`);
}

/**
 * Spawns Electron, attaches over CDP, and returns a session to drive it.
 *
 * @param {object} options
 * @param {string} options.name        short slug, used for the scratch dir name
 * @param {number} options.port        CDP port — take one from CDP_PORTS
 * @param {string} [options.locale]    forced UI language, or null to leave the OS default
 * @param {string} [options.userDataDir] reuse an existing profile dir (for restart tests)
 * @param {number} [options.callTimeoutMs] per-CDP-call budget; raise it for a
 *   test whose single evaluate() legitimately does a lot of work at once
 */
export async function startSession({
  name,
  port,
  locale = 'en',
  userDataDir = null,
  callTimeoutMs = CDP_CALL_TIMEOUT_MS,
}) {
  const env = { ...process.env };
  // Inherited from a VS Code integrated terminal, this makes the Electron
  // binary run as plain Node: no window, no CDP target, nothing to attach to.
  delete env.ELECTRON_RUN_AS_NODE;

  // A scratch --user-data-dir isolates this run's settings.json from the real
  // profile and from other test files' Electron instances. Callers that test
  // persistence across a restart pass the same dir back in for the second
  // launch, which is why this can be supplied rather than always created.
  const ownsUserDataDir = userDataDir === null;
  const resolvedUserDataDir = userDataDir
    ?? (await fs.mkdtemp(path.join(os.tmpdir(), `pageboard-${name}-userdata-`)));

  const electronProcess = spawn(
    electronBinPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${resolvedUserDataDir}`],
    // `detached: true` puts this whole process tree in its own process group —
    // see the comment on killElectron() above for why that matters.
    { cwd: projectRoot, env, stdio: 'ignore', detached: true },
  );

  const wsUrl = await waitForDebuggerUrl(port, DEBUGGER_URL_TIMEOUT_MS);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let msgId = 0;

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
      // Cleared above on a normal response — otherwise this timer keeps Node's
      // event loop alive until it fires, delaying process exit by up to its own
      // delay even though the promise already settled.
      const timer = setTimeout(
        () => reject(new Error(`CDP timeout on ${method}`)),
        callTimeoutMs,
      );
    });
  }

  async function evaluate(expression) {
    const msg = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (msg.result.exceptionDetails) {
      throw new Error(`Renderer exception: ${JSON.stringify(msg.result.exceptionDetails)}`);
    }
    return msg.result.result?.value;
  }

  /**
   * Polls `expression` in the renderer until it returns something truthy, and
   * returns that value.
   *
   * This is the core reason this harness exists. The alternative these tests
   * used before — `await sleep(300)` and hope — is a bet on how fast the
   * machine is, and it is exactly why CI failed ~40% of the time while the
   * app itself was fine. Waiting on the actual observable condition is both
   * faster (returns the instant it's true) and stable (a loaded runner just
   * takes a few more polls).
   *
   * An expression that throws counts as "not true yet", not as a failure:
   * conditions naturally reference elements that don't exist yet. The last
   * such error is kept and reported if the deadline passes, so a permanently
   * broken condition is still diagnosable.
   *
   * @param {string} expression  JS evaluated in the renderer; truthy = done
   * @param {object} [options]
   * @param {string} [options.message]  what was being waited for, for the error
   * @param {number} [options.timeoutMs]
   */
  async function waitFor(expression, { message, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    let lastValue;
    while (Date.now() < deadline) {
      try {
        lastValue = await evaluate(expression);
        if (lastValue) return lastValue;
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    const what = message ? `${message}\n  condition: ${expression}` : expression;
    const why = lastError
      ? `\n  last error: ${lastError.message}`
      : `\n  last value: ${JSON.stringify(lastValue)}`;
    throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}${why}`);
  }

  /**
   * Polls `expression` until it returns the same value twice in a row, then
   * returns it.
   *
   * For things that settle rather than flip: zooming re-rasters everything
   * behind a 200ms debounce (scheduleRebake() in renderer.js), so a size
   * measured immediately after a zoom gesture may still change once more.
   * Waiting for the value to stop moving expresses "once this has settled"
   * without hardcoding how long settling takes on this particular machine.
   */
  async function waitForStable(expression, { message, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let previous = Symbol('none');
    while (Date.now() < deadline) {
      const current = JSON.stringify(await evaluate(expression));
      if (current === previous) return JSON.parse(current);
      previous = current;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for a stable value: ${message ?? expression}`
      + `\n  last value: ${previous}`,
    );
  }

  /**
   * Waits until neither view has a re-raster pending or in flight.
   *
   * Zooming (including entering focus mode) re-rasterizes behind a 200ms
   * debounce and then swaps every visible page's canvas element out at once.
   * Anything measured or clicked while that is pending is timing-dependent:
   * a rect can still change, and — found the hard way — a second click landing
   * mid-swap is dropped by the browser entirely, because its target element no
   * longer matches the first click's, so no dblclick is ever synthesized.
   * Tests used to paper over this by sleeping 600ms after every zoom.
   */
  async function waitForIdle({ timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) {
    await waitFor('__mod.isViewIdleForTests()', {
      message: 'view never stopped re-rasterizing',
      timeoutMs,
    });
  }

  // The CDP target (and a successful Runtime.enable) can exist before
  // index.html has actually finished its own initial navigation — a relative
  // `import('./renderer.js')` attempted in that window fails with "Failed to
  // resolve module specifier" (observed on a real windows-latest CI run).
  // Retry instead of treating one early attempt as authoritative.
  async function importRendererModule() {
    const deadline = Date.now() + RENDERER_IMPORT_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await evaluate(`(async () => { globalThis.__mod = await import('./renderer.js'); return true; })()`);
        return;
      } catch (err) {
        lastError = err;
        await sleep(POLL_INTERVAL_MS);
      }
    }
    throw lastError;
  }

  // Forces the inner viewport to VIEWPORT on every platform — see the comment
  // there for why that matters.
  //
  // `Emulation.setDeviceMetricsOverride` sets the layout viewport directly.
  // `window.resizeTo()` is the obvious-looking alternative and does not work
  // here: it sets the OUTER window size, so the OS chrome still comes off the
  // top (measured on macOS: resizeTo(1000, 700) yields a 1000x668 viewport,
  // and the amount differs per platform — exactly the variance being
  // eliminated). `deviceScaleFactor: 0` means "leave the real one alone", so
  // pages still rasterize at the display's true pixel density; only the CSS
  // pixel dimensions are pinned.
  async function normalizeViewport() {
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await waitFor(
      `window.innerWidth === ${VIEWPORT.width} && window.innerHeight === ${VIEWPORT.height}`,
      {
        message: `viewport could not be normalized to ${VIEWPORT.width}x${VIEWPORT.height}`,
      },
    );
  }

  await send('Runtime.enable');
  await importRendererModule();
  await normalizeViewport();

  // Deterministic UI language regardless of the host OS's locale. This has to
  // go through the renderer's own switchLocale() rather than
  // window.api.saveSettings(), because the latter only updates main.js's
  // state — the already-running renderer keeps its old `t` binding.
  if (locale) {
    await evaluate(`__mod.switchLocale(${JSON.stringify(locale)}); true`);
  }

  /**
   * Opens PDFs and does not return until every page slot is actually
   * rasterized.
   *
   * Both halves matter. Normally the IntersectionObserver
   * (viewObserverFor() in renderer.js) triggers rasterization as slots near
   * the viewport — but Chromium silently pauses IntersectionObserver callbacks
   * for an unfocused or occluded window, which a test-spawned window
   * frequently is. Rasterization then never happens, no matter how long a test
   * waits, and measured page sizes stay at their placeholder dimensions
   * instead of the real rendered ones. Tests that then compare page geometry
   * are measuring something different depending on whether the window happened
   * to have focus — a plausible cause of the focus-mode geometry flakes, which
   * previously just slept 800ms here and hoped.
   *
   * Calling the exported renderPageIntoSlot() directly bypasses the observer
   * entirely, the same way scripts/generate-screenshots.mjs does.
   *
   * @param {string[]} filePaths absolute paths
   */
  async function openFiles(filePaths) {
    await evaluate(`
      (async () => {
        const fileInfos = await window.api.readPdfFiles(${JSON.stringify(filePaths)});
        await __mod.handleOpenedFiles(fileInfos);
        return true;
      })()
    `);
    await forceRenderAllSlots();
  }

  async function forceRenderAllSlots() {
    await evaluate(`
      Promise.all(
        [...document.querySelectorAll('.page-slot:not(.rendered)')]
          .map((slot) => __mod.renderPageIntoSlot(slot)),
      ).then(() => true)
    `);
    await waitFor(
      `document.querySelectorAll('.page-slot:not(.rendered)').length === 0`,
      { message: 'not every page slot ended up rasterized' },
    );
  }

  return {
    port,
    userDataDir: resolvedUserDataDir,
    send,
    evaluate,
    waitFor,
    waitForStable,
    waitForIdle,
    normalizeViewport,
    openFiles,
    forceRenderAllSlots,

    /**
     * Returns the app to a known-good starting point between tests. Without
     * this, tests in one file share whatever state the previous one left
     * behind: a failed assertion in focus mode once left focus mode active,
     * which made the two following tests fail too — one real bug reported as
     * three red tests.
     *
     * The actual work is in renderer.js's resetViewStateForTests(), which can
     * reach the module-private zoom/focus/selection state this needs to clear.
     */
    async reset() {
      await evaluate('__mod.resetViewStateForTests(); true');
      await waitFor('__mod.store.documents.length === 0', {
        message: 'store did not empty out during reset()',
      });
    },

    async close() {
      ws?.close();
      killElectron(electronProcess);
      // Wait until the port is genuinely free again rather than assuming the
      // kill took effect instantly. A test that relaunches against the same
      // port (settings-persistence does, to prove settings survive a restart)
      // would otherwise race: waitForDebuggerUrl() can still reach the dying
      // instance and attach to it instead of the new one, and the test then
      // silently asserts against the wrong process.
      await waitForPortFree(port, DEBUGGER_URL_TIMEOUT_MS);
      if (ownsUserDataDir) {
        await fs.rm(resolvedUserDataDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
