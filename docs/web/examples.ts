import type { PlaygroundOptions } from './options';
import presets from './presets.json';

type PresetName = keyof typeof presets;
function frozenUnion(left: number[], right: number[]): PlaygroundOptions {
  return {
    initialTrees: [
      { keys: left, values: left.map(key => `a${key}`) },
      { keys: right, values: right.map(key => `b${key}`) }
    ],
    initialOperations: [{ operation: 'union', left: 0, right: 1 }],
    selectedOperation: 2,
    pinSelectedOperation: true,
    permissions: {
      addTrees: false, deleteTrees: false, moveTrees: false, combineTrees: false,
      cloneTrees: false, addElements: false, removeElements: false, treeMenus: false,
      selectNodes: true, selectOperations: false, timeline: false, wheelPan: false
    },
    display: { help: false }
  };
}

function unionTimeline(left: number[], right: number[]): PlaygroundOptions {
  const options = frozenUnion(left, right);
  return {
    ...options,
    initialTimelineStep: -1,
    display: { ...options.display, decompositionList: true, reconstruction: false },
    permissions: { ...options.permissions, timeline: true }
  };
}

function reconstructionTimeline(options: PlaygroundOptions): PlaygroundOptions {
  return {
    ...options,
    display: { ...options.display, decompositionList: true, reconstruction: true },
    permissions: { ...options.permissions, timeline: true },
    initialTimelineStep: -1, initialTimelinePhase: 'reconstruction', initialReconstructionStep: 0
  };
}

const examples: Record<PresetName, () => PlaygroundOptions> = {
  playground: () => ({ display: { decompositionList: true, reconstruction: true } }),
  recap: () => ({
    autoCenter: true,
    initialTrees: [{
      keys: Array.from({ length: 32 }, (_, key) => key),
      values: Array.from({ length: 32 }, (_, index) => `v${index + 1}`)
    }],
    permissions: {
      addTrees: false, deleteTrees: false, moveTrees: false, combineTrees: false, cloneTrees: false,
      treeMenus: true, selectNodes: false, selectOperations: false, timeline: false,
      wheelPan: false
    },
    display: {
      toolbar: true, help: false, treeHeaders: false, treeFrames: false, nodeMetadata: false,
      leafValues: true, grid: false, frame: false, colorMode: 'levels', height: 300
    }
  }),
  sharing: () => ({
    initialLayout: 'vertical',
    initialTrees: [
      {
        keys: Array.from({ length: 16 }, (_, key) => key),
        values: Array.from({ length: 16 }, (_, index) => `v${index + 1}`)
      },
      { cloneOf: 0 }
    ],
    permissions: {
      addTrees: false, combineTrees: false, cloneTrees: true,
      addElements: true, removeElements: true, wheelPan: false
    },
    display: { help: false, height: 450 }
  }),
  'small-overlap': () => frozenUnion(
    Array.from({ length: 51 }, (_, key) => key),
    Array.from({ length: 56 }, (_, index) => 45 + index)
  ),
  'step-timeline': () => unionTimeline(
    [...Array.from({ length: 51 }, (_, key) => key), 88],
    [22, ...Array.from({ length: 56 }, (_, index) => 45 + index)]
  ),
  slice: () => ({
    ...unionTimeline(Array.from({ length: 200 }, (_, index) => index + 1), [122]),
    initialTimelineStep: 1
  }),
  'reconstruction-min': () => reconstructionTimeline(examples['step-timeline']()),
  'reconstruction-max': () => reconstructionTimeline(examples['alternating-overlap']()),
  'large-overlap': () => {
    const ranges = (offset: number) => [0, 20, 40].reduce<number[]>((keys, start) =>
      keys.concat(Array.from({ length: 11 }, (_, index) => start + offset + index)), []);
    return frozenUnion(ranges(0), ranges(5));
  },
  'alternating-overlap': () => frozenUnion(
    Array.from({ length: 20 }, (_, index) => index * 2),
    Array.from({ length: 20 }, (_, index) => index * 2 + 1)
  ),
  'union-demo': () => ({
    initialOperations: [{ operation: 'union', left: 0, right: 1 }],
    selectedOperation: 2,
    permissions: {
      addTrees: false, deleteTrees: false, moveTrees: false, combineTrees: false, wheelPan: false,
      cloneTrees: false, addElements: false, removeElements: false
    }
  })
};

export function exampleOptions(name: string): PlaygroundOptions {
  if (Object.prototype.hasOwnProperty.call(examples, name)) return examples[name as PresetName]();
  throw new Error(`Unknown B+ tree example: ${name}`);
}
