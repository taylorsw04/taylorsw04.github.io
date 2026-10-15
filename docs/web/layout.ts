import { hierarchy, tree as tidyTree } from 'd3-hierarchy';
import { CanvasTree, Node, childrenOf, rootOf } from './model';
import type { PlaygroundDisplay } from './options';
import { formatKey } from './format';
import type { KeyRange } from './edit-element';

export const NODE_HEIGHT = 50;
export const CARD_PADDING = 28;
export const HEADER_HEIGHT = 88;
export const CHUNK_RANGE_PADDING = 40;

export interface PlacedNode {
  node: Node;
  x: number;
  y: number;
  width: number;
  cellWidth: number;
  height: number;
  keyY: number;
  valueY?: number;
  metadataY?: number;
  inheritedShared: boolean;
}
export interface TreeLayout {
  entry: CanvasTree;
  width: number;
  height: number;
  headerHeight: number;
  nodes: PlacedNode[];
  edges: Array<{ parent: PlacedNode; child: PlacedNode; index: number }>;
}

export interface TreeLayoutOptions extends Partial<Pick<PlaygroundDisplay,
  'treeHeaders' | 'treeFrames' | 'nodeMetadata' | 'leafValues'>> {
  annotations?: boolean;
}

export function formatLeafValue(value: string | undefined): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

export function layoutTree(entry: CanvasTree, options: TreeLayoutOptions = {}): TreeLayout {
  const { treeHeaders = true, treeFrames = true, nodeMetadata = true, leafValues = false, annotations = true } = options;
  const padding = treeFrames ? CARD_PADDING : 0;
  const headerHeight = treeHeaders ? HEADER_HEIGHT : padding;
  const root = hierarchy(rootOf(entry.tree), childrenOf);
  let cellWidth = 34;
  root.each(node => {
    for (const key of node.data.keys)
      cellWidth = Math.max(cellWidth, formatKey(key).length * 9 + 20);
    if (leafValues && node.data.isLeaf) {
      for (let index = 0; index < node.data.keys.length; index++)
        cellWidth = Math.max(cellWidth, formatLeafValue(node.data.values[index]).length * 7.5 + 20);
    }
  });
  const widthOf = (node: Node) => Math.max(nodeMetadata ? 160 : cellWidth, node.keys.length * cellWidth);
  const layout = tidyTree<Node>()
    .nodeSize([1, 108])
    .separation((a, b) => (widthOf(a.data) + widthOf(b.data)) / 2 + 24)(root);
  const descendants = layout.descendants();
  const left = Math.min(...descendants.map(n => n.x - widthOf(n.data) / 2));
  const right = Math.max(...descendants.map(n => n.x + widthOf(n.data) / 2));
  const width = Math.max(treeHeaders || treeFrames ? 380 : 0, right - left + padding * 2);
  const centering = (width - (right - left)) / 2;
  const positions = new Map<Node, PlacedNode>();
  const nodes = descendants.map(n => {
    const parent = n.parent && positions.get(n.parent.data);
    const showValues = leafValues && n.data.isLeaf;
    const height = NODE_HEIGHT + (showValues && (nodeMetadata || annotations) ? 22 : 0);
    const placed: PlacedNode = {
      node: n.data,
      x: n.x - left + centering,
      y: n.y + headerHeight,
      width: widthOf(n.data),
      cellWidth: widthOf(n.data) / Math.max(1, n.data.keys.length),
      height,
      keyY: showValues ? 18 : nodeMetadata ? 20 : 30,
      valueY: showValues ? 39 : undefined,
      metadataY: nodeMetadata ? height - 8 : undefined,
      inheritedShared: !!parent && (parent.inheritedShared || parent.node.isShared === true)
    };
    positions.set(n.data, placed);
    return placed;
  });
  return {
    entry, width, headerHeight,
    height: Math.max(...nodes.map(n => n.y + n.height)) + padding +
      (annotations ? CHUNK_RANGE_PADDING : 0),
    nodes,
    edges: layout.links().map(link => ({
      parent: positions.get(link.source.data)!,
      child: positions.get(link.target.data)!,
      index: childrenOf(link.source.data).indexOf(link.target.data)
    }))
  };
}

export function selectedNodeInLayout(layout: TreeLayout, nodeId: number,
  range: KeyRange | undefined, identify: (node: Node) => number): PlacedNode {
  const original = layout.nodes.find(placed => identify(placed.node) === nodeId);
  if (original) return original;
  if (!range) return layout.nodes[0];
  const leafKeys = layout.nodes.filter(placed => placed.node.isLeaf)
    .flatMap(placed => placed.node.keys.filter(key => key >= range.min && key <= range.max));
  if (leafKeys.length) {
    const first = leafKeys[0], last = leafKeys[leafKeys.length - 1];
    let selected = layout.nodes[0];
    for (const placed of layout.nodes) {
      const min = placed.node.minKey(), max = placed.node.maxKey();
      if (min !== undefined && max !== undefined && min <= first && max >= last && placed.y >= selected.y)
        selected = placed;
    }
    return selected;
  }
  const leaves = layout.nodes.filter(placed => placed.node.isLeaf);
  return leaves.find(placed => placed.node.maxKey() >= range.min) || leaves[leaves.length - 1];
}

export function editTarget(layout: TreeLayout, key: number, action: 'add' | 'remove'): {
  node: PlacedNode; index: number; x: number;
} {
  const leaves = layout.nodes.filter(placed => placed.node.isLeaf);
  const node = leaves.find(placed => placed.node.maxKey() >= key) || leaves[leaves.length - 1];
  const found = node.node.keys.findIndex(existing => existing >= key);
  const index = found < 0 ? node.node.keys.length : found;
  if (action === 'remove' && node.node.keys[index] !== key) throw new Error('The preview key is not in this tree.');
  return { node, index, x: node.x - node.width / 2 + index * node.cellWidth };
}
