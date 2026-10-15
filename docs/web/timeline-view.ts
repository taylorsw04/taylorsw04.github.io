import type { PlacedNode, TreeLayout } from './layout';
import { childrenOf } from './model';
import { formatKey } from './format';
import { locationPoint } from './timeline';
import type { CursorLocation, TimelineFrame, TracePoint } from './timeline';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string | number> = {}, text?: string
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Recorded movement and the separate END coverage indicator both use real input nodes. */
export function drawCursorTimeline(
  layer: SVGGElement, frame: TimelineFrame, inputs: readonly [TreeLayout, TreeLayout],
  scale: number, nodeId: (placed: PlacedNode) => number
): boolean {
  const fragment = document.createDocumentFragment();
  const fontSize = Math.min(40, 11 / scale);
  for (const side of [0, 1] as const) {
    const layout = inputs[side], cursor = frame.cursors[side];
    const leafClearance = Math.min(...layout.nodes.filter(node => node.node.isLeaf)
      .map(node => node.height - (node.valueY ?? node.keyY) - 10));
    const radius = Math.min(20, leafClearance, 16 / scale);
    const placedNodes = new Map<object, PlacedNode>(layout.nodes.map(placed => [placed.node, placed]));
    function point(location: TracePoint) {
      const placed = placedNodes.get(location.node);
      if (!placed || (!location.end &&
          (location.keyIndex < 0 || location.keyIndex >= placed.node.keys.length))) return undefined;
      return {
        x: location.end ? placed.x + placed.width / 2 + radius + 18
          : placed.x - placed.width / 2 + (location.keyIndex + 0.5) * placed.cellWidth,
        y: placed.y + (!location.end && placed.node.isLeaf ? placed.height : placed.keyY),
        nodeId: nodeId(placed), keyIndex: location.keyIndex, end: !!location.end
      };
    }
    const current = point(locationPoint(cursor.current));
    const previous = cursor.previous && point(locationPoint(cursor.previous));
    const path = cursor.path.map(point);
    if (!current || (cursor.previous && (!previous || cursor.previousMovedAt === undefined)) || path.some(point => !point)) {
      layer.replaceChildren();
      return false;
    }
    const group = svg('g', {
      class: 'lab-cursor-input', 'data-side': side, 'data-tree-id': layout.entry.id,
      transform: `translate(${layout.entry.x},${layout.entry.y})`
    });
    if (path.length) group.append(svg('path', {
      class: 'lab-cursor-trail', 'data-side': side, 'data-tree-id': layout.entry.id,
      'data-step': cursor.movedAt, 'data-current-key': cursor.current.ended ? 'END' : cursor.current.key,
      'data-points': JSON.stringify(path),
      d: path.map((point, index) => `${index ? 'L' : 'M'}${point!.x},${point!.y}`).join(' ')
    }));
    if (cursor.current.ended) {
      const coverage = [current];
      let rightmost = layout.nodes[0];
      while (true) {
        const keyIndex = rightmost.node.keys.length - 1;
        coverage.push({
          x: rightmost.x - rightmost.width / 2 + (keyIndex + 0.5) * rightmost.cellWidth,
          y: rightmost.y + rightmost.keyY, nodeId: nodeId(rightmost), keyIndex, end: false
        });
        const children = childrenOf(rightmost.node);
        if (!children.length) break;
        const child = placedNodes.get(children[children.length - 1]);
        if (!child) { layer.replaceChildren(); return false; }
        rightmost = child;
      }
      group.append(svg('path', {
        class: 'lab-cursor-completion', 'data-side': side, 'data-tree-id': layout.entry.id,
        'data-points': JSON.stringify(coverage), role: 'img',
        'aria-label': `${layout.entry.name} complete: all keys passed`,
        d: coverage.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ')
      }));
    }
    function marker(location: CursorLocation, movedAt: number, ghost: boolean): void {
      const position = point(locationPoint(location))!;
      const label = `T${movedAt}`;
      const labelFont = Math.min(fontSize, radius * 1.5 / (label.length * 0.65));
      const mark = svg('g', {
        class: ghost ? 'lab-cursor-ghost' : 'lab-cursor-current',
        transform: `translate(${position.x},${position.y})`,
        'data-side': side, 'data-tree-id': layout.entry.id, 'data-step': movedAt,
        'data-current-key': location.ended ? 'END' : location.key,
        'data-node-id': position.nodeId, 'data-leaf-index': location.leafIndex,
        'data-key-index': position.keyIndex, 'data-ended': String(location.ended),
        role: 'img', 'aria-label': `${layout.entry.name} ${ghost ? 'previous' : 'current'} cursor: ${
          location.ended ? 'END' : `key ${formatKey(location.key)}`}, ${label}`
      });
      if (!location.ended) mark.append(svg('line', {
        class: 'lab-cursor-stem', x1: 0, x2: 0, y1: -radius,
        y2: placedNodes.get(location.leaf)!.keyY + 5 - placedNodes.get(location.leaf)!.height
      }));
      mark.append(
        svg('circle', { r: radius }),
        svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': labelFont }, label)
      );
      if (location.ended) mark.append(svg('text', {
        class: 'lab-cursor-end', y: radius + fontSize + 3, 'text-anchor': 'middle', 'font-size': fontSize
      }, 'END'));
      group.append(mark);
    }
    if (cursor.previous) marker(cursor.previous, cursor.previousMovedAt!, true);
    marker(cursor.current, cursor.movedAt, false);
    fragment.append(group);
  }
  layer.dataset.step = String(frame.step);
  layer.replaceChildren(fragment);
  return true;
}
