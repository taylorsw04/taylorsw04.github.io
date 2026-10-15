import { BNode, BNodeInternal } from '../../b+tree';
import BTreeEx from '../../extended';
import type { BTreeWithInternals } from '../../extended/shared';
import { Generation, generateKeys } from './generate';
import { CursorTimeline, processedThrough, recordOperation } from './timeline';
import { ElementAction, ElementEdit, KeyRange, randomExistingKey, randomNewKey } from './edit-element';

export type Node = BNode<number, string>;
export type Operation = 'union' | 'subtract' | 'intersect';
export type InitialTree = {
  keys: readonly number[];
  values?: readonly string[];
} | { cloneOf: number };
export interface Provenance {
  left: number;
  right: number;
  operation: Operation;
}
export interface CanvasTree {
  id: number;
  name: string;
  color: string;
  tree: BTreeEx<number, string>;
  origin?: Provenance;
  generation?: Generation;
  timeline?: CursorTimeline;
  edits?: number;
  operationInvalidated?: boolean;
  clonedFrom?: number;
  x: number;
  y: number;
}
export interface NodeIdentity {
  id: number;
  owner: Pick<CanvasTree, 'id' | 'name' | 'color'>;
  color: string;
}
export interface ReusedSubtree {
  root: Node;
  nodes: Node[];
}
export type OutputSequenceItem =
  | { kind: 'step'; number: number; keys: number[]; maxKey: number; step: number }
  | { kind: 'subtree'; number: number; keys: number[]; maxKey: number; subtree: ReusedSubtree }
  | { kind: 'entry'; number: number; keys: [number]; maxKey: number };

// The visualizer deliberately reads the actual node objects, not a cloned JSON tree.
export function rootOf(tree: BTreeEx<number, string>): Node {
  return (tree as unknown as BTreeWithInternals<number, string>)._root;
}

export function childrenOf(node: Node): Node[] {
  return node instanceof BNodeInternal ? node.children : [];
}

export function breadthFirst(tree: BTreeEx<number, string>): Node[] {
  const queue = [rootOf(tree)];
  for (let i = 0; i < queue.length; i++)
    queue.push(...childrenOf(queue[i]));
  return queue;
}

const seedA = [
  ...Array.from({ length: 16 }, (_, i) => i),
  ...Array.from({ length: 16 }, (_, i) => i + 40),
  80, 81, 82, 83, 84, 86, 87, 88, 89, 90, 91, 92, 93, 94, 96, 98,
  ...Array.from({ length: 16 }, (_, i) => i + 120)
];
const seedB = [16, 18, 20, 22, 24, 26, 28, 30, 85, 90, 99, 110, 136, 140, 142, 146];

export class TreeCanvasModel {
  readonly trees: CanvasTree[] = [];
  readonly identities = new Map<Node, NodeIdentity>();
  private nextNodeId = 1;
  private nextTreeId = 0;
  private nextElementValue = 1;

  constructor(initialTrees: readonly InitialTree[] = [
    { keys: seedA, values: seedA.map(key => `a${key}`) },
    { keys: seedB, values: seedB.map(key => `b${key}`) }
  ], private readonly captureDecomposition = false, private readonly captureReconstruction = false) {
    for (const initial of initialTrees) {
      if ('cloneOf' in initial) {
        this.clone(initial.cloneOf);
      } else {
        const keys = Array.from(initial.keys);
        const values = initial.values === undefined ? keys.map(String) : Array.from(initial.values);
        this.add(BTreeEx.bulkLoad(keys, values, 4));
      }
    }
  }

  add(tree: BTreeEx<number, string>, origin?: Provenance, generation?: Generation): CanvasTree {
    const id = this.nextTreeId++;
    const entry: CanvasTree = {
      id, name: `Tree${id + 1}`, tree, origin, generation, x: 0, y: 0,
      color: `hsl(${(id * 137.507764 + 210) % 360}, 65%, 82%)`
    };
    this.trees.push(entry);
    this.refreshIdentities();
    return entry;
  }

  get(id: number): CanvasTree {
    const tree = this.trees.find(tree => tree.id === id);
    if (!tree) throw new Error(`Tree${id + 1} does not exist.`);
    return tree;
  }

  clone(id: number): CanvasTree {
    const source = this.get(id);
    const result = this.add(source.tree.clone());
    result.clonedFrom = id;
    return result;
  }

