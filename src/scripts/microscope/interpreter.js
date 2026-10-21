/** Sandboxed, tracing JavaScript interpreter for the Function Microscope.
 *
 * Uploaded code is never compiled or eval'd. This module walks the ESTree AST
 * itself and records a trace event for every evaluated expression, branch,
 * loop iteration, variable write and call, so the UI can replay real data
 * moving through the dissected nodes.
 *
 * Isolation: only a whitelist of pure built-ins is reachable; Function/eval,
 * the page's globals, DOM, storage and network are replaced with External
 * placeholders; built-in prototypes cannot be modified; every run has step,
 * event and call-depth budgets. Async code runs in a simplified deterministic
 * order (await drains a virtual job/timer queue), and generators are run
 * eagerly. Results are a faithful model for typical application logic but
 * are not a substitute for running the code in its real environment.
 */
import { astKey, unwrapTs, parseExpressionSource } from './parse-source';
import { External, interpretedFunctions, snapshot } from './values';

export class ExecutionHalt extends Error {}
class UserThrow { constructor(value) { this.value = value; } }
class GeneratorCap { }
const SHORT = Symbol('optional-short-circuit');
const TDZ = Symbol('tdz');

// ---------- Sandbox security ----------
const AsyncFunction = (async () => {}).constructor;
const GeneratorFunction = (function* () {}).constructor;
const AsyncGeneratorFunction = (async function* () {}).constructor;
const g = typeof globalThis !== 'undefined' ? globalThis : {};
const FORBIDDEN = new Set([Function, AsyncFunction, GeneratorFunction, AsyncGeneratorFunction, g.eval, g, g.window, g.document, g.self, g.top, g.parent, g.frames, g.fetch, g.XMLHttpRequest, g.WebSocket, g.Worker, g.SharedWorker, g.localStorage, g.sessionStorage, g.indexedDB, g.navigator, g.location, g.history, g.setTimeout, g.setInterval, g.importScripts, g.open, g.postMessage, g.Reflect, g.process, g.require].filter(Boolean));
const NATIVE_CTORS = { Object, Array, String, Number, Boolean, Symbol, Date, RegExp, Map, Set, WeakMap, WeakSet, Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, ArrayBuffer, DataView, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, Proxy, ...(typeof BigInt !== 'undefined' ? { BigInt } : {}), ...(typeof BigInt64Array !== 'undefined' ? { BigInt64Array, BigUint64Array } : {}), ...(g.TextEncoder ? { TextEncoder: g.TextEncoder, TextDecoder: g.TextDecoder } : {}), ...(g.URL ? { URL: g.URL, URLSearchParams: g.URLSearchParams } : {}) };
const PROTECTED = new Set([Math, JSON, Function.prototype, Object.prototype, ...(g.Intl ? [g.Intl] : [])]);
const PROTECTED_PROTOTYPES = new Set([Function.prototype, Object.prototype]);
for (const ctor of Object.values(NATIVE_CTORS)) { PROTECTED.add(ctor); if (ctor.prototype) { PROTECTED.add(ctor.prototype); PROTECTED_PROTOTYPES.add(ctor.prototype); } }
for (const iterable of [[], new Map(), new Set(), '']) { try { const proto = Object.getPrototypeOf(iterable[Symbol.iterator]()); PROTECTED.add(proto); PROTECTED.add(Object.getPrototypeOf(proto)); } catch (_) { /* ignore */ } }
const MUTATING_OBJECT_METHODS = new Set(['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions']);
const SafeObject = new Proxy(Object, {
  get(target, key) {
    const value = target[key];
    if (MUTATING_OBJECT_METHODS.has(key)) return (first, ...rest) => { if (PROTECTED.has(first)) throw new TypeError(`Sandbox: built-in objects cannot be modified`); return value.call(target, first, ...rest); };
    return value;
  },
});
const sanitize = v => (v !== null && (typeof v === 'object' || typeof v === 'function') && FORBIDDEN.has(v)) ? new External('blocked built-in') : v;

// ---------- Deterministic promise model ----------
class SyncPromise {
  constructor(runtime, executor) {
    this.$$promise = true; this.state = 'pending'; this.value = undefined;
    Object.defineProperties(this, { handlers: { value: [], writable: true }, runtime: { value: runtime }, locked: { value: false, writable: true }, handled: { value: false, writable: true } });
    const resolve = v => this.resolveWith(v), reject = e => this.settle('rejected', e);
    if (executor) { try { executor(resolve, reject); } catch (error) { if (error instanceof ExecutionHalt) throw error; reject(error instanceof UserThrow ? error.value : error); } }
  }
  resolveWith(v) {
    if (this.state !== 'pending' || this.locked) return;
    if (v === this) { this.settle('rejected', new TypeError('Promise resolved with itself')); return; }
    if (v instanceof SyncPromise) { this.locked = true; v.addHandler(x => { this.locked = false; this.settle('fulfilled', x); }, e => { this.locked = false; this.settle('rejected', e); }); return; }
    if (v && typeof v === 'object' && !(v instanceof External) && typeof v.then === 'function' && !(v instanceof Promise)) {
      this.locked = true;
      try { v.then(x => { this.locked = false; this.resolveWith(x); }, e => { this.locked = false; this.settle('rejected', e); }); } catch (e) { this.locked = false; this.settle('rejected', e instanceof UserThrow ? e.value : e); }
      return;
    }
    this.settle('fulfilled', v);
  }
  settle(state, value) {
    if (this.state !== 'pending') return;
    this.state = state; this.value = value;
    for (const h of this.handlers) this.schedule(h);
    this.handlers = [];
  }
  schedule(h) { this.runtime.microtasks.push(() => (this.state === 'fulfilled' ? h.f : h.r)(this.value)); }
  addHandler(f, r) { this.handled = true; const h = { f, r }; if (this.state === 'pending') this.handlers.push(h); else this.schedule(h); }
  then(onF, onR) {
    const next = new SyncPromise(this.runtime);
    const wrap = (fn, fallback) => value => {
      if (typeof fn !== 'function') { fallback(value); return; }
      try { next.resolveWith(fn(value)); } catch (error) { if (error instanceof ExecutionHalt) throw error; next.settle('rejected', error instanceof UserThrow ? error.value : error); }
    };
    this.addHandler(wrap(onF, v => next.resolveWith(v)), wrap(onR, e => next.settle('rejected', e)));
    return next;
  }
  catch(onR) { return this.then(undefined, onR); }
  finally(fn) { return this.then(v => { if (typeof fn === 'function') fn(); return v; }, e => { if (typeof fn === 'function') fn(); throw new UserThrow(e); }); }
}
function promiseStatics(runtime) {
  const P = function Promise(executor) { if (typeof executor !== 'function') throw new TypeError('Promise resolver is not a function'); return new SyncPromise(runtime, executor); };
  const fromValue = v => v instanceof SyncPromise ? v : new SyncPromise(runtime, res => res(v));
  P.resolve = fromValue;
  P.reject = e => new SyncPromise(runtime, (_, rej) => rej(e));
  const combine = (items, onAll) => new SyncPromise(runtime, (res, rej) => {
    const list = [...items].map(fromValue); const out = new Array(list.length); let left = list.length;
    if (!left) { onAll.empty(res, rej); return; }
    list.forEach((p, i) => p.addHandler(v => onAll.ok(v, i, out, () => --left === 0, res, rej), e => onAll.fail(e, i, out, () => --left === 0, res, rej)));
  });
  P.all = items => combine(items, { empty: res => res([]), ok: (v, i, out, done, res) => { out[i] = v; if (done()) res(out); }, fail: (e, i, out, done, res, rej) => rej(e) });
  P.allSettled = items => combine(items, { empty: res => res([]), ok: (v, i, out, done, res) => { out[i] = { status: 'fulfilled', value: v }; if (done()) res(out); }, fail: (e, i, out, done, res) => { out[i] = { status: 'rejected', reason: e }; if (done()) res(out); } });
  P.race = items => new SyncPromise(runtime, (res, rej) => { for (const p of [...items].map(fromValue)) p.addHandler(res, rej); });
  P.any = items => combine(items, { empty: (res, rej) => rej(new Error('All promises were rejected')), ok: (v, i, out, done, res) => res(v), fail: (e, i, out, done, res, rej) => { out[i] = e; if (done()) rej(new Error('All promises were rejected')); } });
  Object.defineProperty(P, Symbol.hasInstance, { value: v => v instanceof SyncPromise });
  return P;
}

const BINARY = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b, '**': (a, b) => a ** b,
  '==': (a, b) => a == b, '!=': (a, b) => a != b, '===': (a, b) => a === b, '!==': (a, b) => a !== b, // eslint-disable-line eqeqeq
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b, '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  in: (a, b) => { if (b === null || (typeof b !== 'object' && typeof b !== 'function')) throw new TypeError(`Cannot use 'in' operator to search for '${String(a)}' in ${String(b)}`); return a in b; },
  instanceof: (a, b) => { if (typeof b !== 'function' && !(b && b[Symbol.hasInstance])) throw new TypeError('Right-hand side of instanceof is not callable'); return a instanceof b; },
};

class Scope {
  constructor(parent, kind) { this.parent = parent; this.kind = kind; this.vars = new Map(); }
  declare(name, value, kind = 'let') { this.vars.set(name, { value, kind }); }
  find(name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name); return null; }
  functionScope() { let s = this; while (s.parent && s.kind !== 'function' && s.kind !== 'module') s = s.parent; return s; }
}

const DEFAULTS = { maxSteps: 1500000, maxEvents: 60000, maxDepth: 180, maxTimers: 400 };

export class Runtime {
  constructor(project, options = {}) {
    this.project = project;
    this.options = { ...DEFAULTS, ...options };
    this.events = []; this.steps = 0; this.depth = 0; this.frameSerial = 0;
    this.modules = new Map(); this.microtasks = []; this.timers = []; this.timerSerial = 0; this.virtualTime = 0;
    this.consoleLines = []; this.notes = []; this.silent = 0;
    this.global = this.createGlobalScope();
  }

