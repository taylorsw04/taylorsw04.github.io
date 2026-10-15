import path from 'node:path';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const implementation = path.join(root, 'extended/parallelWalk');
const adapter = path.join(root, 'docs/web/recording-walk.ts');
const decomposition = path.join(root, 'extended/decompose.ts');

export function cursorRecordingPlugin() {
  return {
    name: 'documentation-cursor-recording',
    setup(bundler) {
      bundler.onResolve({ filter: /parallelWalk(?:\.ts)?$/ }, args => {
        const target = path.resolve(args.resolveDir, args.path).replace(/\.ts$/, '');
        if (target === implementation && args.importer !== adapter)
          return { path: adapter };
      });
      bundler.onLoad({ filter: /[/\\]extended[/\\]decompose\.ts$/ }, async args => {
        if (args.path !== decomposition) return;
        let contents = await readFile(args.path, 'utf8');
        const replace = (marker, replacement) => {
          assert.equal(contents.split(marker).length, 2, `The private reconstruction instrumentation contract changed: ${marker.slice(0, 90)}`);
          contents = contents.replace(marker, replacement);
        };
        const setup = '  const minSize = Math.floor(maxNodeSize / 2);';
        const finish = '  return { heights: disjointHeights, nodes: disjointNodes, tallestIndex };';
        for (const marker of [setup, finish])
          assert.equal(contents.split(marker).length, 2, 'The private decompose instrumentation contract changed.');
        contents = contents.replace(setup, `${setup}
  __docsObserveDecomposition(left._root, right._root, () => ({
    nodes: disjointNodes, heights: disjointHeights, pendingKeys, pendingValues, tallestIndex
  }));`);
        contents = contents.replace(finish, `  __docsFinishDecomposition();\n${finish}`);
        replace('  if (disjointEntryCount === 0)\n    return new constructor(undefined, cmp, maxNodeSize) as unknown as TBTree;',
          `  if (disjointEntryCount === 0) {
    __docsBeginReconstruction(() => undefined, -1);
    __docsReconstructionEvent('complete');
    return new constructor(undefined, cmp, maxNodeSize) as unknown as TBTree;
  }`);
        replace('  const frontier: BNode<K, V>[] = [initialRoot];',
          `  const frontier: BNode<K, V>[] = [initialRoot];
  __docsBeginReconstruction(() => frontier[0], tallestIndex);`);
        replace('  const reconstructed = new constructor(undefined, cmp, maxNodeSize);',
          `  __docsReconstructionEvent('complete');
  const reconstructed = new constructor(undefined, cmp, maxNodeSize);`);
        const sizeSetup = '  const unflushedSizes: number[] = new Array(spine.length).fill(0); // pre-fill to avoid "holey" array';
        replace(sizeSetup, `${sizeSetup}
  let __docsFragmentIndex = start;
  let __docsInsertionDepth: number | undefined;
  let __docsCascadeEndDepth: number | undefined;
  __docsObserveReconstructionSide(step, () => ({
    spine, unflushedSizes, fragmentIndex: __docsFragmentIndex,
    insertionDepth: __docsInsertionDepth, cascadeEndDepth: __docsCascadeEndDepth
  }));`);
        const insertion = '    const insertionDepth = currentHeight - (subtreeHeight + 1);';
        replace(insertion, `${insertion}
    __docsFragmentIndex = i;
    __docsInsertionDepth = insertionDepth;
    __docsCascadeEndDepth = undefined;
    __docsReconstructionEvent('fragment');`);
        const cascade = '    const cascadeEndDepth = findSplitCascadeEndDepth(context, insertionDepth, insertionCount);';
        replace(cascade, `${cascade}
    __docsCascadeEndDepth = cascadeEndDepth;
    __docsReconstructionEvent('plan');`);
        replace('    updateFrontier(context, expansionDepth);',
          `    updateFrontier(context, expansionDepth);
    __docsReconstructionEvent('fragment-complete');`);
        replace('      sizeChangeDepth++; // account for the spine lengthening',
          `      sizeChangeDepth++; // account for the spine lengthening
      __docsReconstructionEvent('root', [newRoot]);`);
        replace('    spine[0] = root.clone();',
          `    spine[0] = root.clone();
    __docsReconstructionEvent('clone', [root, spine[0]]);`);
        replace('    spine[depth] = clone;',
          `    spine[depth] = clone;
    __docsReconstructionEvent('clone', [parent, clone]);`);
        replace('    updateMax(node, maxKey);',
          `    updateMax(node, maxKey);
    __docsReconstructionEvent('metadata', [node]);`);
        replace('  parent.keys.splice(index, 0, child.maxKey());',
          `  parent.keys.splice(index, 0, child.maxKey());
  __docsReconstructionEvent('attach', [parent, child]);`);
        for (const side of ['Right', 'Left']) {
          replace(`  return node.splitOff${side}Side();`, `  const split = node.splitOff${side}Side();
  __docsReconstructionEvent('split', [node, split]);
  return split;`);
        }
        replace('  parent.keys[siblingIndex] = sibling.maxKey();',
          `  parent.keys[siblingIndex] = sibling.maxKey();
  __docsReconstructionEvent('balance', [parent, sibling, underfilled]);`);
        replace('  parent.keys[0] = underfilled.maxKey();',
          `  parent.keys[0] = underfilled.maxKey();
  __docsReconstructionEvent('balance', [parent, sibling, underfilled]);`);
        for (const method of ['push', 'unshift']) {
          const merge = `  leaf.values.${method}.apply(leaf.values, entries.values);`;
          replace(merge, `${merge}
  __docsReconstructionEvent('merge', [leaf, entries]);`);
        }
        return {
          contents: `import {
  observeDecomposition as __docsObserveDecomposition, finishDecomposition as __docsFinishDecomposition,
  beginReconstruction as __docsBeginReconstruction, observeReconstructionSide as __docsObserveReconstructionSide,
  recordReconstructionEvent as __docsReconstructionEvent
} from '../docs/web/timeline';\n${contents}`,
          loader: 'ts', resolveDir: path.dirname(args.path)
        };
      });
    }
  };
}

export function interfaceDeclarationsPlugin() {
  return {
    name: 'library-interface-declarations',
    setup(bundler) {
      bundler.onResolve({ filter: /^\.\/interfaces$/ }, args => {
        if (args.importer === path.join(root, 'b+tree.ts'))
          return { path: path.join(root, 'interfaces.d.ts') };
      });
    }
  };
}
