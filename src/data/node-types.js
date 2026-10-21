import { isSafeTestValue } from '../scripts/test-values';
export const PORTS = {
  start: { inputs: [], outputs: [{ id: 'out', label: 'Next', kind: 'flow', top: 162 }] },
  process: { inputs: [{ id: 'in', label: 'In', kind: 'flow', top: 162 }], outputs: [{ id: 'out', label: 'Next', kind: 'flow', top: 162 }] },
  conditional: { inputs: [{ id: 'in', label: 'Flow', kind: 'flow', top: 169 }, { id: 'condition', label: 'Test', kind: 'boolean', top: 203 }], outputs: [{ id: 'true', label: 'Yes', kind: 'flow', top: 169 }, { id: 'false', label: 'No', kind: 'flow', top: 203 }] },
  end: { inputs: [{ id: 'in', label: 'In', kind: 'flow', top: 162 }], outputs: [] },
  boolean: { inputs: [], outputs: [{ id: 'out', label: 'Value', kind: 'boolean', top: 170 }] },
  not: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 169 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 169 }] },
  and: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 161 }, { id: 'b', label: 'B', kind: 'boolean', top: 196 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 178 }] },
  or: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 161 }, { id: 'b', label: 'B', kind: 'boolean', top: 196 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 178 }] },
  nand: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 161 }, { id: 'b', label: 'B', kind: 'boolean', top: 196 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 178 }] },
  nor: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 161 }, { id: 'b', label: 'B', kind: 'boolean', top: 196 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 178 }] },
  xor: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 161 }, { id: 'b', label: 'B', kind: 'boolean', top: 196 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 178 }] },
  xnor: { inputs: [{ id: 'a', label: 'A', kind: 'boolean', top: 161 }, { id: 'b', label: 'B', kind: 'boolean', top: 196 }], outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 178 }] },
  output: { inputs: [{ id: 'in', label: 'Value', kind: 'data', dataType: 'any', top: 170 }], outputs: [] },
  comment: { inputs: [], outputs: [] },
  custom: { inputs: [], outputs: [] }, // v0.2 compatibility
  function: { inputs: [], outputs: [] },
  variable: { inputs: [], outputs: [{ id: 'out', label: 'Value', kind: 'data', dataType: 'number', top: 170 }] },
  watch: { inputs: [{ id: 'in', label: 'Data', kind: 'data', dataType: 'any', top: 173 }], outputs: [{ id: 'out', label: 'Pass', kind: 'data', dataType: 'any', top: 173 }] },
  assert: { inputs: [{ id: 'in', label: 'Data', kind: 'data', dataType: 'any', top: 173 }], outputs: [{ id: 'out', label: 'Pass', kind: 'data', dataType: 'any', top: 173 }] },
  compare: { inputs: [{ id: 'a', label: 'A', kind: 'data', dataType: 'any', top: 169 }, { id: 'b', label: 'B', kind: 'data', dataType: 'any', top: 201 }], outputs: [{ id: 'out', label: 'Result', kind: 'boolean', top: 178 }] },
  ...Object.fromEntries(['add', 'subtract', 'multiply', 'divide', 'modulo', 'power'].map(type => [type, { inputs: [{ id: 'a', label: 'A', kind: 'data', dataType: 'number', top: 169 }, { id: 'b', label: 'B', kind: 'data', dataType: 'number', top: 201 }], outputs: [{ id: 'out', label: 'Result', kind: 'data', dataType: 'number', top: 186 }] }])),
  negate: { inputs: [{ id: 'a', label: 'Value', kind: 'data', dataType: 'number', top: 172 }], outputs: [{ id: 'out', label: 'Result', kind: 'data', dataType: 'number', top: 172 }] },
  concat: { inputs: [{ id: 'a', label: 'Text A', kind: 'data', dataType: 'string', top: 169 }, { id: 'b', label: 'Text B', kind: 'data', dataType: 'string', top: 201 }], outputs: [{ id: 'out', label: 'Text', kind: 'data', dataType: 'string', top: 186 }] },
};

