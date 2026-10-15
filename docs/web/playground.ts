import { select } from 'd3-selection';
import { zoom, zoomIdentity, ZoomTransform } from 'd3-zoom';
import { CanvasTree, NodeIdentity, TreeCanvasModel } from './model';
import { Generation, MAX_GENERATED_KEYS, generateKeys } from './generate';
import { HEADER_HEIGHT, PlacedNode, TreeLayout, editTarget, formatLeafValue, layoutTree, selectedNodeInLayout } from './layout';
import { Rectangle, SequenceLeaf, SequenceUnit, outputSequenceRanges, operationLabel, placeLabel } from './annotations';
import { processedThrough } from './timeline';
import type { TimelineFrame } from './timeline';
import { drawCursorTimeline } from './timeline-view';
import { DECOMPOSITION_PADDING, drawDecomposition } from './decomposition-view';
import { drawReconstruction } from './reconstruction-view';
import { reconstructionPlayback } from './reconstruction';
import type { ReconstructionFrame, ReconstructionNode } from './reconstruction';
import { PlaygroundOptions, resolveOptions, TimelinePhase } from './options';
import type { ElementAction, ElementEdit, KeyRange } from './edit-element';
import { formatKey } from './format';
import './playground.css';

export type { PlaygroundOptions } from './options';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.00001;
let nextInstance = 0;
const mounted = new WeakMap<HTMLElement, () => void>();

// Shared (page-wide, not per-instance) touch tracking used by every playground's outside-tap
// dismissal below. A touch pointerdown must never run the dismiss/re-render path directly, since
// that would mutate the DOM in the touchstart-to-touchend window iOS Safari uses to decide
// whether to cancel the synthesized click -- doing so even once, on an outside tap while some
// *other* diagram instance genuinely has a menu/selection open, is enough to trigger it. Instead,
// we tag the eventual 'click' event (fired only after touchend, once Safari has already committed
// to synthesizing it) with whether it was touch-originated, so each instance can safely run its
// real dismiss logic there instead. A capture-phase listener tags the event exactly once, globally,
// so per-instance bubble-phase listeners can all read the same tag off the same event object
// without racing each other or leaking state into an unrelated later keyboard-triggered click.
let lastPointerDownWasTouch = false;
const touchOriginatedClicks = new WeakSet<MouseEvent>();
let globalTouchTrackerInstances = 0;
function trackPointerDown(event: PointerEvent): void {
  lastPointerDownWasTouch = event.pointerType === 'touch';
}
function tagTouchOriginatedClick(event: MouseEvent): void {
  if (lastPointerDownWasTouch) touchOriginatedClicks.add(event);
  lastPointerDownWasTouch = false;
}
function attachGlobalTouchTracker(): void {
  if (globalTouchTrackerInstances++ === 0) {
    document.addEventListener('pointerdown', trackPointerDown, true);
    document.addEventListener('click', tagTouchOriginatedClick, true);
  }
}
function detachGlobalTouchTracker(): void {
  if (--globalTouchTrackerInstances === 0) {
    document.removeEventListener('pointerdown', trackPointerDown, true);
    document.removeEventListener('click', tagTouchOriginatedClick, true);
  }
}
type Interaction =
  | { kind: 'idle' }
  | { kind: 'picking'; left: number }
  | { kind: 'operation'; left: number; right: number };
type Highlight =
  | { kind: 'none' }
  | { kind: 'node'; identity: NodeIdentity }
  | { kind: 'operation'; result: number };
interface SubtreeColor {
  rootId: string;
  fill: string;
  stroke: string;
}

