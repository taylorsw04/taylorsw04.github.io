// Touch/pointer regression checks for the mobile fixes to the "On this page" disclosure, the
// diagram pan/pinch-zoom gesture handling, and taps anywhere on the page unexpectedly triggering
// every mounted diagram's outside-click cleanup/re-render path -- including the case where a
// diagram genuinely has an open menu/selection, where a touch pointerdown must defer that real
// dismiss to the following click instead of redrawing synchronously before it. Run with `npm test`
// after `npm run build`.
//
// This intentionally does NOT use the `playwright` package (which downloads its own browsers);
// it drives the real Chromium binary already cached locally by a prior Playwright install via the
// lightweight `playwright-core` driver, found through CHROMIUM_EXECUTABLE_PATH or the standard
// `ms-playwright` cache. If no such browser is available (e.g. a fresh machine or CI, where this
// script is not part of the Pages build), checks are SKIPPED with a clear message rather than
// failing the whole suite or claiming coverage that didn't run.
//
// Known limitation: this validates the pointer-event pan/pinch math and event wiring under
// Chromium's touch/CDP emulation, and (for the previously crashing engine) that a full Chromium
// build runs headless here at all. It cannot reproduce WebKit/iOS Safari's own native-gesture
// quirks (the original bug reports were iOS Safari-specific), so it is not a substitute for
// on-device iPhone/iPad verification.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const distPath = path.join(root, 'dist');