export const NODE_TYPES = {
  start: { label: 'Start', category: 'Control flow', description: 'Entry point for your simulation', icon: 'play', accent: '#48d6b2', width: 198 },
  process: { label: 'Process', category: 'Control flow', description: 'Run a step in the flow', icon: 'box', accent: '#65a9ff', width: 208 },
  conditional: { label: 'Decision', category: 'Control flow', description: 'Route execution by a condition', icon: 'branch', accent: '#f6b968', width: 230 },
  end: { label: 'End', category: 'Control flow', description: 'Complete a flow branch', icon: 'stop', accent: '#f391a2', width: 196 },
  boolean: { label: 'Boolean', category: 'Logic', description: 'TRUE / FALSE input switch', icon: 'toggle', accent: '#a68dff', width: 208 },
  and: { label: 'AND gate', category: 'Logic', description: 'Both inputs must be true', icon: 'gate', accent: '#a68dff', width: 210 },
  or: { label: 'OR gate', category: 'Logic', description: 'Either input may be true', icon: 'gate', accent: '#a68dff', width: 210 },
  not: { label: 'NOT gate', category: 'Logic', description: 'Invert an input', icon: 'gate', accent: '#a68dff', width: 210 },
  xor: { label: 'XOR gate', category: 'Logic', description: 'Exactly one input is true', icon: 'gate', accent: '#a68dff', width: 210 },
  nand: { label: 'NAND gate', category: 'Logic', description: 'Inverted AND', icon: 'gate', accent: '#a68dff', width: 210 },
  nor: { label: 'NOR gate', category: 'Logic', description: 'Inverted OR', icon: 'gate', accent: '#a68dff', width: 210 },
  xnor: { label: 'XNOR gate', category: 'Logic', description: 'Both inputs match', icon: 'gate', accent: '#a68dff', width: 210 },
  output: { label: 'Monitor', category: 'Output & notes', description: 'Watch a Boolean signal', icon: 'monitor', accent: '#42cfcc', width: 208 },
  comment: { label: 'Note', category: 'Output & notes', description: 'Add documentation on the canvas', icon: 'note', accent: '#e3c178', width: 230 },
  custom: { label: 'Function', category: 'Logic', description: 'Older saved function node', icon: 'box', accent: '#e889d8', width: 256 },
  function: { label: 'Function', category: 'Programming', description: 'Typed data plus EXEC/DONE ↔ NEXT sequencing', icon: 'box', accent: '#e889d8', width: 256 },
  variable: { label: 'Variable', category: 'Programming', description: 'A number, string, or Boolean value', icon: 'box', accent: '#6dcee8', width: 215 },
  watch: { label: 'Watch', category: 'Debugging', description: 'Record and validate flowing values', icon: 'monitor', accent: '#38d4cf', width: 215 },
  assert: { label: 'Assert', category: 'Debugging', description: 'Flag an unexpected input', icon: 'alert', accent: '#ef9c6b', width: 215 },
  'source-start': { label: 'Function Entry', category: 'Import', description: 'Parameters from imported source', icon: 'play', accent: '#47d7b5', width: 250 },
  'source-operation': { label: 'Source Operation', category: 'Import', description: 'Editable assignment from source', icon: 'box', accent: '#77b4ff', width: 250 },
  'source-decision': { label: 'Source Condition', category: 'Import', description: 'Condition from imported source', icon: 'branch', accent: '#eeb979', width: 250 },
  'source-return': { label: 'Source Return', category: 'Import', description: 'Return from imported source', icon: 'stop', accent: '#eb9eac', width: 250 },
  'source-property-read': { label: 'Property Access', category: 'Import', description: 'Inspect property lookup', icon: 'box', accent: '#74baca', width: 225 },
  'source-property-write': { label: 'Property Write', category: 'Import', description: 'Update a structured value', icon: 'box', accent: '#80d4ac', width: 255 },
  'source-method': { label: 'Method Call', category: 'Import', description: 'Inspect whitelisted method invocation', icon: 'box', accent: '#af9ee9', width: 235 },
  'source-optional': { label: 'Optional Chain', category: 'Import', description: 'Optional property access', icon: 'box', accent: '#afc7e6', width: 225 },
  'source-math': { label: 'Arithmetic', category: 'Import', description: 'Inspect arithmetic operation', icon: 'box', accent: '#75afee', width: 225 },
  'source-comparison': { label: 'Logic Operation', category: 'Import', description: 'Inspect logical comparison', icon: 'box', accent: '#e9b97e', width: 225 },
  'source-object': { label: 'Object Literal', category: 'Import', description: 'Object structure and member values', icon: 'box', accent: '#8bd4b8', width: 240 },
  'source-array': { label: 'Array Literal', category: 'Import', description: 'Array structure', icon: 'box', accent: '#8bd4b8', width: 235 },
  'source-template': { label: 'Template Literal', category: 'Import', description: 'Interpolated string', icon: 'box', accent: '#8bd4b8', width: 235 },
  'source-ternary-step': { label: 'Ternary Select', category: 'Import', description: 'Select conditional expression branch', icon: 'branch', accent: '#e5b57e', width: 245 },
  'source-call': { label: 'Function Dependency', category: 'Import', description: 'Linked function referenced by source; never executes native code', icon: 'box', accent: '#de9ef4', width: 260 },
  'source-update': { label: 'Increment / Update', category: 'Import', description: 'Simulated local variable update', icon: 'plus', accent: '#77b4ff', width: 250 },
  'source-declare': { label: 'Declaration', category: 'Import', description: 'Local declaration without initial value', icon: 'box', accent: '#7ebbbd', width: 250 },
  'source-loop': { label: 'Loop (Not Simulated)', category: 'Import', description: 'Loop preserved; iterations not executed', icon: 'rotate', accent: '#f1a971', width: 250 },
  'source-switch': { label: 'Switch (Not Simulated)', category: 'Import', description: 'Switch preserved; case selection not simulated', icon: 'branch', accent: '#e6bd82', width: 250 },
  'source-try': { label: 'Try / Catch (Not Simulated)', category: 'Import', description: 'Exception paths preserved; not executed', icon: 'alert', accent: '#e6a2a2', width: 250 },
  'source-throw': { label: 'Throw / Exit', category: 'Import', description: 'Unverified throw terminates simulation', icon: 'stop', accent: '#f08893', width: 250 },
  'source-await': { label: 'Async / Await (Not Simulated)', category: 'Import', description: 'Async expression preserved; not executed', icon: 'alert', accent: '#9fa6ed', width: 250 },
  'source-opaque': { label: 'Unsupported Source', category: 'Import', description: 'Preserved but never executed', icon: 'alert', accent: '#ef806b', width: 250 },
  'source-value': { label: 'Source Variable / Literal', category: 'Import', description: 'Primitive expression input; read-only view', icon: 'box', accent: '#63c7b1', width: 232 },
  'source-member': { label: 'Property Access', category: 'Import', description: 'Read-only member lookup in source', icon: 'box', accent: '#b3b5ef', width: 232 },
  'source-ternary': { label: 'Ternary Branch', category: 'Import', description: 'Read-only conditional expression', icon: 'branch', accent: '#eeb979', width: 232 },
  'source-call-expr': { label: 'Call Expression', category: 'Import', description: 'Read-only source call operand', icon: 'box', accent: '#de9ef4', width: 232 },
  'source-operator': { label: 'Source Operator', category: 'Import', description: 'Primitive operator; edit its source statement', icon: 'box', accent: '#78a8f0', width: 232 },
  compare: { label: 'Compare', category: 'Programming', description: 'Compare connected data values', icon: 'branch', accent: '#f4b777', width: 213 },
  add: { label: 'Add (+)', category: 'Operators', description: 'A + B (numbers)', icon: 'plus', accent: '#58c7ec', width: 208 },
  subtract: { label: 'Subtract (−)', category: 'Operators', description: 'A − B (numbers)', icon: 'box', accent: '#58c7ec', width: 208 },
  multiply: { label: 'Multiply (×)', category: 'Operators', description: 'A × B (numbers)', icon: 'box', accent: '#58c7ec', width: 208 },
  divide: { label: 'Divide (÷)', category: 'Operators', description: 'A ÷ B (numbers)', icon: 'box', accent: '#58c7ec', width: 208 },
  modulo: { label: 'Modulo (%)', category: 'Operators', description: 'A remainder B (numbers)', icon: 'box', accent: '#58c7ec', width: 208 },
  power: { label: 'Power (**)', category: 'Operators', description: 'A raised to B (numbers)', icon: 'box', accent: '#58c7ec', width: 208 },
  negate: { label: 'Negate (−A)', category: 'Operators', description: 'Change the sign of a number', icon: 'box', accent: '#58c7ec', width: 208 },
  concat: { label: 'Join text', category: 'Operators', description: 'Concatenate two strings', icon: 'box', accent: '#d2a0ea', width: 208 },
};

