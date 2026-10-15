import type { Cursor } from '../../extended/parallelWalk';
import { BNode, BNodeInternal } from '../../b+tree';
import { ReconstructionRecorder, recordedKey, recordedValue } from './reconstruction';
import type { ObservedReconstructionNode, ReconstructionEvent, ReconstructionFrame, ReconstructionSide } from './reconstruction';

export type CursorSide = 0 | 1;
export interface TracePoint {
  readonly node: object;
  readonly keyIndex: number;
  readonly end?: boolean;
}
export interface CursorLocation {
  readonly leaf: object;
  readonly leafIndex: number;
  readonly key: number;
  readonly spine: readonly { readonly node: object; readonly childIndex: number }[];
  readonly ended: boolean;
}
export interface CursorFrame {
  readonly current: CursorLocation;
  readonly movedAt: number;
  readonly previous?: CursorLocation;
  readonly previousMovedAt?: number;
  readonly path: readonly TracePoint[];
}
export interface TimelineFrame {
  readonly step: number;
  readonly moved?: CursorSide;
  readonly cursors: readonly [CursorFrame, CursorFrame];
  readonly decomposition?: DecompositionSnapshot;
}
export interface CursorTimeline {
  readonly kind: 'walk' | 'fast-path' | 'unavailable';
  readonly message: string;
  readonly frames: readonly TimelineFrame[];
  readonly decomposition?: DecompositionSnapshot;
  readonly reconstruction?: readonly ReconstructionFrame[];
}
export interface DecompositionNode {
  readonly source: object;
  readonly keys: readonly number[];
  readonly values: readonly (string | undefined)[];
  readonly children: readonly DecompositionNode[];
}
export interface DecompositionItem {
  readonly root: DecompositionNode;
  readonly height: number;
  readonly side?: CursorSide;
}
export interface DecompositionSnapshot {
  readonly items: readonly DecompositionItem[];
  readonly pendingKeys: readonly number[];
  readonly pendingValues: readonly (string | undefined)[];
  readonly tallestIndex: number;
  readonly complete: boolean;
}
interface DecompositionState<K, V> {
  nodes: readonly BNode<K, V>[];
  heights: readonly number[];
  pendingKeys: readonly K[];
  pendingValues: readonly V[];
  tallestIndex: number;
}

interface Tracker {
  side: CursorSide;
  snapshot: (ended?: boolean) => CursorLocation;
  frame: CursorFrame;
  path?: TracePoint[];
}

function snapshot<K, V, P>(cursor: Cursor<K, V, P>, ended = false): CursorLocation {
  const key = cursor.leaf.keys[cursor.leafIndex];
  if (typeof key !== 'number') throw new Error('The cursor recorder requires a valid numeric leaf position.');
  return Object.freeze({
    leaf: cursor.leaf, leafIndex: cursor.leafIndex, key, ended,
    spine: Object.freeze(cursor.spine.map(entry => Object.freeze({
      node: entry.node, childIndex: entry.childIndex
    })))
  });
}

export function locationPoint(location: CursorLocation): TracePoint {
  if (location.ended) {
    const root = location.spine[0]?.node || location.leaf;
    return { node: root, keyIndex: -1, end: true };
  }
  return { node: location.leaf, keyIndex: location.leafIndex };
}

/** The prefix completed by both cursors; equality has not yet passed the key. */
export function processedThrough(frame: TimelineFrame): number {
  return Math.min(...frame.cursors.map(cursor =>
    cursor.current.ended ? Infinity : cursor.current.key));
}

class Recorder {
  readonly frames: TimelineFrame[] = [];
  decomposition?: DecompositionSnapshot;
  private readDecomposition?: (complete?: boolean) => DecompositionSnapshot;
  private trackers = new Map<object, Tracker>();
  private sides: [Tracker | undefined, Tracker | undefined] = [undefined, undefined];
  reconstruction?: ReconstructionRecorder;

  constructor(private left: object, private right: object, private captureDecomposition: boolean,
    private captureReconstruction: boolean) {}

  beginReconstruction(readRoot: () => ObservedReconstructionNode | undefined, tallestIndex: number): void {
    if (!this.captureReconstruction) return;
    if (this.reconstruction) throw new Error('A recorded operation cannot reconstruct twice.');
    this.reconstruction = new ReconstructionRecorder(readRoot, tallestIndex);
  }

