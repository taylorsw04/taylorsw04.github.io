import { hierarchy, tree as tidyTree } from 'd3-hierarchy';
import type { DecompositionItem, DecompositionNode, DecompositionSnapshot } from './timeline';
import type { ReconstructionFrame } from './reconstruction';
import { formatKey } from './format';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GAP = 20;
const PADDING = 14;
const NODE_HEIGHT = 50;
export const DECOMPOSITION_PADDING = 16;

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string | number> = {}, text?: string
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function valueText(value: string | undefined): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function fragmentLayout(item: DecompositionItem) {
  const root = hierarchy(item.root, node => node.children);
  let cellWidth = 34;
  root.each(node => {
    node.data.keys.forEach((key, index) => {
      cellWidth = Math.max(cellWidth, formatKey(key).length * 8 + 18);
      if (!node.children)
        cellWidth = Math.max(cellWidth, valueText(node.data.values[index]).length * 7 + 14);
    });
  });
  const nodeWidth = (node: DecompositionNode) => Math.max(64, node.keys.length * cellWidth);
  const tree = tidyTree<DecompositionNode>().nodeSize([1, 78])
    .separation((a, b) => (nodeWidth(a.data) + nodeWidth(b.data)) / 2 + GAP)(root);
  const nodes = tree.descendants();
  const left = Math.min(...nodes.map(node => node.x - nodeWidth(node.data) / 2));
  const right = Math.max(...nodes.map(node => node.x + nodeWidth(node.data) / 2));
  const width = Math.max(250, right - left + PADDING * 2);
  const offset = (width - (right - left)) / 2 - left;
  return {
    width, height: 48 + Math.max(...nodes.map(node => node.y)) + NODE_HEIGHT + PADDING,
    nodes: nodes.map(node => ({
      snapshot: node.data, x: node.x + offset, y: node.y + 48, width: nodeWidth(node.data)
    })),
    edges: tree.links().map(link => ({
      x1: link.source.x + offset, y1: link.source.y + 48 + NODE_HEIGHT,
      x2: link.target.x + offset, y2: link.target.y + 48
    }))
  };
}

export function layoutDecomposition(snapshot: DecompositionSnapshot, availableWidth: number) {
  const y = 66;
  let x = 0, rowHeight = 0, width = availableWidth;
  const fragments = snapshot.items.map((item, index) => {
    const layout = fragmentLayout(item);
    const placed = { item, index, layout, x, y };
    width = Math.max(width, x + layout.width);
    x += layout.width + GAP;
    rowHeight = Math.max(rowHeight, layout.height);
    return placed;
  });
  let bottom = y + rowHeight;
  let pending: { x: number; y: number; width: number; height: number; columns: number; cellWidth: number } | undefined;
  if (snapshot.pendingKeys.length) {
    const cellWidth = Math.max(74, ...snapshot.pendingKeys.map((key, index) =>
      Math.max(formatKey(key).length * 8, valueText(snapshot.pendingValues[index]).length * 7) + 20));
    const columns = Math.max(1, Math.floor((availableWidth - PADDING * 2) / cellWidth));
    const rows = Math.ceil(snapshot.pendingKeys.length / columns);
    pending = {
      x, y, columns, cellWidth,
      width: Math.max(350, Math.min(columns, snapshot.pendingKeys.length) * cellWidth + PADDING * 2),
      height: 48 + rows * NODE_HEIGHT + PADDING
    };
    width = Math.max(width, pending.x + pending.width);
    bottom = Math.max(bottom, pending.y + pending.height);
  }
  return { fragments, pending, width, height: Math.max(104, bottom) };
}