export const NODE_GROUPS = [
  { name: 'CONTROL FLOW', types: ['start', 'process', 'conditional', 'end'] },
  { name: 'LOGIC', types: ['boolean', 'and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor', 'compare'] },
  { name: 'OPERATORS', types: ['add', 'subtract', 'multiply', 'divide', 'modulo', 'power', 'negate', 'concat'] },
  { name: 'FUNCTIONS & DATA', types: ['function', 'variable'] },
  { name: 'DEBUGGING', types: ['watch', 'assert'] },
  { name: 'ANNOTATION', types: ['output', 'comment'] },
];

export const LOGIC_GATES = ['and', 'or', 'xor', 'nand', 'nor', 'xnor'];
export const NUMBER_OPERATORS = ['add', 'subtract', 'multiply', 'divide', 'modulo', 'power', 'negate'];
export const DATA_OPERATORS = [...NUMBER_OPERATORS, 'concat'];
export const getFunctionDataInputs = node => getNodePorts(node).inputs.filter(port => port.id !== 'execute');
export const CODE_LANGUAGES = [
  { id: 'javascript', name: 'JavaScript' }, { id: 'typescript', name: 'TypeScript' },
  { id: 'python', name: 'Python' }, { id: 'java', name: 'Java' },
  { id: 'csharp', name: 'C#' }, { id: 'cpp', name: 'C++' },
  { id: 'rust', name: 'Rust' }, { id: 'go', name: 'Go' },
];
export const NODE_SHAPES = [
  { id: 'rounded', name: 'Rounded rectangle' }, { id: 'square', name: 'Square' },
  { id: 'pill', name: 'Pill' }, { id: 'hexagon', name: 'Hexagon' },
  { id: 'diamond', name: 'Diamond' },
];
export const MAX_PORTS = 16;
export const DATA_TYPES = ['any', 'boolean', 'number', 'string'];
export const isFunctionNode = node => node.type === 'function' || node.type === 'custom';
export const portDataType = port => port.kind === 'boolean' ? 'boolean' : port.dataType || 'any';
// EXEC / DONE are Boolean *and* sequencing attachments. The compatibility
// marker only bridges these two Function ports to control-flow connectors;
// regular Boolean nodes cannot be accidentally wired into a Next socket.
export function canConnectPorts(from, to) {
  if (from.kind === 'flow' || to.kind === 'flow') {
    return (from.kind === 'flow' && to.kind === 'flow') ||
      (from.kind === 'flow' && to.kind === 'boolean' && to.flowCompatible === true) ||
      (to.kind === 'flow' && from.kind === 'boolean' && from.flowCompatible === true);
  }
  const a = portDataType(from), b = portDataType(to);
  return a === 'any' || b === 'any' || a === b;
}
/** Edges that advance control flow, rather than merely transfer a value. */
export function isControlEdge(graph, edge) {
  const source = graph.nodes.find(n => n.id === edge.source);
  const target = graph.nodes.find(n => n.id === edge.target);
  if (!source || !target) return false;
  const output = getNodePorts(source).outputs.find(p => p.id === edge.sourcePort);
  const input = getNodePorts(target).inputs.find(p => p.id === edge.targetPort);
  if (!output || !input || !canConnectPorts(output, input)) return false;
  return output.kind === 'flow' || input.kind === 'flow' ||
    (isFunctionNode(source) && edge.sourcePort === 'done' &&
     isFunctionNode(target) && edge.targetPort === 'execute');
}

