import type { TreeLayout } from './layout';
import type { ReconstructionFrame, ReconstructionNode } from './reconstruction';
import { reconstructionInsertionHeight } from './reconstruction';
import { formatKey } from './format';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string | number> = {}, text?: string
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Final key slots and a fixed leaf baseline prevent recentering as either frontier grows. */
export function layoutReconstruction(frame: ReconstructionFrame, finalLayout: TreeLayout) {
  const leafStyle = finalLayout.nodes.find(placed => placed.node.isLeaf)!;
  const internalStyle = finalLayout.nodes.find(placed => !placed.node.isLeaf) || leafStyle;
  const slots = new Map<number, { x: number; left: number; right: number }>();
  let baseCellWidth = 34;
  for (const placed of finalLayout.nodes) {
    placed.node.keys.forEach((key, index) => {
      baseCellWidth = Math.max(baseCellWidth, formatKey(key).length * 9 + 20);
      if (placed.node.isLeaf) {
        const left = placed.x - placed.width / 2 + index * placed.cellWidth;
        slots.set(key, { left, right: left + placed.cellWidth, x: left + placed.cellWidth / 2 });
        if (placed.valueY !== undefined) {
          const value = placed.node.values[index];
          baseCellWidth = Math.max(baseCellWidth, (value === undefined ? 'undefined' : JSON.stringify(value)).length * 7.5 + 20);
        }
      }
    });
  }
  interface PlacedSnapshot {
    node: ReconstructionNode;
    x: number;
    y: number;
    width: number;
    height: number;
    keyY: number;
    valueY?: number;
    metadataY?: number;
    treeHeight: number;
    keyXs: number[];
  }
  const nodes = new Map<number, PlacedSnapshot>();
  const edges: { parent: number; child: number }[] = [];
  const visit = (node: ReconstructionNode): PlacedSnapshot => {
    const existing = nodes.get(node.id);
    if (existing) return existing;
    const children = node.children.map(visit);
    let x: number, width: number, keyXs: number[];
    if (children.length) {
      x = (children[0].x + children[children.length - 1].x) / 2;
      width = Math.max(internalStyle.metadataY !== undefined ? 160 : baseCellWidth, node.keys.length * baseCellWidth);
      keyXs = node.keys.map((_key, index) => x - width / 2 + (index + 0.5) * width / Math.max(1, node.keys.length));
    } else if (node.keys.length) {
      const locations = node.keys.map(key => {
        const slot = slots.get(key);
        if (!slot) throw new Error(`Reconstruction key ${key} is absent from the final output layout.`);
        return slot;
      });
      const left = locations[0].left, right = locations[locations.length - 1].right;
      x = (left + right) / 2;
      width = right - left;
      keyXs = locations.map(slot => slot.x);
    } else {
      x = leafStyle.x;
      width = leafStyle.width;
      keyXs = [];
    }
    const treeHeight = children.length ? 1 + Math.max(...children.map(child => child.treeHeight)) : 0;
    const style = children.length ? internalStyle : leafStyle;
    const placed = {
      node, x, width, keyXs, treeHeight, y: leafStyle.y - treeHeight * 108,
      height: style.height, keyY: style.keyY, valueY: children.length ? undefined : style.valueY,
      metadataY: style.metadataY
    };
    nodes.set(node.id, placed);
    children.forEach(child => edges.push({ parent: node.id, child: child.node.id }));
    return placed;
  };
  if (frame.root) visit(frame.root);
  frame.detached.forEach(visit);
  return { nodes: Array.from(nodes.values()), edges };
}