export function drawDecomposition(
  layer: SVGGElement, snapshot: DecompositionSnapshot | undefined, availableWidth: number,
  step: number, inputs: readonly { name: string; color: string }[], resultColor: string,
  identity: (source: object) => { id: number; color: string } | undefined,
  selectedNodeId?: number, selectNode?: (source: object) => void,
  unavailable = 'Decomposition recording is unavailable for this operation.',
  reconstruction?: ReconstructionFrame
): { width: number; height: number } {
  layer.replaceChildren();
  const withBackground = (size: { width: number; height: number }) => {
    layer.prepend(svg('rect', {
      class: 'lab-decomposition-background', x: -DECOMPOSITION_PADDING, y: -DECOMPOSITION_PADDING,
      width: size.width + 2 * DECOMPOSITION_PADDING, height: size.height + 2 * DECOMPOSITION_PADDING,
      rx: 12, 'aria-hidden': 'true'
    }));
    return size;
  };
  delete layer.dataset.complete;
  delete layer.dataset.usedCount;
  delete layer.dataset.currentIndex;
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', 'Decomposition list before reconstruction');
  layer.dataset.step = String(step);
  layer.append(svg('text', { class: 'lab-decomposition-title', x: 0, y: 22 }, 'Decomposition list'));
  if (!snapshot) {
    layer.append(svg('text', { class: 'lab-decomposition-status', x: 0, y: 48 }, unavailable));
    return withBackground({ width: availableWidth, height: 84 });
  }
  layer.dataset.complete = String(snapshot.complete);
  const layout = layoutDecomposition(snapshot, availableWidth);
  const label = `${snapshot.items.length} fragments, ${snapshot.pendingKeys.length} pending entries`;
  const currentIndex = reconstruction?.fragmentIndex ??
    (reconstruction?.event === 'seed' && snapshot.items.length ? snapshot.tallestIndex : undefined);
  const usedCount = reconstruction ? reconstruction.consumedEnd - reconstruction.consumedStart : 0;
  if (reconstruction) layer.dataset.usedCount = String(usedCount);
  if (currentIndex !== undefined) layer.dataset.currentIndex = String(currentIndex);
  layer.append(svg('text', { class: 'lab-decomposition-status', x: 0, y: 45 },
    reconstruction ? `${usedCount} / ${snapshot.items.length} used`
      : `${label} - ${step === -1 ? 'complete decomposition' : `T${step}`}`));
  const list = svg('g', { role: 'list' });
  for (const fragment of layout.fragments) {
    const { item, index, x, y } = fragment;
    const reused = item.side !== undefined;
    const kind = reused ? 'reused' : 'exploded';
    const consumed = reconstruction !== undefined && index >= reconstruction.consumedStart && index < reconstruction.consumedEnd;
    const current = currentIndex === index;
    const heading = `#${index + 1} ${reused ? 'Reused subtree' : 'Exploded leaf'} (h=${item.height})`;
    const card = svg('g', {
      class: `lab-decomposition-item is-${kind}${consumed ? ' is-consumed' : ''}${current ? ' is-current-fragment' : ''}`,
      transform: `translate(${x},${y})`,
      role: 'listitem', 'aria-label': reconstruction
        ? `${heading}; ${current ? 'current; ' : ''}${consumed ? 'used' : 'not used yet'}` : heading,
      'data-index': index,
      'data-kind': kind, 'data-height': item.height, 'data-keys': JSON.stringify(item.root.keys),
      'data-consumed': String(consumed)
    });
    card.append(svg('rect', {
      class: 'lab-decomposition-card', width: fragment.layout.width, height: fragment.layout.height, rx: 8
    }));
    if (reconstruction) {
      card.append(svg('rect', {
        class: 'lab-decomposition-state-band', x: 1, y: 1, width: fragment.layout.width - 2, height: 44, rx: 7,
        'aria-hidden': 'true'
      }));
      let badgeX = PADDING;
      const badge = (text: string, kind: string) => {
        const width = text.length * 7 + 16;
        const group = svg('g', {
          class: `lab-decomposition-badge is-${kind}`, transform: `translate(${badgeX},28)`
        });
        group.append(svg('rect', { width, height: 16, rx: 4 }),
          svg('text', { x: 8, y: 12 }, text));
        card.append(group);
        badgeX += width + 6;
      };
      if (current) {
        card.setAttribute('aria-current', 'step');
        badge('Current', 'current');
      }
      if (consumed) badge('Used', 'used');
      else if (!current) badge('Waiting', 'waiting');
    }
    card.append(svg('text', { class: 'lab-decomposition-label', x: PADDING, y: 24 }, heading));
    for (const edge of fragment.layout.edges)
      card.append(svg('path', { class: 'lab-decomposition-link',
        d: `M${edge.x1},${edge.y1} L${edge.x2},${edge.y2}` }));
    for (const placed of fragment.layout.nodes) {
      const node = placed.snapshot;
      const reference = reused ? identity(node.source) : undefined;
      const chosen = reference !== undefined && reference.id === selectedNodeId;
      const nodeGroup = svg('g', {
        class: `lab-decomposition-node${chosen ? ' is-node-selected' : ''}`,
        transform: `translate(${placed.x - placed.width / 2},${placed.y})`,
        'data-keys': JSON.stringify(node.keys), 'data-values': JSON.stringify(node.values),
        'data-leaf': String(!node.children.length)
      });
      if (reference) nodeGroup.dataset.nodeId = String(reference.id);
      const fill = reference?.color ?? (reused ? inputs[item.side!].color : resultColor);
      nodeGroup.append(svg('rect', { width: placed.width, height: NODE_HEIGHT, rx: 5, fill }));
      const cellWidth = placed.width / Math.max(1, node.keys.length);
      node.keys.forEach((key, index) => {
        if (index) nodeGroup.append(svg('line', {
          class: 'lab-cell-divider', x1: index * cellWidth, x2: index * cellWidth, y1: 0, y2: NODE_HEIGHT
        }));
        nodeGroup.append(svg('text', { class: 'lab-key', x: (index + 0.5) * cellWidth, y: 20, 'text-anchor': 'middle' }, formatKey(key)));
        if (!node.children.length) nodeGroup.append(svg('text', {
          class: 'lab-value', x: (index + 0.5) * cellWidth, y: 40, 'text-anchor': 'middle'
        }, valueText(node.values[index])));
      });
      if (reference && selectNode) {
        nodeGroup.setAttribute('role', 'button');
        nodeGroup.setAttribute('tabindex', '0');
        nodeGroup.setAttribute('aria-pressed', String(chosen));
        nodeGroup.setAttribute('aria-label', `Reused node ${reference.id}, keys ${node.keys.map(formatKey).join(', ')}`);
        nodeGroup.addEventListener('click', event => { event.stopPropagation(); selectNode(node.source); });
        nodeGroup.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); event.stopPropagation(); selectNode(node.source);
          }
        });
      }
      card.append(nodeGroup);
    }
    list.append(card);
  }
  layer.append(list);
  if (layout.pending) {
    const pending = layout.pending;
    const group = svg('g', { class: 'lab-decomposition-pending', transform: `translate(${pending.x},${pending.y})`,
      'data-keys': JSON.stringify(snapshot.pendingKeys), 'data-values': JSON.stringify(snapshot.pendingValues) });
    group.append(svg('rect', { class: 'lab-decomposition-card', width: pending.width, height: pending.height, rx: 8 }),
      svg('text', { class: 'lab-decomposition-label', x: PADDING, y: 24 }, 'Exploded entries - waiting to be made into leaves'));
    snapshot.pendingKeys.forEach((key, index) => {
      const x = PADDING + (index % pending.columns + 0.5) * pending.cellWidth;
      const y = 66 + Math.floor(index / pending.columns) * NODE_HEIGHT;
      group.append(svg('text', { class: 'lab-key', x, y, 'text-anchor': 'middle' }, formatKey(key)),
        svg('text', { class: 'lab-value', x, y: y + 20, 'text-anchor': 'middle' }, valueText(snapshot.pendingValues[index])));
    });
    layer.append(group);
  } else if (!snapshot.items.length) {
    layer.append(svg('text', { class: 'lab-decomposition-status', x: 0, y: 82 },
      snapshot.complete ? 'The decomposition is empty.' : 'No fragments emitted yet.'));
  }
  return withBackground(layout);
}