const count = (value, fallback, min = 0) => Number.isInteger(value) ? Math.max(min, Math.min(MAX_PORTS, value)) : fallback;

/** All consumers (canvas, validation, connection manager, simulator, export) use
 * this function rather than the static legacy definitions. Stable IDs ensure
 * existing wires survive when a user adds ports. */
export function getNodePorts(node) {
  if (LOGIC_GATES.includes(node.type)) {
    const length = count(node.inputCount, 2, 2);
    return {
      inputs: Array.from({ length }, (_, i) => ({ id: String.fromCharCode(97 + i), label: String.fromCharCode(65 + i), kind: 'boolean', top: 170 + i * 34 })),
      outputs: [{ id: 'out', label: 'Out', kind: 'boolean', top: 170 + (length - 1) * 17 }],
    };
  }
  if (node.type === 'conditional') {
    const n = count(node.inputCount, 1, 1);
    return {
      inputs: [{ id: 'in', label: 'Flow', kind: 'flow', top: 169 }, ...Array.from({ length: n }, (_, i) => ({ id: i === 0 ? 'condition' : `condition${i + 1}`, label: `Test ${i + 1}`, kind: 'boolean', top: 203 + i * 34 }))],
      outputs: [{ id: 'true', label: 'Yes', kind: 'flow', top: 169 }, { id: 'false', label: 'No', kind: 'flow', top: 203 }],
    };
  }
  if (isFunctionNode(node)) {
    const inputs = count(node.inputCount, 2), outputs = count(node.outputCount, 1);
    return {
      inputs: [{ id: 'execute', label: 'EXEC', kind: 'boolean', flowCompatible: true, top: 194 }, ...Array.from({ length: inputs }, (_, i) => ({ id: `in${i + 1}`, label: node.portLabels?.[`in${i + 1}`] || `in${i + 1}`, kind: 'data', dataType: node.portTypes?.[`in${i + 1}`] || 'any', top: 228 + i * 34 }))],
      outputs: [{ id: 'done', label: 'DONE', kind: 'boolean', flowCompatible: true, top: 194 }, ...Array.from({ length: outputs }, (_, i) => ({ id: `out${i + 1}`, label: `out${i + 1}`, kind: 'data', dataType: node.portTypes?.[`out${i + 1}`] || 'any', top: 228 + i * 34 }))],
    };
  }
  if (['source-value', 'source-operator', 'source-member', 'source-ternary', 'source-call-expr'].includes(node.type)) return { inputs: [], outputs: [] };
  if (node.type.startsWith('source-')) {
    const n = Number.isInteger(node.flowInCount) ? Math.max(1, Math.min(16, node.flowInCount)) : 1;
    const inputs = node.type === 'source-start' ? [] : Array.from({ length: n }, (_, i) => ({ id: i ? `in${i + 1}` : 'in', label: 'Flow', kind: 'flow', top: 168 + i * 32 }));
    const outputs = node.type === 'source-start' || node.type === 'source-operation' || node.type === 'source-update' || node.type === 'source-declare' || node.type === 'source-call' || node.type === 'source-property-write' || (node.inspectOnly && node.type.startsWith('source-')) || ['source-opaque', 'source-loop', 'source-switch', 'source-try', 'source-throw', 'source-await'].includes(node.type) ? [{ id: 'out', label: 'Next', kind: 'flow', top: 168 }] : node.type === 'source-decision' ? [{ id: 'true', label: 'Yes', kind: 'flow', top: 168 }, { id: 'false', label: 'No', kind: 'flow', top: 201 }, ...(node.sourceCallCondition || node.richExpression ? [{id:'unknown',label:'Unknown',kind:'flow',top:234}] : [])] : [];
    return { inputs, outputs };
  }
  if (node.type === 'variable') return { inputs: [], outputs: [{ id: 'out', label: node.dataType || 'number', kind: 'data', dataType: node.dataType || 'number', top: 170 }] };
  return PORTS[node.type] || { inputs: [], outputs: [] };
}