  // ---------- Tracing ----------
  emit(event) {
    if (this.silent) return; // module setup is not part of a function's trace
    if (this.events.length >= this.options.maxEvents) throw new ExecutionHalt(`Trace limit of ${this.options.maxEvents.toLocaleString()} events reached — the remaining execution was not recorded.`);
    event.i = this.events.length;
    this.events.push(event);
  }
  tick() { if (++this.steps > this.options.maxSteps) throw new ExecutionHalt(`Step budget of ${this.options.maxSteps.toLocaleString()} exceeded (possible infinite loop).`); }
  ev(kind, node, ctx, extra) { this.emit({ k: kind, key: node ? astKey(node) : null, fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth, ...extra }); }
  value(node, ctx, v) { this.emit({ k: 'eval', key: astKey(node), fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth, v: snapshot(v) }); return v; }

  // ---------- Globals ----------
  createGlobalScope() {
    const scope = new Scope(null, 'global');
    const define = (name, value) => scope.declare(name, value, 'const');
    for (const [name, ctor] of Object.entries(NATIVE_CTORS)) define(name, name === 'Object' ? SafeObject : ctor);
    define('Math', Math); define('JSON', JSON); if (g.Intl) define('Intl', g.Intl);
    define('undefined', undefined); define('NaN', NaN); define('Infinity', Infinity);
    for (const name of ['parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'btoa', 'atob', 'structuredClone']) if (g[name]) define(name, g[name]);
    define('Promise', promiseStatics(this));
    const log = level => (...args) => {
      const text = args.map(a => typeof a === 'string' ? a : snapshot(a).s).join(' ');
      this.consoleLines.push({ level, text });
      const ctx = this.currentCtx || { fnId: null, frame: 0, depth: 0 };
      this.emit({ k: 'log', level, text: text.slice(0, 500), fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth });
    };
    const consoleShim = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug'), trace: log('trace'), table: log('table'), dir: log('dir'), group: log('group'), groupCollapsed: log('group'), groupEnd: () => {}, time: () => {}, timeEnd: log('time'), count: log('count'), assert: (cond, ...rest) => { if (!cond) log('error')('Assertion failed:', ...rest); } };
    define('console', consoleShim);
    const schedule = (repeat) => (fn, ms = 0, ...args) => {
      const id = ++this.timerSerial;
      if (typeof fn === 'function') this.timers.push({ id, fn, args, at: this.virtualTime + Math.max(0, Number(ms) || 0), every: repeat ? Math.max(1, Number(ms) || 1) : 0, runs: 0 });
      return id;
    };
    const clear = id => { this.timers = this.timers.filter(t => t.id !== id); };
    define('setTimeout', schedule(false)); define('setInterval', schedule(true)); define('setImmediate', schedule(false));
    define('clearTimeout', clear); define('clearInterval', clear); define('clearImmediate', clear);
    define('queueMicrotask', fn => { if (typeof fn === 'function') this.microtasks.push(() => fn()); });
    define('requestAnimationFrame', schedule(false)); define('cancelAnimationFrame', clear);
    define('process', { env: { NODE_ENV: 'development' }, argv: ['node', 'main'], platform: 'sandbox', version: 'v0-sandbox', exit: code => { throw new ExecutionHalt(`process.exit(${code ?? 0}) called`); }, cwd: () => '/', nextTick: (fn, ...args) => this.microtasks.push(() => fn(...args)), on: () => {}, stdout: { write: log('log') }, stderr: { write: log('error') } });
    const sandboxGlobal = Object.create(null);
    define('globalThis', sandboxGlobal); define('window', new External('window')); define('document', new External('document'));
    this.sandboxGlobal = sandboxGlobal;
    return scope;
  }

  // ---------- Variables ----------
  lookup(scope, name, node, ctx) {
    const entry = scope.find(name);
    if (entry) {
      if (entry.value === TDZ) throw this.userError(ReferenceError, `Cannot access '${name}' before initialization`);
      if (entry.importRef) return this.readImport(entry.importRef);
      return entry.value;
    }
    if (Object.prototype.hasOwnProperty.call(this.sandboxGlobal, name)) return this.sandboxGlobal[name];
    // Unknown free variable: a browser/Node global or something outside the project.
    const ext = new External(name);
    this.ev('external', node, ctx, { label: `${name} (outside project)` });
    return ext;
  }
  assign(scope, name, value, ctx, node) {
    const entry = scope.find(name);
    if (!entry) { this.sandboxGlobal[name] = value; }
    else {
      if (entry.kind === 'const' && entry.value !== TDZ) throw this.userError(TypeError, 'Assignment to constant variable.');
      if (entry.value === TDZ) throw this.userError(ReferenceError, `Cannot access '${name}' before initialization`);
      entry.value = value;
    }
    this.emit({ k: 'write', name, key: node ? astKey(node) : null, fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth, v: snapshot(value) });
  }
  initialize(scope, name, value, kind, ctx, node) {
    const entry = scope.vars.get(name);
    if (entry && kind !== 'var') { entry.value = value; entry.kind = kind; }
    else if (kind === 'var') { const target = scope.functionScope(); const existing = target.vars.get(name); if (existing) existing.value = value; else target.declare(name, value, 'var'); }
    else scope.declare(name, value, kind);
    this.emit({ k: 'write', name, key: node ? astKey(node) : null, fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth, v: snapshot(value) });
  }
  userError(Ctor, message) { return new UserThrow(new Ctor(message)); }

  // ---------- Hoisting ----------
  hoist(statements, scope, ctx, functionLevel) {
    for (const raw of statements) {
      const statement = raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration' ? (raw.declaration || raw) : raw;
      if (statement.type === 'FunctionDeclaration' && statement.id) scope.declare(statement.id.name, this.makeFunction(statement, scope, ctx), 'let');
      else if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') for (const d of statement.declarations) for (const name of patternNames(d.id)) scope.declare(name, TDZ, statement.kind);
      else if (statement.type === 'ClassDeclaration' && statement.id) scope.declare(statement.id.name, TDZ, 'let');
      else if (statement.type === 'TSEnumDeclaration') scope.declare(statement.id.name, TDZ, 'const');
    }
    if (functionLevel) {
      const target = scope.functionScope();
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const d of node.declarations) for (const name of patternNames(d.id)) if (!target.vars.has(name)) target.declare(name, undefined, 'var');
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type)) return;
        for (const key of ['body', 'consequent', 'alternate', 'block', 'handler', 'finalizer', 'cases', 'init', 'left', 'declaration']) if (node[key]) visit(node[key]);
      };
      visit(statements);
    }
  }

  // ---------- Functions ----------
  fnIdFor(node, ctx) {
    const path = ctx.path;
    const id = `${path}#${node.start}`;
    return this.project?.functions[id] ? id : null;
  }
  makeFunction(node, scope, ctx, { name, homeObject = null, isClass = false, classInfo = null, kind = null } = {}) {
    const runtime = this;
    const wrapper = function (...args) { return runtime.callFunction(wrapper, this, args, new.target); };
    const fnName = name || node.id?.name || '';
    const isArrow = node.type === 'ArrowFunctionExpression';
    const meta = {
      node, scope, path: ctx.path, name: fnName, isArrow, isClass, classInfo, homeObject, kind,
      fnId: this.fnIdFor(node, ctx),
      lexicalThis: isArrow ? ctx.thisValue : undefined, lexicalCtx: isArrow ? ctx : null,
    };
    interpretedFunctions.set(wrapper, meta);
    try { Object.defineProperty(wrapper, 'name', { value: fnName, configurable: true }); Object.defineProperty(wrapper, 'length', { value: node.params?.filter(p => p.type !== 'AssignmentPattern' && p.type !== 'RestElement').length || 0, configurable: true }); } catch (_) { /* ignore */ }
    if (isArrow || kind === 'method' || kind === 'getter' || kind === 'setter' || node.async || node.generator) { try { delete wrapper.prototype; } catch (_) { /* ignore */ } }
    return wrapper;
  }
  callFunction(fn, thisArg, args, newTarget, callNode = null, callerCtx = null) {
    if (fn instanceof External) return new External(`${fn.label}()`);
    if (typeof fn !== 'function') throw this.userError(TypeError, `${callNode ? exprLabel(callNode.callee) : 'value'} is not a function`);
    const meta = interpretedFunctions.get(fn);
    if (!meta) {
      if (FORBIDDEN.has(fn)) throw this.userError(TypeError, 'Sandbox: this built-in is not available');
      if (PROTECTED_PROTOTYPES.has(thisArg)) throw this.userError(TypeError, 'Sandbox: built-in prototypes cannot be used as a receiver');
      try {
        const result = newTarget ? Reflect.construct(fn, args) : Reflect.apply(fn, thisArg, args);
        return sanitize(result);
      } catch (error) {
        if (error instanceof ExecutionHalt || error instanceof UserThrow || error instanceof GeneratorCap) throw error;
        throw new UserThrow(error);
      }
    }
    if (meta.isClass && !newTarget) throw this.userError(TypeError, `Class constructor ${meta.name} cannot be invoked without 'new'`);
    if (++this.depth > this.options.maxDepth) { this.depth--; throw new ExecutionHalt(`Call depth limit (${this.options.maxDepth}) exceeded — likely unbounded recursion in ${meta.name || 'a function'}.`); }
    const frame = ++this.frameSerial;
    const parentCtx = this.currentCtx;
    const ctx = {
      fnId: meta.fnId || `anon:${meta.path}#${meta.node.start}`, frame, depth: this.depth, path: meta.path,
      thisValue: meta.isArrow ? meta.lexicalThis : sanitize(thisArg), newTarget: meta.isArrow ? meta.lexicalCtx?.newTarget : newTarget,
      homeObject: meta.isArrow ? meta.lexicalCtx?.homeObject : meta.homeObject, meta: meta.isArrow ? meta.lexicalCtx?.meta : meta,
      argumentsList: args, derivedPending: false,
    };
    if (meta.isArrow && meta.lexicalCtx) { ctx.thisRef = meta.lexicalCtx.thisRef || meta.lexicalCtx; }
    this.emit({ k: 'enter', fn: ctx.fnId, frame, depth: ctx.depth, name: meta.name, args: args.slice(0, 16).map(snapshot), call: callNode ? astKey(callNode) : null, callerFrame: callerCtx?.frame ?? parentCtx?.frame ?? 0 });
    this.currentCtx = ctx;
    let result, threw = false, thrown;
    try {
      result = this.invokeBody(meta, ctx, args.map(sanitize));
    } catch (error) {
      threw = true; thrown = error;
    } finally {
      this.depth--;
      this.currentCtx = parentCtx;
    }
    if (threw) {
      if (!(thrown instanceof ExecutionHalt)) this.emit({ k: 'exit', fn: ctx.fnId, frame, depth: ctx.depth, threw: true, v: snapshot(thrown instanceof UserThrow ? thrown.value : thrown) });
      throw thrown;
    }
    this.emit({ k: 'exit', fn: ctx.fnId, frame, depth: ctx.depth, v: snapshot(result) });
    return result;
  }
  invokeBody(meta, ctx, args) {
    const { node } = meta;
    const scope = new Scope(meta.scope, 'function');
    if (!meta.isArrow) {
      const argumentsObject = [...args];
      scope.declare('arguments', argumentsObject, 'let');
    }
    if (meta.classInfo?.derived) { ctx.derivedPending = true; ctx.thisValue = undefined; }
    if (meta.isClass) {
      // Base classes initialize fields before the constructor body runs.
      if (!meta.classInfo.derived) this.initializeFields(meta.classInfo, ctx.thisValue);
    }
    const run = () => {
      node.params.forEach((param, index) => {
        if (param.type === 'TSParameterProperty') {
          const inner = param.parameter;
          this.bindPattern(inner, index < args.length ? args[index] : undefined, scope, ctx, 'let');
          const names = patternNames(inner);
          if (ctx.thisValue && names[0]) this.setMember(ctx.thisValue, names[0], scope.find(names[0]).value);
          return;
        }
        if (param.type === 'RestElement') this.bindPattern(param.argument, args.slice(index), scope, ctx, 'let');
        else this.bindPattern(param, args[index], scope, ctx, 'let');
      });
      if (!node.body) return undefined;
      if (node.body.type !== 'BlockStatement') return this.evaluate(node.body, scope, ctx);
      this.hoist(node.body.body, scope, ctx, true);
      const completion = this.execList(node.body.body, scope, ctx);
      if (completion?.type === 'return') return completion.value;
      return undefined;
    };
    if (node.generator) return this.runGenerator(run, ctx, node.async);
    if (node.async) {
      const promise = new SyncPromise(this);
      try { promise.resolveWith(run()); } catch (error) {
        if (error instanceof ExecutionHalt) throw error;
        promise.settle('rejected', error instanceof UserThrow ? error.value : error);
      }
      return promise;
    }
    const result = run();
    if (meta.isClass) {
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) return result;
      if (ctx.derivedPending) throw this.userError(ReferenceError, 'Must call super constructor in derived class before returning');
      return ctx.thisValue;
    }
    return result;
  }
  runGenerator(run, ctx, isAsync) {
    ctx.yields = [];
    let returned;
    try { returned = run(); } catch (error) { if (!(error instanceof GeneratorCap)) throw error; this.notes.push('A generator produced more than 10,000 values; it was stopped (generators run eagerly in the sandbox).'); }
    const values = ctx.yields;
    let index = 0;
    const iterator = {
      next: () => {
        const result = index < values.length ? { value: values[index++], done: false } : { value: index++ === values.length ? returned : undefined, done: true };
        return isAsync ? new SyncPromise(this, res => res(result)) : result;
      },
      return: value => { index = values.length + 1; const r = { value, done: true }; return isAsync ? new SyncPromise(this, res => res(r)) : r; },
      throw: error => { throw new UserThrow(error); },
      [isAsync ? Symbol.asyncIterator : Symbol.iterator]() { return this; },
    };
    if (isAsync) iterator[Symbol.iterator] = undefined;
    return iterator;
  }
  construct(callee, args, node, ctx, newTarget = callee) {
    if (callee instanceof External) return new External(`new ${callee.label}`);
    if (typeof callee !== 'function') throw this.userError(TypeError, `${exprLabel(node.callee)} is not a constructor`);
    const meta = interpretedFunctions.get(callee);
    if (!meta) {
      return this.callFunction(callee, undefined, args, newTarget, node, ctx);
    }
    if (meta.isArrow || meta.node.async || meta.node.generator || meta.kind === 'method') throw this.userError(TypeError, `${meta.name || 'function'} is not a constructor`);
    if (meta.isClass && meta.classInfo.derived) return this.callFunction(callee, undefined, args, newTarget, node, ctx);
    const proto = newTarget.prototype && (typeof newTarget.prototype === 'object' || typeof newTarget.prototype === 'function') ? newTarget.prototype : Object.prototype;
    const instance = Object.create(proto);
    const result = this.callFunction(callee, instance, args, newTarget, node, ctx);
    return result !== null && (typeof result === 'object' || typeof result === 'function') ? result : instance;
  }
  initializeFields(classInfo, target) {
    for (const field of classInfo.fields) {
      const value = field.value ? this.evaluate(field.value, field.scope, { ...classInfo.ctx, thisValue: target, homeObject: classInfo.proto }) : undefined;
      this.defineOwn(target, field.key, value);
    }
  }
  defineOwn(target, key, value) {
    if (PROTECTED.has(target)) throw this.userError(TypeError, 'Sandbox: built-in objects cannot be modified');
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }

  // ---------- Classes ----------
  evaluateClass(node, scope, ctx, inferredName) {
    const name = node.id?.name || inferredName || '';
    const superClass = node.superClass ? this.evaluate(node.superClass, scope, ctx) : null;
    if (superClass !== null && node.superClass && typeof superClass !== 'function' && !(superClass instanceof External)) throw this.userError(TypeError, 'Class extends value is not a constructor or null');
    const classScope = new Scope(scope, 'block');
    const ctorDef = node.body.body.find(m => m.type === 'MethodDefinition' && m.kind === 'constructor');
    const derived = Boolean(node.superClass) && !(superClass instanceof External);
    const synthetic = ctorDef ? ctorDef.value : { type: 'FunctionExpression', params: derived ? [{ type: 'RestElement', argument: { type: 'Identifier', name: 'args', start: node.start, end: node.start } }] : [], body: derived ? syntheticSuperBody(node) : { type: 'BlockStatement', body: [], start: node.start, end: node.start }, start: node.start, end: node.end, loc: node.loc, synthetic: true };
    const classInfo = { derived, superClass: derived ? superClass : null, fields: [], ctx: { ...ctx }, proto: null };
    const cls = this.makeFunction(synthetic, classScope, ctx, { name, isClass: true, classInfo });
    const proto = cls.prototype;
    classInfo.proto = proto;
    if (derived) {
      if (superClass.prototype !== undefined) Object.setPrototypeOf(proto, superClass.prototype);
      Object.setPrototypeOf(cls, superClass);
    }
    interpretedFunctions.get(cls).homeObject = proto;
    if (node.id) classScope.declare(node.id.name, cls, 'const');
    const staticInits = [];
    for (const member of node.body.body) {
      const isStatic = Boolean(member.static);
      const target = isStatic ? cls : proto;
      const key = member.computed ? this.toPropertyKey(this.evaluate(member.key, classScope, ctx)) : propertyName(member.key);
      if (member.type === 'MethodDefinition') {
        if (member.kind === 'constructor') continue;
        const kind = member.kind === 'get' ? 'getter' : member.kind === 'set' ? 'setter' : 'method';
        const method = this.makeFunction(member.value, classScope, ctx, { name: String(key), homeObject: target, kind });
        if (kind === 'method') Object.defineProperty(target, key, { value: method, writable: true, configurable: true, enumerable: false });
        else { const existing = Object.getOwnPropertyDescriptor(target, key) || {}; Object.defineProperty(target, key, { get: kind === 'getter' ? method : existing.get, set: kind === 'setter' ? method : existing.set, configurable: true, enumerable: false }); }
      } else if (['PropertyDefinition', 'ClassProperty', 'ClassPrivateProperty'].includes(member.type)) {
        if (isStatic) staticInits.push({ key, value: member.value });
        else classInfo.fields.push({ key, value: member.value, scope: classScope });
      } else if (member.type === 'StaticBlock') staticInits.push({ block: member });
    }
    for (const init of staticInits) {
      const staticCtx = { ...ctx, thisValue: cls, homeObject: cls };
      if (init.block) this.execList(init.block.body, new Scope(classScope, 'function'), staticCtx);
      else this.defineOwn(cls, init.key, init.value ? this.evaluate(init.value, classScope, staticCtx) : undefined);
    }
    return cls;
  }
  superCall(node, scope, ctx) {
    const meta = ctx.meta;
    if (!meta?.classInfo?.derived) throw this.userError(SyntaxError, "'super' keyword unexpected here");
    if (!ctx.derivedPending) throw this.userError(ReferenceError, 'Super constructor may only be called once');
    const args = this.evaluateArguments(node.arguments, scope, ctx);
    const parent = meta.classInfo.superClass;
    const parentMeta = interpretedFunctions.get(parent);
    let instance;
    if (parentMeta) instance = parentMeta.isClass && parentMeta.classInfo.derived ? this.callFunction(parent, undefined, args, ctx.newTarget, node, ctx) : (() => { const obj = Object.create(ctx.newTarget.prototype); const r = this.callFunction(parent, obj, args, ctx.newTarget, node, ctx); return r !== null && typeof r === 'object' ? r : obj; })();
    else {
      if (FORBIDDEN.has(parent)) throw this.userError(TypeError, 'Sandbox: this built-in is not available');
      try { instance = Reflect.construct(parent, args, ctx.newTarget); } catch (error) { throw new UserThrow(error); }
    }
    ctx.thisValue = instance; ctx.derivedPending = false;
    this.initializeFields(meta.classInfo, instance);
    return this.value(node, ctx, undefined);
  }

  // ---------- Modules ----------
  loadModule(path) {
    if (this.modules.has(path)) return this.modules.get(path);
    const file = this.project.files[path];
    const record = { path, scope: new Scope(this.global, 'module'), exportsMap: Object.create(null), defaultValue: undefined, exportAll: [], cjs: { exports: {} }, usesEsm: false, loaded: false };
    this.modules.set(path, record);
    if (!file?.ast) { record.loaded = true; return record; }
    record.originalExports = record.cjs.exports;
    const ctx = { fnId: `module:${path}`, frame: 0, depth: 0, path, thisValue: undefined, module: record };
    const { scope } = record;
    scope.declare('module', record.cjs, 'let');
    scope.declare('exports', record.cjs.exports, 'let');
    scope.declare('require', request => this.require(path, request), 'const');
    scope.declare('__filename', path, 'const'); scope.declare('__dirname', path.split('/').slice(0, -1).join('/'), 'const');
    for (const statement of file.ast.body) {
      if (statement.type === 'ImportDeclaration') {
        record.usesEsm = true;
        const target = this.project.resolveModule(path, statement.source.value);
        for (const spec of statement.specifiers) {
          const imported = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : propertyName(spec.imported);
          const entry = { value: undefined, kind: 'const', importRef: { target, request: statement.source.value, imported } };
          scope.vars.set(spec.local.name, entry);
        }
      } else if (statement.type === 'ExportNamedDeclaration') {
        record.usesEsm = true;
        if (statement.source) for (const spec of statement.specifiers) record.exportsMap[propertyName(spec.exported)] = { reexport: { target: this.project.resolveModule(path, statement.source.value), request: statement.source.value, imported: spec.local ? propertyName(spec.local) : 'default' } };
        else {
          for (const spec of statement.specifiers) record.exportsMap[propertyName(spec.exported)] = { local: propertyName(spec.local) };
          const decl = statement.declaration;
          if (decl?.id?.name) record.exportsMap[decl.id.name] = { local: decl.id.name };
          if (decl?.type === 'VariableDeclaration') for (const d of decl.declarations) for (const name of patternNames(d.id)) record.exportsMap[name] = { local: name };
        }
      } else if (statement.type === 'ExportAllDeclaration') {
        record.usesEsm = true;
        const target = this.project.resolveModule(path, statement.source.value);
        if (statement.exported) record.exportsMap[propertyName(statement.exported)] = { namespace: { target, request: statement.source.value } };
        else record.exportAll.push({ target, request: statement.source.value });
      } else if (statement.type === 'ExportDefaultDeclaration') record.usesEsm = true;
    }
    this.hoist(file.ast.body, scope, ctx, true);
    const previous = this.currentCtx;
    this.currentCtx = ctx;
    this.silent++;
    try {
      for (const statement of file.ast.body) {
        if (statement.type === 'ImportDeclaration' || statement.type === 'ExportAllDeclaration' || (statement.type === 'ExportNamedDeclaration' && !statement.declaration)) continue;
        if (statement.type === 'ExportDefaultDeclaration') {
          const decl = statement.declaration;
          if (decl.type === 'FunctionDeclaration' && decl.id) record.defaultValue = scope.find(decl.id.name).value;
          else if (decl.type === 'ClassDeclaration' && decl.id) { const cls = this.evaluateClass(decl, scope, ctx); scope.find(decl.id.name).value = cls; record.defaultValue = cls; }
          else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') record.defaultValue = decl.type === 'ClassDeclaration' ? this.evaluateClass(decl, scope, ctx, 'default') : this.makeFunction(decl, scope, ctx, { name: 'default' });
          else record.defaultValue = this.evaluate(decl, scope, ctx);
          record.hasDefault = true;
          continue;
        }
        // Skip top-level side effects (e.g. `main();`, `app.listen()`) so that
        // loading a module to reach a function does not run the whole program.
        if (statement.type === 'ExpressionStatement' && !isModuleAssignment(statement.expression)) continue;
        try { this.exec(statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement, scope, ctx); }
        catch (error) {
          if (error instanceof ExecutionHalt) throw error;
          this.notes.push(`${path}: top-level statement on line ${statement.loc?.start.line} failed during module setup (${describeThrown(error)}); continuing.`);
        }
      }
    } finally { this.currentCtx = previous; this.silent--; }
    record.loaded = true;
    return record;
  }
  readImport(ref) {
    if (!ref.target) {
      if (ref.imported === '*' || ref.imported === 'default') return new External(ref.request);
      return new External(`${ref.request}.${ref.imported}`);
    }
    const record = this.loadModule(ref.target);
    if (ref.imported === '*') return this.namespaceOf(record);
    return this.getExport(record, ref.imported);
  }
  getExport(record, name, depth = 0) {
    if (depth > 20) return undefined;
    const isCjs = !record.usesEsm || record.cjs.exports !== record.originalExports || Object.keys(record.originalExports).length > 0;
    if (name === 'default') {
      if (record.hasDefault) return record.defaultValue;
      if (isCjs) return record.cjs.exports;
    }
    const entry = record.exportsMap[name];
    if (entry?.local) { const v = record.scope.find(entry.local); return v ? (v.value === TDZ ? undefined : v.importRef ? this.readImport(v.importRef) : v.value) : undefined; }
    if (entry?.reexport) return this.readImport(entry.reexport);
    if (entry?.namespace) return entry.namespace.target ? this.namespaceOf(this.loadModule(entry.namespace.target)) : new External(entry.namespace.request);
    for (const star of record.exportAll) {
      if (!star.target) continue;
      const other = this.loadModule(star.target);
      const v = this.getExport(other, name, depth + 1);
      if (v !== undefined) return v;
    }
    if (isCjs && record.cjs.exports != null) return this.getMember(record.cjs.exports, name);
    return undefined;
  }
  namespaceOf(record) {
    if (record.namespace) return record.namespace;
    const ns = Object.create(null);
    record.namespace = ns;
    const names = new Set([...Object.keys(record.exportsMap), ...(record.hasDefault ? ['default'] : [])]);
    for (const star of record.exportAll) if (star.target) for (const n of Object.keys(this.loadModule(star.target).exportsMap)) names.add(n);
    // Getters keep ES module bindings live (and tolerate circular imports).
    for (const name of names) Object.defineProperty(ns, name, { enumerable: true, get: () => this.getExport(record, name) });
    if (!record.usesEsm && record.cjs.exports && typeof record.cjs.exports === 'object') for (const [k, v] of Object.entries(record.cjs.exports)) if (!(k in ns)) Object.defineProperty(ns, k, { enumerable: true, value: v });
    return ns;
  }
  require(fromPath, request) {
    if (typeof request !== 'string') return new External('require(?)');
    const target = this.project.resolveModule(fromPath, request);
    if (!target) return new External(request);
    const record = this.loadModule(target);
    if (record.usesEsm && !Object.keys(record.cjs.exports).length) return this.namespaceOf(record);
    return record.cjs.exports;
  }

  // ---------- Statements ----------
  execList(list, scope, ctx) {
    for (const statement of list) {
      const completion = this.exec(statement, scope, ctx);
      if (completion) return completion;
    }
    return undefined;
  }
  execBlock(node, scope, ctx) {
    const blockScope = new Scope(scope, 'block');
    this.hoist(node.body, blockScope, ctx, false);
    return this.execList(node.body, blockScope, ctx);
  }
  exec(node, scope, ctx, labels = []) {
    this.tick();
    switch (node.type) {
      case 'ExpressionStatement': this.ev('stmt', node, ctx); this.evaluate(node.expression, scope, ctx); return undefined;
      case 'VariableDeclaration': {
        this.ev('stmt', node, ctx);
        for (const d of node.declarations) {
          if (!d.init && node.kind === 'var') continue;
          const value = d.init ? this.evaluate(d.init, scope, ctx, d.id.type === 'Identifier' ? d.id.name : undefined) : undefined;
          this.bindPattern(d.id, value, scope, ctx, node.kind, d);
        }
        return undefined;
      }
      case 'FunctionDeclaration': return undefined;
      case 'ClassDeclaration': { this.ev('stmt', node, ctx); const cls = this.evaluateClass(node, scope, ctx); this.initialize(scope, node.id.name, cls, 'let', ctx, node); return undefined; }
      case 'ReturnStatement': {
        this.ev('stmt', node, ctx);
        const value = node.argument ? this.evaluate(node.argument, scope, ctx) : undefined;
        this.ev('return', node, ctx, { v: snapshot(value) });
        return { type: 'return', value };
      }
      case 'IfStatement': {
        this.ev('stmt', node, ctx);
        const test = this.evaluate(node.test, scope, ctx);
        const taken = truthy(test);
        this.ev('branch', node, ctx, { taken: taken ? 'then' : 'else', v: snapshot(test), uncertain: test instanceof External });
        if (taken) return this.execNested(node.consequent, scope, ctx);
        return node.alternate ? this.execNested(node.alternate, scope, ctx) : undefined;
      }
      case 'BlockStatement': return this.execBlock(node, scope, ctx);
      case 'EmptyStatement': return undefined;
      case 'DebuggerStatement': this.ev('note', node, ctx, { text: 'debugger statement reached' }); return undefined;
      case 'ThrowStatement': {
        this.ev('stmt', node, ctx);
        const value = this.evaluate(node.argument, scope, ctx);
        this.ev('throw', node, ctx, { v: snapshot(value) });
        throw new UserThrow(value);
      }
      case 'TryStatement': return this.execTry(node, scope, ctx);
      case 'BreakStatement': this.ev('stmt', node, ctx); return { type: 'break', label: node.label?.name };
      case 'ContinueStatement': this.ev('stmt', node, ctx); return { type: 'continue', label: node.label?.name };
      case 'LabeledStatement': {
        const completion = this.exec(node.body, scope, ctx, [...labels, node.label.name]);
        if (completion?.type === 'break' && completion.label === node.label.name) return undefined;
        return completion;
      }
      case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement': case 'ForInStatement': case 'ForOfStatement':
        return this.execLoop(node, scope, ctx, labels);
      case 'SwitchStatement': return this.execSwitch(node, scope, ctx, labels);
      case 'ExportNamedDeclaration': return node.declaration ? this.exec(node.declaration, scope, ctx) : undefined;
      case 'ExportDefaultDeclaration': case 'ImportDeclaration': case 'ExportAllDeclaration': return undefined;
      case 'TSEnumDeclaration': {
        const enumObject = {};
        let next = 0;
        for (const member of node.members) {
          const key = propertyName(member.id);
          const value = member.initializer ? this.evaluate(member.initializer, scope, ctx) : next;
          enumObject[key] = value;
          if (typeof value === 'number') { enumObject[value] = key; next = value + 1; }
        }
        this.initialize(scope, node.id.name, enumObject, 'const', ctx, node);
        return undefined;
      }
      case 'WithStatement': throw this.userError(SyntaxError, 'with statements are not supported');
      default:
        if (node.type.startsWith('TS') || node.type === 'DeclareFunction') return undefined;
        throw this.userError(SyntaxError, `Unsupported statement ${node.type}`);
    }
  }
  execNested(node, scope, ctx) {
    if (node.type === 'BlockStatement') return this.execBlock(node, scope, ctx);
    return this.exec(node, new Scope(scope, 'block'), ctx);
  }
  execTry(node, scope, ctx) {
    this.ev('stmt', node, ctx);
    let completion, pending = null;
    try { completion = this.execBlock(node.block, scope, ctx); }
    catch (error) {
      if (error instanceof ExecutionHalt || error instanceof GeneratorCap || !node.handler) pending = error;
      else {
        const value = error instanceof UserThrow ? error.value : error;
        this.ev('catch', node.handler, ctx, { v: snapshot(value) });
        const catchScope = new Scope(scope, 'block');
        if (node.handler.param) this.bindPattern(node.handler.param, value, catchScope, ctx, 'let');
        try { completion = this.execBlock(node.handler.body, catchScope, ctx); } catch (inner) { pending = inner; }
      }
    }
    if (node.finalizer) {
      this.ev('branch', node.finalizer, ctx, { taken: 'finally' });
      const finalCompletion = this.execBlock(node.finalizer, scope, ctx);
      if (finalCompletion) return finalCompletion;
    }
    if (pending) throw pending;
    return completion;
  }
  loopControl(completion, labels) {
    // Returns 'break' | 'continue' | completion-to-propagate | undefined
    if (!completion) return undefined;
    if (completion.type === 'break' && (!completion.label || labels.includes(completion.label))) return 'break';
    if (completion.type === 'continue' && (!completion.label || labels.includes(completion.label))) return 'continue';
    return completion;
  }
  execLoop(node, scope, ctx, labels) {
    this.ev('stmt', node, ctx);
    let n = 0;
    const iterate = () => { n++; this.ev('iter', node, ctx, { n }); };
    const handle = completion => { const c = this.loopControl(completion, labels); return c; };
    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
      let first = node.type === 'DoWhileStatement';
      for (;;) {
        this.tick();
        if (!first) {
          const test = this.evaluate(node.test, scope, ctx);
          this.ev('branch', node, ctx, { taken: truthy(test) ? 'loop' : 'exit', v: snapshot(test) });
          if (!truthy(test)) break;
        }
        first = false;
        iterate();
        const c = handle(this.execNested(node.body, scope, ctx));
        if (c === 'break') break;
        if (c && c !== 'continue') return c;
      }
      return undefined;
    }
    if (node.type === 'ForStatement') {
      let loopScope = new Scope(scope, 'block');
      const perIteration = node.init?.type === 'VariableDeclaration' && node.init.kind !== 'var' ? node.init.declarations.flatMap(d => patternNames(d.id)) : [];
      if (node.init) {
        if (node.init.type === 'VariableDeclaration') { this.hoist([node.init], loopScope, ctx, false); this.exec(node.init, loopScope, ctx); }
        else this.evaluate(node.init, loopScope, ctx);
      }
      const copyScope = () => { if (!perIteration.length) return; const next = new Scope(scope, 'block'); for (const name of perIteration) next.declare(name, loopScope.vars.get(name).value, loopScope.vars.get(name).kind); loopScope = next; };
      for (;;) {
        this.tick();
        if (node.test) {
          const test = this.evaluate(node.test, loopScope, ctx);
          this.ev('branch', node, ctx, { taken: truthy(test) ? 'loop' : 'exit', v: snapshot(test) });
          if (!truthy(test)) break;
        }
        iterate();
        const c = handle(this.execNested(node.body, loopScope, ctx));
        if (c === 'break') break;
        if (c && c !== 'continue') return c;
        copyScope();
        if (node.update) this.evaluate(node.update, loopScope, ctx);
      }
      return undefined;
    }
    // for-in / for-of
    const right = this.evaluate(node.right, scope, ctx);
    let items;
    if (node.type === 'ForInStatement') {
      items = [];
      if (right !== null && right !== undefined && !(right instanceof External)) for (const key in right) items.push(key); // eslint-disable-line guard-for-in
    } else items = this.iterate(right, node.right, ctx, node.await);
    for (const raw of items) {
      this.tick();
      const item = node.await ? this.awaitValue(raw, node, ctx) : raw;
      const iterScope = new Scope(scope, 'block');
      this.ev('branch', node, ctx, { taken: 'loop', v: snapshot(item) });
      iterate();
      if (node.left.type === 'VariableDeclaration') this.bindPattern(node.left.declarations[0].id, item, iterScope, ctx, node.left.kind, node.left.declarations[0]);
      else this.bindPattern(node.left, item, iterScope, ctx, 'assign');
      const c = handle(this.execNested(node.body, iterScope, ctx));
      if (c === 'break') break;
      if (c && c !== 'continue') return c;
    }
    this.ev('branch', node, ctx, { taken: 'exit' });
    return undefined;
  }
  execSwitch(node, scope, ctx, labels) {
    this.ev('stmt', node, ctx);
    const value = this.evaluate(node.discriminant, scope, ctx);
    const switchScope = new Scope(scope, 'block');
    for (const c of node.cases) this.hoist(c.consequent, switchScope, ctx, false);
    let matched = node.cases.findIndex(c => c.test && this.evaluate(c.test, switchScope, ctx) === value);
    if (matched < 0) matched = node.cases.findIndex(c => !c.test);
    this.ev('branch', node, ctx, { taken: matched < 0 ? 'none' : node.cases[matched].test ? `case:${matched}` : 'default', v: snapshot(value) });
    if (matched < 0) return undefined;
    for (let i = matched; i < node.cases.length; i++) {
      this.ev('stmt', node.cases[i], ctx);
      const completion = this.execList(node.cases[i].consequent, switchScope, ctx);
      if (!completion) continue;
      if (completion.type === 'break' && (!completion.label || labels.includes(completion.label))) return undefined;
      return completion;
    }
    return undefined;
  }

  // ---------- Patterns ----------
  bindPattern(pattern, value, scope, ctx, mode, ownerNode = null) {
    pattern = unwrapTs(pattern);
    switch (pattern.type) {
      case 'Identifier':
        if (mode === 'assign') this.assign(scope, pattern.name, value, ctx, ownerNode || pattern);
        else this.initialize(scope, pattern.name, value, mode, ctx, ownerNode || pattern);
        return;
      case 'MemberExpression': {
        const object = this.evaluate(pattern.object, scope, ctx);
        const key = pattern.computed ? this.evaluate(pattern.property, scope, ctx) : propertyName(pattern.property);
        this.setMember(object, key, value);
        return;
      }
      case 'AssignmentPattern': {
        const actual = value === undefined ? this.evaluate(pattern.right, scope, ctx, pattern.left.type === 'Identifier' ? pattern.left.name : undefined) : value;
        this.bindPattern(pattern.left, actual, scope, ctx, mode, ownerNode);
        return;
      }
      case 'ObjectPattern': {
        if (value === null || value === undefined) throw this.userError(TypeError, `Cannot destructure '${String(value)}' as it is ${value === null ? 'null' : 'undefined'}.`);
        const used = [];
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            const rest = {};
            if (!(value instanceof External)) for (const key of Object.keys(value)) if (!used.includes(key)) rest[key] = value[key];
            this.bindPattern(prop.argument, value instanceof External ? new External(`${value.label}…`) : rest, scope, ctx, mode, ownerNode);
            continue;
          }
          const key = prop.computed ? this.toPropertyKey(this.evaluate(prop.key, scope, ctx)) : propertyName(prop.key);
          used.push(key);
          this.bindPattern(prop.value, this.getMember(value, key), scope, ctx, mode, ownerNode);
        }
        return;
      }
      case 'ArrayPattern': {
        const items = this.iterate(value, pattern, ctx, false, pattern.elements.length);
        pattern.elements.forEach((element, i) => {
          if (!element) return;
          if (element.type === 'RestElement') this.bindPattern(element.argument, items.slice(i), scope, ctx, mode, ownerNode);
          else this.bindPattern(element, items[i], scope, ctx, mode, ownerNode);
        });
        return;
      }
      default: throw this.userError(SyntaxError, `Unsupported binding pattern ${pattern.type}`);
    }
  }
  iterate(value, node, ctx, isAsync = false, needed = Infinity) {
    if (value instanceof External) { this.ev('external', node, ctx, { label: `iterating ${value.label}` }); return Array.from({ length: needed === Infinity ? 0 : Math.min(needed, 8) }, (_, i) => new External(`${value.label}[${i}]`)); }
    if (value === null || value === undefined) throw this.userError(TypeError, `${String(value)} is not iterable`);
    if (isAsync && value[Symbol.asyncIterator]) {
      const it = value[Symbol.asyncIterator]();
      const out = [];
      for (;;) { this.tick(); const step = this.awaitValue(it.next(), node, ctx); if (step.done) break; out.push(step.value); if (out.length > 100000) throw new ExecutionHalt('Iteration limit exceeded'); }
      return out;
    }
    const iteratorFn = value[Symbol.iterator];
    if (typeof iteratorFn !== 'function') throw this.userError(TypeError, `${snapshot(value).s} is not iterable`);
    const out = [];
    try {
      const it = iteratorFn.call(value);
      for (;;) {
        this.tick();
        const step = it.next();
        if (step.done) break;
        out.push(sanitize(step.value));
        if (out.length >= needed) break;
        if (out.length > 100000) throw new ExecutionHalt('Iteration limit exceeded');
      }
    } catch (error) { if (error instanceof ExecutionHalt || error instanceof UserThrow) throw error; throw new UserThrow(error); }
    return out;
  }

  // ---------- Members ----------
  toPropertyKey(key) { return typeof key === 'symbol' ? key : String(key); }
  getMember(object, key, node = null, ctx = null) {
    if (object instanceof External) return new External(`${object.label}.${String(key)}`);
    if (object === null || object === undefined) throw this.userError(TypeError, `Cannot read properties of ${String(object)} (reading '${String(key)}')`);
    let value;
    try { value = object[key]; } catch (error) { if (error instanceof ExecutionHalt || error instanceof UserThrow) throw error; throw new UserThrow(error); }
    return sanitize(value);
  }
  setMember(object, key, value) {
    if (object instanceof External) return value;
    if (object === null || object === undefined) throw this.userError(TypeError, `Cannot set properties of ${String(object)} (setting '${String(key)}')`);
    if (PROTECTED.has(object)) throw this.userError(TypeError, 'Sandbox: built-in objects cannot be modified');
    if (typeof object !== 'object' && typeof object !== 'function') return value; // primitives silently ignore (sloppy) — strict would throw
    try { object[key] = value; } catch (error) { if (error instanceof ExecutionHalt || error instanceof UserThrow) throw error; throw new UserThrow(error); }
    return value;
  }
  superBase(ctx) { const home = ctx.homeObject; return home ? Object.getPrototypeOf(home) : null; }

  // ---------- Expressions ----------
  evaluateArguments(list, scope, ctx) {
    const args = [];
    for (const arg of list) {
      if (arg.type === 'SpreadElement') { const spread = this.evaluate(arg.argument, scope, ctx); args.push(...this.iterate(spread, arg, ctx)); }
      else args.push(this.evaluate(arg, scope, ctx));
    }
    return args;
  }
  awaitValue(value, node, ctx) {
    if (!(value instanceof SyncPromise)) {
      if (value instanceof Promise) { this.ev('external', node, ctx, { label: 'native promise (unresolvable in sandbox)' }); return new External('awaited native promise'); }
      if (value && typeof value === 'object' && typeof value.then === 'function' && !(value instanceof External)) { const p = new SyncPromise(this); p.resolveWith(value); value = p; }
      else { this.drainMicrotasks(); return value; }
    }
    this.ev('await', node, ctx, { v: snapshot(value) });
    let guard = 0;
    while (value.state === 'pending') {
      if (this.microtasks.length) this.runMicrotask();
      else if (this.timers.length) this.runNextTimer();
      else { this.ev('note', node, ctx, { text: 'await on a promise that never settles' }); return new External('never-settled promise'); }
      if (++guard > 200000) throw new ExecutionHalt('Async scheduling limit reached');
    }
    if (value.state === 'rejected') throw new UserThrow(value.value);
    return value.value;
  }
  runMicrotask() { const job = this.microtasks.shift(); const saved = this.currentCtx; try { job(); } catch (error) { if (error instanceof ExecutionHalt) throw error; this.notes.push(`Uncaught error in async callback: ${describeThrown(error)}`); } finally { this.currentCtx = saved; } }
  drainMicrotasks(limit = 100000) { let n = 0; while (this.microtasks.length && n++ < limit) this.runMicrotask(); }
  runNextTimer() {
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const timer = this.timers.shift();
    if (!timer) return false;
    this.virtualTime = Math.max(this.virtualTime, timer.at);
    if (timer.every && ++timer.runs < 25) this.timers.push({ ...timer, at: timer.at + timer.every });
    else if (timer.every) this.notes.push('An interval was stopped after 25 simulated runs.');
    this.emit({ k: 'timer', fn: null, frame: 0, depth: 0, t: this.virtualTime, text: `timer fired at +${this.virtualTime}ms` });
    try { this.callFunction(timer.fn, undefined, timer.args); } catch (error) { if (error instanceof ExecutionHalt) throw error; this.notes.push(`Uncaught error in timer callback: ${describeThrown(error)}`); }
    this.drainMicrotasks();
    return true;
  }

  evaluate(node, scope, ctx, inferredName) {
    this.tick();
    switch (node.type) {
      case 'Literal': {
        if (node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
        if (node.bigint !== undefined) return BigInt(node.bigint);
        return node.value;
      }
      case 'Identifier': {
        if (node.name === 'undefined') return undefined;
        return this.value(node, ctx, this.lookup(scope, node.name, node, ctx));
      }
      case 'ThisExpression': {
        if (ctx.derivedPending || ctx.thisRef?.derivedPending) throw this.userError(ReferenceError, "Must call super constructor before accessing 'this'");
        const value = ctx.thisRef && ctx.thisRef !== ctx ? ctx.thisRef.thisValue : ctx.thisValue;
        return this.value(node, ctx, value);
      }
      case 'TemplateLiteral': {
        let out = node.quasis[0].value.cooked ?? '';
        node.expressions.forEach((expression, i) => { out += String(this.toStringValue(this.evaluate(expression, scope, ctx))) + (node.quasis[i + 1].value.cooked ?? ''); });
        return this.value(node, ctx, out);
      }
      case 'TaggedTemplateExpression': {
        const { fn, thisArg } = this.calleeOf(node.tag, scope, ctx);
        const strings = node.quasi.quasis.map(q => q.value.cooked);
        Object.defineProperty(strings, 'raw', { value: node.quasi.quasis.map(q => q.value.raw) });
        const values = node.quasi.expressions.map(e => this.evaluate(e, scope, ctx));
        return this.value(node, ctx, this.callFunction(fn, thisArg, [strings, ...values], undefined, node, ctx));
      }
      case 'ArrayExpression': {
        const out = [];
        for (const element of node.elements) {
          if (!element) { out.length += 1; continue; }
          if (element.type === 'SpreadElement') out.push(...this.iterate(this.evaluate(element.argument, scope, ctx), element, ctx));
          else out.push(this.evaluate(element, scope, ctx));
        }
        return this.value(node, ctx, out);
      }
      case 'ObjectExpression': return this.value(node, ctx, this.evaluateObject(node, scope, ctx));
      case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const fn = this.makeFunction(node, scope, ctx, { name: node.id?.name || inferredName });
        if (node.type === 'FunctionExpression' && node.id) { const own = new Scope(scope, 'block'); own.declare(node.id.name, fn, 'const'); interpretedFunctions.get(fn).scope = own; }
        return this.value(node, ctx, fn);
      }
      case 'ClassExpression': return this.value(node, ctx, this.evaluateClass(node, scope, ctx, inferredName));
      case 'UnaryExpression': return this.value(node, ctx, this.evaluateUnary(node, scope, ctx));
      case 'UpdateExpression': {
        const old = this.readReference(node.argument, scope, ctx);
        const numeric = old.value instanceof External ? old.value : typeof old.value === 'bigint' ? old.value : Number(old.value);
        const next = numeric instanceof External ? numeric : node.operator === '++' ? numeric + (typeof numeric === 'bigint' ? 1n : 1) : numeric - (typeof numeric === 'bigint' ? 1n : 1);
        old.write(next, node);
        return this.value(node, ctx, node.prefix ? next : numeric);
      }
      case 'BinaryExpression': {
        const left = node.left.type === 'PrivateName' || node.left.type === 'PrivateIdentifier' ? `#${node.left.name || node.left.id?.name}` : this.evaluate(node.left, scope, ctx);
        const right = this.evaluate(node.right, scope, ctx);
        return this.value(node, ctx, this.binary(node.operator, left, right));
      }
      case 'LogicalExpression': {
        const left = this.evaluate(node.left, scope, ctx);
        const shortCircuit = node.operator === '&&' ? !truthy(left) : node.operator === '||' ? truthy(left) : left !== null && left !== undefined;
        this.ev('branch', node, ctx, { taken: shortCircuit ? 'left' : 'right', v: snapshot(left) });
        return this.value(node, ctx, shortCircuit ? left : this.evaluate(node.right, scope, ctx));
      }
      case 'ConditionalExpression': {
        const test = this.evaluate(node.test, scope, ctx);
        this.ev('branch', node, ctx, { taken: truthy(test) ? 'then' : 'else', v: snapshot(test) });
        return this.value(node, ctx, this.evaluate(truthy(test) ? node.consequent : node.alternate, scope, ctx, inferredName));
      }
      case 'AssignmentExpression': return this.value(node, ctx, this.evaluateAssignment(node, scope, ctx));
      case 'SequenceExpression': { let last; for (const e of node.expressions) last = this.evaluate(e, scope, ctx); return this.value(node, ctx, last); }
      case 'ChainExpression': { const v = this.evaluateChainPart(node.expression, scope, ctx); return this.value(node, ctx, v === SHORT ? undefined : v); }
      case 'MemberExpression': case 'CallExpression': case 'OptionalMemberExpression': case 'OptionalCallExpression': {
        const v = this.evaluateChainPart(node, scope, ctx);
        return v === SHORT ? undefined : v;
      }
      case 'NewExpression': {
        const callee = this.evaluate(node.callee, scope, ctx);
        const args = this.evaluateArguments(node.arguments, scope, ctx);
        this.ev('call', node, ctx, { args: args.slice(0, 16).map(snapshot), callee: interpretedFunctions.get(callee)?.fnId || null });
        return this.value(node, ctx, this.construct(callee, args, node, ctx));
      }
      case 'AwaitExpression': {
        const value = this.evaluate(node.argument, scope, ctx);
        return this.value(node, ctx, this.awaitValue(value, node, ctx));
      }
      case 'YieldExpression': {
        const genCtx = ctx;
        if (!genCtx.yields) throw this.userError(SyntaxError, 'yield outside generator');
        const value = node.argument ? this.evaluate(node.argument, scope, ctx) : undefined;
        if (node.delegate) genCtx.yields.push(...this.iterate(value, node, ctx));
        else genCtx.yields.push(value);
        this.ev('yield', node, ctx, { v: snapshot(value) });
        if (genCtx.yields.length > 10000) throw new GeneratorCap();
        return this.value(node, ctx, undefined);
      }
      case 'SpreadElement': return this.evaluate(node.argument, scope, ctx);
      case 'MetaProperty': return node.meta.name === 'new' ? ctx.newTarget : new External('import.meta');
      case 'ImportExpression': { this.evaluate(node.source, scope, ctx); return this.value(node, ctx, new SyncPromise(this, res => res(new External('dynamic import')))); }
      case 'Super': return this.superBase(ctx);
      case 'JSXElement': case 'JSXFragment': return this.value(node, ctx, this.evaluateJsx(node, scope, ctx));
      case 'JSXExpressionContainer': return node.expression.type === 'JSXEmptyExpression' ? undefined : this.evaluate(node.expression, scope, ctx);
      case 'JSXText': return node.value;
      case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSTypeAssertion': case 'TSSatisfiesExpression': case 'TSInstantiationExpression':
        return this.evaluate(node.expression, scope, ctx, inferredName);
      case 'ClassPrivateProperty': case 'PrivateName': case 'PrivateIdentifier': return `#${node.name || node.id?.name}`;
      default: throw this.userError(SyntaxError, `Unsupported expression ${node.type}`);
    }
  }
  toStringValue(v) { return v instanceof External ? `‹${v.label}›` : typeof v === 'symbol' ? (() => { throw this.userError(TypeError, 'Cannot convert a Symbol value to a string'); })() : v; }
  binary(op, left, right) {
    if (left instanceof External || right instanceof External) {
      if (op === '===' || op === '!==') return BINARY[op](left, right);
      return new External(`${left instanceof External ? left.label : snapshot(left).s} ${op} ${right instanceof External ? right.label : snapshot(right).s}`);
    }
    const fn = BINARY[op];
    if (!fn) throw this.userError(SyntaxError, `Unsupported operator ${op}`);
    try { return fn(left, right); } catch (error) { if (error instanceof ExecutionHalt || error instanceof UserThrow) throw error; throw new UserThrow(error); }
  }
  evaluateUnary(node, scope, ctx) {
    if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !scope.find(node.argument.name) && !Object.prototype.hasOwnProperty.call(this.sandboxGlobal, node.argument.name)) return 'undefined';
    if (node.operator === 'delete') {
      const target = unwrapTs(node.argument);
      if (target.type !== 'MemberExpression') return true;
      const object = this.evaluate(target.object, scope, ctx);
      if (object instanceof External) return true;
      if (PROTECTED.has(object)) throw this.userError(TypeError, 'Sandbox: built-in objects cannot be modified');
      const key = target.computed ? this.evaluate(target.property, scope, ctx) : propertyName(target.property);
      return delete object[key];
    }
    const value = this.evaluate(node.argument, scope, ctx);
    if (value instanceof External && node.operator !== 'typeof' && node.operator !== 'void' && node.operator !== '!') return new External(`${node.operator}${value.label}`);
    switch (node.operator) {
      case '!': return !truthy(value);
      case '-': return -value;
      case '+': if (typeof value === 'bigint') throw this.userError(TypeError, 'Cannot convert a BigInt value to a number'); return +value;
      case '~': return ~value;
      case 'typeof': return value instanceof External ? 'object' : typeof value;
      case 'void': return undefined;
      default: throw this.userError(SyntaxError, `Unsupported unary ${node.operator}`);
    }
  }
  evaluateObject(node, scope, ctx) {
    const out = {};
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') {
        const source = this.evaluate(prop.argument, scope, ctx);
        if (source !== null && source !== undefined && !(source instanceof External)) Object.assign(out, typeof source === 'string' ? { ...source } : source);
        continue;
      }
      const key = prop.computed ? this.toPropertyKey(this.evaluate(prop.key, scope, ctx)) : propertyName(prop.key);
      if (prop.kind === 'get' || prop.kind === 'set') {
        const fn = this.makeFunction(prop.value, scope, ctx, { name: String(key), homeObject: out, kind: prop.kind === 'get' ? 'getter' : 'setter' });
        const existing = Object.getOwnPropertyDescriptor(out, key) || {};
        Object.defineProperty(out, key, { get: prop.kind === 'get' ? fn : existing.get, set: prop.kind === 'set' ? fn : existing.set, enumerable: true, configurable: true });
        continue;
      }
      if (key === '__proto__' && !prop.computed && !prop.shorthand) {
        const proto = this.evaluate(prop.value, scope, ctx);
        if (proto === null || (typeof proto === 'object' && !PROTECTED.has(proto)) || typeof proto === 'function') Object.setPrototypeOf(out, proto);
        continue;
      }
      const value = prop.method ? this.makeFunction(prop.value, scope, ctx, { name: String(key), homeObject: out, kind: 'method' }) : this.evaluate(prop.value, scope, ctx, typeof key === 'string' ? key : undefined);
      if (prop.method) this.value(prop.value, ctx, value);
      Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return out;
  }
  evaluateJsx(node, scope, ctx) {
    const children = [];
    for (const child of node.children) {
      if (child.type === 'JSXText') { const text = child.value.replace(/\s*\n\s*/g, ' ').trim(); if (text) children.push(text); continue; }
      if (child.type === 'JSXExpressionContainer') { if (child.expression.type !== 'JSXEmptyExpression') children.push(this.evaluate(child.expression, scope, ctx)); continue; }
      if (child.type === 'JSXSpreadChild') { children.push(...this.iterate(this.evaluate(child.expression, scope, ctx), child, ctx)); continue; }
      children.push(this.evaluate(child, scope, ctx));
    }
    if (node.type === 'JSXFragment') return { $$jsx: true, type: 'Fragment', props: {}, children };
    const name = node.openingElement.name;
    const resolveName = n => {
      if (n.type === 'JSXIdentifier') return /^[a-z]/.test(n.name) && !n.name.includes('.') ? n.name : this.lookup(scope, n.name, n, ctx);
      if (n.type === 'JSXMemberExpression') return this.getMember(resolveName(n.object), n.property.name);
      if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
      return 'unknown';
    };
    const type = resolveName(name);
    const props = {};
    for (const attr of node.openingElement.attributes) {
      if (attr.type === 'JSXSpreadAttribute') { const spread = this.evaluate(attr.argument, scope, ctx); if (spread && typeof spread === 'object' && !(spread instanceof External)) Object.assign(props, spread); continue; }
      const attrName = attr.name.type === 'JSXNamespacedName' ? `${attr.name.namespace.name}:${attr.name.name.name}` : attr.name.name;
      props[attrName] = attr.value === null ? true : attr.value.type === 'Literal' ? attr.value.value : this.evaluate(attr.value, scope, ctx);
    }
    if (typeof type === 'function' && interpretedFunctions.get(type)) this.ev('call', node, ctx, { callee: interpretedFunctions.get(type).fnId, jsx: true, args: [snapshot(props)] });
    return { $$jsx: true, type, props, children };
  }
  readReference(target, scope, ctx) {
    target = unwrapTs(target);
    if (target.type === 'Identifier') {
      return { value: this.lookup(scope, target.name, target, ctx), write: (v, node) => this.assign(scope, target.name, v, ctx, node) };
    }
    if (target.type === 'MemberExpression') {
      const object = target.object.type === 'Super' ? ctx.thisValue : this.evaluate(target.object, scope, ctx);
      const key = target.computed ? this.toPropertyKey(this.evaluate(target.property, scope, ctx)) : propertyName(target.property);
      const value = target.object.type === 'Super' ? this.getMember(this.superBase(ctx), key) : this.getMember(object, key);
      return { value, write: v => { this.setMember(object, key, v); this.emit({ k: 'write', name: `${exprLabel(target.object)}.${String(key)}`, key: astKey(target), fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth, v: snapshot(v), prop: true }); } };
    }
    throw this.userError(SyntaxError, `Invalid assignment target ${target.type}`);
  }
  evaluateAssignment(node, scope, ctx) {
    const left = unwrapTs(node.left);
    if (node.operator === '=') {
      if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
        const value = this.evaluate(node.right, scope, ctx);
        this.bindPattern(left, value, scope, ctx, 'assign', node);
        return value;
      }
      if (left.type === 'Identifier') {
        const value = this.evaluate(node.right, scope, ctx, left.name);
        this.assign(scope, left.name, value, ctx, node);
        return value;
      }
      const ref = this.memberTarget(left, scope, ctx);
      const value = this.evaluate(node.right, scope, ctx);
      ref.write(value);
      return value;
    }
    const ref = this.readReference(left, scope, ctx);
    if (['&&=', '||=', '??='].includes(node.operator)) {
      const keep = node.operator === '&&=' ? !truthy(ref.value) : node.operator === '||=' ? truthy(ref.value) : ref.value !== null && ref.value !== undefined;
      this.ev('branch', node, ctx, { taken: keep ? 'left' : 'right', v: snapshot(ref.value) });
      if (keep) return ref.value;
      const value = this.evaluate(node.right, scope, ctx);
      ref.write(value, node);
      return value;
    }
    const right = this.evaluate(node.right, scope, ctx);
    const value = this.binary(node.operator.slice(0, -1), ref.value, right);
    ref.write(value, node);
    return value;
  }
  memberTarget(target, scope, ctx) {
    const object = target.object.type === 'Super' ? ctx.thisValue : this.evaluate(target.object, scope, ctx);
    const key = target.computed ? this.toPropertyKey(this.evaluate(target.property, scope, ctx)) : propertyName(target.property);
    return { write: v => { this.setMember(object, key, v); this.emit({ k: 'write', name: `${exprLabel(target.object)}.${String(key)}`, key: astKey(target), fn: ctx.fnId, frame: ctx.frame, depth: ctx.depth, v: snapshot(v), prop: true }); } };
  }
  /** Evaluate member/call chains with optional short-circuiting. */
  evaluateChainPart(node, scope, ctx) {
    node = unwrapTs(node);
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      if (node.object.type === 'Super') {
        const key = node.computed ? this.toPropertyKey(this.evaluate(node.property, scope, ctx)) : propertyName(node.property);
        const base = this.superBase(ctx);
        const desc = base && findDescriptor(base, key);
        const v = desc?.get ? this.callFunction(desc.get, ctx.thisValue, []) : sanitize(base?.[key]);
        return this.value(node, ctx, v);
      }
      const object = this.evaluateChainPart(node.object, scope, ctx);
      if (object === SHORT) return SHORT;
      if (node.optional && (object === null || object === undefined)) { this.ev('branch', node, ctx, { taken: 'short-circuit' }); return SHORT; }
      const key = node.computed ? this.toPropertyKey(this.evaluate(node.property, scope, ctx)) : propertyName(node.property);
      return this.value(node, ctx, this.getMember(object, key, node, ctx));
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = unwrapTs(node.callee);
      if (callee.type === 'Super') return this.superCall(node, scope, ctx);
      let fn, thisArg;
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        if (callee.object.type === 'Super') {
          const key = callee.computed ? this.toPropertyKey(this.evaluate(callee.property, scope, ctx)) : propertyName(callee.property);
          fn = sanitize(this.superBase(ctx)?.[key]); thisArg = ctx.thisValue;
        } else {
          const object = this.evaluateChainPart(callee.object, scope, ctx);
          if (object === SHORT) return SHORT;
          if (callee.optional && (object === null || object === undefined)) { this.ev('branch', callee, ctx, { taken: 'short-circuit' }); return SHORT; }
          const key = callee.computed ? this.toPropertyKey(this.evaluate(callee.property, scope, ctx)) : propertyName(callee.property);
          fn = this.getMember(object, key);
          thisArg = object;
          this.value(callee, ctx, fn);
        }
      } else {
        fn = this.evaluateChainPart(callee, scope, ctx);
        if (fn === SHORT) return SHORT;
        thisArg = undefined;
      }
      if (node.optional && (fn === null || fn === undefined)) { this.ev('branch', node, ctx, { taken: 'short-circuit' }); return SHORT; }
      const args = this.evaluateArguments(node.arguments, scope, ctx);
      const meta = typeof fn === 'function' ? interpretedFunctions.get(fn) : null;
      this.ev('call', node, ctx, { args: args.slice(0, 16).map(snapshot), callee: meta?.fnId || null, native: !meta && typeof fn === 'function' ? (fn.name || 'native') : null, external: fn instanceof External ? fn.label : null });
      if (fn instanceof External) this.ev('external', node, ctx, { label: `${fn.label}(…)` });
      return this.value(node, ctx, this.callFunction(fn, thisArg, args, undefined, node, ctx));
    }
    if (node.type === 'ChainExpression') return this.evaluateChainPart(node.expression, scope, ctx);
    return this.evaluate(node, scope, ctx);
  }
  calleeOf(node, scope, ctx) {
    node = unwrapTs(node);
    if (node.type === 'MemberExpression') {
      const object = this.evaluate(node.object, scope, ctx);
      const key = node.computed ? this.toPropertyKey(this.evaluate(node.property, scope, ctx)) : propertyName(node.property);
      return { fn: this.getMember(object, key), thisArg: object };
    }
    return { fn: this.evaluate(node, scope, ctx), thisArg: undefined };
  }

  // ---------- Entry ----------
  /** Resolve the runtime function value for an indexed project function. */
  resolveFunctionValue(fn) {
    const record = this.loadModule(fn.path);
    const ctx = { fnId: `module:${fn.path}`, frame: 0, depth: 0, path: fn.path, thisValue: undefined };
    const binding = !fn.className && fn.topLevel ? record.scope.vars.get(fn.name) : null;
    if (binding && typeof binding.value === 'function' && interpretedFunctions.get(binding.value)?.node === fn.node) return { value: binding.value, thisArg: undefined, approximate: false };
    const exported = fn.exportedAs.length ? this.getExport(record, fn.exportedAs[0]) : null;
    if (typeof exported === 'function' && interpretedFunctions.get(exported)?.node === fn.node) return { value: exported, thisArg: undefined, approximate: false };
    if (fn.className) {
      const cls = record.scope.find(fn.className)?.value;
      if (typeof cls === 'function') {
        const member = fn.name.split('.').pop();
        if (fn.kind === 'constructor') return { value: cls, thisArg: undefined, construct: true, approximate: false };
        const staticFn = Object.getOwnPropertyDescriptor(cls, member);
        if (staticFn && interpretedFunctions.get(staticFn.value)?.node === fn.node) return { value: staticFn.value, thisArg: cls, approximate: false };
        const desc = findDescriptor(cls.prototype, member);
        const method = desc?.value || desc?.get || desc?.set;
        if (method && interpretedFunctions.get(method)?.node === fn.node) return { value: method, thisArg: Object.create(cls.prototype), approximate: true, note: `Called on a bare ${fn.className} instance (constructor not run). Run the constructor or a caller for full state.` };
      }
    }
    // Objects exported/bound at module level, e.g. const api = { load() {} }.
    for (const entry of record.scope.vars.values()) {
      const holder = entry.value;
      if (holder && typeof holder === 'object' && !(holder instanceof External)) {
        for (const key of Object.keys(holder)) {
          let desc; try { desc = Object.getOwnPropertyDescriptor(holder, key); } catch (_) { continue; }
          if (desc && typeof desc.value === 'function' && interpretedFunctions.get(desc.value)?.node === fn.node) return { value: desc.value, thisArg: holder, approximate: false };
        }
      }
    }
    // Nested function or callback: closure variables of its parent are unavailable.
    return { value: this.makeFunction(fn.node, record.scope, ctx, { name: fn.name.split(' › ').pop() }), thisArg: undefined, approximate: !fn.topLevel, note: fn.topLevel ? null : 'This function is nested; it ran with module scope only. Run its parent function to give it real closure values.' };
  }
  evaluateInput(text, path) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return undefined;
    const record = this.loadModule(path);
    const ctx = { fnId: `input`, frame: 0, depth: 0, path, thisValue: undefined };
    const expression = parseExpressionSource(trimmed);
    const saved = this.events.length;
    const value = this.evaluate(expression, record.scope, ctx);
    this.events.length = saved; // inputs are not part of the trace
    return value;
  }
}

