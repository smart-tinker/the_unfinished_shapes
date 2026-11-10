import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SHAPE_DEFAULT_SIZES } from '../../src/movement.mjs';
import assert from 'node:assert/strict';

// Execute renderer state/event logic without pretending this is a WebGL or Electron test.
const source = readFileSync(new URL('../../src/renderer.mjs', import.meta.url), 'utf8');
export function rendererHarness() {
  const elements = new Map();
  let sequence = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', hidden: false, disabled: false, textContent: '', dataset: {}, style: {}, children: [], listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      setAttribute(name, value) { this[name] = value; },
      replaceChildren(...children) { this.children = []; children.forEach(child => this.append(child)); },
      append(child) { child.parent = this; this.children.push(child); },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      get firstElementChild() { return this.children[0]; },
    });
    return elements.get(id);
  }
  const context = vm.createContext({ console, structuredClone, JSON, Number, Object, Map, String, Boolean, SHAPE_DEFAULT_SIZES,
    selectedId: null, selectedIds: new Set(), selectionBoxes: new Map(), MAX_GROUP_SELECTION: 32,
    boxSelectMode: false, boxCandidate: null, movePreview: null, dragCandidate: null,
    worldLightingPreview: null, lampLights: new Map(), updateWorldLighting: () => {}, updateLightingControls: () => {},
    agentBuildPreview: null, clearAgentBuildPreview: () => {}, updateAgentBuildPreviewControls: () => {}, poll: async () => {},
    document: { createElement: () => element(`generated-${++sequence}`) }, $: element,
  });
  function run(code) { return vm.runInContext(code, context); }
  function load(start, end) {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Renderer test boundaries missing: ${start} … ${end}`);
    run(source.slice(from, to));
  }
  function text() { return [...elements.values()].map(node => node.textContent).join('\n'); }
  load('function refreshAgentStatus()', 'function populateAgentEfforts(');
  return { context, element, run, load, text, has: start => source.includes(start) };
}
