/** Value helpers shared by the interpreter and the microscope UI. */

/** Stand-in for anything outside the analysed project (npm packages, DOM,
 * network, unknown globals). Operations on it produce more External values,
 * so a trace can continue while clearly marking unverifiable data. */
export class External {
  constructor(label) { this.label = String(label).slice(0, 120); }
  toString() { return `‹${this.label}›`; }
}
export const isExternal = v => v instanceof External;

/** Interpreted functions are real JS functions (so native callbacks such as
 * Array#map work), registered here with their AST metadata. */
export const interpretedFunctions = new WeakMap();

export function valueType(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (v instanceof External) return 'external';
  const t = typeof v;
  if (t === 'number') return Number.isNaN(v) ? 'nan' : 'number';
  if (t === 'string' || t === 'boolean' || t === 'bigint' || t === 'symbol') return t;
  if (t === 'function') return 'function';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Error) return 'error';
  if (v && v.$$jsx) return 'jsx';
  if (v && v.$$promise) return 'promise';
  return 'object';
}

const quote = s => JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);

function ownDataEntries(obj, limit) {
  const out = [];
  let keys;
  try { keys = Object.keys(obj); } catch (_) { return { out, total: 0 }; }
  for (const key of keys.slice(0, limit)) {
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(obj, key); } catch (_) { desc = null; }
    out.push([key, desc && 'value' in desc ? { value: desc.value } : { accessor: true }]);
  }
  return { out, total: keys.length };
}

/** Short, side-effect-free textual preview (never invokes getters). */
export function previewValue(v, depth = 0, budget = { n: 0 }) {
  if (++budget.n > 60) return '…';
  const type = valueType(v);
  switch (type) {
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'nan': return 'NaN';
    case 'number': return Object.is(v, -0) ? '-0' : String(v);
    case 'string': return quote(v);
    case 'boolean': return String(v);
    case 'bigint': return `${v}n`;
    case 'symbol': return v.toString();
    case 'external': return `‹${v.label}›`;
    case 'function': {
      const meta = interpretedFunctions.get(v);
      const name = meta?.name || v.name || 'anonymous';
      return meta?.isClass ? `class ${name}` : `ƒ ${name}()`;
    }
    case 'error': return `${v.name || 'Error'}: ${String(v.message).slice(0, 80)}`;
    case 'jsx': {
      const tag = typeof v.type === 'string' ? v.type : interpretedFunctions.get(v.type)?.name || v.type?.name || (v.type instanceof External ? v.type.label : 'Component');
      return `<${tag}${v.props && Object.keys(v.props).length ? ' …' : ''}${v.children?.length ? `>…</${tag}>` : ' />'}`;
    }
    case 'promise': return `Promise<${v.state}${v.state !== 'pending' ? `: ${depth > 1 ? '…' : previewValue(v.value, depth + 1, budget)}` : ''}>`;
    case 'array': {
      if (depth > 1) return `Array(${v.length})`;
      const items = v.slice(0, 6).map(x => previewValue(x, depth + 1, budget));
      return `[${items.join(', ')}${v.length > 6 ? `, …+${v.length - 6}` : ''}]`;
    }
    default: {
      if (v instanceof Map) return depth > 1 ? `Map(${v.size})` : `Map(${v.size}) {${[...v.entries()].slice(0, 4).map(([k, x]) => `${previewValue(k, depth + 1, budget)} => ${previewValue(x, depth + 1, budget)}`).join(', ')}${v.size > 4 ? ', …' : ''}}`;
      if (v instanceof Set) return depth > 1 ? `Set(${v.size})` : `Set(${v.size}) {${[...v].slice(0, 5).map(x => previewValue(x, depth + 1, budget)).join(', ')}${v.size > 5 ? ', …' : ''}}`;
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : `Date(${v.toISOString()})`;
      if (v instanceof RegExp) return String(v);
      if (ArrayBuffer.isView(v)) return `${v.constructor?.name || 'TypedArray'}(${v.length})`;
      let proto = null;
      try { proto = Object.getPrototypeOf(v); } catch (_) { /* proxy */ }
      const ctor = proto && proto !== Object.prototype ? interpretedFunctions.get(proto.constructor)?.name || (typeof proto.constructor === 'function' ? proto.constructor.name : '') : '';
      if (depth > 1) return `${ctor ? ctor + ' ' : ''}{…}`;
      const { out, total } = ownDataEntries(v, 5);
      const body = out.map(([k, d]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${d.accessor ? '(getter)' : previewValue(d.value, depth + 1, budget)}`).join(', ');
      return `${ctor ? ctor + ' ' : ''}{${body}${total > 5 ? `, …+${total - 5}` : ''}}`;
    }
  }
}

/** Numeric magnitude used by the heatmap: the number itself, 0/1 for
 * booleans, and length/size for collections. Strings and others get null
 * (the heatmap ranks their distinct values instead). */
export function magnitude(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v && typeof v === 'object' && ArrayBuffer.isView(v)) return v.length;
  if (v && typeof v === 'object' && !(v instanceof External) && !v.$$jsx && !v.$$promise && !(v instanceof Error)) { try { return Object.keys(v).length; } catch (_) { return null; } }
  return null;
}

/** Compact preview record stored in trace events. */
export function snapshot(v) {
  let text;
  try { text = previewValue(v); } catch (_) { text = '‹unpreviewable›'; }
  const n = magnitude(v);
  return { t: valueType(v), s: text.length > 160 ? `${text.slice(0, 157)}…` : text, ...(n === null ? {} : { n }) };
}

/** Expanded, multi-line structure for the inspector (still getter-free). */
export function describeValue(v, depth = 0, seen = new Set()) {
  const type = valueType(v);
  if (!['object', 'array', 'error', 'jsx', 'promise'].includes(type) || depth > 3) return { type, text: previewValue(v) };
  if (seen.has(v)) return { type, text: '[Circular]' };
  seen.add(v);
  if (type === 'array') return { type, text: `Array(${v.length})`, children: v.slice(0, 50).map((x, i) => ({ key: String(i), ...describeValue(x, depth + 1, seen) })) };
  if (v instanceof Map) return { type, text: `Map(${v.size})`, children: [...v.entries()].slice(0, 50).map(([k, x]) => ({ key: previewValue(k), ...describeValue(x, depth + 1, seen) })) };
  if (v instanceof Set) return { type, text: `Set(${v.size})`, children: [...v].slice(0, 50).map((x, i) => ({ key: String(i), ...describeValue(x, depth + 1, seen) })) };
  const { out, total } = ownDataEntries(v, 50);
  return { type, text: previewValue(v), children: out.map(([k, d]) => ({ key: k, ...(d.accessor ? { type: 'getter', text: '(getter)' } : describeValue(d.value, depth + 1, seen)) })), more: Math.max(0, total - 50) };
}