  nameOf(id: number): string {
    if (!Number.isInteger(id) || id < 0 || id >= this.nextTreeId)
      throw new Error(`Tree ID ${id} has never existed on this canvas.`);
    return `Tree${id + 1}`;
  }

  remove(id: number): void {
    const index = this.trees.indexOf(this.get(id));
    this.trees.splice(index, 1);
    for (const entry of this.trees) {
      if (entry.origin && (entry.origin.left === id || entry.origin.right === id))
        entry.timeline = undefined;
    }
    this.pruneIdentities();
  }

  private pruneIdentities(): void {
    const liveNodes = new Set<Node>();
    for (const entry of this.trees)
      for (const node of breadthFirst(entry.tree)) liveNodes.add(node);
    this.identities.forEach((_identity, node) => {
      if (!liveNodes.has(node)) this.identities.delete(node);
    });
  }

  nodeRange(id: number, node = rootOf(this.get(id).tree)): KeyRange | undefined {
    if (!breadthFirst(this.get(id).tree).includes(node))
      throw new Error('The selected node is not in this tree.');
    const min = node.minKey(), max = node.maxKey();
    return min === undefined || max === undefined ? undefined : Object.freeze({ min, max });
  }

  previewElement(id: number, action: ElementAction, range?: KeyRange, random = Math.random): ElementEdit {
    const entry = this.get(id);
    const bounds = range || this.nodeRange(id);
    if (!bounds) throw new Error('Select a non-empty node to edit.');
    const keys = entry.tree.keysArray();
    let key: number;
    switch (action) {
      case 'add': key = randomNewKey(keys, random, bounds); break;
      case 'remove': key = randomExistingKey(keys, random, bounds); break;
      default: throw new Error(`Unknown element action: ${action}`);
    }
    return Object.freeze({
      treeId: id, action, key, range: Object.freeze({ ...bounds }), revision: entry.edits || 0
    });
  }

  applyElement(edit: ElementEdit): { key: number; value?: string } {
    const entry = this.get(edit.treeId);
    if ((entry.edits || 0) !== edit.revision) throw new Error('The tree changed; preview the edit again.');
    const { key, range } = edit;
    if (!Number.isFinite(key) || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max)
      throw new Error('Invalid key or range for this edit.');
    let value: string | undefined;
    if (edit.action === 'add') {
      const low = range.min === range.max ? range.min - 1 : range.min;
      const high = range.min === range.max ? range.max + 1 : range.max;
      if (!entry.tree.size || key <= low || key >= high || entry.tree.has(key))
        throw new Error('The insertion preview is no longer valid.');
      const values = new Set(entry.tree.valuesArray());
      value = `v${this.nextElementValue++}`;
      while (values.has(value)) value = `v${this.nextElementValue++}`;
      entry.tree.set(key, value);
    } else if (edit.action === 'remove') {
      if (entry.tree.size <= 1) throw new Error('Keep at least one element in the tree.');
      if (key < range.min || key > range.max || !entry.tree.has(key))
        throw new Error('The removal preview is no longer valid.');
      entry.tree.delete(key);
    } else throw new Error(`Unknown element action: ${edit.action}`);
    this.edited(entry);
    return { key, value };
  }

  addElement(id: number, random = Math.random, range?: KeyRange): { key: number; value: string } {
    const result = this.applyElement(this.previewElement(id, 'add', range, random));
    return { key: result.key, value: result.value! };
  }

  removeElement(id: number, random = Math.random, range?: KeyRange): { key: number } {
    if (this.get(id).tree.size <= 1) throw new Error('Keep at least one element in the tree.');
    return this.applyElement(this.previewElement(id, 'remove', range, random));
  }

  private edited(edited: CanvasTree): void {
    edited.edits = (edited.edits || 0) + 1;
    for (const entry of this.trees) {
      if (entry.origin && (entry.id === edited.id || entry.origin.left === edited.id || entry.origin.right === edited.id)) {
        entry.operationInvalidated = true;
        entry.timeline = undefined;
      }
    }
    this.pruneIdentities();
    this.refreshIdentities();
  }

  generate(spec: Generation): CanvasTree {
    const keys = generateKeys(spec);
    const values = keys.map(key => `t${this.nextTreeId + 1}:${key}`);
    return this.add(BTreeEx.bulkLoad(keys, values, 4), undefined, { ...spec });
  }

