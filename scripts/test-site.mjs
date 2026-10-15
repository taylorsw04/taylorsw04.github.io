// Focused checks for the built static site. Run with `npm test` after `npm run build`.
// Deliberately avoids browser automation here (see scripts/test-mobile-interactions.mjs for the
// separate, optional touch/pointer interaction checks) in favor of Node-native checks: static
// analysis of the build output plus running the real, unmodified vendored BTree TypeScript
// directly in Node to exercise actual union/decompose behavior bundled into the site.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { build } from 'esbuild';
import { interfaceDeclarationsPlugin } from './docs-plugins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const distPath = path.join(root, 'dist');

let passed = 0;
const range = (start, end, step = 1) => {
  const out = [];
  for (let i = start; i <= end; i += step) out.push(i);
  return out;
};
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

function elements(node) {
  return [...(node.tagName ? [node] : []), ...(node.childNodes || []).flatMap(elements)];
}
function attr(node, name) {
  return node.attrs?.find(a => a.name === name)?.value;
}
function text(node) {
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
}
async function parseHtml(filePath) {
  return parseFragment(await readFile(filePath, 'utf8'), { sourceCodeLocationInfo: true });
}

async function fileExists(filePath) {
  return readFile(filePath).then(() => true, () => false);
}

async function httpGet(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

async function withServer(rootDir, fn) {
  const contentTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.txt': 'text/plain' };
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

// --- 1. dist/ output routes exist and are complete static files ---
await check('dist/index.html (landing route) exists', async () => {
  assert.ok(await fileExists(path.join(distPath, 'index.html')));
});
await check('dist/sublinear-set-operations-in-btrees/index.html (post route) exists', async () => {
  assert.ok(await fileExists(path.join(distPath, 'sublinear-set-operations-in-btrees/index.html')));
});
await check('post route has its own self-contained assets directory', async () => {
  const entries = await readdir(path.join(distPath, 'sublinear-set-operations-in-btrees/assets'));
  assert.ok(entries.some(name => /^article-.*\.js$/.test(name)), 'expected a hashed article JS bundle');
  assert.ok(entries.some(name => /^article-.*\.css$/.test(name)), 'expected a hashed article CSS bundle');
});
await check('post route has chunked (code-split) assets for lazily-loaded diagrams', async () => {
  const chunks = await readdir(path.join(distPath, 'sublinear-set-operations-in-btrees/assets/chunks'));
  assert.ok(chunks.length > 0, 'expected at least one chunk (e.g. the mermaid renderer)');
});

// --- 2. Legal notices preserved in the distributed artifact ---
await check('post route carries library LICENSE.txt and THIRD-PARTY-NOTICES.txt', async () => {
  const license = await readFile(path.join(distPath, 'sublinear-set-operations-in-btrees/LICENSE.txt'), 'utf8');
  assert.match(license, /MIT License/);
  const notices = await readFile(path.join(distPath, 'sublinear-set-operations-in-btrees/THIRD-PARTY-NOTICES.txt'), 'utf8');
  assert.match(notices, /mermaid/);
  assert.match(notices, /d3-hierarchy/);
});

// --- 2b. Published avatar photo: real <img> (not the monogram fallback), with
// explicit width/height to avoid layout shift, meaningful alt text, and no
// leftover EXIF/GPS metadata in the published copy ---
await check('landing page uses the real avatar photo with dimensions, alt text, and stripped metadata', async () => {
  const site = JSON.parse(await readFile(path.join(root, 'content/site.json'), 'utf8'));
  assert.ok(site.avatar, 'content/site.json must configure an avatar for this check to be meaningful');
  const html = await readFile(path.join(distPath, 'index.html'), 'utf8');
  const imgMatch = /<img class="avatar-image"([^>]*)>/.exec(html);
  assert.ok(imgMatch, 'expected a real avatar <img>, not the monogram fallback, since public/avatar.jpg is present');
  const attrs = imgMatch[1];
  assert.match(attrs, /\balt="[^"]+"/);
  assert.doesNotMatch(attrs, /alt=""/, 'alt text must not be empty');
  assert.match(attrs, /\bwidth="\d+"/);
  assert.match(attrs, /\bheight="\d+"/);
  assert.match(attrs, /aspect-ratio:\s*\d+\s*\/\s*\d+/);
  const srcMatch = /src="\.\/(assets\/avatar-[^"]+\.jpg)"/.exec(attrs);
  assert.ok(srcMatch, 'avatar src should be a hashed local asset path');
  const publishedBuffer = await readFile(path.join(distPath, srcMatch[1]));
  assert.ok(publishedBuffer.length < 500 * 1024, 'published avatar should be a reasonably sized, optimized web asset');
  // A bare EXIF APP1 marker (0xFFE1) right after the SOI would mean metadata
  // (and potentially GPS) survived into the published copy; the source image
  // is known to carry GPS EXIF, so this guards against republishing it.
  assert.equal(publishedBuffer[0], 0xff);
  assert.equal(publishedBuffer[1], 0xd8);
  assert.ok(!(publishedBuffer[2] === 0xff && publishedBuffer[3] === 0xe1), 'published avatar must not carry an EXIF APP1 segment (metadata/GPS should be stripped)');
});