export function drawReconstruction(
  layer: SVGGElement, frame: ReconstructionFrame, layout: TreeLayout,
  identity: (source: object) => { id: number; color: string; owner: { name: string } } | undefined,
  selectedId?: number, selectedSourceId?: number, selectNode?: (node: ReconstructionNode) => void
): void {
  layer.replaceChildren();
  layer.dataset.step = String(frame.step);
  layer.dataset.event = frame.event;
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', `Reconstruction R${frame.step}: ${frame.message}`);
  const placed = layoutReconstruction(frame, layout);
  const byId = new Map(placed.nodes.map(node => [node.node.id, node]));
  const frontier = new Set(frame.frontier), changed = new Set(frame.changed);
  const detached = new Set(frame.detached.map(node => node.id));
  const target = frame.event === 'fragment' && frame.insertionDepth !== undefined
    ? frame.frontier[frame.insertionDepth] : undefined;
  for (const edge of placed.edges) {
    const parent = byId.get(edge.parent)!, child = byId.get(edge.child)!;
    const y1 = parent.y + parent.height, y2 = child.y;
    layer.append(svg('path', {
      class: `lab-reconstruction-link${frontier.has(edge.parent) && frontier.has(edge.child) ? ' is-frontier' : ''}`,
      d: `M${parent.x},${y1} C${parent.x},${(y1 + y2) / 2} ${child.x},${(y1 + y2) / 2} ${child.x},${y2}`
    }));
  }
  for (const placedNode of placed.nodes) {
    const { node, x, y, width, height, keyXs } = placedNode;
    const reference = identity(node.source);
    const selected = selectedId === node.id || (selectedSourceId !== undefined && reference?.id === selectedSourceId);
    const group = svg('g', {
      class: `lab-reconstruction-node${frontier.has(node.id) ? ' is-frontier' : ''}${
        changed.has(node.id) ? ' is-changed' : ''}${target === node.id ? ' is-insertion-target' : ''}${
        detached.has(node.id) ? ' is-detached' : ''}${
        selected ? ' is-node-selected' : ''}`,
      transform: `translate(${x - width / 2},${y})`,
      'data-reconstruction-id': node.id, 'data-keys': JSON.stringify(node.keys),
      'data-leaf': String(!node.children.length), 'data-cached-size': node.size,
      'data-shared': String(node.shared)
    });
    if (reference) group.dataset.nodeId = String(reference.id);
    group.append(svg('rect', {
      class: 'lab-reconstruction-node-box', width, height, rx: 5, fill: reference?.color || layout.entry.color
    }));
    if (target === node.id) group.append(svg('text', {
      class: 'lab-reconstruction-target-label', x: width / 2, y: -16, 'text-anchor': 'middle'
    }, `Insert at height ${reconstructionInsertionHeight(frame)}`));
    node.keys.forEach((key, index) => {
      const keyX = keyXs[index] - (x - width / 2);
      if (index) {
        const divider = (keyXs[index - 1] + keyXs[index]) / 2 - (x - width / 2);
        group.append(svg('line', { class: 'lab-cell-divider', x1: divider, x2: divider, y1: 0, y2: height }));
      }
      group.append(svg('text', { class: 'lab-key', x: keyX, y: placedNode.keyY, 'text-anchor': 'middle' }, formatKey(key)));
      if (placedNode.valueY !== undefined) group.append(svg('text', {
        class: 'lab-value', x: keyX, y: placedNode.valueY, 'text-anchor': 'middle'
      }, node.values[index] === undefined ? 'undefined' : JSON.stringify(node.values[index])));
    });
    if (placedNode.metadataY !== undefined) {
      const label = `${reference ? `#${reference.id}` : `R-node ${node.id}`} - ${reference?.owner.name || layout.entry.name}`;
      group.append(svg('text', {
        class: 'lab-node-meta', x: width / 2, y: placedNode.metadataY, 'text-anchor': 'middle',
        style: `font-size:${Math.min(10, width / Math.max(1, label.length * 0.6))}px`
      }, label));
    }
    group.append(svg('title', {}, `${node.shared ? 'Shared' : 'Unshared'} node${
      detached.has(node.id) ? '; awaiting placement' : ''}`));
    if (selectNode) {
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-pressed', String(selected));
      group.setAttribute('aria-label', `Reconstruction node ${node.id}, keys ${node.keys.map(formatKey).join(', ')}`);
      group.addEventListener('click', event => { event.stopPropagation(); selectNode(node); });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); selectNode(node);
        }
      });
    }
    layer.append(group);
  }
  if (!placed.nodes.length)
    layer.append(svg('text', { class: 'lab-reconstruction-empty', x: layout.width / 2, y: layout.headerHeight + 30,
      'text-anchor': 'middle' }, 'Empty result'));
}