  observeDecomposition<K, V>(left: BNode<K, V>, right: BNode<K, V>, read: () => DecompositionState<K, V>): void {
    if (!this.captureDecomposition) return;
    if (this.readDecomposition || this.decomposition)
      throw new Error('A recorded operation cannot contain multiple decompositions.');
    const sides = new Map<object, CursorSide>();
    const mark = (node: BNode<K, V>, side: CursorSide): void => {
      if (sides.has(node)) return;
      sides.set(node, side);
      if (node instanceof BNodeInternal) node.children.forEach(child => mark(child, side));
    };
    mark(left, 0);
    mark(right, 1);
    const keys = (values: readonly K[]) => Object.freeze(values.map(recordedKey));
    const values = (entries: readonly V[]) => Object.freeze(entries.map(recordedValue));
    const snapshots = new Map<object, DecompositionNode>();
    const nodeSnapshot = (node: BNode<K, V>): DecompositionNode => {
      let snapshot = snapshots.get(node);
      if (!snapshot) {
        snapshot = Object.freeze({
          source: node, keys: keys(node.keys), values: node.isLeaf ? values(node.values) : Object.freeze([]),
          children: Object.freeze(node instanceof BNodeInternal ? node.children.map(nodeSnapshot) : [])
        });
        snapshots.set(node, snapshot);
      }
      return snapshot;
    };
    const items: DecompositionItem[] = [];
    const pendingKeyHistory: number[] = [];
    const pendingValueHistory: (string | undefined)[] = [];
    let pendingStart = 0, pendingLength = 0;
    this.readDecomposition = (complete = false) => {
      const state = read();
      if (state.nodes.length !== state.heights.length || state.nodes.length < items.length ||
          state.pendingKeys.length !== state.pendingValues.length)
        throw new Error('The decomposition list must be append-only with matching node heights.');
      if (state.nodes.length > items.length) {
        pendingStart = pendingKeyHistory.length;
        pendingLength = 0;
      }
      while (items.length < state.nodes.length) {
        const index = items.length, node = state.nodes[index];
        items.push(Object.freeze({ root: nodeSnapshot(node), height: state.heights[index], side: sides.get(node) }));
      }
      if (!complete) {
        if (state.pendingKeys.length < pendingLength)
          throw new Error('Pending decomposition entries disappeared without being emitted.');
        for (let index = pendingLength; index < state.pendingKeys.length; index++) {
          pendingKeyHistory.push(recordedKey(state.pendingKeys[index]));
          pendingValueHistory.push(recordedValue(state.pendingValues[index]));
        }
        pendingLength = state.pendingKeys.length;
      }
      const itemCount = items.length, start = pendingStart, count = complete ? 0 : pendingLength;
      // Keep frame storage linear; materialize immutable prefix arrays only when a frame is viewed.
      return Object.freeze({
        get items() { return Object.freeze(items.slice(0, itemCount)); },
        get pendingKeys() { return Object.freeze(pendingKeyHistory.slice(start, start + count)); },
        get pendingValues() { return Object.freeze(pendingValueHistory.slice(start, start + count)); },
        tallestIndex: state.tallestIndex, complete
      });
    };
  }

  finishDecomposition(): void {
    if (!this.captureDecomposition) return;
    if (!this.readDecomposition) throw new Error('Decomposition finished without an observed list.');
    this.decomposition = this.readDecomposition(true);
    this.readDecomposition = undefined;
    const last = this.frames.length - 1;
    if (last >= 0)
      this.frames[last] = Object.freeze({ ...this.frames[last], decomposition: this.decomposition });
  }

  attach<K, V, P>(cursor: Cursor<K, V, P>): Tracker {
    let side: CursorSide;
    if (cursor.tree === this.left && !this.sides[0]) side = 0;
    else if (cursor.tree === this.right && !this.sides[1]) side = 1;
    else throw new Error('Cursor recording contract changed: unexpected cursor or input tree.');
    const tracker: Tracker = {
      side, snapshot: ended => snapshot(cursor, ended),
      frame: Object.freeze({ current: snapshot(cursor), movedAt: 0, path: Object.freeze([]) })
    };
    this.sides[side] = tracker;
    this.trackers.set(cursor, tracker);
    if (this.sides[0] && this.sides[1]) this.pushFrame();
    return tracker;
  }

  private pushFrame(moved?: CursorSide): void {
    const [left, right] = this.sides;
    if (!left || !right) throw new Error('Cursor recording requires both input cursors.');
    const cursors = Object.freeze([left.frame, right.frame] as const);
    this.frames.push(Object.freeze({
      step: this.frames.length, moved, cursors, decomposition: this.readDecomposition?.()
    }));
  }

