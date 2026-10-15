# taylorsw04.github.io

Taylor Williams's personal website: a short landing page with an intro and a
rolling, reverse-chronological list of blog posts. The site is a small static
build — no client-side framework — built with Node, [Marked](https://marked.js.org/),
and [esbuild](https://esbuild.github.io/). It is published on GitHub Pages at
`https://taylorsw04.github.io/` (a GitHub user/organization Pages site, served
from the domain root — not a project-site sub-path).

The first post, [Sub-linear set operations in B+ trees](content/posts/sublinear-set-operations-in-btrees.md),
is a long-form interactive article with live B+ tree diagrams. Its build system
observes real `union`/`decompose`/`buildFromDecomposition` calls on a vendored,
unmodified snapshot of the [`sorted-btree`](https://github.com/qwertie/btree-typescript)
library — see [`VENDORED-BTREE-NOTICE.md`](VENDORED-BTREE-NOTICE.md) for provenance
and license details. **No BTree algorithm code is modified.**

## Building

```sh
npm ci
npm run build
```

This produces a complete, self-contained static site in `dist/`:

- `dist/index.html` — the landing page (intro + post list), plus `dist/assets/`
  for its CSS and an optional avatar image.
- `dist/<post-slug>/index.html` — each post's complete, direct-linkable page
  (no client-side router: every route is a real file GitHub Pages can serve).
- `dist/<post-slug>/assets/` — that post's bundled JavaScript, CSS, and code-split
  chunks (e.g. the Mermaid renderer, loaded lazily).
- `dist/<post-slug>/LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` — the vendored
  library's MIT license and notices for every bundled dependency.
- `dist/.nojekyll` — tells GitHub Pages not to run Jekyll over the output.

All links between pages and to assets are **relative**, so the exact same
`dist/` output works whether it's served from the domain root (this is a
user-site deployment, so root is the real target) or nested under some other
sub-path (e.g. local testing, or a future project-site). There is no
absolute base-path variable to configure.

## Local preview

```sh
npm run build
npm run serve         # http://localhost:4174
```

Set `PORT` to use a different port, e.g. `PORT=8080 npm run serve`. The server
only serves `dist/` and does not fall back to another route for missing URLs,
matching GitHub Pages' static-file behavior.

For live-reloading local editing (rebuilds on save):

```sh
npm run dev            # http://localhost:4174
```

> Note: the original blog's local preview (a separate, untouched checkout) uses
> port 4173. This site defaults to **4174** to avoid colliding with it.

## Adding a future post

1. Add a Markdown file under `content/posts/` (see `docs/web/README.md` for the
   Markdown conventions — stable `{#anchors}`, `:::btree preset #id` embeds,
   Mermaid fences, tables, sub/sup spans, etc.).
2. Add one entry to `content/posts.json`:
   ```json
   { "slug": "my-new-post", "title": "...", "date": "2027-01-01",
     "summary": "...", "markdown": "content/posts/my-new-post.md",
     "entry": "docs/web/article.ts", "template": "docs/web/post-template.html" }
   ```
   Posts are listed on the landing page in reverse-chronological `date` order.
   A plain prose post can reuse the existing `entry`/`template`; a post with its
   own interactive diagrams can point at its own TypeScript entry point and
   template instead.
3. Run `npm run build`.

## Adding a portrait photo

The landing page currently uses `public/avatar.jpg`, built from a high-resolution
original kept at `assets-src/portrait-original.jpg` (not published — the build
never reads anything under `assets-src/`). To update or add a photo:

1. Keep the original, untouched source photo somewhere under `assets-src/`
   (this directory exists only as a recoverable source location; it is never
   copied into `dist/`, and the whole directory is listed in `.gitignore` so
   originals — which may still carry embedded GPS/EXIF metadata — can never
   be accidentally committed; only the optimized copies under `public/` are
   versioned).
2. Generate an optimized, web-sized copy for `public/` — resize to a sensible
   display width (a few hundred pixels is plenty for the current layout),
   normalize EXIF orientation, and **re-save without embedded metadata**
   (especially GPS) before publishing. For example, with Pillow:
   ```python
   from PIL import Image, ImageOps
   im = ImageOps.exif_transpose(Image.open('assets-src/portrait-original.jpg')).convert('RGB')
   w, h = im.size
   im.resize((480, round(480 * h / w))).save('public/avatar.jpg', quality=82, optimize=True, progressive=True)
   ```
   A plain re-save like this (without passing `exif=`) strips all metadata
   from the published copy by default.
3. Update `content/site.json`'s `avatar` path (and `avatarAlt`, a short factual
   description of the photo) if the filename changed. The build reads the
   published JPEG's real pixel dimensions and emits them as the `<img>`'s
   `width`/`height`/`aspect-ratio` automatically, so there's nothing else to
   configure for layout stability.

## Adding a post cover image

Each entry in `content/posts.json` may optionally set `cover` (a path to a
PNG or JPEG under the repo root, e.g. `public/covers/<slug>.png`) and
`coverAlt` (descriptive alt text). When present, the build publishes that
image unmodified (byte-for-byte, no cropping/re-encoding) into the landing
page's post card, wrapped in the same clickable link as the title, with real
`width`/`height`/`aspect-ratio` read from the file so the layout never shifts.
Omit `cover` entirely for a post to render as a plain text card.


The photo is shown as a larger rounded-rectangle image beside the intro text
on wide viewports, and above it on narrow ones, at its real aspect ratio (no
forced circular crop). If no avatar file is present at the configured path,
the landing page automatically falls back to a plain initials monogram — no
image is invented or required.

Edit the intro blurb and display name in `content/site.json`.

## Testing

```sh
npm run build
npm test
```

`scripts/test-site.mjs` checks (without a browser, since headless Chromium
crashes reliably in some sandboxes): that every route exists and is a complete
static file; that the landing page lists posts in reverse-chronological order;
that there are no dangling internal `#anchors` (this is what originally caught
the broken `#making-it-fast-reconstruction-fast-reconstruction` link, now fixed
to `#fast-reconstruction`) or missing local asset references; that the article
retains all 10 interactive embeds, its byline, and has no site navigation/footer
chrome; that legal notices are present in the build output; that no local
machine paths (e.g. `/Users/...`) leak into the published artifact; that the
exact same build output works whether served from the root or nested under
an arbitrary sub-path; and — most importantly — that the real, vendored
BTree TypeScript source (not a mock) produces correct `union`/`decompose`
results when bundled and executed directly in Node.

`npm run check` runs the TypeScript compiler (`tsc --noEmit`) over
`docs/web/*.ts` against the vendored library types.

## Deploying (GitHub Pages via GitHub Actions)

`.github/workflows/deploy-pages.yml` builds the site and deploys it with the
official `actions/configure-pages`, `actions/upload-pages-artifact`, and
`actions/deploy-pages` actions, using minimal `contents: read` / `pages: write`
/ `id-token: write` permissions and a non-cancelling `pages` concurrency group.

To enable it: in the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**. The workflow runs automatically on pushes to `main` (and
can also be run manually via **workflow_dispatch**). *(This has intentionally
not been done as part of this change — no Pages settings were modified and
nothing was deployed.)*

## How the interactive article build works

See [`docs/web/README.md`](docs/web/README.md) for the full writing and build
mechanics inherited from the original article tooling (Markdown directives,
diagram/embed semantics, decomposition/reconstruction instrumentation, etc.).
In short:

- `scripts/render-markdown.mjs` renders Markdown with Marked, including stable
  anchors, Mermaid fences, tables, and `:::btree` directives.
- `scripts/build.mjs` validates the projected HTML with parse5, builds each
  post's esbuild bundle (resolving local **TypeScript before JavaScript**, so
  the playground always uses the current vendored library source, never a
  stale committed `.js` file), and renders the landing page.
- `scripts/docs-plugins.mjs` resolves the library's legacy `./interfaces`
  re-export, and in-memory (never touching the production source file) wires
  in guarded observation calls so the playground can show real decomposition
  and reconstruction events as they occur.
