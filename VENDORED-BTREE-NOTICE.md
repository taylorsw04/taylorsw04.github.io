# Vendored `sorted-btree` sources

This repository vendors a small, byte-for-byte snapshot of the B+ tree
implementation from [qwertie/btree-typescript](https://github.com/qwertie/btree-typescript)
(npm package `sorted-btree`) so the interactive diagrams in the
[Sub-linear set operations in B+ trees](content/posts/sublinear-set-operations-in-btrees.md)
post can import the exact TypeScript internals they observe (private locals in
`extended/decompose.ts`, the real `parallelWalk` cursor, etc.) without depending
on a published package version or the author's other local checkouts.

- **Source revision:** `77736030fe0c14d909b4bdd0fca7dc5f81fcfb7c`
- **Upstream repository:** https://github.com/qwertie/btree-typescript
- **License:** MIT — see [`LICENSE-btree-typescript`](LICENSE-btree-typescript) (unmodified upstream license text).
- **Vendored files** (unmodified, copied verbatim from the revision above):
  - `b+tree.ts`
  - `interfaces.d.ts`
  - `extended/*.ts` (bulkLoad, decompose, diffAgainst, forEachKeyInBoth, forEachKeyNotIn, index, intersect, parallelWalk, shared, subtract, union)

Only the TypeScript sources needed to build and bundle the library and the
interactive playground were copied. Upstream benchmarks, prebuilt/minified
`.js` output, declaration (`.d.ts`) files for the `extended/*` modules (not
required because esbuild resolves `.ts` sources directly), and the upstream
test/publish tooling were intentionally left out.

**The BTree algorithms themselves are not modified.** The only adaptations made
for this site are build-time plumbing in `scripts/docs-plugins.mjs` (which
observes decomposition/reconstruction calls in memory during the documentation
build, exactly as upstream did) — no production library source file is edited.
