// Builds the full static site into dist/:
//   dist/index.html                                  — landing page (intro + post list)
//   dist/assets/...                                   — landing page CSS and optional avatar
//   dist/<post-slug>/index.html                       — each post's complete article page
//   dist/<post-slug>/assets/...                        — each post's bundled JS/CSS/chunks
//   dist/<post-slug>/LICENSE.txt, THIRD-PARTY-NOTICES.txt — library + bundled dependency notices
//
// Adding a future post is a matter of dropping a new Markdown file in content/posts/
// and adding one entry to content/posts.json; see README.md for details.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseFragment } from 'parse5';
import { cursorRecordingPlugin, interfaceDeclarationsPlugin } from './docs-plugins.mjs';
import { renderMarkdown } from './render-markdown.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const finalOutputPath = path.join(root, 'dist');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/**
 * Renders plain site-metadata text (e.g. the bio) to safe inline HTML,
 * supporting only a single Markdown-style `[label](https://url)` link
 * syntax — not a general Markdown/raw-HTML pass, which isn't needed here and
 * would widen what site.json can inject into the page. Everything else is
 * HTML-escaped as plain text; only `http(s)://` URLs are allowed as link
 * targets.
 */
function renderInlineLinks(value) {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = linkPattern.exec(value))) {
    result += escapeHtml(value.slice(lastIndex, match.index));
    const [, label, url] = match;
    result += `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(value.slice(lastIndex));
  return result;
}

/** Strips the `[label](url)` syntax down to just its label, for plain-text contexts like <meta name="description">. */
function stripInlineLinks(value) {
  return value.replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1');
}

function textContent(node) {
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes || []).map(textContent).join('');
}

function attribute(node, name) {
  return node.attrs?.find(attr => attr.name === name)?.value;
}

function elements(node) {
  return [
    ...(node.tagName ? [node] : []),
    ...(node.childNodes || []).flatMap(elements),
  ];
}

async function licenseNotices(postOutputPath, inputs) {
  const directories = new Set();
  for (const input of Object.keys(inputs)) {
    const matches = [...input.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g)];
    const match = matches.at(-1);
    if (match) directories.add(input.slice(0, match.index + match[0].length));
  }
  const sections = [];
  for (const directory of [...directories].sort()) {
    const packageRoot = path.join(root, directory);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const entries = await readdir(packageRoot, { withFileTypes: true });
    const files = entries
      .filter(file => file.isFile() && /^(?:licen[sc]e|copying)(?:[._-].*)?$/i.test(file.name));
    const texts = [];
    for (const file of files)
      texts.push(`${file.name}\n\n${await readFile(path.join(packageRoot, file.name), 'utf8')}`);
    if (!texts.length) {
      const readme = entries.find(file => file.isFile() && /^readme(?:\..*)?$/i.test(file.name));
      if (readme) {
        const text = await readFile(path.join(packageRoot, readme.name), 'utf8');
        const heading = /^#+\s+licen[sc]e\b.*$/im.exec(text);
        if (heading) texts.push(`${readme.name}\n\n${text.slice(heading.index)}`);
      }
    }
    assert.ok(texts.length, `No license notice found for bundled package ${metadata.name}.`);
    sections.push(`${metadata.name} ${metadata.version}\n${'='.repeat(72)}\n${texts.join('\n\n')}`);
  }
  return `${sections.join('\n\n\n')}\n`;
}

/** Build one interactive-article post (Markdown + embeds) into <outputPath>/<slug>/. */
async function buildPost(outputPath, post) {
  const postOutputPath = path.join(outputPath, post.slug);
  const [markdown, template] = await Promise.all([
    readFile(path.join(root, post.markdown), 'utf8'),
    readFile(path.join(root, post.template), 'utf8'),
  ]);
  const projection = renderMarkdown(markdown);
  const source = projection.html;
  const parseErrors = [];
  const fragment = parseFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError: error => parseErrors.push(error),
  });
  assert.deepEqual(parseErrors, [], `The "${post.slug}" article source must be valid HTML.`);
  const nodes = elements(fragment);
  const ids = nodes.map(node => attribute(node, 'id')).filter(id => id !== undefined);
  assert.equal(ids.length, new Set(ids).size, 'Article IDs must be unique.');
  for (const reserved of ['article-start', 'article', 'contents'])
    assert.ok(!ids.includes(reserved), `${reserved} is reserved for the page template.`);
  const headings = nodes.filter(node => /^h[1-6]$/.test(node.tagName));
  const titles = headings.filter(node => node.tagName === 'h1');
  assert.equal(titles.length, 1, 'The article must have exactly one title.');
  for (const heading of headings)
    assert.ok(attribute(heading, 'id'), 'Every article heading needs an explicit anchor ID.');
  const hasClass = (node, name) => (attribute(node, 'class') || '').split(/\s+/).includes(name);
  const figures = nodes.filter(node => node.tagName === 'figure' && hasClass(node, 'diagram'));
  const diagramSources = nodes.filter(node => node.tagName === 'pre' && hasClass(node, 'mermaid'));
  assert.equal(diagramSources.length, figures.length, 'Each diagram needs its Mermaid source.');
  figures.forEach((figure, index) => {
    assert.equal(attribute(figure, 'data-diagram'), String(index + 1), 'Diagram numbers must follow document order.');
    const children = elements(figure);
    for (const name of ['diagram-output', 'diagram-source', 'diagram-status', 'mermaid'])
      assert.equal(children.filter(node => hasClass(node, name)).length, 1, `Diagram ${index + 1} needs one ${name}.`);
  });
  assert.deepEqual(diagramSources.map(textContent), projection.diagrams, 'Markdown diagrams must be preserved verbatim.');
  assert.deepEqual(headings.map(node => attribute(node, 'id')), projection.headings.map(heading => heading.id));
  const titleLocation = titles[0].sourceCodeLocation;
  assert.ok(titleLocation?.endTag, 'The article title needs an explicit closing </h1> tag.');
  const articleTitle = source.slice(titleLocation.startOffset, titleLocation.endOffset);
  const article = source.slice(0, titleLocation.startOffset) + source.slice(titleLocation.endOffset);
  const navigation = projection.headings.filter(heading => heading.depth > 1);
  const toc = navigation.map(heading =>
    `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.label)}</a></li>`).join('\n');
  const diagrams = figures.length;

  const bundle = await build({
    absWorkingDir: root,
    entryPoints: { article: post.entry },
    outdir: path.relative(root, path.join(postOutputPath, 'assets')),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    resolveExtensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'],
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: '[name]-[hash]',
    minify: true,
    legalComments: 'linked',
    metafile: true,
    write: false,
    logLevel: 'warning',
    plugins: [{
      name: 'keep-documentation-styles',
      setup(bundler) {
        // The library package is sideEffects:false; these CSS imports are intentional effects.
        bundler.onResolve({ filter: /^\.\/(?:article|playground)\.css$/ }, args => ({
          path: path.resolve(args.resolveDir, args.path),
          sideEffects: true,
        }));
      },
    }, interfaceDeclarationsPlugin(), cursorRecordingPlugin()],
  });
  assert.ok(Object.hasOwn(bundle.metafile.inputs, 'b+tree.ts'),
    'The playground must bundle the current BTree TypeScript source.');
  assert.ok(!Object.hasOwn(bundle.metafile.inputs, 'b+tree.js'),
    'The playground must not bundle the stale committed BTree JavaScript.');
  assert.ok(Object.hasOwn(bundle.metafile.inputs, 'docs/web/recording-walk.ts'),
    'The documentation cursor adapter must be bundled.');
  const libraryLicense = await readFile(path.join(root, 'LICENSE-btree-typescript'), 'utf8');
  const dependencyLicenses = await licenseNotices(postOutputPath, bundle.metafile.inputs);
  const entry = Object.entries(bundle.metafile.outputs).find(([name, metadata]) =>
    name.endsWith('.js') && metadata.entryPoint === post.entry);
  assert.ok(entry?.[1].cssBundle, 'The article must include its local JavaScript and CSS bundles.');
  const assetUrl = name => `./${path.relative(postOutputPath, path.resolve(root, name)).split(path.sep).join('/')}`;
  const replacements = {
    TITLE: escapeHtml(textContent(titles[0])),
    ARTICLE_TITLE: articleTitle,
    ARTICLE: article,
    TOC: toc,
    SCRIPT: escapeHtml(assetUrl(entry[0])),
    STYLESHEET: escapeHtml(assetUrl(entry[1].cssBundle)),
  };
  for (const key of Object.keys(replacements)) {
    assert.ok(template.includes(`{{${key}}}`), `Missing template placeholder: ${key}`);
  }
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(replacements, key), `Unknown template placeholder: ${key}`);
    return replacements[key];
  });

  for (const file of bundle.outputFiles) {
    assert.ok(file.path.startsWith(`${postOutputPath}${path.sep}`), `Bundle output for "${post.slug}" escaped its output directory.`);
  }
  await mkdir(postOutputPath, { recursive: true });
  for (const file of bundle.outputFiles) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }
  await writeFile(path.join(postOutputPath, 'LICENSE.txt'), libraryLicense);
  await writeFile(path.join(postOutputPath, 'THIRD-PARTY-NOTICES.txt'), dependencyLicenses);
  await writeFile(path.join(postOutputPath, 'index.html'), html);
  console.log(`Published ${path.relative(root, postOutputPath)}/index.html: ${headings.length} source headings, ${diagrams} Mermaid diagrams, and the interactive playground.`);
  return { ...post, title: textContent(titles[0]) };
}

async function hashedAssetName(name, contents) {
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const extension = path.extname(name);
  return `${path.basename(name, extension)}-${hash}${extension}`;
}

/**
 * Reads pixel dimensions straight out of a JPEG's SOF marker, with no image
 * library dependency. Used only to emit explicit width/height (and an
 * aspect-ratio) on published <img>s, so the browser can reserve their layout
 * space before the file loads (avoiding layout shift).
 */
function jpegDimensions(buffer) {
  assert.equal(buffer[0], 0xff, 'Not a JPEG (missing SOI marker)');
  assert.equal(buffer[1], 0xd8, 'Not a JPEG (missing SOI marker)');
  let offset = 2;
  while (offset < buffer.length) {
    assert.equal(buffer[offset], 0xff, 'Malformed JPEG marker');
    const marker = buffer[offset + 1];
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  throw new Error('Could not find a JPEG SOF marker to read dimensions');
}

/** Reads pixel dimensions out of a PNG's IHDR chunk (always the first chunk). */
function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buffer.subarray(0, 8).equals(signature), 'Not a PNG (bad signature)');
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', 'Expected IHDR as the first PNG chunk');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/** Dispatches to the right dimension reader based on file extension. */
function imageDimensions(buffer, extension) {
  if (extension === '.jpg' || extension === '.jpeg') return jpegDimensions(buffer);
  if (extension === '.png') return pngDimensions(buffer);
  throw new Error(`Unsupported image extension for dimension reading: ${extension}`);
}

/** Build the landing page: intro + reverse-chronological post list. */
async function buildLanding(outputPath, posts) {
  const [site, template, css] = await Promise.all([
    readFile(path.join(root, 'content/site.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'site/landing/template.html'), 'utf8'),
    readFile(path.join(root, 'site/landing/landing.css'), 'utf8'),
  ]);
  const cssName = await hashedAssetName('landing.css', css);
  await mkdir(path.join(outputPath, 'assets'), { recursive: true });
  await writeFile(path.join(outputPath, 'assets', cssName), css);

  let avatarHtml;
  const avatarPath = site.avatar ? path.join(root, site.avatar) : undefined;
  const avatarBuffer = avatarPath ? await readFile(avatarPath).catch(() => undefined) : undefined;
  if (avatarBuffer) {
    const avatarName = await hashedAssetName(path.basename(site.avatar), avatarBuffer);
    await writeFile(path.join(outputPath, 'assets', avatarName), avatarBuffer);
    const alt = escapeHtml(site.avatarAlt || `Portrait of ${site.name}`);
    const { width, height } = imageDimensions(avatarBuffer, path.extname(site.avatar).toLowerCase());
    avatarHtml = `<img class="avatar-image" src="./assets/${escapeHtml(avatarName)}" alt="${alt}" width="${width}" height="${height}" style="aspect-ratio: ${width} / ${height};">`;
  } else {
    const initials = site.name.split(/\s+/).filter(Boolean).map(word => word[0].toUpperCase()).slice(0, 2).join('');
    avatarHtml = `<div class="avatar-monogram" role="img" aria-label="${escapeHtml(site.name)}">${escapeHtml(initials)}</div>`;
  }

  const ordered = [...posts].sort((a, b) => b.date.localeCompare(a.date));
  const postsHtml = [];
  for (const post of ordered) {
    let coverHtml = '';
    if (post.cover) {
      const coverPath = path.join(root, post.cover);
      const coverBuffer = await readFile(coverPath);
      const coverName = await hashedAssetName(path.basename(post.cover), coverBuffer);
      await writeFile(path.join(outputPath, 'assets', coverName), coverBuffer);
      const alt = escapeHtml(post.coverAlt || post.title);
      const { width, height } = imageDimensions(coverBuffer, path.extname(post.cover).toLowerCase());
      coverHtml = `<img class="post-cover" src="./assets/${escapeHtml(coverName)}" alt="${alt}" width="${width}" height="${height}" style="aspect-ratio: ${width} / ${height};">\n`;
    }
    postsHtml.push(`<li class="post-item">