// --- 2c. Static post cover image: published byte-for-byte as supplied (no
// crop/re-encode), with real dimensions/alt text, inside the clickable card ---
await check('landing page post card renders the static cover image unmodified, at its natural aspect ratio', async () => {
  const posts = JSON.parse(await readFile(path.join(root, 'content/posts.json'), 'utf8'));
  const post = posts.find(p => p.slug === 'sublinear-set-operations-in-btrees');
  assert.ok(post?.cover, 'expected a cover configured for the sublinear-set-operations-in-btrees post');
  const sourceBuffer = await readFile(path.join(root, post.cover));
  const html = await readFile(path.join(distPath, 'index.html'), 'utf8');
  const imgMatch = /<img class="post-cover"([^>]*)>/.exec(html);
  assert.ok(imgMatch, 'expected a post-cover <img> in the landing page post list');
  const attrs = imgMatch[1];
  assert.match(attrs, /\balt="[^"]+"/);
  assert.doesNotMatch(attrs, /alt=""/, 'alt text must not be empty');
  assert.match(attrs, /\bwidth="\d+"/);
  assert.match(attrs, /\bheight="\d+"/);
  assert.match(attrs, /aspect-ratio:\s*\d+\s*\/\s*\d+/);
  const srcMatch = /src="\.\/(assets\/[^"]+\.png)"/.exec(attrs);
  assert.ok(srcMatch, 'cover src should be a hashed local PNG asset path');
  const publishedBuffer = await readFile(path.join(distPath, srcMatch[1]));
  // The user asked for the supplied screenshot to be published as-is, with no
  // crop, redraw, or re-encode: the published bytes must match the source
  // configured in content/posts.json exactly.
  assert.ok(sourceBuffer.equals(publishedBuffer), 'published cover must be byte-for-byte identical to the configured source image (no cropping/re-encoding)');
});

// --- 2d. Landing page heading/bio wording and post-card layout: "Latest"
// heading, bio renders its one Markdown link as a real anchor with exact
// surrounding text, no visible summary on the card, and the cover appears
// below (not above) the title/date in document order ---
await check('landing page heading reads "Latest"', async () => {
  const landing = await parseHtml(path.join(distPath, 'index.html'));
  const h2 = elements(landing).find(n => n.tagName === 'h2');
  assert.ok(h2, 'expected an <h2> section heading');
  assert.equal(text(h2).trim(), 'Latest');
});

