import * as original from '../../extended/parallelWalk';
import { observeCursor, observeMove } from './timeline';

export * from '../../extended/parallelWalk';

// Preserve the real signatures and forward all arguments, including future optional arguments.
export const createCursor: typeof original.createCursor = (...args) => {
  const cursor = original.createCursor(...args);
  observeCursor(cursor);
  return cursor;
};

export const moveTo: typeof original.moveTo = (...args) =>
  observeMove(args[0], () => original.moveTo(...args), result => result[0]);

export const moveForwardOne: typeof original.moveForwardOne = (...args) =>
  observeMove(args[0], () => original.moveForwardOne(...args), result => result);
