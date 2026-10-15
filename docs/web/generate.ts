export type Generation =
  | { kind: 'size'; count: number; start: number }
  | { kind: 'ranges'; ranges: string }
  | { kind: 'random'; count: number; min: number; max: number; seed: number };

export const MAX_GENERATED_KEYS = 10000;

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
}

function countWithinLimit(count: number): void {
  integer(count, 'Size');
  if (count < 0 || count > MAX_GENERATED_KEYS)
    throw new Error(`Size must be between 0 and ${MAX_GENERATED_KEYS.toLocaleString('en-US')} keys.`);
}

function rangeSize(start: number, end: number): number {
  integer(start, 'Range start');
  integer(end, 'Range end');
  if (end < start) throw new Error('Range end must be greater than or equal to its start.');
  const size = end - start + 1;
  if (!Number.isSafeInteger(size)) throw new Error('The range is too wide for precise integer sampling.');
  return size;
}

function keysFromRanges(source: string): number[] {
  if (!source.trim()) throw new Error('Enter at least one key or range, such as 0..15, 40..55, 90.');
  const parts = source.split(/[,\n]/).map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter at least one key or range.');
  const intervals = parts.map(part => {
    const match = /^\s*(-?\d+)\s*(?:\.\.\s*(-?\d+))?\s*$/.exec(part);
    if (!match) throw new Error(`Invalid range "${part.trim()}". Use integers or start..end, separated by commas or new lines.`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    rangeSize(start, end);
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const count = merged.reduce((sum, interval) => sum + rangeSize(interval.start, interval.end), 0);
  countWithinLimit(count);
  const keys: number[] = [];
  for (const interval of merged) {
    const length = rangeSize(interval.start, interval.end);
    for (let index = 0; index < length; index++) keys.push(interval.start + index);
  }
  return keys;
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateKeys(spec: Generation): number[] {
  switch (spec.kind) {
    case 'ranges': return keysFromRanges(spec.ranges);
    case 'size': {
      countWithinLimit(spec.count);
      integer(spec.start, 'Starting key');
      if (spec.count > 0) integer(spec.start + (spec.count - 1), 'Final key');
      return Array.from({ length: spec.count }, (_, index) => spec.start + index);
    }
    case 'random': {
      countWithinLimit(spec.count);
      const available = rangeSize(spec.min, spec.max);
      if (spec.count > available)
        throw new Error(`The range contains only ${available} distinct keys; reduce the size or widen the bounds.`);
      integer(spec.seed, 'Seed');
      if (spec.seed < 0 || spec.seed > 0xFFFFFFFF)
        throw new Error('Seed must be between 0 and 4294967295.');
      const random = randomSource(spec.seed);
      const selected = new Set<number>();
      // Floyd's sampling takes exactly count iterations, even when the interval is nearly full.
      for (let index = available - spec.count; index < available; index++) {
        const sample = Math.floor(random() * (index + 1));
        selected.add(selected.has(sample) ? index : sample);
      }
      return Array.from(selected, offset => spec.min + offset).sort((a, b) => a - b);
    }
    default: throw new Error('Unknown key generation method.');
  }
}