  combine(leftId: number, rightId: number, operation: Operation): CanvasTree {
    const left = this.get(leftId);
    const right = this.get(rightId);
    const keepLeft = (_key: number, value: string) => value;
    const recorded = recordOperation(left.tree, right.tree, operation, () => {
      switch (operation) {
        case 'union': return left.tree.union(right.tree, keepLeft);
        case 'subtract': return left.tree.subtract(right.tree);
        case 'intersect': return left.tree.intersect(right.tree, keepLeft);
        default: throw new Error(`Unknown operation: ${operation}`);
      }
    }, this.captureDecomposition, this.captureReconstruction);
    const result = this.add(recorded.value, { left: leftId, right: rightId, operation });
    result.timeline = recorded.timeline;
    return result;
  }

  operationSharing(resultId: number): {
    trees: CanvasTree[]; nodes: Set<Node>; subtrees: ReusedSubtree[];
    sequence: OutputSequenceItem[]; missing: number[]
  } {
    const result = this.get(resultId);
    if (!result.origin) throw new Error(`${result.name} has no operation inputs.`);
    if (result.operationInvalidated) throw new Error(`${result.name}'s operation no longer matches its edited participants.`);
    const participantIds = new Set([result.origin.left, result.origin.right, result.id]);
    const trees = this.trees.filter(tree => participantIds.has(tree.id));
    const inputNodes = new Set<Node>();
    for (const tree of trees) {
      if (tree.id !== result.id)
        breadthFirst(tree.tree).forEach(node => inputNodes.add(node));
    }
    const resultNodes = breadthFirst(result.tree);
    const nodes = new Set(resultNodes.filter(node => inputNodes.has(node)));
    const subtrees: ReusedSubtree[] = [];
    const subtreeFor = new Map<Node, ReusedSubtree>();
    // BFS visits parents first. Only a reused parent passes its component to its children.
    for (const node of resultNodes) {
      if (!nodes.has(node)) continue;
      let subtree = subtreeFor.get(node);
      if (!subtree) {
        subtree = { root: node, nodes: [] };
        subtrees.push(subtree);
      }
      subtree.nodes.push(node);
      for (const child of childrenOf(node))
        if (nodes.has(child)) subtreeFor.set(child, subtree);
    }
    // Maxima order these disjoint fragments from left to right, even at different heights.
    subtrees.sort((a, b) => a.root.maxKey() - b.root.maxKey());
    const sequence: OutputSequenceItem[] = [];
    const byRoot = new Map(subtrees.map(subtree => [subtree.root, subtree] as const));
    const visit = (node: Node): void => {
      const subtree = byRoot.get(node);
      if (subtree) {
        const keys: number[] = [];
        for (const descendant of subtree.nodes)
          if (descendant.isLeaf) keys.push(...descendant.keys);
        if (keys.length) sequence.push({
          kind: 'subtree', number: sequence.length + 1, keys,
          maxKey: keys[keys.length - 1], subtree
        });
      } else if (node.isLeaf) {
        for (const key of node.keys)
          sequence.push({ kind: 'entry', number: sequence.length + 1, keys: [key], maxKey: key });
      } else {
        for (const child of childrenOf(node)) visit(child);
      }
    };
    if (result.timeline?.kind === 'walk') {
      const keys = result.tree.keysArray();
      let next = 0;
      for (const frame of result.timeline.frames.slice(1)) {
        const start = next, boundary = processedThrough(frame);
        while (next < keys.length && keys[next] < boundary) next++;
        if (next > start) sequence.push({
          kind: 'step', number: sequence.length + 1, keys: keys.slice(start, next),
          maxKey: keys[next - 1], step: frame.step
        });
      }
      if (next !== keys.length)
        throw new Error('Cursor recording does not account for every output key.');
    } else {
      visit(rootOf(result.tree));
    }
    return {
      trees, nodes, subtrees, sequence,
      missing: Array.from(participantIds).filter(id => !trees.some(tree => tree.id === id))
    };
  }

  refreshIdentities(): void {
    // Never recolor an existing object. Oldest trees claim new objects first, in BFS order.
    for (const entry of this.trees) {
      for (const node of breadthFirst(entry.tree)) {
        if (!this.identities.has(node)) {
          this.identities.set(node, {
            id: this.nextNodeId++,
            owner: { id: entry.id, name: entry.name, color: entry.color },
            color: entry.color
          });
        }
      }
    }
  }

  identity(node: Node): NodeIdentity {
    const identity = this.identities.get(node);
    if (!identity) throw new Error('Node was not registered in this canvas.');
    return identity;
  }
}