  move<R>(cursor: object, run: () => R, outOfTree: (result: R) => boolean): R {
    const tracker = this.trackers.get(cursor);
    if (!tracker) throw new Error('Cursor recording contract changed: movement of an unobserved cursor.');
    if (tracker.path) throw new Error('Nested movement of the same cursor is not supported by the recorder.');
    const previous = tracker.frame;
    tracker.path = [locationPoint(previous.current)];
    try {
      const value = run();
      const ended = outOfTree(value);
      const current = tracker.snapshot(ended);
      const changed = current.ended !== previous.current.ended ||
        current.leaf !== previous.current.leaf || current.leafIndex !== previous.current.leafIndex;
      // A repeated failed seek on an already exhausted cursor is not another movement.
      if (changed) {
        appendPoint(tracker, locationPoint(current));
        const path = Object.freeze(tracker.path.map(point => Object.freeze({ ...point })));
        tracker.frame = Object.freeze({
          current, movedAt: this.frames.length,
          previous: previous.current, previousMovedAt: previous.movedAt, path
        });
        this.pushFrame(tracker.side);
      }
      return value;
    } finally {
      tracker.path = undefined;
    }
  }
}

function appendPoint(tracker: Tracker, point: TracePoint): void {
  const path = tracker.path;
  if (!path) return;
  const last = path[path.length - 1];
  if (!last || last.node !== point.node || last.keyIndex !== point.keyIndex || !!last.end !== !!point.end)
    path.push(point);
}

let active: Recorder | undefined;

/** Build-time instrumentation observes real private locals without changing the library source. */
export function observeDecomposition<K, V>(
  left: BNode<K, V>, right: BNode<K, V>, read: () => DecompositionState<K, V>
): void {
  active?.observeDecomposition(left, right, read);
}

export function finishDecomposition(): void {
  active?.finishDecomposition();
}

export function beginReconstruction(readRoot: () => ObservedReconstructionNode | undefined, tallestIndex: number): void {
  active?.beginReconstruction(readRoot, tallestIndex);
}

export function observeReconstructionSide(step: number, read: () => ReconstructionSide): void {
  active?.reconstruction?.observeSide(step, read);
}

export function recordReconstructionEvent(event: ReconstructionEvent, nodes: readonly ObservedReconstructionNode[] = []): void {
  active?.reconstruction?.capture(event, nodes);
}

/** Used only by the documentation build's parallelWalk adapter. */
export function observeCursor<K, V, P>(cursor: Cursor<K, V, P>): void {
  if (!active) return;
  const tracker = active.attach(cursor);
  const moveInLeaf = cursor.onMoveInLeaf;
  cursor.onMoveInLeaf = function(...args) {
    appendPoint(tracker, { node: args[0], keyIndex: args[3] });
    return moveInLeaf.apply(this, args);
  };
  const stepUp = cursor.onStepUp;
  cursor.onStepUp = function(...args) {
    appendPoint(tracker, { node: args[0], keyIndex: args[3] });
    if (Number.isFinite(args[5])) appendPoint(tracker, { node: args[0], keyIndex: args[5] });
    return stepUp.apply(this, args);
  };
  const stepDown = cursor.onStepDown;
  cursor.onStepDown = function(...args) {
    appendPoint(tracker, { node: args[0], keyIndex: args[3] });
    return stepDown.apply(this, args);
  };
  const enterLeaf = cursor.onEnterLeaf;
  cursor.onEnterLeaf = function(...args) {
    appendPoint(tracker, { node: args[0], keyIndex: args[1] });
    return enterLeaf.apply(this, args);
  };
}

export function observeMove<R>(cursor: object, run: () => R, outOfTree: (result: R) => boolean): R {
  return active ? active.move(cursor, run, outOfTree) : run();
}

export function recordOperation<T>(
  left: { readonly size: number },
  right: { readonly size: number },
  operation: string,
  run: () => T,
  captureDecomposition = false,
  captureReconstruction = false
): { value: T; timeline: CursorTimeline } {
  const previous = active;
  const recorder = new Recorder(left, right, captureDecomposition || captureReconstruction, captureReconstruction);
  active = recorder;
  try {
    const value = run();
    const frames = Object.freeze(recorder.frames.slice());
    let kind: CursorTimeline['kind'] = 'walk';
    let message = operation === 'intersect' ? 'Intersection cursor walk' : 'Decomposition cursor walk';
    if (!frames.length) {
      if (!left.size || !right.size || (operation === 'union' && left === right)) {
        kind = 'fast-path';
        message = 'No cursor walk: fast path.';
      } else {
        kind = 'unavailable';
        message = 'Cursor recording is unavailable: the documentation adapter did not capture this operation.';
      }
    }
    return { value, timeline: Object.freeze({
      kind, message, frames, decomposition: recorder.decomposition,
      reconstruction: recorder.reconstruction && Object.freeze(recorder.reconstruction.frames.slice())
    }) };
  } finally {
    active = previous;
  }
}
