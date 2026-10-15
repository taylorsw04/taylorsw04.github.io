export interface KeyRange {
  readonly min: number;
  readonly max: number;
}
export type ElementAction = 'add' | 'remove';
export interface ElementEdit {
  readonly treeId: number;
  readonly action: ElementAction;
  readonly key: number;
  readonly range: KeyRange;
  readonly revision: number;
}

function sample(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error('The random source must return a number between 0 (inclusive) and 1 (exclusive).');
  return value;
}

function validateRange(range: KeyRange): void {
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max)
    throw new Error('The selected range must have finite, ordered bounds.');
}

export function randomExistingKey(keys: readonly number[], random = Math.random, range?: KeyRange): number {
  if (keys.length <= 1) throw new Error('Keep at least one element in the tree.');
  if (range) validateRange(range);
  const eligible = range ? keys.filter(key => key >= range.min && key <= range.max) : keys;
  if (!eligible.length) throw new Error('No elements remain in the selected range.');
  return eligible[Math.floor(sample(random) * eligible.length)];
}

export function randomNewKey(keys: readonly number[], random = Math.random, range?: KeyRange): number {
  if (!keys.length) throw new Error('Add element requires a non-empty tree.');
  const bounds = range || { min: keys[0], max: keys[keys.length - 1] };
  validateRange(bounds);
  const low = bounds.min === bounds.max ? bounds.min - 1 : bounds.min;
  const high = bounds.min === bounds.max ? bounds.max + 1 : bounds.max;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(low < high))
    throw new Error('The selected range is too large to sample safely.');
  const draw = sample(random), occupied = new Set(keys);
  const usable = (key: number) => key > low && key < high && !Number.isInteger(key) && !occupied.has(key);
  const candidate = low * (1 - draw) + high * draw;
  const rounded = Number(candidate.toFixed(6));
  if (usable(rounded)) return rounded;
  if (usable(candidate)) return candidate;

  // Resolve collisions deterministically rather than looping on random retries.
  const boundaries = [low, ...keys.filter(key => key > low && key < high), high];
  const candidates: number[] = [];
  for (let index = 1; index < boundaries.length; index++) {
    const a = boundaries[index - 1];
    let b = boundaries[index];
    for (let attempt = 0; attempt < 54; attempt++) {
      const midpoint = a / 2 + b / 2;
      if (!(midpoint > a && midpoint < b)) break;
      const short = Number(midpoint.toFixed(6));
      if (short > a && short < b && usable(short)) { candidates.push(short); break; }
      if (usable(midpoint)) { candidates.push(midpoint); break; }
      b = midpoint;
    }
  }
  if (!candidates.length) throw new Error('No distinct numeric key can be represented inside this range.');
  return candidates[Math.floor(draw * candidates.length)];
}