function findChromiumExecutable() {
  if (process.env.CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.CHROMIUM_EXECUTABLE_PATH))
    return process.env.CHROMIUM_EXECUTABLE_PATH;
  const cacheDir = path.join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cacheDir)) return undefined;
  const candidates = readdirSync(cacheDir).filter(name => /^chromium-\d+$/.test(name)).sort().reverse();
  for (const name of candidates) {
    const macPath = path.join(cacheDir, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    const macX64Path = path.join(cacheDir, name, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    const linuxPath = path.join(cacheDir, name, 'chrome-linux/chrome');
    for (const candidate of [macPath, macX64Path, linuxPath])
      if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function withServer(rootDir, fn) {
  const contentTypes = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.txt': 'text/plain',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
  };
  const server = createServer(async (request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = path.join(rootDir, pathname);
    try {
      const data = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

let passed = 0, skipped = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok  - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const executablePath = findChromiumExecutable();
if (!executablePath) {
  console.log('SKIP - mobile touch/pointer checks: no cached Chromium found locally (set CHROMIUM_EXECUTABLE_PATH, ' +
    'or install one via `npx playwright install chromium`). These checks are not part of `npm run build` or CI.');
  process.exit(0);
}

let chromium, devices;
try {
  ({ chromium, devices } = await import('playwright-core'));
} catch {
  console.log('SKIP - mobile touch/pointer checks: the optional `playwright-core` dev dependency is not installed.');
  process.exit(0);
}

await withServer(distPath, async baseUrl => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const postUrl = `${baseUrl}/sublinear-set-operations-in-btrees/`;

    // --- 1. "On this page" disclosure: tappable in portrait, and a manual choice survives an
    // orientation/viewport change instead of being silently reset back to the width-based default. ---
    await check('TOC disclosure starts collapsed on a narrow (mobile-width) portrait viewport', async () => {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        assert.equal(await page.locator('.toc-disclosure').evaluate(el => el.open), false);
      } finally { await context.close(); }
    });
    await check('tapping "On this page" opens it, and it stays open after rotating to landscape and back to portrait', async () => {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        const disclosure = page.locator('.toc-disclosure');
        await page.locator('.toc-disclosure > summary').tap();
        assert.equal(await disclosure.evaluate(el => el.open), true, 'tap should open the disclosure');
        // iPhone 13 landscape width (844) crosses the 700px "desktop" breakpoint used for the
        // initial default; a correct fix must not let that crossing override the user's tap.
        await page.setViewportSize({ width: 844, height: 390 });
        await page.waitForTimeout(50);
        assert.equal(await disclosure.evaluate(el => el.open), true, 'rotating to landscape must not reset an explicit user choice');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(50);
        assert.equal(await disclosure.evaluate(el => el.open), true, 'rotating back to portrait must not reset an explicit user choice');
      } finally { await context.close(); }
    });
    await check('tapping "On this page" again re-collapses it (native toggle still works both ways)', async () => {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        const disclosure = page.locator('.toc-disclosure');
        const summary = page.locator('.toc-disclosure > summary');
        await summary.tap();
        assert.equal(await disclosure.evaluate(el => el.open), true);
        await summary.tap();
        assert.equal(await disclosure.evaluate(el => el.open), false);
      } finally { await context.close(); }
    });
    await check('"On this page" still defaults open on a desktop-width viewport', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        assert.equal(await page.locator('.toc-disclosure').evaluate(el => el.open), true);
      } finally { await context.close(); }
    });

    // --- 2. Touch pan/pinch-zoom on a frozen (read-only) diagram ---
    async function touchGestureContext() {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      const page = await context.newPage();
      await page.goto(postUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.lab-canvas');
      const canvas = page.locator('.lab-canvas').first();
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      const client = await context.newCDPSession(page);
      const dispatch = (type, points) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      const worldTransform = () => canvas.evaluate(el => el.closest('.lab-surface').querySelector('.lab-world').getAttribute('transform'));
      return { context, page, canvas, box, dispatch, worldTransform };
    }
    await check('computed touch-action is "none" on both the diagram canvas and its parent surface', async () => {
      const { context, page } = await touchGestureContext();
      try {
        const values = await page.evaluate(() => ({
          surface: getComputedStyle(document.querySelector('.lab-surface')).touchAction,
          canvas: getComputedStyle(document.querySelector('.lab-canvas')).touchAction
        }));
        assert.equal(values.surface, 'none');
        assert.equal(values.canvas, 'none');
      } finally { await context.close(); }
    });
    await check('one-finger touch drag pans a frozen diagram (world transform translates)', async () => {
      const { context, box, dispatch, worldTransform } = await touchGestureContext();
      try {
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        const before = await worldTransform();
        await dispatch('touchStart', [{ x: cx, y: cy }]);
        await dispatch('touchMove', [{ x: cx + 80, y: cy + 30 }]);
        await dispatch('touchEnd', [{ x: cx + 80, y: cy + 30 }]);
        const after = await worldTransform();
        assert.notEqual(after, before, 'expected the camera transform to change after a one-finger drag');
      } finally { await context.close(); }
    });
    await check('two-finger pinch zooms a frozen diagram (scale readout changes)', async () => {
      const { context, canvas, box, dispatch } = await touchGestureContext();
      try {
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        const before = await canvas.evaluate(el => el.closest('.lab-surface').querySelector('.lab-scale')?.value);
        await dispatch('touchStart', [{ x: cx - 20, y: cy }, { x: cx + 20, y: cy }]);
        await dispatch('touchMove', [{ x: cx - 70, y: cy }, { x: cx + 70, y: cy }]);
        await dispatch('touchEnd', [{ x: cx - 70, y: cy }, { x: cx + 70, y: cy }]);
        const after = await canvas.evaluate(el => el.closest('.lab-surface').querySelector('.lab-scale')?.value);
        assert.notEqual(after, before, 'expected the zoom percentage readout to change after a two-finger pinch');
      } finally { await context.close(); }
    });
    await check('a pointercancel mid-gesture does not break a subsequent fresh touch gesture', async () => {
      const { context, box, dispatch, worldTransform } = await touchGestureContext();
      try {
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        await dispatch('touchStart', [{ x: cx, y: cy }]);
        await dispatch('touchMove', [{ x: cx + 40, y: cy }]);
        // Simulate the browser cancelling the in-flight gesture (e.g. a system interruption),
        // without a matching touchEnd, then verify a brand-new drag still works afterward.
        await dispatch('touchCancel', []);
        const before = await worldTransform();
        await dispatch('touchStart', [{ x: cx, y: cy }]);
        await dispatch('touchMove', [{ x: cx + 60, y: cy + 20 }]);
        await dispatch('touchEnd', [{ x: cx + 60, y: cy + 20 }]);
        const after = await worldTransform();
        assert.notEqual(after, before, 'a fresh drag after a cancelled gesture should still pan the camera');
      } finally { await context.close(); }
    });

    // --- 3. Existing desktop mouse controls remain unaffected ---
    await check('desktop mouse drag still pans, and Ctrl/Cmd+wheel still zooms, a frozen diagram', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        await page.waitForSelector('.lab-canvas');
        const canvas = page.locator('.lab-canvas').first();
        await canvas.scrollIntoViewIfNeeded();
        const box = await canvas.boundingBox();
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        const worldTransform = () => canvas.evaluate(el => el.closest('.lab-surface').querySelector('.lab-world').getAttribute('transform'));
        const beforeDrag = await worldTransform();
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 70, cy + 25, { steps: 5 });
        await page.mouse.up();
        const afterDrag = await worldTransform();
        assert.notEqual(afterDrag, beforeDrag, 'expected mouse drag to still pan the camera');
        const readScale = () => page.locator('.lab-canvas').first()
          .evaluate(el => el.closest('.lab-surface').querySelector('.lab-scale')?.value);
        const beforeZoom = await readScale();
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -200);
        await page.keyboard.up('Control');
        const afterZoom = await readScale();
        assert.notEqual(afterZoom, beforeZoom, 'expected Ctrl+wheel to still zoom the camera');
      } finally { await context.close(); }
    });

    // --- 4. Taps on ordinary links elsewhere on the page must not trigger every mounted
    // diagram's "outside click" cleanup/re-render path, which previously ran unconditionally on
    // every single pointerdown anywhere on the page (even when nothing was open), making it a
    // plausible cause of iOS Safari cancelling tap-to-click activation for every link. ---
    await check('tapping an ordinary article link does not trigger DOM churn in mounted diagrams', async () => {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        // Scroll partway through the article so several diagrams are mounted, matching how a
        // reader would have reached an inline cross-reference link in practice.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.35));
        await page.waitForTimeout(300);
        const mounted = await page.evaluate(() => document.querySelectorAll('.tree-playground').length);
        assert.ok(mounted >= 2, `expected multiple mounted diagrams by this scroll position, got ${mounted}`);
        const mutationCount = await page.evaluate(async () => {
          const link = Array.from(document.querySelectorAll('a[href="#fast-reconstruction"]')).pop();
          let count = 0;
          const observer = new MutationObserver(records => { count += records.length; });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true });
          const rect = link.getBoundingClientRect();
          link.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
          }));
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));
          observer.disconnect();
          return count;
        });
        assert.equal(mutationCount, 0,
          `tapping an unrelated link should not mutate diagram DOM, but caused ${mutationCount} mutation record(s)`);
      } finally { await context.close(); }
    });

    // --- 5. The outside-tap cleanup must still actually run when a diagram genuinely has open
    // state to clear (tree menu / node selection), so the fix above is a targeted no-op skip, not
    // a removal of real dismiss-on-outside-click behavior. ---
    await check('tapping outside a diagram still clears a real open tree menu/selection', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        const canvas = page.locator('.lab-canvas').first();
        await canvas.scrollIntoViewIfNeeded();
        const node = canvas.locator('.lab-node.is-interactive').first();
        await node.click();
        const menuVisibleAfterClick = await canvas.evaluate(
          el => el.closest('.lab-surface').querySelector('.lab-tree-menu')?.hidden === false);
        assert.ok(menuVisibleAfterClick, 'clicking a node should open its tree menu (precondition for this check)');
        await page.locator('.article-byline').click();
        const menuHiddenAfterOutsideClick = await canvas.evaluate(
          el => el.closest('.lab-surface').querySelector('.lab-tree-menu')?.hidden === true);
        assert.ok(menuHiddenAfterOutsideClick, 'clicking outside the diagram should still dismiss an open tree menu');
      } finally { await context.close(); }
    });

    // --- 6/7. The scenario check 4 didn't cover: a touch tap outside a diagram that GENUINELY has
    // an open menu/selection (so there is real work for the outside-tap handler to do, unlike
    // check 4's no-op case). The touch pointerdown itself must still cause zero DOM churn (the only
    // way to guarantee Safari can't cancel the click for it); the dismiss must instead happen on
    // the subsequent native click, once it's already fired, without ever calling preventDefault --
    // so an ordinary link still navigates and the TOC <summary> still toggles. ---
    async function openATreeMenu(page) {
      const canvas = page.locator('.lab-canvas').first();
      await canvas.scrollIntoViewIfNeeded();
      await canvas.locator('.lab-node.is-interactive').first().click();
      const open = await canvas.evaluate(el => el.closest('.lab-surface').querySelector('.lab-tree-menu')?.hidden === false);
      assert.ok(open, 'clicking a node should open its tree menu (precondition for this check)');
      return canvas;
    }
    await check('a touch pointerdown outside a diagram with a real open menu causes no DOM churn, and the subsequent click dismisses it without blocking the link it landed on', async () => {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        const canvas = await openATreeMenu(page);
        const link = page.locator('a[href="#fast-reconstruction"]').last();
        await link.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);

        const mutationCount = await page.evaluate(async selector => {
          const target = document.querySelector(selector);
          let count = 0;
          const observer = new MutationObserver(records => { count += records.length; });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true });
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
          }));
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));
          observer.disconnect();
          return count;
        }, 'a[href="#fast-reconstruction"]:last-of-type');
        assert.equal(mutationCount, 0,
          `a touch pointerdown outside a diagram must not redraw it even with a real menu open, but caused ${mutationCount} mutation record(s)`);
        const stillOpenAfterPointerDown = await canvas.evaluate(
          el => el.closest('.lab-surface').querySelector('.lab-tree-menu')?.hidden === false);
        assert.ok(stillOpenAfterPointerDown, 'the touch pointerdown alone must not have dismissed the menu yet (that happens on click)');

        // The browser only ever dispatches 'click' itself after touchend; here we dispatch it
        // directly to stand in for that (real on-device touchstart/touchend synthesis isn't
        // reproducible in this headless harness -- see the file-level comment).
        const defaultPrevented = await page.evaluate(selector => {
          const target = document.querySelector(selector);
          const rect = target.getBoundingClientRect();
          const event = new MouseEvent('click', {
            bubbles: true, cancelable: true,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
          });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        }, 'a[href="#fast-reconstruction"]:last-of-type');
        assert.equal(defaultPrevented, false, 'the dismiss-on-click handling must never preventDefault() on the link');
        await page.waitForTimeout(50);
        assert.equal(page.url().split('#')[1], 'fast-reconstruction', 'the link must still have actually navigated to its hash target');
        const menuHiddenAfterClick = await canvas.evaluate(
          el => el.closest('.lab-surface').querySelector('.lab-tree-menu')?.hidden === true);
        assert.ok(menuHiddenAfterClick, 'the completed click should dismiss the menu that the earlier touch pointerdown deliberately left open');
      } finally { await context.close(); }
    });
    await check('the same touch-pointerdown-then-click sequence does not block the "On this page" summary from toggling', async () => {
      const context = await browser.newContext({ ...devices['iPhone 13'] });
      try {
        const page = await context.newPage();
        await page.goto(postUrl, { waitUntil: 'networkidle' });
        const canvas = await openATreeMenu(page);
        const summary = page.locator('.toc-disclosure > summary');
        await summary.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);

        const mutationCount = await page.evaluate(async () => {
          const target = document.querySelector('.toc-disclosure > summary');
          let count = 0;
          const observer = new MutationObserver(records => { count += records.length; });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true });
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
          }));
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));
          observer.disconnect();
          return count;
        });
        assert.equal(mutationCount, 0, `a touch pointerdown on the TOC summary must not redraw mounted diagrams, but caused ${mutationCount} mutation record(s)`);

        // A real tap toggles <summary> via the browser's native 'click'-driven default action; a
        // bare dispatched MouseEvent('click') does not reliably trigger that native <details>
        // behavior the way a trusted click does, so exercise the actual toggle via Playwright's tap
        // (which performs a real trusted touch gesture end-to-end) rather than another dispatchEvent.
        await summary.tap();
        assert.equal(await page.locator('.toc-disclosure').evaluate(el => el.open), true,
          'tapping the summary must still toggle the disclosure open');
        const menuHiddenAfterTap = await canvas.evaluate(
          el => el.closest('.lab-surface').querySelector('.lab-tree-menu')?.hidden === true);
        assert.ok(menuHiddenAfterTap, 'the completed tap/click on the summary should still dismiss the diagram menu left open earlier');
      } finally { await context.close(); }
    });
  } finally {
    await browser.close();
  }
});

console.log(`${passed} check(s) passed${skipped ? `, ${skipped} skipped` : ''}.`);