await check('bio renders the Optimization Theory of Everything link as a real anchor with exact text', async () => {
  const html = await readFile(path.join(distPath, 'index.html'), 'utf8');
  assert.match(html, /I&#39;m an engineer building distributed trees @ Fluid Framework\. Lately, I&#39;ve been exploring fractals, learning about mechanistic interpretability, and playing pickleball\. I&#39;m a devout believer in the <a href="https:\/\/12gramsofcarbon\.com\/p\/the-optimization-theory-of-everything">Optimization Theory of Everything<\/a>\./);
  assert.doesNotMatch(html, /@ Microsoft/, 'bio must not retain the old "@ Microsoft" wording');
  const landing = await parseHtml(path.join(distPath, 'index.html'));
  const bioLink = elements(landing).find(n => n.tagName === 'a' && text(n) === "Optimization Theory of Everything");
  assert.ok(bioLink, 'expected a real <a> anchor for the bio link, not literal Markdown brackets');
  assert.equal(attr(bioLink, 'href'), 'https://12gramsofcarbon.com/p/the-optimization-theory-of-everything');
});

await check('post card has no visible summary, and shows title/date before the cover image', async () => {
  const landing = await parseHtml(path.join(distPath, 'index.html'));
  const postItem = elements(landing).find(n => n.tagName === 'li' && (attr(n, 'class') || '').includes('post-item'));
  assert.ok(postItem, 'expected a post-item in the landing page');
  assert.ok(!elements(postItem).some(n => (attr(n, 'class') || '').includes('post-summary')), 'post card must not render a visible summary');
  const link = elements(postItem).find(n => n.tagName === 'a' && (attr(n, 'class') || '').includes('post-link'));
  const children = (link.childNodes || []).filter(n => n.tagName);
  const titleIndex = children.findIndex(n => (attr(n, 'class') || '').includes('post-title'));
  const dateIndex = children.findIndex(n => n.tagName === 'time');
  const coverIndex = children.findIndex(n => (attr(n, 'class') || '').includes('post-cover'));
  assert.ok(titleIndex >= 0 && dateIndex >= 0 && coverIndex >= 0, 'expected title, date, and cover elements in the post card');
  assert.ok(titleIndex < coverIndex && dateIndex < coverIndex, 'title and date must appear before the cover image in document order');
});

// --- 3. Landing page lists posts in reverse-chronological order ---
await check('landing page lists posts reverse-chronologically', async () => {
  const posts = JSON.parse(await readFile(path.join(root, 'content/posts.json'), 'utf8'));
  const expectedOrder = [...posts].sort((a, b) => b.date.localeCompare(a.date)).map(p => p.slug);
  const landing = await parseHtml(path.join(distPath, 'index.html'));
  const links = elements(landing).filter(n => n.tagName === 'a' && (attr(n, 'class') || '').includes('post-link'));
  const actualOrder = links.map(link => attr(link, 'href').replace(/^\.\//, '').replace(/\/$/, ''));
  assert.deepEqual(actualOrder, expectedOrder);
});

// --- 4. Internal anchors and local asset references resolve ---
async function collectIds(doc) {
  return new Set(elements(doc).map(n => attr(n, 'id')).filter(Boolean));
}
async function checkInternalLinks(htmlPath, baseDir) {
  const doc = await parseHtml(htmlPath);
  const ids = await collectIds(doc);
  const anchors = elements(doc).filter(n => n.tagName === 'a').map(n => attr(n, 'href')).filter(Boolean);
  for (const href of anchors) {
    if (href.startsWith('#')) {
      const target = href.slice(1);
      assert.ok(ids.has(target), `Dangling internal anchor ${href} in ${htmlPath}`);
    }
  }
  const assetRefs = elements(doc)
    .filter(n => ['link', 'script', 'img'].includes(n.tagName))
    .map(n => attr(n, 'href') || attr(n, 'src'))
    .filter(src => src && !/^(?:https?:|data:)/.test(src));
  for (const src of assetRefs) {
    const resolved = path.join(baseDir, src);
    assert.ok(await fileExists(resolved), `Missing local asset ${src} referenced from ${htmlPath}`);
  }
}
await check('post page has no dangling #anchors (including the fixed reconstruction link) and local assets resolve', async () => {
  await checkInternalLinks(path.join(distPath, 'sublinear-set-operations-in-btrees/index.html'), path.join(distPath, 'sublinear-set-operations-in-btrees'));
  const html = await readFile(path.join(distPath, 'sublinear-set-operations-in-btrees/index.html'), 'utf8');
  assert.match(html, /href="#fast-reconstruction"/);
  assert.doesNotMatch(html, /making-it-fast-reconstruction-fast-reconstruction/);
});
await check('landing page has no dangling #anchors and local assets resolve', async () => {
  await checkInternalLinks(path.join(distPath, 'index.html'), distPath);
});

// --- 5. Article preserves the required embeds, byline, and has no site chrome ---
await check('article preserves all 10 expected interactive embeds in document order', async () => {
  const html = await readFile(path.join(distPath, 'sublinear-set-operations-in-btrees/index.html'), 'utf8');
  const expected = ['recap-tree', 'sharing-tree', 'tree-small-overlap', 'tree-large-overlap',
    'tree-alternating-overlap', 'tree-step-timeline', 'tree-slice', 'tree-reconstruction-min',
    'tree-reconstruction-max', 'tree-playground'];
  const found = [...html.matchAll(/data-btree-example="[a-z-]+"[^>]*>|id="([a-z-]+)" data-btree-example/g)];
  const ids = [...html.matchAll(/<div id="([a-z-]+)" data-btree-example="[a-z-]+">/g)].map(m => m[1]);
  assert.deepEqual(ids, expected);
});
await check('article byline reads "Taylor Williams · 09/2026"', async () => {
  const html = await readFile(path.join(distPath, 'sublinear-set-operations-in-btrees/index.html'), 'utf8');
  assert.match(html, /Taylor Williams · <time datetime="2026-09">09\/2026<\/time>/);
});
await check('article page has no site navigation bar or footer (deliberately no site chrome)', async () => {
  const doc = await parseHtml(path.join(distPath, 'sublinear-set-operations-in-btrees/index.html'));
  const all = elements(doc);
  assert.equal(all.filter(n => n.tagName === 'nav' && (attr(n, 'aria-label') || '') !== 'Sections').length, 0);
  assert.equal(all.filter(n => n.tagName === 'footer').length, 0);
  assert.equal(all.filter(n => (attr(n, 'class') || '').includes('site-')).length, 0);
});

// --- 6. No local-machine (/Users/...) paths leaked into the published artifact ---
await check('no local filesystem paths leaked into dist/', async () => {
  const files = [
    'index.html',
    'sublinear-set-operations-in-btrees/index.html',
  ];
  for (const file of files) {
    const content = await readFile(path.join(distPath, file), 'utf8');
    assert.doesNotMatch(content, /\/Users\//);
    assert.doesNotMatch(content, /btree-staging/);
  }
});

// --- 7. Base path independence: the exact same artifact works at the root (this is a
// user Pages site, taylorsw04.github.io, so root is primary) and, as a robustness
// check, nested under an arbitrary sub-path too ---
await check('built site works identically served from root and from an arbitrary nested path (relative links, no absolute base path needed)', async () => {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'site-basepath-'));
  try {
    const nestedParent = path.join(stagingRoot, 'nested');
    await cp(distPath, path.join(stagingRoot, 'root-copy'), { recursive: true });
    await cp(distPath, path.join(nestedParent, 'nested-subpath'), { recursive: true });
    await withServer(path.join(stagingRoot, 'root-copy'), async base => {
      const landing = await httpGet(`${base}/`);
      assert.equal(landing.status, 200);
      const post = await httpGet(`${base}/sublinear-set-operations-in-btrees/`);
      assert.equal(post.status, 200);
      const scriptMatch = /src="(\.\/assets\/article-[^"]+\.js)"/.exec(post.body);
      assert.ok(scriptMatch);
      const asset = await httpGet(`${base}/sublinear-set-operations-in-btrees/${scriptMatch[1]}`);
      assert.equal(asset.status, 200);
    });
    await withServer(nestedParent, async base => {
      const landing = await httpGet(`${base}/nested-subpath/`);
      assert.equal(landing.status, 200);
      const post = await httpGet(`${base}/nested-subpath/sublinear-set-operations-in-btrees/`);
      assert.equal(post.status, 200);
      const scriptMatch = /src="(\.\/assets\/article-[^"]+\.js)"/.exec(post.body);
      assert.ok(scriptMatch);
      const asset = await httpGet(`${base}/nested-subpath/sublinear-set-operations-in-btrees/${scriptMatch[1]}`);
      assert.equal(asset.status, 200);
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

// --- 8. Real bundled tree behavior: exercise the exact vendored TypeScript sources in Node ---
await check('real vendored BTree union/decompose produce correct results (exact TS bundled into the site)', async () => {
  const entryFile = path.join(root, `.test-harness-${process.pid}.mjs`);
  const outFile = path.join(root, `.test-harness-${process.pid}.out.mjs`);
  await writeFile(entryFile, `
    import BTree from '${path.join(root, 'b+tree.ts').replace(/\\/g, '/')}';
    import union from '${path.join(root, 'extended/union.ts').replace(/\\/g, '/')}';
    import { decompose } from '${path.join(root, 'extended/decompose.ts').replace(/\\/g, '/')}';

    function tree(keys) {
      const t = new BTree();
      for (const k of keys) t.set(k, k);
      return t;
    }
    const range = (start, end, step = 1) => {
      const out = [];
      for (let i = start; i <= end; i += step) out.push(i);
      return out;
    };
    globalThis.__results = {};

    // small-overlap preset style: disjoint-ish ranges with a small overlap
    {
      const a = tree(range(0, 20));
      const b = tree(range(15, 35));
      const u = union(a, b, (k, l, r) => l);
      globalThis.__results.smallOverlap = [...u.keys()];
    }
    // step-timeline preset: A 0..50 step 2 + 88, B 22 step2 46..100
    {
      const a = tree([...range(0, 50, 2), 88]);
      const b = tree(range(22, 100, 2).filter(k => k >= 46));
      const u = union(a, b, (k, l, r) => l);
      globalThis.__results.stepTimeline = [...u.keys()];
    }
    // decompose should report disjoint, height-ordered subtree fragments for a real union
    {
      const a = tree(range(0, 40));
      const b = tree(range(20, 60));
      const _a = a, _b = b;
      const result = decompose(_a, _b, (k, l, r) => l);
      globalThis.__results.decomposeNodeCount = result.nodes.length;
      globalThis.__results.decomposeHeightCount = result.heights.length;
    }
  `, 'utf8');
  try {
    await build({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: outFile,
      logLevel: 'warning',
      plugins: [interfaceDeclarationsPlugin()],
    });
    await import(`${outFile}?t=${Date.now()}`);
    const results = globalThis.__results;
    const expectedSmallOverlap = [...new Set([...range(0, 20), ...range(15, 35)])].sort((a, b) => a - b);
    const expectedStepTimeline = [...new Set([...range(0, 50, 2), 88, ...range(22, 100, 2).filter(k => k >= 46)])].sort((a, b) => a - b);
    assert.deepEqual(results.smallOverlap, expectedSmallOverlap);
    assert.deepEqual(results.stepTimeline, expectedStepTimeline);
    assert.ok(results.decomposeNodeCount > 0);
    assert.equal(results.decomposeHeightCount, results.decomposeNodeCount);
  } finally {
    await rm(entryFile, { force: true });
    await rm(outFile, { force: true });
    delete globalThis.__results;
  }
});

// --- 9. Markdown embed directives match the registered presets (future-post safety net) ---
await check('every :::btree directive in the post markdown maps to a known, documented preset', async () => {
  const presets = JSON.parse(await readFile(path.join(root, 'docs/web/presets.json'), 'utf8'));
  const markdown = await readFile(path.join(root, 'content/posts/sublinear-set-operations-in-btrees.md'), 'utf8');
  const directives = [...markdown.matchAll(/^ {0,3}:::btree[ \t]+([a-z][a-z0-9-]*)/gm)].map(m => m[1]);
  assert.equal(directives.length, 10);
  for (const name of directives) assert.ok(Object.hasOwn(presets, name), `Unknown preset referenced: ${name}`);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('Some checks FAILED.');
}
