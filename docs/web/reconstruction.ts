import type { DecompositionNode } from './timeline';

export type ReconstructionEvent = 'seed' | 'side' | 'fragment' | 'clone' | 'plan' |
  'split' | 'attach' | 'root' | 'merge' | 'balance' | 'metadata' | 'fragment-complete' | 'complete';

export interface ReconstructionNode extends DecompositionNode {
  readonly source: ObservedReconstructionNode;
  readonly id: number;
  readonly shared: boolean;
  readonly size: number;
  readonly children: readonly ReconstructionNode[];
}

export interface ReconstructionFrame {
  readonly step: number;
  readonly event: ReconstructionEvent;
  readonly message: string;
  readonly root?: ReconstructionNode;
  readonly detached: readonly ReconstructionNode[];
  readonly frontier: readonly number[];
  readonly changed: readonly number[];
  readonly side?: 'left' | 'right';
  readonly fragmentIndex?: number;
  readonly insertionDepth?: number;
  readonly cascadeEndDepth?: number;
  readonly pendingSizes: readonly number[];
  readonly consumedStart: number;
  readonly consumedEnd: number;
  readonly complete: boolean;
}

export interface ObservedReconstructionNode {
  readonly keys: readonly unknown[];
  readonly values: readonly unknown[];
  readonly children?: readonly ObservedReconstructionNode[];
  readonly isLeaf: boolean;
  readonly isShared?: boolean;
  size(): number;
}

export interface ReconstructionSide {
  readonly spine: readonly ObservedReconstructionNode[];
  readonly unflushedSizes: readonly number[];
  readonly fragmentIndex: number;
  readonly insertionDepth?: number;
  readonly cascadeEndDepth?: number;
}

export function recordedKey(key: unknown): number {
  if (typeof key !== 'number') throw new Error('Timeline recording requires numeric keys.');
  return key;
}

export function recordedValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  throw new Error('Timeline recording requires string or undefined values.');
}

const messages: Record<ReconstructionEvent, string> = {
  seed: 'Start from the tallest decomposition fragment',
  side: 'Follow the frontier for this side',
  fragment: 'Select the next fragment and its insertion depth',
  clone: 'Clone a shared frontier node before modifying it',
  plan: 'Find where the split cascade stops',
  split: 'Split a full node; keep its detached sibling as a carry',
  attach: 'Attach a subtree without propagating its size yet',
  root: 'Install the new root; the frontier will be refreshed next',
  merge: 'Merge an underfilled entry fragment into its boundary leaf',
  balance: 'Borrow entries from the neighboring leaf',
  metadata: 'Propagate deferred sizes and routing maxima',
  'fragment-complete': 'Finish this fragment and refresh the frontier',
  complete: 'Reconstruction complete'
};

export function reconstructionInsertionHeight(frame: ReconstructionFrame): number | undefined {
  return frame.insertionDepth === undefined ? undefined : frame.frontier.length - 1 - frame.insertionDepth;
}

const playbackCache = new WeakMap<readonly ReconstructionFrame[], readonly ReconstructionFrame[]>();

/** Keep real snapshots, but expose tree-building steps rather than every helper call. */
export function reconstructionPlayback(frames: readonly ReconstructionFrame[]): readonly ReconstructionFrame[] {
  const cached = playbackCache.get(frames);
  if (cached) return cached;
  const steps: ReconstructionFrame[] = [];
  const changed = new Set<number>();
  let repair: 'merge' | 'balance' | undefined;
  const append = (frame: ReconstructionFrame, message: string) => {
    steps.push(Object.freeze({
      ...frame, step: steps.length, message, changed: Object.freeze(Array.from(changed))
    }));
    changed.clear();
  };
  for (const frame of frames) {
    if (frame.event !== 'metadata') frame.changed.forEach(id => changed.add(id));
    if (frame.event === 'merge' || frame.event === 'balance') repair = frame.event;
    switch (frame.event) {
      case 'seed':
        append(frame, 'Start with the tallest fragment.');
        break;
      case 'fragment': {
        changed.clear();
        repair = undefined;
        const height = reconstructionInsertionHeight(frame);
        append(frame, `Select #${frame.fragmentIndex! + 1} - ${
          frame.insertionDepth === -1 ? 'new root at' : 'insert at'} height ${height}.`);
        break;
      }
      case 'split':
        append(frame, 'Split a full node.');
        break;
      case 'fragment-complete':
        append(frame, `${repair === 'merge' ? 'Merge' : 'Place'} #${frame.fragmentIndex! + 1}${
          repair === 'balance' ? ' and rebalance' : ''}.`);
        break;
      case 'complete': {
        const previous = steps[steps.length - 1];
        if (previous?.event === 'fragment-complete' || previous?.event === 'seed') {
          steps[steps.length - 1] = Object.freeze({
            ...frame, step: previous.step, changed: previous.changed,
            message: previous.event === 'seed' ? frame.root ? 'Single fragment - done.' : 'Empty result.'
              : `${previous.message.slice(0, -1)} - done.`
          });
        } else append(frame, 'Done.');
        break;
      }
    }
  }
  const playback = Object.freeze(steps);
  playbackCache.set(frames, playback);
  return playback;
}