export function getNodeHeight(node) {
  const ports = getNodePorts(node);
  const last = Math.max(0, ...ports.inputs.map(p => p.top), ...ports.outputs.map(p => p.top));
  if (node.type === 'comment') return Math.max(120, Math.min(240, 72 + Math.ceil((node.description || '').length / 34) * 17));
  return Math.max(isFunctionNode(node) ? 228 : 198, last + 35);
}

let counter = 0;
export function makeId(prefix = 'node') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createNode(type, x = 0, y = 0) {
  const meta = NODE_TYPES[type];
  if (!meta) throw new Error(`Unknown node type: ${type}`);
  return {
    id: makeId(), type, x: Math.round(x), y: Math.round(y),
    title: type === 'boolean' ? 'Boolean input' : type === 'comment' ? 'Canvas note' : meta.label,
    description: type === 'comment' ? 'Double-click a note or select it to edit its contents.' : meta.description,
    value: true,
    ...(isFunctionNode({ type }) ? { inputCount: 2, outputCount: 1, triggerMode: 'signal', language: 'javascript', shape: 'rounded', functionName: 'calculate', portTypes: {}, code: 'out1 = in1 + in2;' } : {}),
    ...(type === 'variable' ? { dataType: 'number', dataValue: 42 } : {}),
    ...(type === 'compare' ? { comparison: '>=' } : {}),
    ...(['watch', 'assert'].includes(type) ? { check: 'range', min: 0, max: 100, expected: 'true', expectedType: 'number', ...(type === 'watch' ? { traceVariable: 'all' } : {}) } : {}),
    ...(LOGIC_GATES.includes(type) ? { inputCount: 2 } : {}),
    ...(type === 'conditional' ? { inputCount: 1, conditionMode: 'and' } : {}),
  };
}