function subtreeColor(identity: NodeIdentity, darkened = false): SubtreeColor {
  const color = identity.owner.color;
  return {
    rootId: String(identity.id),
    fill: darkened ? `color-mix(in srgb, ${color} 75%, black)` : color,
    stroke: `color-mix(in srgb, ${color} 40%, black)`
  };
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string | number> = {}, text?: string
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function required<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing playground element: ${selector}`);
  return element;
}

export function mountPlayground(host: HTMLElement, options: PlaygroundOptions = {}): () => void {
  const { permissions, display, initialTrees, initialOperations, selectedOperation, pinSelectedOperation,
    initialTimelineStep, initialTimelinePhase, initialReconstructionStep, autoCenter, initialLayout } = resolveOptions(options);
  const model = new TreeCanvasModel(initialTrees, display.decompositionList, display.reconstruction);
  for (const { left, right, operation } of initialOperations || [])
    model.combine(left, right, operation);
  if (selectedOperation !== undefined && !model.get(selectedOperation).origin)
    throw new Error('The selected tree must be an operation result.');
  mounted.get(host)?.();
  attachGlobalTouchTracker();
  const instance = ++nextInstance;
  const addPanelId = `lab-add-panel-${instance}`;
  const helpId = `lab-help-${instance}`;
  const timelineMessageId = `lab-timeline-message-${instance}`;
  const layoutOptions = {
    ...display,
    annotations: permissions.selectOperations || selectedOperation !== undefined
  };
  const canClearSelection = permissions.selectNodes || permissions.selectOperations;
  host.classList.add('tree-playground');
  host.classList.toggle('lab-no-frame', !display.frame);
  host.classList.toggle('lab-no-grid', !display.grid);
  host.classList.toggle('lab-can-pan', permissions.pan);
  host.innerHTML = `
    <div class="lab-surface">
      <div class="lab-camera" role="toolbar" aria-label="Canvas view">
        <button type="button" data-action="out" aria-label="Zoom out">−</button>
        <output class="lab-scale" aria-label="Zoom level">100%</output>
        <button type="button" data-action="in" aria-label="Zoom in">+</button>
        <button type="button" data-action="fit">Fit all</button>
        <button type="button" data-action="add" aria-expanded="false" aria-controls="${addPanelId}">Add tree</button>
      </div>
      <svg class="lab-canvas" tabindex="0" role="group" aria-label="Interactive B+ tree canvas"
        ${display.help ? `aria-describedby="${helpId}"` : ''}></svg>
      <div class="lab-empty" hidden>No trees yet. Use Add tree to start.</div>
      <div class="lab-pick-prompt" hidden>
        <span role="status"></span><button type="button" data-action="cancel">Cancel</button>
      </div>
      <div class="lab-tree-menu" role="toolbar" aria-label="Tree actions" hidden>
        <strong class="lab-menu-name"></strong>
        <div class="lab-menu-actions">
          <button type="button" data-action="center-tree">Center</button>
          <button type="button" data-action="add-element">Add element</button>
          <button type="button" data-action="remove-element">Remove element</button>
          <button type="button" data-action="clone">Clone</button>
          <button type="button" data-action="combine">Combine with another tree</button>
          <button type="button" data-action="delete" class="lab-danger">Delete</button>
        </div>
      </div>
      <section id="${addPanelId}" class="lab-popover lab-add-panel" role="dialog" aria-label="Add tree" hidden>
        <div class="lab-popover-heading"><h3>Add tree</h3>
          <button type="button" data-action="close-add" aria-label="Close Add tree">×</button>
        </div>
        <form class="lab-create" novalidate>
          <div class="lab-fields">
            <label>Method <select name="generation" aria-label="Generation method">
              <option value="size">By size (consecutive keys)</option>
              <option value="ranges">Ranges and individual keys</option>
              <option value="random">Random unique keys</option>
            </select></label>
            <label class="lab-count">Size <input name="count" type="number" value="32" min="0"
              max="${MAX_GENERATED_KEYS}" step="1" required></label>
          </div>
          <fieldset data-generator="size">
            <label>Starting key <input name="start" type="number" value="0" step="1" required></label>
          </fieldset>
          <fieldset data-generator="ranges" hidden disabled>
            <label>Keys and inclusive ranges
              <textarea name="ranges" rows="2" spellcheck="false">0..15, 40..55, 90</textarea>
            </label>
            <p class="lab-semantics">Use start..end or individual integers, separated by commas or new lines.
              Negative keys are welcome; overlaps and duplicates are merged.</p>
          </fieldset>
          <fieldset data-generator="random" hidden disabled>
            <div class="lab-fields">
              <label>Minimum key <input name="minimum" type="number" value="0" step="1" required></label>
              <label>Maximum key <input name="maximum" type="number" value="199" step="1" required></label>
              <label>Seed <input name="seed" type="number" value="42" min="0" max="4294967295" step="1" required></label>
              <button type="button" data-action="new-seed">New seed</button>
            </div>
            <p class="lab-semantics">Bounds are inclusive. Keys are unique; the same seed and settings
              reproduce the same keys in a new, independently allocated tree.</p>
          </fieldset>
          <p class="lab-generation-preview" aria-live="polite"></p>
          <p class="lab-semantics">Up to ${MAX_GENERATED_KEYS.toLocaleString('en-US')} keys per generated tree.
            Size 0 creates an empty tree.</p>
          <p class="lab-error" role="alert" hidden></p>
          <div class="lab-form-actions"><button type="submit" class="lab-primary">Add tree</button></div>
        </form>
      </section>
      <section class="lab-popover lab-combine-panel" role="dialog" aria-label="Combine trees" hidden>
        <div class="lab-popover-heading"><h3>Combine trees</h3>
          <button type="button" data-action="cancel" aria-label="Cancel combination">×</button>
        </div>
        <form class="lab-combine">
          <p class="lab-operands"></p>
          <label>Operation <select name="operation" aria-label="Operation">
            <option value="union">Union</option>
            <option value="subtract">Subtract (left minus right)</option>
            <option value="intersect">Intersect</option>
          </select></label>
          <p class="lab-semantics">The first tree is the left input (blue); the second is the right input
            (orange). Union and intersection keep the left value for matching keys. Neither input is changed.</p>
          <p class="lab-combine-error" role="alert" hidden></p>
          <div class="lab-form-actions">
            <button type="button" data-action="cancel">Cancel</button>
            <button type="submit" class="lab-primary">OK</button>
          </div>
        </form>
      </section>
      <section class="lab-timeline" aria-label="Operation cursor timeline" hidden>
        <div class="lab-timeline-heading">
          <strong>Cursor timeline</strong><output class="lab-timeline-step" aria-live="off">T-1</output>
          <button type="button" data-action="clear-timeline" aria-label="Close cursor timeline">×</button>
        </div>
        <div class="lab-timeline-operation"></div>
        <label class="lab-timeline-phase-label" hidden>Phase
          <select class="lab-timeline-phase" aria-label="Timeline phase">
            <option value="decomposition">Decomposition</option>
            <option value="reconstruction">Reconstruction</option>
          </select>
        </label>
        <div class="lab-timeline-controls">
          <button type="button" class="lab-timeline-previous" aria-label="Previous cursor step">‹</button>
          <input type="range" min="-1" max="-1" value="-1" step="1" aria-label="Cursor timeline"
            aria-describedby="${timelineMessageId}">
          <button type="button" class="lab-timeline-next" aria-label="Next cursor step">›</button>
        </div>
        <p id="${timelineMessageId}" class="lab-timeline-message"></p>
      </section>
      <p class="lab-status" role="status" aria-live="polite" hidden></p>
      <p id="${helpId}" class="lab-help">Drag background to pan · scroll to pan · Ctrl/⌘ + scroll
        or pinch to zoom · click a tree for actions · click nodes or operation lines to highlight sharing · Esc to clear</p>
    </div>`;

  const surface = required<HTMLElement>(host, '.lab-surface');
  const canvas = required<SVGSVGElement>(host, '.lab-canvas');
  const addButton = required<HTMLButtonElement>(host, '[data-action=add]');
  const addPanel = required<HTMLElement>(host, '.lab-add-panel');
  const combinePanel = required<HTMLElement>(host, '.lab-combine-panel');
  const treeMenu = required<HTMLElement>(host, '.lab-tree-menu');
  const pickPrompt = required<HTMLElement>(host, '.lab-pick-prompt');
  const creationForm = required<HTMLFormElement>(host, '.lab-create');
  const generationInput = required<HTMLSelectElement>(host, '[name=generation]');
  const operationInput = required<HTMLSelectElement>(host, '[name=operation]');
  const status = required<HTMLElement>(host, '.lab-status');
  const error = required<HTMLElement>(host, '.lab-error');
  const timelinePanel = required<HTMLElement>(host, '.lab-timeline');
  const timelineSlider = required<HTMLInputElement>(timelinePanel, 'input');
  const timelineStepLabel = required<HTMLOutputElement>(timelinePanel, '.lab-timeline-step');
  const timelineMessage = required<HTMLElement>(timelinePanel, '.lab-timeline-message');
  const timelinePrevious = required<HTMLButtonElement>(timelinePanel, '.lab-timeline-previous');
  const timelineNext = required<HTMLButtonElement>(timelinePanel, '.lab-timeline-next');
  const timelinePhaseControl = required<HTMLSelectElement>(timelinePanel, '.lab-timeline-phase');
  required<HTMLElement>(timelinePanel, '.lab-timeline-phase-label').hidden = !display.reconstruction;
  required<HTMLElement>(host, '.lab-camera').hidden = !display.toolbar;
  const help = required<HTMLElement>(host, '.lab-help');
  help.hidden = !display.help;
  help.textContent = [
    permissions.pan && 'Drag background to pan',
    permissions.pan && permissions.wheelPan && 'scroll to pan',
    permissions.zoom && 'Ctrl/⌘ + scroll or pinch to zoom',
    permissions.treeMenus && 'click a tree for actions',
    permissions.selectNodes && permissions.selectOperations
      ? 'click nodes or operation lines to highlight sharing'
      : permissions.selectNodes ? 'click nodes to highlight sharing'
      : permissions.selectOperations && 'click operation lines to highlight sharing',
    canClearSelection && 'Esc to clear'
  ].filter(Boolean).join(' · ');
  addButton.hidden = addButton.disabled = !permissions.addTrees;
  for (const action of ['in', 'out'])
    required<HTMLButtonElement>(host, `[data-action=${action}]`).disabled = !permissions.zoom;
  for (const action of ['fit', 'center-tree'])
    required<HTMLButtonElement>(host, `[data-action=${action}]`).disabled = !permissions.pan && !permissions.zoom;
  for (const [action, allowed] of [
    ['delete', permissions.deleteTrees], ['combine', permissions.combineTrees],
    ['clone', permissions.cloneTrees],
    ['add-element', permissions.addElements], ['remove-element', permissions.removeElements],
    ['clear-timeline', canClearSelection]
  ] as const) {
    const button = required<HTMLButtonElement>(host, `[data-action=${action}]`);
    button.hidden = button.disabled = !allowed;
  }
  if (!permissions.pan && !permissions.zoom && !permissions.selectNodes &&
      !permissions.selectOperations && !permissions.treeMenus && !permissions.combineTrees)
    canvas.removeAttribute('tabindex');
  canvas.setAttribute('aria-label', permissions.selectNodes || permissions.treeMenus
    ? 'Interactive B+ tree canvas' : 'B+ tree diagram');
  // iOS Safari does not reliably honor `touch-action` set only on an <svg>: it can still treat a
  // two-finger gesture over the canvas as a page-level pinch-zoom and never deliver pointer events
  // to our handlers. Setting the same value on the HTML parent makes WebKit respect it consistently.
  const touchAction = permissions.pan || permissions.zoom ? 'none' : 'auto';
  canvas.style.touchAction = touchAction;
  surface.style.touchAction = touchAction;
  if (display.height !== undefined) {
    canvas.style.height = `${display.height}px`;
    canvas.style.minHeight = '0';
  }
  const world = svg('g', { class: 'lab-world' });
  const connections = svg('g', { class: 'lab-connections' });
  const treeLayer = svg('g', { class: 'lab-trees' });
  const cursorLayer = svg('g', { class: 'lab-cursors', 'aria-label': 'Input cursors' });
  const editLayer = svg('g', { class: 'lab-edit-overlay', 'aria-label': 'Pending element edit' });
  const decompositionLayer = svg('g', { class: 'lab-decomposition' });
  world.append(connections, treeLayer, decompositionLayer, cursorLayer, editLayer);
  canvas.append(world);
  const layouts = new Map<number, TreeLayout>();
  const groups = new Map<number, SVGGElement>();
  let camera: ZoomTransform = zoomIdentity;
  let interaction: Interaction = { kind: 'idle' };
  let highlight: Highlight = selectedOperation === undefined
    ? { kind: 'none' } : { kind: 'operation', result: selectedOperation };
  let pinnedNodeSelection: NodeIdentity | undefined;
  let timelineStep = initialTimelineStep;
  let timelinePhase: TimelinePhase = initialTimelinePhase;
  let reconstructionStep = initialReconstructionStep;
  let reconstructionFrame: ReconstructionFrame | undefined;
  let selectedReconstructionNode: number | undefined;
  let timelineFrame: TimelineFrame | undefined;
  let timelineFailure: string | undefined;
  let decompositionBounds: { result: number; x: number; y: number; right: number; bottom: number } | undefined;
  let menuTree: number | undefined;
  let menuSelection: { nodeId: number; range?: KeyRange; x: number; y: number; height: number } | undefined;
  let menuPosition: { x: number; y: number } | undefined;
  const pendingEdits = new Map<ElementAction, ElementEdit>();
  let hoveredEdit: ElementAction | undefined;
  let focusedEdit: ElementAction | undefined;
  let drag: {
    id: number; pointer: number; startX: number; startY: number;
    originX: number; originY: number; moved: boolean;
  } | undefined;

  const zoomBehavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([MIN_ZOOM, 4])
    .touchable(false)
    .filter(event => {
      const target = event.target;
      if (target instanceof Element &&
          ((permissions.moveTrees && target.closest('.lab-tree-handle')) ||
            (permissions.selectOperations && target.closest('.lab-operation-edge')) ||
            (interaction.kind === 'picking' && target.closest('.lab-tree'))))
        return false;
      if (event.type === 'wheel') return permissions.zoom && (event.ctrlKey || event.metaKey);
      return false;
    })
    .on('zoom', event => {
      camera = event.transform;
      world.setAttribute('transform', camera.toString());
      const percent = camera.k * 100;
      required<HTMLOutputElement>(host, '.lab-scale').value =
        `${percent < 1 ? percent.toFixed(2) : Math.round(percent)}%`;
      model.refreshIdentities();
      positionMenus();
      positionAnnotations();
    });
  const selection = select(canvas);
  selection.call(zoomBehavior).on('dblclick.zoom', null);
  function wheelPan(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey || !permissions.pan || !permissions.wheelPan) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
    selection.call(zoomBehavior.translateBy, -dx * units / camera.k, -dy * units / camera.k);
  }
  canvas.addEventListener('wheel', wheelPan, { passive: false });

  const pointers = new Map<number, { x: number; y: number; target: Element }>();
  let gesture: { camera: ZoomTransform; x: number; y: number; distance: number } | undefined;
  let suppressCanvasClick = false;
  function pointerGeometry() {
    const points = Array.from(pointers.values()).slice(0, 2);
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
    };
  }
  function resetGesture(): void {
    gesture = pointers.size ? { camera, ...pointerGeometry() } : undefined;
  }
  function startCameraGesture(event: PointerEvent): void {
    if (event.button !== 0 || (!permissions.pan && !permissions.zoom) || drag ||
        !(event.target instanceof Element)) return;
    if ((permissions.moveTrees && event.target.closest('.lab-tree-handle')) ||
        (permissions.selectOperations && event.target.closest('.lab-operation-edge')) ||
        (interaction.kind === 'picking' && event.target.closest('.lab-tree'))) return;
    if (event.pointerType !== 'touch' && !permissions.pan) return;
    // Own the drag from its start; otherwise WebKit can select the SVG as article content.
    event.preventDefault();
    if (!pointers.size) suppressCanvasClick = false;
    const bounds = canvas.getBoundingClientRect();
    pointers.set(event.pointerId, {
      x: event.clientX - bounds.left, y: event.clientY - bounds.top, target: event.target
    });
    // Capture on the original target so a tap still activates that node or tree.
    event.target.setPointerCapture(event.pointerId);
    resetGesture();
  }
  function moveCameraGesture(event: PointerEvent): void {
    const point = pointers.get(event.pointerId);
    if (!point || !gesture) return;
    const bounds = canvas.getBoundingClientRect();
    point.x = event.clientX - bounds.left;
    point.y = event.clientY - bounds.top;
    const current = pointerGeometry();
    const pinching = pointers.size > 1;
    if (pinching ? !permissions.zoom : !permissions.pan) return;
    const dx = current.x - gesture.x, dy = current.y - gesture.y;
    if (!suppressCanvasClick && Math.hypot(dx, dy) < 4 &&
        (!pinching || Math.abs(current.distance - gesture.distance) < 4)) return;
    event.preventDefault();
    suppressCanvasClick = true;
    const scale = pinching && gesture.distance > 0
      ? Math.max(MIN_ZOOM, Math.min(4, gesture.camera.k * current.distance / gesture.distance))
      : gesture.camera.k;
    const [x, y] = gesture.camera.invert([gesture.x, gesture.y]);
    selection.call(zoomBehavior.transform, zoomIdentity.translate(
      (permissions.pan ? current.x : gesture.x) - x * scale,
      (permissions.pan ? current.y : gesture.y) - y * scale
    ).scale(scale));
  }
  function finishCameraGesture(event: PointerEvent): void {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    pointers.delete(event.pointerId);
    if (point.target.hasPointerCapture(event.pointerId)) point.target.releasePointerCapture(event.pointerId);
    resetGesture();
  }
  function suppressGestureClick(event: MouseEvent): void {
    if (!suppressCanvasClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressCanvasClick = false;
  }
  canvas.addEventListener('pointerdown', startCameraGesture);
  canvas.addEventListener('pointermove', moveCameraGesture);
  canvas.addEventListener('pointerup', finishCameraGesture);
  canvas.addEventListener('pointercancel', finishCameraGesture);
  canvas.addEventListener('lostpointercapture', finishCameraGesture);
  canvas.addEventListener('click', suppressGestureClick, true);
  // Safari's proprietary two-finger `gesture*` events drive its native page pinch-zoom and are
  // dispatched independent of `touch-action`/Pointer Events. Swallow them over the canvas so a
  // pinch always reaches our own pointer-based zoom instead of zooming the whole page.
  function preventNativeGesture(event: Event): void {
    if (permissions.pan || permissions.zoom) event.preventDefault();
  }
  canvas.addEventListener('gesturestart', preventNativeGesture);
  canvas.addEventListener('gesturechange', preventNativeGesture);
  function preventCanvasSelection(event: Event): void {
    event.preventDefault();
  }
  canvas.addEventListener('selectstart', preventCanvasSelection);
  canvas.addEventListener('dragstart', preventCanvasSelection);

  function announce(message: string): void {
    status.textContent = message;
    status.hidden = false;
  }

  function describe(entry: CanvasTree): string {
    if (entry.edits) return entry.name;
    if (entry.operationInvalidated) return `${entry.name} · retained result`;
    if (entry.clonedFrom !== undefined) return `${entry.name} · clone of ${model.nameOf(entry.clonedFrom)}`;
    if (entry.generation) {
      switch (entry.generation.kind) {
        case 'size': return `${entry.name} · consecutive keys`;
        case 'ranges': return `${entry.name} · ranges`;
        case 'random': return `${entry.name} · random / seed ${entry.generation.seed}`;
      }
    }
    if (!entry.origin) return `${entry.name} · input`;
    return `${entry.name} = ${entry.origin.operation}(${model.nameOf(entry.origin.left)}, ${
      model.nameOf(entry.origin.right)})`;
  }

  function positionMenus(reanchorTree = false): void {
    const toolbar = required<HTMLElement>(host, '.lab-camera');
    const top = toolbar.hidden ? 12 : toolbar.offsetTop + toolbar.offsetHeight + 8;
    const helpHeight = required<HTMLElement>(host, '.lab-help').offsetHeight;
    surface.style.setProperty('--lab-menu-top', `${top}px`);
    surface.style.setProperty('--lab-help-height', `${helpHeight}px`);
    if (menuTree === undefined || treeMenu.hidden) return;
    if (!menuPosition || reanchorTree) {
      const entry = model.get(menuTree);
      const layout = layouts.get(menuTree)!;
      const anchor = menuSelection || layout.nodes[0];
      const x = camera.x + (entry.x + anchor.x) * camera.k - treeMenu.offsetWidth / 2;
      const left = Math.max(12, Math.min(x, canvas.clientWidth - treeMenu.offsetWidth - 12));
      const toolbarRight = toolbar.offsetLeft + toolbar.offsetWidth;
      const minimumY = toolbar.hidden || left > toolbarRight + 8 ? 12 : top;
      let y = camera.y + (entry.y + anchor.y) * camera.k - treeMenu.offsetHeight - 8;
      treeMenu.dataset.placement = 'above';
      if (y < minimumY - 0.5) {
        y = camera.y + (entry.y + anchor.y + anchor.height) * camera.k + 8;
        treeMenu.dataset.placement = 'below';
      }
      menuPosition = { x, y };
    }
    menuPosition.x = Math.max(12, Math.min(menuPosition.x, canvas.clientWidth - treeMenu.offsetWidth - 12));
    const minimumY = toolbar.hidden || menuPosition.x > toolbar.offsetLeft + toolbar.offsetWidth + 8 ? 12 : top;
    menuPosition.y = Math.max(minimumY, Math.min(menuPosition.y, canvas.clientHeight - treeMenu.offsetHeight - helpHeight - 12));
    treeMenu.style.left = `${menuPosition.x}px`;
    treeMenu.style.top = `${menuPosition.y}px`;
  }

  function hideTreeMenu(): void {
    pendingEdits.clear();
    hoveredEdit = focusedEdit = undefined;
    clearEditPreview();
    treeMenu.hidden = true;
    menuTree = undefined;
    menuSelection = undefined;
    delete treeMenu.dataset.nodeId;
    delete treeMenu.dataset.rangeMin;
    delete treeMenu.dataset.rangeMax;
    menuPosition = undefined;
    treeMenu.style.removeProperty('width');
    required<HTMLElement>(treeMenu, '.lab-menu-name').style.removeProperty('min-height');
  }

  function showTreeMenu(entry: CanvasTree, selected?: PlacedNode): void {
    if (!permissions.treeMenus) return;
    if (drag || interaction.kind !== 'idle' || !addPanel.hidden || !combinePanel.hidden) return;
    const opening = treeMenu.hidden || menuTree !== entry.id || selected !== undefined;
    if (opening) hideTreeMenu();
    if (opening) {
      const node = selected || layouts.get(entry.id)!.nodes[0];
      menuSelection = {
        nodeId: model.identity(node.node).id, range: model.nodeRange(entry.id, node.node),
        x: node.x, y: node.y, height: node.height
      };
    }
    menuTree = entry.id;
    treeMenu.hidden = false;
    treeMenu.dataset.treeId = String(entry.id);
    treeMenu.dataset.nodeId = String(menuSelection!.nodeId);
    const range = menuSelection!.range;
    if (range) {
      treeMenu.dataset.rangeMin = String(range.min);
      treeMenu.dataset.rangeMax = String(range.max);
    }
    required<HTMLElement>(treeMenu, '.lab-menu-name').textContent = describe(entry);
    const combine = required<HTMLButtonElement>(treeMenu, '[data-action=combine]');
    combine.disabled = !permissions.combineTrees || model.trees.length < 2;
    combine.title = combine.disabled ? 'Add another tree to combine with.' : '';
    const addElement = required<HTMLButtonElement>(treeMenu, '[data-action=add-element]');
    addElement.disabled = !permissions.addElements || entry.tree.size === 0 || !range;
    addElement.title = entry.tree.size === 0 ? 'Add element requires a non-empty tree.' : '';
    const removeElement = required<HTMLButtonElement>(treeMenu, '[data-action=remove-element]');
    const hasEligible = range && entry.tree.keysArray().some(key => key >= range.min && key <= range.max);
    removeElement.disabled = !permissions.removeElements || entry.tree.size <= 1 || !hasEligible;
    removeElement.title = entry.tree.size <= 1 ? 'Keep at least one element in the tree.'
      : !hasEligible ? 'No elements remain in the selected range.' : '';
    if (opening) {
      treeMenu.style.width = `${treeMenu.offsetWidth}px`;
      const name = required<HTMLElement>(treeMenu, '.lab-menu-name');
      name.style.minHeight = `${name.offsetHeight}px`;
    }
    if (opening && autoCenter) centerSelectedNode();
    positionMenus();
  }

  function clearEditPreview(): void {
    editLayer.replaceChildren();
    host.querySelectorAll('.is-removal-target').forEach(element => element.classList.remove('is-removal-target'));
  }

  function activeEditAction(): ElementAction | undefined {
    const action = hoveredEdit || focusedEdit;
    return action && !required<HTMLButtonElement>(treeMenu, `[data-action=${action}-element]`).disabled
      ? action : undefined;
  }

  function drawEditPreview(): void {
    clearEditPreview();
    const action = activeEditAction();
    const pendingEdit = action && pendingEdits.get(action);
    if (!pendingEdit || treeMenu.hidden) return;
    const entry = model.get(pendingEdit.treeId);
    if ((entry.edits || 0) !== pendingEdit.revision) return;
    const target = editTarget(layouts.get(entry.id)!, pendingEdit.key, pendingEdit.action);
    const preview = svg('g', {
      class: 'lab-edit-preview', transform: `translate(${entry.x},${entry.y})`,
      'data-action': pendingEdit.action, 'data-key': pendingEdit.key, 'data-tree-id': entry.id,
      'data-node-id': model.identity(target.node.node).id, 'data-key-index': target.index,
      role: 'img', 'aria-label': `${pendingEdit.action === 'add' ? 'Insert' : 'Remove'} key ${formatKey(pendingEdit.key)}`
    });
    if (pendingEdit.action === 'add') {
      preview.append(svg('line', {
        class: 'lab-edit-insert', x1: target.x, x2: target.x,
        y1: target.node.y - 4, y2: target.node.y + target.node.height + 4
      }));
    } else {
      preview.append(svg('rect', {
        class: 'lab-edit-remove', x: target.x + 1, y: target.node.y + 1,
        width: target.node.cellWidth - 2, height: target.node.height - 2, rx: 3
      }));
      const node = groups.get(entry.id)!.querySelector<SVGGElement>(`.lab-node[data-node-id="${model.identity(target.node.node).id}"]`)!;
      node.querySelectorAll('.lab-key')[target.index].classList.add('is-removal-target');
    }
    editLayer.append(preview);
  }

  function previewEdit(action: ElementAction): void {
    const button = required<HTMLButtonElement>(treeMenu, `[data-action=${action === 'add' ? 'add-element' : 'remove-element'}]`);
    if (button.disabled || treeMenu.hidden || menuTree === undefined || !menuSelection?.range) {
      clearEditPreview();
      return;
    }
    try {
      const pendingEdit = pendingEdits.get(action);
      if (!pendingEdit || pendingEdit.treeId !== menuTree ||
          pendingEdit.revision !== (model.get(menuTree).edits || 0))
        pendingEdits.set(action, model.previewElement(menuTree, action, menuSelection.range));
      drawEditPreview();
    } catch (failure) {
      pendingEdits.delete(action);
      clearEditPreview();
      announce(failure instanceof Error ? failure.message : String(failure));
    }
  }

  for (const action of ['add', 'remove'] as const) {
    const button = required<HTMLButtonElement>(treeMenu, `[data-action=${action}-element]`);
    button.addEventListener('pointerenter', () => { hoveredEdit = action; previewEdit(action); });
    button.addEventListener('pointerleave', () => {
      if (hoveredEdit === action) hoveredEdit = undefined;
      const active = activeEditAction();
      if (active) previewEdit(active); else clearEditPreview();
    });
    button.addEventListener('focus', () => {
      focusedEdit = action;
      const active = activeEditAction();
      if (active) previewEdit(active);
    });
    button.addEventListener('blur', () => {
      if (focusedEdit === action) focusedEdit = undefined;
      const active = activeEditAction();
      if (active) previewEdit(active); else clearEditPreview();
    });
  }

  function centerSelectedNode(): void {
    if (menuTree === undefined || !menuSelection || (!permissions.pan && !permissions.zoom)) return;
    const entry = model.get(menuTree), layout = layouts.get(menuTree)!;
    const selected = selectedNodeInLayout(layout, menuSelection.nodeId, menuSelection.range, node => model.identity(node).id);
    menuSelection = {
      ...menuSelection, nodeId: model.identity(selected.node).id,
      x: selected.x, y: selected.y, height: selected.height
    };
    treeMenu.dataset.nodeId = String(menuSelection.nodeId);
    const toolbar = required<HTMLElement>(host, '.lab-camera');
    const menuLeft = Math.max(12, (canvas.clientWidth - treeMenu.offsetWidth) / 2);
    const menuTop = toolbar.hidden || menuLeft > toolbar.offsetLeft + toolbar.offsetWidth + 8
      ? 12 : toolbar.offsetTop + toolbar.offsetHeight + 8;
    const nodeTop = menuTop + treeMenu.offsetHeight + 8;
    selection.call(zoomBehavior.transform, zoomIdentity.translate(
      canvas.clientWidth / 2 - (entry.x + selected.x) * camera.k,
      nodeTop - (entry.y + selected.y) * camera.k
    ).scale(camera.k));
    positionMenus(true);
  }

  function isOperationPinned(): boolean {
    return !!pinSelectedOperation && highlight.kind === 'operation' && highlight.result === selectedOperation;
  }

  function applyHighlights(): void {
    updateTimeline();
    const nodeColors = new Map<string, SubtreeColor>();
    const sequence: SequenceUnit[] = [];
    let treeIds: Set<number> | undefined;
    let excludedInput: number | undefined;
    if (highlight.kind === 'node')
      nodeColors.set(String(highlight.identity.id), subtreeColor(highlight.identity));
    else if (highlight.kind === 'operation') {
      const shared = model.operationSharing(highlight.result);
      const origin = model.get(highlight.result).origin!;
      if (origin.operation === 'subtract') excludedInput = origin.right;
      for (const item of shared.sequence) sequence.push({
        number: item.number, keys: item.keys, maxKey: item.maxKey,
        step: item.kind === 'step' ? item.step : undefined,
        reuseRootId: item.kind === 'subtree' ? String(model.identity(item.subtree.root).id) : undefined
      });
      const ownerCounts = new Map<number, number>();
      for (const subtree of shared.subtrees) {
        const identity = model.identity(subtree.root);
        const index = ownerCounts.get(identity.owner.id) || 0;
        const color = subtreeColor(identity, index % 2 === 1);
        ownerCounts.set(identity.owner.id, index + 1);
        for (const node of subtree.nodes) nodeColors.set(String(model.identity(node).id), color);
      }
      treeIds = new Set(shared.trees.map(tree => tree.id));
    }
    for (const [id, group] of groups) {
      const inScope = !treeIds || treeIds.has(id);
      group.querySelectorAll<SVGGElement>('.lab-node').forEach(node => {
        const color = inScope ? nodeColors.get(node.dataset.nodeId!) : undefined;
        const nodeSelected = (isOperationPinned() || reconstructionFrame !== undefined) &&
          node.dataset.nodeId === String(pinnedNodeSelection?.id);
        node.classList.toggle('is-selected', !!color);
        node.classList.toggle('is-node-selected', nodeSelected);
        node.classList.toggle('is-reuse-root', !!color && color.rootId === node.dataset.nodeId);
        if (permissions.selectNodes) node.setAttribute('aria-pressed',
          String(isOperationPinned() || reconstructionFrame !== undefined ? nodeSelected : !!color));
        else node.removeAttribute('aria-pressed');
        if (color) {
          node.dataset.reuseRoot = color.rootId;
          node.style.setProperty('--shared-fill', display.colorMode === 'levels'
            ? required<SVGRectElement>(node, '.lab-node-box').getAttribute('fill')! : color.fill);
          node.style.setProperty('--shared-stroke', color.stroke);
        } else {
          delete node.dataset.reuseRoot;
          node.style.removeProperty('--shared-fill');
          node.style.removeProperty('--shared-stroke');
        }
      });
      group.querySelectorAll<SVGPathElement>('.lab-child-link').forEach(link => {
        const parent = inScope ? nodeColors.get(link.dataset.parentId!) : undefined;
        const child = inScope ? nodeColors.get(link.dataset.childId!) : undefined;
        const connected = !!parent && parent.rootId === child?.rootId;
        link.classList.toggle('is-shared', connected);
        if (connected) link.style.setProperty('--shared-stroke', parent!.stroke);
        else link.style.removeProperty('--shared-stroke');
      });
      const ranges = required<SVGGElement>(group, '.lab-chunk-ranges');
      ranges.replaceChildren();
      if (highlight.kind === 'operation' && inScope && id !== excludedInput) {
        const leaves: SequenceLeaf[] = layouts.get(id)!.nodes.filter(placed => placed.node.isLeaf).map(placed => {
          const nodeId = String(model.identity(placed.node).id);
          const color = nodeColors.get(nodeId);
          return {
            id: nodeId, left: placed.x - placed.width / 2, right: placed.x + placed.width / 2,
            bottom: placed.y + placed.height, cellWidth: placed.cellWidth, keys: placed.node.keys,
            reuseRootId: color?.rootId
          };
        });
        for (const range of outputSequenceRanges(leaves, sequence, timelineFrame && processedThrough(timelineFrame))) {
          const y = range.bottom + 18;
          const bracket = svg('g', {
            class: 'lab-chunk-range lab-sequence-range', 'data-sequence-number': range.number,
            'data-kind': range.kind, 'data-leaf-ids': range.leafIds.join(','),
            'data-keys': JSON.stringify(range.keys), 'data-max-key': range.maxKey,
            role: 'img', 'aria-label': `Output segment ${range.number}: ${range.kind === 'step'
              ? `cursor step T${range.step}, keys ${formatKey(range.keys[0])} to ${formatKey(range.keys[range.keys.length - 1])}`
              : range.kind === 'subtree' ? 'reused subtree' : `key ${formatKey(range.keys[0])}`}`
          });
          if (range.step !== undefined) bracket.setAttribute('data-cursor-step', String(range.step));
          if (range.rootId !== undefined) bracket.setAttribute('data-reuse-root', range.rootId);
          bracket.append(
            svg('path', {
              class: 'lab-chunk-bracket',
              d: `M${range.left},${y - 8} V${y} H${range.right} V${y - 8}`
            }),
            svg('text', {
              class: 'lab-chunk-number', x: (range.left + range.right) / 2,
              'data-bar-y': y, 'data-span-width': range.right - range.left, 'text-anchor': 'middle'
            }, String(range.number))
          );
          ranges.append(bracket);
        }
      }
    }
    connections.querySelectorAll<SVGGElement>('.lab-operation-edge').forEach(edge => {
      const selected = highlight.kind === 'operation' && edge.dataset.resultId === String(highlight.result);
      edge.classList.toggle('is-selected', selected);
      if (permissions.selectOperations) edge.setAttribute('aria-pressed', String(selected));
    });
    updateDecomposition();
    updateReconstruction();
    positionAnnotations();
  }

  function updateReconstruction(): void {
    for (const group of groups.values()) {
      group.classList.remove('is-reconstructing');
      group.querySelector('.lab-reconstruction')?.remove();
      const meta = group.querySelector<SVGTextElement>('.lab-tree-meta');
      if (meta?.dataset.finalText !== undefined) meta.textContent = meta.dataset.finalText;
    }
    if (highlight.kind !== 'operation' || timelinePhase !== 'reconstruction' || !reconstructionFrame) return;
    const result = model.get(highlight.result), group = groups.get(result.id), layout = layouts.get(result.id);
    if (!group || !layout || reconstructionFrame.complete) return;
    group.classList.add('is-reconstructing');
    const layer = svg('g', { class: 'lab-reconstruction' });
    group.append(layer);
    const identities = new Map<object, NodeIdentity>(model.identities);
    const selectSnapshot = permissions.selectNodes ? (node: ReconstructionNode) => {
      hideTreeMenu();
      selectedReconstructionNode = node.id;
      pinnedNodeSelection = identities.get(node.source);
      applyHighlights();
    } : undefined;
    drawReconstruction(layer, reconstructionFrame, layout, source => identities.get(source),
      selectedReconstructionNode, pinnedNodeSelection?.id, selectSnapshot);
    const meta = group.querySelector<SVGTextElement>('.lab-tree-meta');
    if (meta) {
      if (meta.dataset.finalText === undefined) meta.dataset.finalText = meta.textContent || '';
      meta.textContent = `R${reconstructionFrame.step}${
        reconstructionFrame.fragmentIndex === undefined ? '' : ` - fragment #${reconstructionFrame.fragmentIndex + 1}`}`;
    }
  }

  function updateDecomposition(): void {
    decompositionLayer.replaceChildren();
    decompositionBounds = undefined;
    if ((!display.decompositionList && !(display.reconstruction && timelinePhase === 'reconstruction')) ||
        highlight.kind !== 'operation') return;
    const result = model.get(highlight.result), layout = layouts.get(result.id);
    if (!layout || !result.origin || result.operationInvalidated) return;
    const inputs = [result.origin.left, result.origin.right].map(id => model.trees.find(entry => entry.id === id));
    if (!inputs[0] || !inputs[1]) return;
    const reconstructing = timelinePhase === 'reconstruction';
    const snapshot = reconstructing || timelineStep === -1 ? result.timeline?.decomposition : timelineFrame?.decomposition;
    const decompositionStep = reconstructing ? Math.max(0, (result.timeline?.frames.length || 1) - 1) : timelineStep;
    const identities = new Map<object, NodeIdentity>(model.identities);
    const selectSource = permissions.selectNodes ? (source: object) => {
      for (const input of layouts.values()) {
        const placed = input.nodes.find(node => node.node === source);
        if (placed) {
          selectNode(input.entry, placed);
          return;
        }
      }
      throw new Error('The selected decomposition node no longer has a tree occurrence.');
    } : undefined;
    const selectedId = pinnedNodeSelection?.id;
    const size = drawDecomposition(decompositionLayer, snapshot, layout.width, decompositionStep,
      [inputs[0], inputs[1]], result.color, source => identities.get(source), selectedId, selectSource,
      result.timeline?.kind === 'fast-path' ? 'Fast path: no decomposition was needed.'
        : result.origin.operation === 'intersect' ? 'Intersection does not use a decomposition list.'
        : 'Decomposition recording is unavailable for this operation.', reconstructionFrame);
    const x = result.x, y = result.y + layout.height + 36;
    decompositionLayer.setAttribute('transform', `translate(${x},${y})`);
    decompositionLayer.dataset.resultId = String(result.id);
    decompositionBounds = {
      result: result.id, x: x - DECOMPOSITION_PADDING, y: y - DECOMPOSITION_PADDING,
      right: x + size.width + DECOMPOSITION_PADDING, bottom: y + size.height + DECOMPOSITION_PADDING
    };
  }

  function positionAnnotations(): void {
    positionCursors();
    drawEditPreview();
    const chunkFont = Math.min(26, 14 / camera.k);
    treeLayer.querySelectorAll<SVGTextElement>('.lab-chunk-number').forEach(label => {
      const font = Math.min(chunkFont, Number(label.dataset.spanWidth) * 0.8 / (label.textContent!.length * 0.65));
      label.style.fontSize = `${font}px`;
      label.setAttribute('y', '0');
      label.setAttribute('y', String(Number(label.dataset.barY) + 4 - label.getBBox().y));
    });
    const obstacles: Rectangle[] = Array.from(layouts.values(), layout => ({
      left: layout.entry.x - 6, right: layout.entry.x + layout.width + 6,
      top: layout.entry.y - 6, bottom: layout.entry.y + layout.height + 6
    }));
    const fontSize = Math.min(40, 14 / camera.k);
    const fractions = [0.5];
    for (let step = 1; step <= 9; step++) fractions.push(0.5 - step * 0.05, 0.5 + step * 0.05);
    connections.querySelectorAll<SVGGElement>('.lab-operation-edge').forEach(edge => {
      const label = required<SVGGElement>(edge, '.lab-operation-label');
      const text = required<SVGTextElement>(label, 'text');
      const background = required<SVGRectElement>(label, 'rect');
      const path = required<SVGPathElement>(edge, '.lab-operation-link');
      text.style.fontSize = `${fontSize}px`;
      const width = text.getComputedTextLength() + fontSize * 1.2;
      const height = fontSize * 1.8;
      const length = path.getTotalLength();
      const candidates = fractions.map(fraction => path.getPointAtLength(length * fraction));
      const point = placeLabel(candidates, width, height, obstacles);
      label.setAttribute('transform', `translate(${point.x},${point.y})`);
      background.setAttribute('x', String(-width / 2));
      background.setAttribute('y', String(-height / 2));
      background.setAttribute('width', String(width));
      background.setAttribute('height', String(height));
      background.setAttribute('rx', String(fontSize * 0.3));
      obstacles.push({
        left: point.x - width / 2, right: point.x + width / 2,
        top: point.y - height / 2, bottom: point.y + height / 2
      });
    });
  }

  function updateTimeline(): void {
    timelineFrame = undefined;
    reconstructionFrame = undefined;
    cursorLayer.replaceChildren();
    delete cursorLayer.dataset.step;
    timelinePanel.hidden = !permissions.timeline || highlight.kind !== 'operation';
    surface.classList.toggle('has-timeline', !timelinePanel.hidden);
    if (!permissions.timeline) {
      timelineStep = -1;
      timelineSlider.disabled = timelinePrevious.disabled = timelineNext.disabled = true;
      return;
    }
    if (highlight.kind !== 'operation') return;
    const entry = model.get(highlight.result), timeline = entry.timeline;
    timelinePanel.dataset.phase = timelinePhase;
    timelinePhaseControl.value = timelinePhase;
    const reconstruction = timeline?.reconstruction && reconstructionPlayback(timeline.reconstruction);
    required<HTMLOptionElement>(timelinePhaseControl, '[value=reconstruction]').disabled = !reconstruction?.length;
    const reconstructing = timelinePhase === 'reconstruction';
    required<HTMLElement>(timelinePanel, '.lab-timeline-heading strong').textContent =
      reconstructing ? 'Reconstruction timeline' : 'Cursor timeline';
    timelinePanel.setAttribute('aria-label', reconstructing ? 'Operation reconstruction timeline' : 'Operation cursor timeline');
    timelineSlider.setAttribute('aria-label', reconstructing ? 'Reconstruction timeline' : 'Cursor timeline');
    timelinePrevious.setAttribute('aria-label', reconstructing ? 'Previous reconstruction step' : 'Previous cursor step');
    timelineNext.setAttribute('aria-label', reconstructing ? 'Next reconstruction step' : 'Next cursor step');
    timelineSlider.min = reconstructing ? '0' : '-1';
    required<HTMLElement>(timelinePanel, '.lab-timeline-operation').textContent = operationLabel(
      entry.origin!.operation, model.nameOf(entry.origin!.left), model.nameOf(entry.origin!.right), entry.name);
    if (reconstructing) {
      const available = !!reconstruction?.length;
      const maximum = available ? reconstruction!.length - 1 : 0;
      reconstructionStep = Math.max(0, Math.min(reconstructionStep, maximum));
      reconstructionFrame = reconstruction?.[reconstructionStep];
      timelineFrame = timeline?.frames[timeline.frames.length - 1];
      timelinePanel.dataset.resultId = String(entry.id);
      timelinePanel.dataset.kind = available ? 'reconstruction' : 'unavailable';
      timelinePanel.dataset.step = String(reconstructionStep);
      timelinePanel.dataset.decompositionStep = String(Math.max(-1, (timeline?.frames.length || 0) - 1));
      timelineSlider.max = String(maximum);
      timelineSlider.value = String(reconstructionStep);
      timelineSlider.disabled = !available;
      timelinePrevious.disabled = !available || reconstructionStep === 0;
      timelineNext.disabled = !available || reconstructionStep === maximum;
      timelineStepLabel.value = available ? `R${reconstructionStep}` : 'Unavailable';
      timelineMessage.textContent = reconstructionFrame
        ? reconstructionFrame.message
        : entry.origin!.operation === 'intersect' ? 'Intersection does not use this reconstruction algorithm.'
        : timeline?.kind === 'fast-path' ? 'Fast path: no reconstruction was needed.'
        : timeline?.decomposition?.items.length === 0 ? 'Empty decomposition: no reconstruction was needed.'
        : 'Reconstruction recording is unavailable for this operation.';
      timelineSlider.setAttribute('aria-valuetext', `${timelineStepLabel.value}. ${timelineMessage.textContent}`);
      return;
    }
    delete timelinePanel.dataset.decompositionStep;
    const walk = !timelineFailure && timeline?.kind === 'walk' && timeline.frames.length > 0;
    if (!walk) timelineStep = -1;
    const maximum = walk ? timeline!.frames.length - 1 : -1;
    timelineStep = Math.max(-1, Math.min(timelineStep, maximum));
    timelinePanel.dataset.resultId = String(entry.id);
    timelinePanel.dataset.kind = walk ? 'walk'
      : !timelineFailure && timeline?.kind === 'fast-path' ? 'fast-path' : 'unavailable';
    timelinePanel.dataset.step = String(timelineStep);
    timelineSlider.disabled = !walk;
    timelineSlider.max = String(maximum);
    timelineSlider.value = String(timelineStep);
    timelineStepLabel.value = `T${timelineStep}`;
    timelinePrevious.disabled = !walk || timelineStep === -1;
    timelineNext.disabled = !walk || timelineStep === maximum;
    required<HTMLElement>(timelinePanel, '.lab-timeline-operation').textContent = operationLabel(
      entry.origin!.operation, model.nameOf(entry.origin!.left), model.nameOf(entry.origin!.right), entry.name);
    timelineFrame = walk && timelineStep >= 0 ? timeline!.frames[timelineStep] : undefined;
    timelineMessage.textContent = !walk
      ? timelineFailure || (timeline?.kind === 'fast-path' || timeline?.kind === 'unavailable'
        ? timeline.message : 'Cursor recording is unavailable for this operation.')
      : timelineStep === -1 ? 'All output sequence numbers. Advance to T0 to start the cursor walk.'
      : timelineStep === 0 ? 'Both cursors start at their first key. No output items passed yet.'
      : timelineFrame!.cursors.map((cursor, side) =>
        `${model.nameOf(side === 0 ? entry.origin!.left : entry.origin!.right)}: ${
          cursor.current.ended ? 'END' : formatKey(cursor.current.key)} (T${cursor.movedAt})`).join(' · ');
    timelineSlider.setAttribute('aria-valuetext', `T${timelineStep}. ${timelineMessage.textContent}`);
    positionCursors();
  }

  function positionCursors(): void {
    if (!permissions.timeline || timelinePhase === 'reconstruction' || !timelineFrame || highlight.kind !== 'operation') return;
    const origin = model.get(highlight.result).origin!;
    const left = layouts.get(origin.left), right = layouts.get(origin.right);
    if (!left || !right || !drawCursorTimeline(cursorLayer, timelineFrame, [left, right], camera.k,
        placed => model.identity(placed.node).id)) {
      timelineFailure = 'Cursor recording is unavailable: a recorded position is not in the input layout.';
      applyHighlights();
    }
  }

  function scrubTimeline(step: number): void {
    if (!permissions.timeline || timelineSlider.disabled || highlight.kind !== 'operation') return;
    if (timelinePhase === 'reconstruction') reconstructionStep = step;
    else timelineStep = step;
    applyHighlights();
  }
  timelineSlider.addEventListener('input', () => scrubTimeline(timelineSlider.valueAsNumber));
  timelinePrevious.addEventListener('click', () => scrubTimeline((timelinePhase === 'reconstruction' ? reconstructionStep : timelineStep) - 1));
  timelineNext.addEventListener('click', () => scrubTimeline((timelinePhase === 'reconstruction' ? reconstructionStep : timelineStep) + 1));
  timelinePhaseControl.addEventListener('change', () => {
    if (!permissions.timeline || !display.reconstruction || highlight.kind !== 'operation') return;
    const phase = timelinePhaseControl.value;
    if (phase !== 'decomposition' && phase !== 'reconstruction') throw new Error('Unknown timeline phase.');
    if (phase === 'reconstruction' && !model.get(highlight.result).timeline?.reconstruction?.length) {
      announce('This operation has no reconstruction recording.');
      timelinePhaseControl.value = timelinePhase;
      return;
    }
    hideTreeMenu();
    timelinePhase = phase;
    pinnedNodeSelection = undefined;
    selectedReconstructionNode = undefined;
    applyHighlights();
  });
  timelinePanel.addEventListener('pointerdown', event => event.stopPropagation());
  timelinePanel.addEventListener('click', event => event.stopPropagation());

  function highlightInputs(): void {
    for (const [id, group] of groups) {
      const left = interaction.kind !== 'idle' && id === interaction.left;
      const right = interaction.kind === 'operation' && id === interaction.right;
      group.classList.toggle('is-left-input', left);
      group.classList.toggle('is-right-input', right);
      group.classList.toggle('is-pickable', interaction.kind === 'picking' && !left);
      const label = group.querySelector<SVGTextElement>('.lab-input-label');
      if (label) label.textContent = left ? 'LEFT INPUT' : right ? 'RIGHT INPUT' : '';
      if (!permissions.selectNodes) group.querySelectorAll<SVGGElement>('.lab-node').forEach(node => {
        const picking = permissions.combineTrees && interaction.kind === 'picking';
        const actionable = picking || permissions.treeMenus;
        node.classList.toggle('is-interactive', actionable);
        if (actionable) {
          node.setAttribute('tabindex', '0');
          node.setAttribute('role', 'button');
          node.setAttribute('aria-label', picking
            ? `Choose ${model.nameOf(id)} as the right input` : `Actions for ${model.nameOf(id)}`);
        } else {
          node.removeAttribute('tabindex');
          node.removeAttribute('role');
          node.removeAttribute('aria-label');
        }
      });
    }
    surface.classList.toggle('is-picking', interaction.kind === 'picking');
    pickPrompt.hidden = interaction.kind !== 'picking';
    if (interaction.kind === 'picking')
      required<HTMLElement>(pickPrompt, '[role=status]').textContent =
        `Select another tree to combine with ${model.nameOf(interaction.left)} (left input).`;
  }

  function dismiss(clearHighlights = true, keepTreeMenu = false): void {
    if (!keepTreeMenu) hideTreeMenu();
    if (clearHighlights && canClearSelection) {
      pinnedNodeSelection = undefined;
      selectedReconstructionNode = undefined;
      if (!isOperationPinned()) {
        highlight = { kind: 'none' };
        timelineStep = -1;
        reconstructionStep = 0;
        timelinePhase = 'decomposition';
        timelineFailure = undefined;
      }
      applyHighlights();
    }
    addPanel.hidden = combinePanel.hidden = true;
    addButton.setAttribute('aria-expanded', 'false');
    status.hidden = true;
    interaction = { kind: 'idle' };
    highlightInputs();
  }

  function fit(entries: CanvasTree[] = model.trees, initial = false): void {
    if (!initial && !permissions.pan && !permissions.zoom) return;
    if (!entries.length) {
      selection.call(zoomBehavior.transform, initial || permissions.zoom ? zoomIdentity
        : zoomIdentity.scale(camera.k));
      return;
    }
    const bounds = entries.map(entry => {
      const layout = layouts.get(entry.id)!;
      return { x: entry.x, y: entry.y, right: entry.x + layout.width, bottom: entry.y + layout.height };
    });
    if (decompositionBounds && entries.some(entry => entry.id === decompositionBounds!.result))
      bounds.push(decompositionBounds);
    const minX = Math.min(...bounds.map(b => b.x));
    const minY = Math.min(...bounds.map(b => b.y));
    const width = Math.max(...bounds.map(b => b.right)) - minX;
    const height = Math.max(...bounds.map(b => b.bottom)) - minY;
    const toolbar = required<HTMLElement>(host, '.lab-camera');
    const top = (toolbar.hidden ? 16 : toolbar.offsetTop + toolbar.offsetHeight + 24) +
      (interaction.kind === 'picking' ? pickPrompt.offsetHeight + 8 : 0);
    const bottom = required<HTMLElement>(host, '.lab-help').offsetHeight + 20 +
      (timelinePanel.hidden ? 0 : timelinePanel.offsetHeight + 8);
    const usableHeight = Math.max(1, canvas.clientHeight - top - bottom);
    const scale = initial || permissions.zoom
      ? Math.max(MIN_ZOOM, Math.min(1, (canvas.clientWidth - (display.frame ? 64 : 32)) / width,
        usableHeight / height))
      : camera.k;
    selection.call(zoomBehavior.transform, zoomIdentity
      .translate(canvas.clientWidth / 2 - (minX + width / 2) * scale,
        top + usableHeight / 2 - (minY + height / 2) * scale).scale(scale));
  }

  function chooseTree(entry: CanvasTree): void {
    if (interaction.kind === 'picking') {
      if (!permissions.combineTrees) return;
      if (entry.id === interaction.left) {
        announce('Choose a different tree as the right input.');
        return;
      }
      interaction = { kind: 'operation', left: interaction.left, right: entry.id };
      highlightInputs();
      required<HTMLElement>(host, '.lab-operands').textContent =
        `${model.nameOf(interaction.left)} (left) + ${entry.name} (right)`;
      operationInput.value = 'union';
      required<HTMLOptionElement>(operationInput, '[value=subtract]').textContent =
        `Subtract ${model.nameOf(interaction.left)} − ${entry.name}`;
      required<HTMLElement>(host, '.lab-combine-error').hidden = true;
      status.hidden = true;
      combinePanel.hidden = false;
      positionMenus();
      operationInput.focus({ preventScroll: true });
    } else if (interaction.kind === 'idle') showTreeMenu(entry);
  }

  function generationSpec(): Generation {
    const number = (name: string) => required<HTMLInputElement>(host, `[name=${name}]`).valueAsNumber;
    switch (generationInput.value) {
      case 'size': return { kind: 'size', count: number('count'), start: number('start') };
      case 'ranges': return { kind: 'ranges', ranges: required<HTMLTextAreaElement>(host, '[name=ranges]').value };
      case 'random': return {
        kind: 'random', count: number('count'), min: number('minimum'), max: number('maximum'), seed: number('seed')
      };
      default: throw new Error('Choose a key generation method.');
    }
  }

  function previewGeneration(): void {
    const preview = required<HTMLElement>(host, '.lab-generation-preview');
    try {
      const keys = generateKeys(generationSpec());
      preview.textContent = keys.length
        ? `${keys.length} unique keys: ${keys.slice(0, 8).map(formatKey).join(' | ')}${
          keys.length > 8 ? ` ... ${formatKey(keys[keys.length - 1])}` : ''}` : 'Empty tree (0 keys).';
      preview.classList.remove('is-invalid');
    } catch (failure) {
      preview.textContent = failure instanceof Error ? failure.message : String(failure);
      preview.classList.add('is-invalid');
    }
  }

  function updateGenerator(): void {
    host.querySelectorAll<HTMLFieldSetElement>('[data-generator]').forEach(fields => {
      fields.hidden = fields.disabled = fields.dataset.generator !== generationInput.value;
    });
    required<HTMLElement>(host, '.lab-count').hidden = generationInput.value === 'ranges';
    required<HTMLInputElement>(host, '[name=count]').disabled = generationInput.value === 'ranges';
    error.hidden = true;
    previewGeneration();
    positionMenus();
  }

  function redrawConnections(): void {
    connections.replaceChildren();
    for (const entry of model.trees) {
      const origin = entry.origin;
      if (!origin || entry.operationInvalidated) continue;
      if (!layouts.has(origin.left) || !layouts.has(origin.right)) continue;
      const destination = layouts.get(entry.id)!;
      [origin.left, origin.right].forEach((id, index) => {
        const source = model.get(id);
        const sourceLayout = layouts.get(id)!;
        const x1 = source.x + sourceLayout.width / 2;
        const y1 = source.y + sourceLayout.height;
        const x2 = entry.x + destination.width / 2 + (index === 0 ? -24 : 24);
        const y2 = entry.y;
        const middle = (y1 + y2) / 2;
        const d = `M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`;
        const edge = svg('g', {
          class: `lab-operation-edge${permissions.selectOperations ? ' is-interactive' : ''}`,
          'data-result-id': entry.id, 'data-source-id': id,
          'data-operation': origin.operation, 'data-left-id': origin.left, 'data-right-id': origin.right,
          ...(permissions.selectOperations ? {
            tabindex: 0, role: 'button', 'aria-label': `Highlight shared nodes in ${describe(entry)}`
          } : {})
        });
        edge.append(
          svg('title', {}, `${source.name} is the ${index === 0 ? 'left' : 'right'} input to ${
            describe(entry)}.${permissions.selectOperations
              ? ' Click to color each connected subtree reused by the result from either input.' : ''}`),
          svg('path', { d, class: 'lab-operation-link' }),
          svg('circle', { cx: x2, cy: y2, r: 5, class: 'lab-operation-end' }),
          svg('path', { d, class: 'lab-operation-hit' })
        );
        const label = svg('g', { class: 'lab-operation-label' });
        label.append(
          svg('rect'),
          svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' },
            operationLabel(origin.operation, model.nameOf(origin.left),
              model.nameOf(origin.right), entry.name))
        );
        edge.append(label);
        edge.addEventListener('click', event => {
          event.stopPropagation();
          selectOperation(entry.id);
        });
        edge.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            selectOperation(entry.id);
          }
        });
        connections.append(edge);
      });
    }
    applyHighlights();
  }

  function selectOperation(result: number): void {
    if (!permissions.selectOperations) return;
    if (isOperationPinned() && result !== selectedOperation) return;
    const entry = model.get(result), origin = entry.origin;
    if (!origin || entry.operationInvalidated || !layouts.has(origin.left) || !layouts.has(origin.right)) {
      announce('This operation no longer has both input trees on the canvas.');
      return;
    }
    dismiss();
    highlight = { kind: 'operation', result };
    applyHighlights();
    const shared = model.operationSharing(result);
    if (shared.missing.length) {
      announce(`${shared.missing.map(id => model.nameOf(id)).join(', ')} removed; highlighting nodes shared by the result and the remaining inputs.`);
    } else if (!shared.nodes.size) {
      announce('No node objects are shared by the result and its inputs.');
    }
  }

  function selectNode(entry: CanvasTree, placed: PlacedNode): void {
    if (!permissions.selectNodes && !permissions.treeMenus) return;
    const reconstructing = timelinePhase === 'reconstruction' && highlight.kind === 'operation';
    if (reconstructing) {
      hideTreeMenu();
      selectedReconstructionNode = undefined;
    } else dismiss();
    if (permissions.selectNodes) {
      if (isOperationPinned() || reconstructing) pinnedNodeSelection = model.identity(placed.node);
      else highlight = { kind: 'node', identity: model.identity(placed.node) };
      applyHighlights();
    }
    showTreeMenu(entry, placed);
  }

  function drawTree(layout: TreeLayout): void {
    const { entry } = layout;
    const group = svg('g', {
      class: 'lab-tree', transform: `translate(${entry.x},${entry.y})`, 'data-tree-id': entry.id
    });
    if (display.treeFrames) group.append(svg('rect', {
      width: layout.width, height: layout.height, rx: 14, class: 'lab-tree-card'
    }));
    const handle = svg('g', {
      class: `lab-tree-handle${permissions.moveTrees ? ' is-movable' : ''}${
        permissions.treeMenus ? ' is-interactive' : ''}`, 'data-tree-id': entry.id,
      ...(permissions.treeMenus ? { tabindex: 0, role: 'button', 'aria-label': `Actions for ${entry.name}` } : {})
    });
    handle.append(svg('rect', { width: layout.width, height: HEADER_HEIGHT - 14, rx: 14, fill: entry.color }));
    handle.append(svg('text', { x: 20, y: 29, class: 'lab-tree-title' }, describe(entry)));
    const reused = layout.nodes.filter(n => model.identity(n.node).owner.id !== entry.id).length;
    handle.append(svg('text', { x: 20, y: 53, class: 'lab-tree-meta' },
      `${entry.tree.size} keys · ${layout.nodes.length} nodes · ${reused} reused${
        permissions.moveTrees ? ' · drag to move' : ''}`));
    let suppressClick = false;
    group.addEventListener('pointerdown', () => { suppressClick = false; }, true);
    group.addEventListener('click', event => {
      event.stopPropagation();
      if (!suppressClick) chooseTree(entry);
    });
    handle.addEventListener('keydown', event => {
      if (permissions.treeMenus && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        event.stopPropagation();
        chooseTree(entry);
        if (!treeMenu.hidden) required<HTMLButtonElement>(treeMenu, '[data-action=center-tree]').focus();
      }
    });
    handle.addEventListener('pointerdown', event => {
      if (!permissions.moveTrees || event.button !== 0 || drag || interaction.kind !== 'idle') return;
      event.preventDefault();
      event.stopPropagation();
      hideTreeMenu();
      handle.setPointerCapture(event.pointerId);
      drag = {
        id: entry.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY,
        originX: entry.x, originY: entry.y, moved: false
      };
    });
    handle.addEventListener('pointermove', event => {
      if (!permissions.moveTrees || !drag || drag.id !== entry.id || event.pointerId !== drag.pointer) return;
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        treeLayer.append(group);
        handle.setPointerCapture(event.pointerId);
      }
      if (!drag.moved) return;
      group.classList.add('is-dragging');
      entry.x = drag.originX + dx / camera.k;
      entry.y = drag.originY + dy / camera.k;
      group.setAttribute('transform', `translate(${entry.x},${entry.y})`);
      model.refreshIdentities();
      redrawConnections();
    });
    function finish(event: PointerEvent): void {
      if (!drag || event.pointerId !== drag.pointer) return;
      const finished = drag;
      drag = undefined;
      suppressClick = finished.moved;
      if (event.type === 'pointercancel') {
        entry.x = finished.originX;
        entry.y = finished.originY;
        group.setAttribute('transform', `translate(${entry.x},${entry.y})`);
      }
      group.classList.remove('is-dragging');
      redrawConnections();
    }
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    if (display.treeHeaders) group.append(handle, svg('text', { x: 16, y: -12, class: 'lab-input-label' }));
    for (const { parent, child, index } of layout.edges) {
      const x = parent.x - parent.width / 2 + parent.cellWidth * (index + 0.5);
      const y = parent.y + parent.height;
      group.append(svg('path', {
        d: `M${x},${y} C${x},${y + 28} ${child.x},${child.y - 28} ${child.x},${child.y}`,
        class: 'lab-child-link',
        'data-parent-id': model.identity(parent.node).id,
        'data-child-id': model.identity(child.node).id
      }));
    }
    for (const placed of layout.nodes) {
      const identity = model.identity(placed.node);
      const node = svg('g', {
        class: `lab-node${permissions.selectNodes ? ' is-interactive' : ''}`,
        transform: `translate(${placed.x - placed.width / 2},${placed.y})`,
        'data-node-id': identity.id,
        ...(permissions.selectNodes ? {
          tabindex: 0, role: 'button',
          'aria-label': `Node ${identity.id}, keys ${placed.node.keys.map(formatKey).join(', ') || 'empty'}, first seen in ${identity.owner.name}`
        } : {})
      });
      node.append(svg('rect', {
        width: placed.width, height: placed.height, rx: 6,
        fill: display.colorMode === 'levels' ? placed.node.isLeaf ? '#dcfce7' : '#dbeafe' : identity.color,
        class: 'lab-node-box'
      }));
      if (placed.valueY !== undefined && placed.node.keys.length) {
        node.append(svg('line', {
          x1: 0, x2: placed.width, y1: 25, y2: 25, class: 'lab-value-divider'
        }));
      }
      placed.node.keys.forEach((key, index) => {
        if (index) node.append(svg('line', {
          x1: index * placed.cellWidth, x2: index * placed.cellWidth, y1: 0,
          y2: display.nodeMetadata ? placed.height - 21 : placed.height, class: 'lab-cell-divider'
        }));
        node.append(svg('text', {
          x: (index + 0.5) * placed.cellWidth, y: placed.keyY, 'text-anchor': 'middle', class: 'lab-key', 'data-key': key
        }, formatKey(key)));
        if (placed.valueY !== undefined) {
          node.append(svg('text', {
            x: (index + 0.5) * placed.cellWidth, y: placed.valueY, 'text-anchor': 'middle',
            class: 'lab-value', 'aria-label': `Value for key ${formatKey(key)}: ${formatLeafValue(placed.node.values[index])}`
          }, formatLeafValue(placed.node.values[index])));
        }
      });
      if (!placed.node.keys.length)
        node.append(svg('text', { x: placed.width / 2, y: placed.keyY, 'text-anchor': 'middle' }, '∅'));
      if (placed.metadataY !== undefined) node.append(svg('text', {
        x: placed.width / 2, y: placed.metadataY, 'text-anchor': 'middle', class: 'lab-node-meta'
      }, `#${identity.id} · ${identity.owner.name} · shared: ${placed.node.isShared === true}`));
      if (permissions.selectNodes)
        node.append(svg('title', {}, `Click to highlight every occurrence of node #${identity.id}.`));
      function activate(): void {
        if (interaction.kind === 'picking') chooseTree(entry);
        else selectNode(entry, placed);
      }
      node.addEventListener('click', event => { event.stopPropagation(); activate(); });
      node.addEventListener('keydown', event => {
        if ((permissions.selectNodes || permissions.treeMenus || (permissions.combineTrees && interaction.kind === 'picking')) &&
            (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          activate();
        }
      });
      group.append(node);
    }
    group.append(svg('g', { class: 'lab-chunk-ranges' }));
    groups.set(entry.id, group);
    treeLayer.append(group);
  }

  function render(): void {
    model.refreshIdentities();
    treeLayer.replaceChildren();
    groups.clear();
    layouts.clear();
    for (const entry of model.trees) {
      const layout = layoutTree(entry, layoutOptions);
      layouts.set(entry.id, layout);
      drawTree(layout);
    }
    redrawConnections();
    highlightInputs();
    const empty = required<HTMLElement>(host, '.lab-empty');
    empty.hidden = model.trees.length > 0;
    empty.textContent = permissions.addTrees && display.toolbar
      ? 'No trees yet. Use Add tree to start.' : 'No trees to display.';
  }

  function placeNewTree(result: CanvasTree): void {
    const resultLayout = layoutTree(result, layoutOptions);
    if (result.origin) {
      const a = model.get(result.origin.left), b = model.get(result.origin.right);
      result.x = (a.x + layouts.get(a.id)!.width / 2 + b.x + layouts.get(b.id)!.width / 2) / 2 -
        resultLayout.width / 2;
    } else if (result.clonedFrom !== undefined) {
      const source = model.get(result.clonedFrom);
      const sourceLayout = layouts.get(source.id)!;
      result.x = source.x + sourceLayout.width / 2 - resultLayout.width / 2;
    } else {
      const [center] = camera.invert([canvas.clientWidth / 2, canvas.clientHeight / 2]);
      result.x = center - resultLayout.width / 2;
    }
    const previous = model.trees.filter(entry => entry.id !== result.id);
    result.y = previous.length
      ? Math.max(...previous.map(entry => entry.y + layouts.get(entry.id)!.height)) + 140 : 0;
    dismiss();
    render();
    announce(`${describe(result)} created with ${result.tree.size} keys.`);
    if (autoCenter) fit([result]);
    canvas.focus({ preventScroll: true });
  }

  creationForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!permissions.addTrees) return;
    try { placeNewTree(model.generate(generationSpec())); }
    catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
    }
  });
  creationForm.addEventListener('input', () => {
    if (permissions.addTrees) { error.hidden = true; previewGeneration(); }
  });
  generationInput.addEventListener('change', () => { if (permissions.addTrees) updateGenerator(); });
  required<HTMLFormElement>(host, '.lab-combine').addEventListener('submit', event => {
    event.preventDefault();
    if (!permissions.combineTrees) return;
    try {
      if (interaction.kind !== 'operation') throw new Error('Select two trees before combining.');
      const operation = operationInput.value;
      if (operation !== 'union' && operation !== 'subtract' && operation !== 'intersect')
        throw new Error(`Unsupported operation: ${operation}`);
      placeNewTree(model.combine(interaction.left, interaction.right, operation));
    } catch (failure) {
      const message = required<HTMLElement>(host, '.lab-combine-error');
      message.textContent = failure instanceof Error ? failure.message : String(failure);
      message.hidden = false;
    }
  });

  host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    button.addEventListener('click', () => {
      switch (button.dataset.action) {
        case 'add': {
          if (!permissions.addTrees || !display.toolbar) return;
          const opening = addPanel.hidden;
          dismiss();
          if (opening) {
            status.hidden = true;
            addPanel.hidden = false;
            addButton.setAttribute('aria-expanded', 'true');
            updateGenerator();
            generationInput.focus({ preventScroll: true });
          }
          break;
        }
        case 'close-add': dismiss(); addButton.focus({ preventScroll: true }); break;
        case 'cancel':
          dismiss(); canvas.focus({ preventScroll: true }); break;
        case 'clear-timeline':
          if (permissions.timeline && canClearSelection) {
            dismiss(); canvas.focus({ preventScroll: true });
          }
          break;
        case 'center-tree':
          if (permissions.treeMenus && menuTree !== undefined) {
            centerSelectedNode();
          }
          break;
        case 'clone': {
          if (!permissions.treeMenus || !permissions.cloneTrees) return;
          if (menuTree === undefined) throw new Error('Select a tree to clone.');
          placeNewTree(model.clone(menuTree));
          break;
        }
        case 'add-element':
        case 'remove-element': {
          const adding = button.dataset.action === 'add-element';
          if (!permissions.treeMenus || !(adding ? permissions.addElements : permissions.removeElements)) return;
          if (menuTree === undefined || !menuSelection?.range) throw new Error('Select a non-empty node to edit.');
          const entry = model.get(menuTree);
          try {
            const action: ElementAction = adding ? 'add' : 'remove';
            const pendingEdit = pendingEdits.get(action);
            const prepared = pendingEdit?.treeId === entry.id
              ? pendingEdit : model.previewElement(entry.id, action, menuSelection.range);
            const result = model.applyElement(prepared);
            pendingEdits.clear();
            clearEditPreview();
            highlight = { kind: 'none' };
            timelineStep = -1;
            timelineFailure = undefined;
            dismiss(true, true);
            render();
            showTreeMenu(entry);
            if (autoCenter) centerSelectedNode();
            announce(`${entry.name}: ${adding ? 'added' : 'removed'} key ${formatKey(result.key)}.`);
            const focusAction = adding || !required<HTMLButtonElement>(treeMenu, '[data-action=remove-element]').disabled
              ? button.dataset.action : 'add-element';
            required<HTMLButtonElement>(treeMenu, `[data-action=${focusAction}]`).focus({ preventScroll: true });
            const nextAction = activeEditAction();
            if (nextAction) previewEdit(nextAction);
          } catch (failure) {
            announce(failure instanceof Error ? failure.message : String(failure));
          }
          break;
        }
        case 'combine': {
          if (!permissions.treeMenus || !permissions.combineTrees) return;
          if (menuTree === undefined) throw new Error('Select a tree to combine.');
          const left = menuTree;
          dismiss();
          interaction = { kind: 'picking', left };
          status.hidden = true;
          highlightInputs();
          if (autoCenter) fit();
          canvas.focus({ preventScroll: true });
          break;
        }
        case 'delete': {
          if (!permissions.treeMenus || !permissions.deleteTrees) return;
          if (menuTree === undefined) throw new Error('Select a tree to delete.');
          const id = menuTree, name = model.nameOf(id);
          dismiss();
          if (highlight.kind === 'operation' &&
              [highlight.result, model.get(highlight.result).origin!.left, model.get(highlight.result).origin!.right].includes(id)) {
            highlight = { kind: 'none' };
            pinnedNodeSelection = undefined;
            timelineStep = -1;
            timelineFailure = undefined;
          }
          model.remove(id);
          render();
          announce(`${name} removed from the canvas. Existing results are unchanged.`);
          if (autoCenter && !model.trees.length) fit();
          canvas.focus({ preventScroll: true });
          break;
        }
        case 'new-seed': {
          if (!permissions.addTrees) return;
          const input = required<HTMLInputElement>(host, '[name=seed]');
          let seed = crypto.getRandomValues(new Uint32Array(1))[0];
          if (seed === input.valueAsNumber) seed = (seed + 1) >>> 0;
          input.value = String(seed);
          error.hidden = true;
          previewGeneration();
          break;
        }
        case 'fit':
          if (display.toolbar) { hideTreeMenu(); fit(); }
          break;
        case 'in':
        case 'out':
          if (permissions.zoom && display.toolbar)
            selection.call(zoomBehavior.scaleBy, button.dataset.action === 'in' ? 1.3 : 1 / 1.3);
          break;
      }
    });
  });

  // dismiss() is otherwise unconditional, so without this check every playground instance on the
  // page (there are usually several) would re-render its full node/link highlight state and
  // tree-input labels on *every* pointerdown anywhere on the page, including ordinary taps on
  // unrelated prose/TOC links. That synchronous DOM churn directly under a touch can make iOS
  // Safari's touch-to-click gesture recognizer decide the tapped content changed underneath the
  // finger and silently cancel the synthesized click (long-press/context-menu still works, since
  // that's a separate gesture path) -- matching reports of taps doing nothing on iPhone while a
  // long-press correctly opens the link. Mirror dismiss()'s own effective no-op conditions here so
  // we only pay for- and perform- the heavy re-render when something is actually open to clear.
  function wouldDismissAnything(clearHighlights: boolean): boolean {
    if (!treeMenu.hidden) return true;
    if (clearHighlights && canClearSelection &&
        (pinnedNodeSelection !== undefined || selectedReconstructionNode !== undefined ||
          (!isOperationPinned() && highlight.kind !== 'none'))) return true;
    if (!addPanel.hidden || !combinePanel.hidden) return true;
    if (!status.hidden) return true;
    if (interaction.kind !== 'idle') return true;
    return false;
  }
  // Shared by both the (non-touch) pointerdown path below and the touch/click path further down:
  // decides whether `target` is "outside" this instance in the sense that an activation there
  // should dismiss this instance's menu/selection, and if so, does it.
  function dismissIfOutside(target: Element): void {
    const playground = target.closest('.tree-playground');
    if (playground && playground !== host) return;
    if (host.contains(target) && target.closest('.lab-popover, .lab-tree-menu, .lab-camera, .lab-pick-prompt, .lab-timeline')) return;
    if (interaction.kind === 'picking' && host.contains(target)) return;
    const clearHighlights = !canvas.contains(target);
    if (!wouldDismissAnything(clearHighlights)) return;
    dismiss(clearHighlights);
  }
  function outsidePointerDown(event: PointerEvent): void {
    // A touch pointerdown is handled on the later 'click' instead (see outsideClick below): by
    // the time 'click' fires, Safari has already decided to synthesize it, so running the heavy
    // dismiss/re-render there can no longer cause it to cancel that decision. Running it here, on
    // pointerdown, would mutate the DOM while Safari is still deciding, for exactly the taps (an
    // outside link/summary, while some *other* diagram has a menu/selection open) most likely to
    // need a real dismiss -- i.e. the case this guard specifically has to cover.
    if (event.pointerType === 'touch') return;
    if (!(event.target instanceof Element)) return;
    dismissIfOutside(event.target);
  }
  document.addEventListener('pointerdown', outsidePointerDown);
  function outsideClick(event: MouseEvent): void {
    if (!touchOriginatedClicks.has(event)) return;
    if (!(event.target instanceof Element)) return;
    dismissIfOutside(event.target);
  }
  document.addEventListener('click', outsideClick);
  function blankClick(event: MouseEvent): void {
    if (event.target instanceof Element && !event.target.closest('.lab-tree, .lab-operation-edge')) dismiss();
  }
  canvas.addEventListener('click', blankClick);
  function hostKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof Element && event.target.closest('.tree-playground') !== host) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      canvas.focus({ preventScroll: true });
    }
  }
  host.addEventListener('keydown', hostKeyDown);
  function canvasKeyDown(event: KeyboardEvent): void {
    if (event.key === '+' || event.key === '=') {
      if (!permissions.zoom) return;
      selection.call(zoomBehavior.scaleBy, 1.3);
    }
    else if (event.key === '-') {
      if (!permissions.zoom) return;
      selection.call(zoomBehavior.scaleBy, 1 / 1.3);
    }
    else if (event.key === '0') fit();
    else if (event.key.startsWith('Arrow')) {
      if (!permissions.pan) return;
      const directions: Record<string, [number, number]> = {
        ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60]
      };
      const [dx, dy] = directions[event.key];
      selection.call(zoomBehavior.translateBy, dx / camera.k, dy / camera.k);
    } else return;
    event.preventDefault();
  }
  canvas.addEventListener('keydown', canvasKeyDown);

  let inputX = 0, inputY = 0;
  const initialWidths = initialLayout === 'vertical'
    ? model.trees.filter(entry => !entry.origin).map(entry => layoutTree(entry, layoutOptions).width)
    : [];
  const widestInput = Math.max(0, ...initialWidths);
  for (const entry of model.trees) {
    const layout = layoutTree(entry, layoutOptions);
    if (entry.origin) {
      const left = layouts.get(entry.origin.left)!, right = layouts.get(entry.origin.right)!;
      entry.x = (left.entry.x + left.width / 2 + right.entry.x + right.width / 2) / 2 - layout.width / 2;
      entry.y = Math.max(...Array.from(layouts.values(), previous => previous.entry.y + previous.height)) + 140;
    } else {
      if (initialLayout === 'vertical') {
        entry.x = (widestInput - layout.width) / 2;
        entry.y = inputY;
        inputY += layout.height + 120;
      } else {
        entry.x = inputX;
        inputX += layout.width + 120;
      }
    }
    layouts.set(entry.id, layout);
  }
  render();
  if (permissions.addTrees) updateGenerator();
  let previousWidth = 0, previousHeight = 0;
  let disposed = false;
  const observer = new ResizeObserver(() => {
    if (disposed) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    if (!previousWidth) fit(model.trees, true);
    else selection.call(zoomBehavior.translateBy, (width - previousWidth) / (2 * camera.k),
      (height - previousHeight) / (2 * camera.k));
    previousWidth = width;
    previousHeight = height;
    positionMenus();
  });
  observer.observe(canvas);
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener('pointerdown', outsidePointerDown);
    document.removeEventListener('click', outsideClick);
    detachGlobalTouchTracker();
    host.removeEventListener('keydown', hostKeyDown);
    canvas.removeEventListener('keydown', canvasKeyDown);
    canvas.removeEventListener('wheel', wheelPan);
    canvas.removeEventListener('click', blankClick);
    canvas.removeEventListener('click', suppressGestureClick, true);
    canvas.removeEventListener('pointerdown', startCameraGesture);
    canvas.removeEventListener('pointermove', moveCameraGesture);
    canvas.removeEventListener('pointerup', finishCameraGesture);
    canvas.removeEventListener('pointercancel', finishCameraGesture);
    canvas.removeEventListener('lostpointercapture', finishCameraGesture);
    canvas.removeEventListener('gesturestart', preventNativeGesture);
    canvas.removeEventListener('gesturechange', preventNativeGesture);
    canvas.removeEventListener('selectstart', preventCanvasSelection);
    canvas.removeEventListener('dragstart', preventCanvasSelection);
    for (const [id, point] of pointers)
      if (point.target.hasPointerCapture(id)) point.target.releasePointerCapture(id);
    pointers.clear();
    selection.on('.zoom', null);
    zoomBehavior.on('zoom', null);
    if (mounted.get(host) === dispose) {
      mounted.delete(host);
      host.replaceChildren();
    }
  }
  mounted.set(host, dispose);
  return dispose;
}