/** Versioned snapshots share unchanged subtrees, but never reuse a stale mutated frontier. */
export class ReconstructionRecorder {
  readonly frames: ReconstructionFrame[] = [];
  private cache = new Map<ObservedReconstructionNode, ReconstructionNode>();
  private ids = new Map<ObservedReconstructionNode, number>();
  private detached = new Set<ObservedReconstructionNode>();
  private parents = new Map<ObservedReconstructionNode, ObservedReconstructionNode>();
  private readSide?: () => ReconstructionSide;
  private side?: 'left' | 'right';
  private activeFragment?: number;
  private consumedStart: number;
  private consumedEnd: number;

  constructor(private readRoot: () => ObservedReconstructionNode | undefined, tallestIndex: number) {
    this.consumedStart = Math.max(0, tallestIndex);
    this.consumedEnd = tallestIndex < 0 ? 0 : tallestIndex + 1;
    this.capture('seed');
  }

  observeSide(step: number, read: () => ReconstructionSide): void {
    this.side = step > 0 ? 'right' : 'left';
    this.readSide = read;
    this.activeFragment = undefined;
    this.capture('side');
  }

  private id(node: ObservedReconstructionNode): number {
    let id = this.ids.get(node);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(node, id);
    }
    return id;
  }

  capture(event: ReconstructionEvent, changed: readonly ObservedReconstructionNode[] = []): void {
    const root = this.readRoot(), state = this.readSide?.();
    if (event === 'fragment') this.activeFragment = state?.fragmentIndex;
    if (event === 'split' && changed[1]) this.detached.add(changed[1]);
    if (event === 'attach') {
      const [parent, child] = changed;
      if (child) this.detached.delete(child);
      if (parent && parent !== root && !state?.spine.includes(parent)) this.detached.add(parent);
    }
    if (root) this.detached.delete(root);
    if (event === 'fragment-complete' && this.activeFragment !== undefined) {
      this.consumedStart = Math.min(this.consumedStart, this.activeFragment);
      this.consumedEnd = Math.max(this.consumedEnd, this.activeFragment + 1);
    }
    const dirty = new Set<ObservedReconstructionNode>([...(state?.spine || []), ...changed, ...Array.from(this.detached)]);
    if (root) dirty.add(root);
    // Cloning propagates isShared to immediate children, including off-frontier siblings.
    for (const node of Array.from(dirty))
      node.children?.forEach(child => dirty.add(child));
    const snapshot = (node: ObservedReconstructionNode): ReconstructionNode => {
      const cached = this.cache.get(node);
      if (cached && !dirty.has(node)) return cached;
      for (const child of cached?.children || []) {
        const previous = child.source;
        if (this.parents.get(previous) === node && !node.children?.includes(previous)) this.parents.delete(previous);
      }
      node.children?.forEach(child => this.parents.set(child, node));
      const children = node.children?.map(snapshot) || [];
      const keys = node.keys.map(recordedKey), values = node.isLeaf ? node.values.map(recordedValue) : [];
      const shared = node.isShared === true, size = node.size();
      if (cached && cached.shared === shared && cached.size === size &&
          keys.length === cached.keys.length && keys.every((key, index) => key === cached.keys[index]) &&
          values.length === cached.values.length && values.every((value, index) => value === cached.values[index]) &&
          children.length === cached.children.length && children.every((child, index) => child === cached.children[index]))
        return cached;
      const next = Object.freeze({
        id: this.id(node), source: node, keys: Object.freeze(keys), values: Object.freeze(values),
        children: Object.freeze(children), shared, size
      });
      this.cache.set(node, next);
      return next;
    };
    const rootSnapshot = root && snapshot(root);
    const looseSnapshots = new Map(Array.from(this.detached, node => [node, snapshot(node)] as const));
    for (const node of Array.from(this.detached)) {
      let parent = this.parents.get(node);
      while (parent) {
        if (parent === root || this.detached.has(parent)) {
          this.detached.delete(node);
          break;
        }
        parent = this.parents.get(parent);
      }
    }
    const detached = Array.from(this.detached, node => looseSnapshots.get(node)!);
    const fragment = this.activeFragment;
    this.frames.push(Object.freeze({
      step: this.frames.length, event,
      message: `${messages[event]}${this.side && event !== 'complete' ? ` (${this.side})` : ''}${
        fragment === undefined ? '' : ` - fragment #${fragment + 1}`}`,
      root: rootSnapshot, detached: Object.freeze(detached),
      frontier: Object.freeze((state?.spine || (root ? [root] : [])).map(node => this.id(node))),
      changed: Object.freeze(changed.map(node => this.id(node))),
      side: this.side, fragmentIndex: fragment,
      insertionDepth: state?.insertionDepth, cascadeEndDepth: state?.cascadeEndDepth,
      pendingSizes: Object.freeze(state ? Array.from(state.unflushedSizes) : []),
      consumedStart: this.consumedStart, consumedEnd: this.consumedEnd, complete: event === 'complete'
    }));
    if (event === 'fragment-complete') this.activeFragment = undefined;
    if (event === 'complete' && this.detached.size)
      throw new Error('Reconstruction finished with unattached recorded carries.');
  }
}
