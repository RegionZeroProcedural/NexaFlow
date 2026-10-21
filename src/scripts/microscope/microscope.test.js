import { buildProject, searchFunctions } from './project-index';
import { traceFunction } from './interpreter';
import { dissectFunction, indexTrace } from './dissect';

const files = [
  { path: 'app/src/index.js', text: `import { checkout } from './cart/checkout';
import Logger from './util/logger.js';
const config = { taxRate: 0.1 };
export function main() {
  const log = new Logger('main');
  const items = [{ price: 10, qty: 2 }, { price: 5, qty: 1 }];
  const total = checkout(items, config.taxRate);
  log.write('total ' + total);
  return total;
}
main();
` },
  { path: 'app/src/cart/checkout.js', text: `import { sum, clamp } from '../util/math';
export function checkout(items, taxRate) {
  let subtotal = 0;
  for (const item of items) {
    if (item.qty <= 0) continue;
    subtotal += item.price * item.qty;
  }
  const lines = items.map(i => i.price * i.qty);
  const tax = Math.round(sum(lines) * taxRate * 100) / 100;
  return clamp(subtotal + tax, 0, 1000);
}
` },
  { path: 'app/src/util/math.js', text: `export const sum = list => list.reduce((a, b) => a + b, 0);
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
` },
  { path: 'app/src/util/logger.js', text: `export default class Logger {
  lines = [];
  constructor(name) { this.name = name; }
  write(msg) { this.lines.push(this.name + ': ' + msg); console.log(msg); return this.lines.length; }
}
` },
  { path: 'app/src/component.jsx', text: `import React, { useState } from 'react';
export default function Counter({ start = 0 }) {
  const [count, setCount] = useState(start);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
` },
  { path: 'app/src/async.ts', text: `type N = number;
export async function delayed(x: N): Promise<N> {
  const v = await new Promise<N>(resolve => setTimeout(() => resolve(x * 2), 10));
  try { if (v > 5) throw new Error('big ' + v); } catch (e: any) { return -v; } finally { console.log('done'); }
  return v;
}
export function* gen(n: number) { for (let i = 0; i < n; i++) yield i * i; }
export function useGen() { return [...gen(4)]; }
export function sw(k) { switch (k) { case 'a': return 1; case 'b': case 'c': return 2; default: return 0; } }
export function escape() { return [].constructor.constructor('return 1'); }
export function pollute() { Array.prototype.evil = 1; }
export function forever() { while (true) {} }
` },
];

describe('project index', () => {
  const project = buildProject(files);
  test('finds functions and resolves cross-file calls', () => {
    const names = project.order.map(id => project.functions[id].name);
    expect(names).toEqual(expect.arrayContaining(['main', 'checkout', 'sum', 'clamp', 'Logger.constructor', 'Logger.write', 'Counter']));
    const main = project.functions[project.rootId];
    expect(main.name).toBe('main');
    const checkout = Object.values(project.functions).find(f => f.name === 'checkout');
    const targets = checkout.calls.filter(c => c.targetId).map(c => project.functions[c.targetId].name);
    expect(targets).toEqual(expect.arrayContaining(['sum', 'clamp']));
    const mainTargets = main.calls.filter(c => c.targetId).map(c => project.functions[c.targetId].name);
    expect(mainTargets).toEqual(expect.arrayContaining(['checkout', 'Logger.constructor', 'Logger.write']));
  });
  test('search ranks names', () => {
    expect(searchFunctions(project, 'clam')[0].name).toBe('clamp');
  });
});

describe('interpreter', () => {
  const project = buildProject(files);
  const idOf = name => Object.values(project.functions).find(f => f.name === name).id;
  test('runs main across modules with real values', () => {
    const run = traceFunction(project, idOf('main'));
    expect(run.error).toBeNull();
    expect(run.halted).toBeNull();
    expect(run.value.s).toBe('27.5');
    expect(run.console.map(l => l.text)).toEqual(['total 27.5']);
    expect(run.events.some(e => e.k === 'iter')).toBe(true);
    expect(run.events.some(e => e.k === 'enter' && e.fn === idOf('clamp'))).toBe(true);
  });
  test('arguments are expressions', () => {
    expect(traceFunction(project, idOf('clamp'), ['50', '0', '10']).value.s).toBe('10');
    expect(traceFunction(project, idOf('checkout'), ['[{price: 1, qty: 3}]', '0']).value.s).toBe('3');
  });
  test('async, try/finally, generators, switch', () => {
    const run = traceFunction(project, idOf('delayed'), ['4']);
    expect(run.value.s).toBe('-8');
    expect(run.console.map(l => l.text)).toEqual(['done']);
    expect(traceFunction(project, idOf('useGen')).value.s).toBe('[0, 1, 4, 9]');
    expect(traceFunction(project, idOf('sw'), ['"c"']).value.s).toBe('2');
  });
  test('jsx and external react', () => {
    const run = traceFunction(project, idOf('Counter'), ['{start: 3}']);
    expect(run.error).toBeNull();
    expect(run.value.t).toBe('jsx');
  });
  test('sandbox blocks escapes and pollution, halts infinite loops', () => {
    const escaped = traceFunction(project, idOf('escape'));
    expect(escaped.value?.s || escaped.error).not.toBe('ƒ anonymous()');
    expect(String(escaped.error || escaped.value.s)).toMatch(/not a function|blocked|‹/);
    const polluted = traceFunction(project, idOf('pollute'));
    expect(polluted.error).toMatch(/Sandbox/);
    expect([].evil).toBeUndefined();
    const forever = traceFunction(project, idOf('forever'), [], { maxSteps: 20000 });
    expect(forever.halted).toMatch(/Step budget/);
  });
});

describe('dissector', () => {
  const project = buildProject(files);
  const idOf = name => Object.values(project.functions).find(f => f.name === name).id;
  test('produces non-overlapping nodes keyed to trace events', () => {
    const die = dissectFunction(project, idOf('checkout'));
    expect(die.regions.some(r => r.kind === 'loop')).toBe(true);
    expect(die.nodes.some(n => n.kind === 'call' && n.targetName === 'clamp')).toBe(true);
    expect(die.nodes.some(n => n.kind === 'closure')).toBe(true);
    expect(new Set(die.nodes.map(n => n.id)).size).toBe(die.nodes.length);
    for (const a of die.nodes) for (const b of die.nodes) if (a !== b) {
      const overlap = a.x < b.x + 172 && b.x < a.x + 172 && a.y < b.y + 56 && b.y < a.y + 56;
      if (overlap) throw new Error(`overlap ${a.label} / ${b.label}`);
    }
    const run = traceFunction(project, idOf('checkout'), ['[{price: 2, qty: 2}]', '0.5']);
    const byKey = indexTrace(run.events);
    const hit = die.nodes.filter(n => byKey.has(n.id));
    expect(hit.length).toBeGreaterThan(10);
    expect(die.varWires.some(w => w.label === 'item' && die.byId.get(w.from).kind === 'declare')).toBe(true);
  });
  test('dissects every function in the sample without throwing', () => {
    for (const id of project.order) expect(() => dissectFunction(project, id)).not.toThrow();
  });
});
