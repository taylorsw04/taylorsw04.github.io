import type { InitialTree, Operation } from './model';

export type TimelinePhase = 'decomposition' | 'reconstruction';

export interface PlaygroundPermissions {
  addTrees: boolean;
  deleteTrees: boolean;
  moveTrees: boolean;
  combineTrees: boolean;
  cloneTrees: boolean;
  addElements: boolean;
  removeElements: boolean;
  treeMenus: boolean;
  selectNodes: boolean;
  selectOperations: boolean;
  timeline: boolean;
  pan: boolean;
  zoom: boolean;
  wheelPan: boolean;
}

export interface PlaygroundDisplay {
  toolbar: boolean;
  help: boolean;
  treeHeaders: boolean;
  treeFrames: boolean;
  nodeMetadata: boolean;
  leafValues: boolean;
  decompositionList: boolean;
  reconstruction: boolean;
  grid: boolean;
  frame: boolean;
  colorMode: 'provenance' | 'levels';
  height?: number;
}

export interface PlaygroundOptions {
  autoCenter?: boolean;
  initialLayout?: 'horizontal' | 'vertical';
  initialTrees?: readonly InitialTree[];
  initialOperations?: readonly { operation: Operation; left: number; right: number }[];
  selectedOperation?: number;
  pinSelectedOperation?: boolean;
  initialTimelineStep?: number;
  initialTimelinePhase?: TimelinePhase;
  initialReconstructionStep?: number;
  permissions?: Partial<PlaygroundPermissions>;
  display?: Partial<PlaygroundDisplay>;
}

export const DEFAULT_PERMISSIONS: Readonly<PlaygroundPermissions> = Object.freeze({
  addTrees: true, deleteTrees: true, moveTrees: true, combineTrees: true, treeMenus: true,
  cloneTrees: true, addElements: true, removeElements: true,
  selectNodes: true, selectOperations: true, timeline: true, pan: true, zoom: true, wheelPan: true
});

export const DEFAULT_DISPLAY: Readonly<PlaygroundDisplay> = Object.freeze({
  toolbar: true, help: true, treeHeaders: true, treeFrames: true, nodeMetadata: true,
  leafValues: false, decompositionList: false, reconstruction: false, grid: true, frame: true, colorMode: 'provenance'
});

export function resolveOptions(options: PlaygroundOptions = {}) {
  const permissions = { ...DEFAULT_PERMISSIONS, ...options.permissions };
  const display = { ...DEFAULT_DISPLAY, ...options.display };
  if (display.height !== undefined && (!Number.isFinite(display.height) || display.height <= 0))
    throw new Error('Canvas height must be a positive number.');
  const initialLayout = options.initialLayout ?? 'horizontal';
  if (initialLayout !== 'horizontal' && initialLayout !== 'vertical')
    throw new Error('Initial tree layout must be horizontal or vertical.');
  if (options.pinSelectedOperation && options.selectedOperation === undefined)
    throw new Error('Pinning an operation requires selectedOperation.');
  const initialTimelineStep = options.initialTimelineStep ?? -1;
  if (!Number.isInteger(initialTimelineStep) || initialTimelineStep < -1)
    throw new Error('Initial timeline step must be an integer at least -1.');
  if (initialTimelineStep >= 0 && (options.selectedOperation === undefined || !permissions.timeline))
    throw new Error('An initial cursor step requires selectedOperation and timeline navigation.');
  const initialTimelinePhase = options.initialTimelinePhase ?? 'decomposition';
  if (initialTimelinePhase !== 'decomposition' && initialTimelinePhase !== 'reconstruction')
    throw new Error('Timeline phase must be decomposition or reconstruction.');
  const initialReconstructionStep = options.initialReconstructionStep ?? 0;
  if (!Number.isInteger(initialReconstructionStep) || initialReconstructionStep < 0)
    throw new Error('Initial reconstruction step must be a nonnegative integer.');
  if (initialTimelinePhase === 'reconstruction' &&
      (options.selectedOperation === undefined || !permissions.timeline || !display.reconstruction))
    throw new Error('The reconstruction phase requires a selected operation and reconstruction timeline display.');
  return { ...options, autoCenter: options.autoCenter ?? false, initialLayout, initialTimelineStep,
    initialTimelinePhase, initialReconstructionStep, permissions, display };
}