function findDescriptor(object, key) {
  for (let o = object; o; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, key); if (d) return d; }
  return null;
}
function truthy(v) { return Boolean(v); }
export function propertyName(key) {
  if (!key) return '';
  if (key.type === 'Identifier' || key.type === 'JSXIdentifier') return key.name;
  if (key.type === 'PrivateIdentifier' || key.type === 'PrivateName') return `#${key.name || key.id?.name}`;
  if (key.type === 'Literal') return String(key.value);
  return String(key.name ?? key.value ?? '');
}
export function patternNames(pattern, out = []) {
  if (!pattern) return out;
  pattern = unwrapTs(pattern);
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
  else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) patternNames(e, out);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  else if (pattern.type === 'TSParameterProperty') patternNames(pattern.parameter, out);
  return out;
}
function exprLabel(node) {
  node = unwrapTs(node);
  if (!node) return 'expression';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') return `${exprLabel(node.object)}.${node.computed ? '[…]' : propertyName(node.property)}`;
  if (node.type === 'CallExpression') return `${exprLabel(node.callee)}()`;
  return node.type;
}
function isModuleAssignment(expression) {
  return expression.type === 'AssignmentExpression' || (expression.type === 'SequenceExpression' && expression.expressions.every(isModuleAssignment)) || (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression' && /^(Object\.defineProperty|Object\.assign)$/.test(`${expression.callee.object.name}.${expression.callee.property.name}`));
}
function syntheticSuperBody(node) {
  const at = { start: node.start, end: node.start };
  return { type: 'BlockStatement', ...at, body: [{ type: 'ExpressionStatement', ...at, expression: { type: 'CallExpression', ...at, callee: { type: 'Super', ...at }, arguments: [{ type: 'SpreadElement', ...at, argument: { type: 'Identifier', name: 'args', ...at } }] } }] };
}
export function describeThrown(error) {
  const value = error instanceof UserThrow ? error.value : error;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return snapshot(value).s;
}

/** Run one project function with argument expressions (strings) and return a trace. */
export function traceFunction(project, fnId, argTexts = [], options = {}) {
  const runtime = new Runtime(project, options);
  const fn = project.functions[fnId];
  const result = { fnId, events: runtime.events, console: runtime.consoleLines, notes: runtime.notes, value: null, error: null, halted: null, approximate: false };
  if (!fn) { result.error = 'Function not found'; return result; }
  try {
    const args = argTexts.map((text, i) => {
      try { return runtime.evaluateInput(text, fn.path); }
      catch (error) { throw new Error(`Argument ${i + 1} (${fn.params[i] || '?'}): ${error instanceof UserThrow ? describeThrown(error) : error.message}`); }
    });
    runtime.events.length = 0; // module setup is not part of the replay
    const target = runtime.resolveFunctionValue(fn);
    runtime.events.length = 0;
    if (target.note) runtime.notes.push(target.note);
    result.approximate = Boolean(target.approximate);
    let value = target.construct
      ? runtime.construct(target.value, args, { callee: { type: 'Identifier', name: fn.className } }, { fnId: 'root', frame: 0, depth: 0, path: fn.path })
      : runtime.callFunction(target.value, target.thisArg, args);
    // Let queued promise jobs and timers finish (simulated event loop).
    runtime.drainMicrotasks();
    let timers = 0;
    while (runtime.timers.length && timers++ < runtime.options.maxTimers) runtime.runNextTimer();
    if (runtime.timers.length) runtime.notes.push(`${runtime.timers.length} timer(s) were still pending and did not run.`);
    if (value instanceof SyncPromise) {
      if (value.state === 'rejected') result.error = `Promise rejected: ${describeThrown(value.value)}`;
      value = value.state === 'fulfilled' ? value.value : value;
    }
    result.value = snapshot(value);
    result.rawValue = value;
  } catch (error) {
    if (error instanceof ExecutionHalt) result.halted = error.message;
    else if (error instanceof UserThrow) result.error = `Uncaught ${describeThrown(error)}`;
    else result.error = error.message || String(error);
  }
  return result;
}