export function portPosition(node, portId, direction) {
  const port = getNodePorts(node)[direction === 'out' ? 'outputs' : 'inputs'].find(p => p.id === portId);
  if (!port) return null;
  return { x: node.x + (direction === 'out' ? NODE_TYPES[node.type].width : 0), y: node.y + port.top };
}

export function isValidGraph(data) {
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || data.nodes.length > 500 || data.edges.length > 2000) return false;
  const nodes = new Map();
  for (const n of data.nodes) {
    if (!n || typeof n.id !== 'string' || nodes.has(n.id) || !NODE_TYPES[n.type] || !Number.isFinite(n.x) || !Number.isFinite(n.y) || Math.abs(n.x) > 100000 || Math.abs(n.y) > 100000 || typeof n.title !== 'string' || n.title.length > 100 || (n.description !== undefined && (typeof n.description !== 'string' || n.description.length > 10000)) || (n.value !== undefined && typeof n.value !== 'boolean')) return false;
    if (n.inputCount !== undefined && (!Number.isInteger(n.inputCount) || n.inputCount < (n.type === 'conditional' ? 1 : LOGIC_GATES.includes(n.type) ? 2 : 0) || n.inputCount > MAX_PORTS)) return false;
    if (n.outputCount !== undefined && (!Number.isInteger(n.outputCount) || n.outputCount < 0 || n.outputCount > MAX_PORTS)) return false;
    if (isFunctionNode(n)) {
      if (n.triggerMode !== undefined && !['signal', 'auto'].includes(n.triggerMode)) return false;
      if (typeof n.code !== 'string' || n.code.length > 20000 || !CODE_LANGUAGES.some(l => l.id === n.language) || !NODE_SHAPES.some(s => s.id === n.shape)) return false;
      if (n.functionName !== undefined && (typeof n.functionName !== 'string' || n.functionName.length > 80)) return false;
      if (n.portTypes !== undefined && (!n.portTypes || typeof n.portTypes !== 'object' || Array.isArray(n.portTypes) || Object.keys(n.portTypes).length > 32 || Object.entries(n.portTypes).some(([k, v]) => !/^(in|out)(?:[1-9]|1[0-6])$/.test(k) || !DATA_TYPES.includes(v)))) return false;
    }
    if (n.type === 'variable' && (!['boolean', 'number', 'string'].includes(n.dataType) || typeof n.dataValue !== n.dataType || (typeof n.dataValue === 'number' && !Number.isFinite(n.dataValue)) || (typeof n.dataValue === 'string' && n.dataValue.length > 2000))) return false;
    if (['watch', 'assert'].includes(n.type) && (!['range', 'equals', 'type'].includes(n.check || 'range') || (n.min !== undefined && !Number.isFinite(Number(n.min))) || (n.max !== undefined && !Number.isFinite(Number(n.max))))) return false;
    if (n.type === 'watch' && ((n.traceVariable !== undefined && !['all', 'port', 'named'].includes(n.traceVariable)) || (n.traceVariableName !== undefined && (typeof n.traceVariableName !== 'string' || (n.traceVariableName !== '' && !/^[a-zA-Z_$][a-zA-Z0-9_$]{0,79}$/.test(n.traceVariableName)))))) return false;
    if (n.type.startsWith('source-') && (n.flowInCount !== undefined && (!Number.isInteger(n.flowInCount) || n.flowInCount < 1 || n.flowInCount > 16))) return false;
    if (n.type === 'compare' && !['==', '!=', '>', '>=', '<', '<='].includes(n.comparison || '==')) return false;
    if (n.type === 'conditional' && n.conditionMode !== undefined && !['and', 'or', 'xor'].includes(n.conditionMode)) return false;
    nodes.set(n.id, n);
  }
  const ids = new Set(), targets = new Set();
  for (const e of data.edges) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || !nodes.has(e.source) || !nodes.has(e.target)) return false;
    const source = getNodePorts(nodes.get(e.source)).outputs.find(p => p.id === e.sourcePort);
    const target = getNodePorts(nodes.get(e.target)).inputs.find(p => p.id === e.targetPort);
    if (!source || !target || !canConnectPorts(source, target) || targets.has(`${e.target}:${e.targetPort}`)) return false;
    ids.add(e.id); targets.add(`${e.target}:${e.targetPort}`);
  }
  if (data.program !== undefined) {
    const p = data.program;
    if (!p || p.kind !== 'javascript-function' || typeof p.source !== 'string' || p.source.length > 150000 || (p.workspaceFiles !== undefined && (typeof p.workspaceFiles !== 'object' || Array.isArray(p.workspaceFiles) || Object.keys(p.workspaceFiles).length > 24 || Object.entries(p.workspaceFiles).some(([k, v]) => typeof k !== 'string' || k.length > 260 || typeof v !== 'string' || v.length > 150000) || Object.values(p.workspaceFiles).reduce((a, v) => a + v.length, 0) > 900000)) || typeof p.functionName !== 'string' || !Array.isArray(p.parameters) || p.parameters.length > 16 || !p.parameters.every(v => typeof v === 'string' && /^[A-Za-z_$][\w$]*$/.test(v)) || !p.inputValues || typeof p.inputValues !== 'object' || Array.isArray(p.inputValues) || Object.values(p.inputValues).some(v => !isSafeTestValue(v)) || !Array.isArray(p.dataEdges) || p.dataEdges.length > 4000 || p.dataEdges.some(e => !e || typeof e.variable !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') || !Array.isArray(p.watchRules) || p.watchRules.length > 50 || p.watchRules.some(r => !r || typeof r.id !== 'string' || typeof r.variable !== 'string' || !['range','equals','type'].includes(r.check) || !Number.isFinite(Number(r.min)) || !Number.isFinite(Number(r.max))) || !Array.isArray(p.importedNodeIds) || !Array.isArray(p.importedEdgeIds) || !Array.isArray(p.originalEdges) || p.originalEdges.length !== p.importedEdgeIds.length) return false;
    if (data.nodes.some(n => n.type.startsWith('source-') && (n.expressionText !== undefined && (typeof n.expressionText !== 'string' || n.expressionText.length > 2000) || n.sourceStart !== undefined && (!Number.isInteger(n.sourceStart) || n.sourceStart < 0 || n.sourceStart > p.source.length) || n.sourceEnd !== undefined && (!Number.isInteger(n.sourceEnd) || n.sourceEnd < 0 || n.sourceEnd > p.source.length)))) return false;
  }
  // Imported project files must obey the same DAG invariant as interactive edits.
  const targetsBySource = new Map();
  for (const e of data.edges) {
    if (!targetsBySource.has(e.source)) targetsBySource.set(e.source, []);
    targetsBySource.get(e.source).push(e.target);
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const target of targetsBySource.get(id) || []) if (!visit(target)) return false;
    visiting.delete(id); visited.add(id);
    return true;
  };
  return [...nodes.keys()].every(visit);
}