<a class="post-link" href="./${escapeHtml(post.slug)}/">
<span class="post-title">${escapeHtml(post.title)}</span>
<time class="post-date" datetime="${escapeHtml(post.date)}">${escapeHtml(formatDate(post.date))}</time>
${coverHtml}</a>
</li>`);
  }
  const postsHtmlJoined = postsHtml.join('\n');

  const replacements = {
    NAME: escapeHtml(site.name),
    DESCRIPTION: escapeHtml(stripInlineLinks(site.intro)),
    INTRO: renderInlineLinks(site.intro),
    AVATAR: avatarHtml,
    POSTS: postsHtmlJoined,
    STYLESHEET: `./assets/${cssName}`,
  };
  for (const key of Object.keys(replacements))
    assert.ok(template.includes(`{{${key}}}`), `Missing landing template placeholder: ${key}`);
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(replacements, key), `Unknown landing template placeholder: ${key}`);
    return replacements[key];
  });
  await writeFile(path.join(outputPath, 'index.html'), html);
  console.log(`Published ${path.relative(root, outputPath)}/index.html with ${ordered.length} post(s).`);
}

function formatDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

async function main() {
  // Build into a fresh staging directory, then rename it over dist/ atomically
  // so a concurrent request never sees a half-written mix of old and new files.
  assert.equal(await realpath(root), path.resolve(root), 'Refusing to publish through a symlinked project root.');
  const previous = await lstat(finalOutputPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.ok(!previous?.isSymbolicLink(), 'Refusing to replace a symlinked dist directory.');

  const posts = JSON.parse(await readFile(path.join(root, 'content/posts.json'), 'utf8'));
  const slugs = posts.map(post => post.slug);
  assert.equal(slugs.length, new Set(slugs).size, 'Post slugs must be unique.');
  for (const slug of slugs)
    assert.ok(/^[a-z0-9-]+$/.test(slug), `Post slug "${slug}" must be a URL-safe, lowercase, hyphenated string.`);

  const stagingPath = path.join(root, `.dist-build-${process.pid}-${Date.now()}`);
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: true });
  try {
    const builtPosts = [];
    for (const post of posts) builtPosts.push(await buildPost(stagingPath, post));
    await buildLanding(stagingPath, builtPosts);
    await writeFile(path.join(stagingPath, '.nojekyll'), '');
    await rm(finalOutputPath, { recursive: true, force: true });
    await rename(stagingPath, finalOutputPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  console.error('Site build failed:', error);
  process.exitCode = 1;
});
