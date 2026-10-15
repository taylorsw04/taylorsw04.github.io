import type { Operation } from './model';

export interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChunkLeaf {
  id: string;
  left: number;
  right: number;
  bottom: number;
  chunk?: { number: number; rootId: string };
}

export interface ChunkRange {
  number: number;
  rootId: string;
  left: number;
  right: number;
  bottom: number;
  leafIds: string[];
}

export interface SequenceUnit {
  number: number;
  keys: readonly number[];
  maxKey: number;
  step?: number;
  reuseRootId?: string;
}

export interface SequenceLeaf {
  id: string;
  keys: readonly number[];
  left: number;
  right: number;
  bottom: number;
  cellWidth: number;
  reuseRootId?: string;
}

export interface SequenceRange {
  number: number;
  kind: 'step' | 'subtree' | 'entry';
  step?: number;
  rootId?: string;
  keys: number[];
  maxKey: number;
  left: number;
  right: number;
  bottom: number;
  leafIds: string[];
}

/** A cursor step spans adjacent output keys regardless of leaf or reuse boundaries. */
export function outputSequenceRanges(
  leaves: readonly SequenceLeaf[], sequence: readonly SequenceUnit[], passedBefore?: number
): SequenceRange[] {
  const byKey = new Map<number, SequenceUnit>();
  const byRoot = new Map<string, SequenceUnit>();
  for (const item of sequence) {
    for (const key of item.keys) byKey.set(key, item);
    if (item.reuseRootId !== undefined) byRoot.set(item.reuseRootId, item);
  }
  const passed = (item: SequenceUnit) => passedBefore === undefined || item.maxKey < passedBefore;
  const chunks: ChunkLeaf[] = [];
  const ranges: SequenceRange[] = [];
  const leavesById = new Map(leaves.map(leaf => [leaf.id, leaf] as const));
  let current: SequenceRange | undefined;
  for (const leaf of leaves.slice().sort((a, b) => a.left - b.left)) {
    const item = leaf.reuseRootId === undefined ? undefined : byRoot.get(leaf.reuseRootId);
    chunks.push({
      ...leaf,
      chunk: item && passed(item) ? { number: item.number, rootId: item.reuseRootId! } : undefined
    });
    if (item || !leaf.keys.length) {
      current = undefined;
      continue;
    }
    leaf.keys.forEach((key, index) => {
      const item = byKey.get(key);
      if (!item || !passed(item)) {
        current = undefined;
        return;
      }
      if (item.step !== undefined) {
        const left = leaf.left + index * leaf.cellWidth + (index === 0 ? 0 : 3);
        const right = leaf.left + (index + 1) * leaf.cellWidth - (index === leaf.keys.length - 1 ? 0 : 3);
        if (current?.number === item.number) {
          current.keys.push(key);
          current.right = right;
          current.bottom = Math.max(current.bottom, leaf.bottom);
          if (current.leafIds[current.leafIds.length - 1] !== leaf.id) current.leafIds.push(leaf.id);
        } else {
          current = {
            kind: 'step', number: item.number, step: item.step, keys: [key], maxKey: item.maxKey,
            left, right, bottom: leaf.bottom, leafIds: [leaf.id]
          };
          ranges.push(current);
        }
        return;
      }
      current = undefined;
      ranges.push({
        kind: 'entry', number: item.number, keys: [key], maxKey: item.maxKey,
        left: leaf.left + index * leaf.cellWidth + 3,
        right: leaf.left + (index + 1) * leaf.cellWidth - 3,
        bottom: leaf.bottom, leafIds: [leaf.id]
      });
    });
  }
  for (const chunk of leafChunkRanges(chunks)) {
    const keys: number[] = [];
    for (const id of chunk.leafIds) keys.push(...leavesById.get(id)!.keys);
    ranges.push({ ...chunk, kind: 'subtree', keys, maxKey: byRoot.get(chunk.rootId)!.maxKey });
  }
  return ranges.sort((a, b) => a.left - b.left);
}

export function operationLabel(operation: Operation, left: string, right: string, result: string): string {
  switch (operation) {
    case 'union': return `union ${left} and ${right} → ${result}`;
    case 'subtract': return `subtract ${right} from ${left} → ${result}`;
    case 'intersect': return `intersect ${left} and ${right} → ${result}`;
    default: throw new Error(`Unknown operation: ${operation}`);
  }
}

export function leafChunkRanges(leaves: readonly ChunkLeaf[]): ChunkRange[] {
  const ranges: ChunkRange[] = [];
  let current: ChunkRange | undefined;
  for (const leaf of leaves.slice().sort((a, b) => a.left - b.left)) {
    if (!leaf.chunk) {
      current = undefined;
    } else if (current && current.rootId === leaf.chunk.rootId && current.number === leaf.chunk.number) {
      current.right = leaf.right;
      current.bottom = Math.max(current.bottom, leaf.bottom);
      current.leafIds.push(leaf.id);
    } else {
      current = { ...leaf.chunk, left: leaf.left, right: leaf.right, bottom: leaf.bottom, leafIds: [leaf.id] };
      ranges.push(current);
    }
  }
  return ranges;
}

export function placeLabel(
  candidates: readonly { x: number; y: number }[],
  width: number,
  height: number,
  obstacles: readonly Rectangle[]
): { x: number; y: number } {
  if (!candidates.length) throw new Error('An operation label needs a position on its connector.');
  let best = candidates[0], bestOverlap = Infinity;
  for (const candidate of candidates) {
    let overlap = 0;
    for (const rectangle of obstacles) {
      const x = Math.max(0, Math.min(candidate.x + width / 2, rectangle.right) -
        Math.max(candidate.x - width / 2, rectangle.left));
      const y = Math.max(0, Math.min(candidate.y + height / 2, rectangle.bottom) -
        Math.max(candidate.y - height / 2, rectangle.top));
      overlap += x * y;
    }
    if (overlap < bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
    if (overlap === 0) return candidate;
  }
  return best;
}
