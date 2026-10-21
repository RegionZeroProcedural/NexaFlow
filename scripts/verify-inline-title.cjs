// A dependency-light smoke test for the interaction contract. Real React
// rendering still requires npm install; this verifies click/commit/cancel
// behavior against the actual exported component with simulated hooks.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../src/components/inline-title.jsx'), 'utf8');
const result = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
let hooks = [], cursor = 0;
const fakeReact = {
  createElement(tag, props, ...children) { return { tag, props: { ...(props || {}), children } }; },
  useState(initial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = initial;
    return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
  },
  useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
  useEffect(callback, dependencies) {
    const i = cursor++;
    const previous = hooks[i];
    if (!previous || dependencies.some((d, j) => d !== previous[j])) {
      hooks[i] = dependencies;
      callback();
    }
  },
};
fakeReact.default = fakeReact;
const compiled = new Module('inline-title-test', module);
compiled.filename = __filename;
compiled.paths = module.paths;
compiled.require = name => name === 'react' ? fakeReact : require(name);
compiled._compile(result.outputText, __filename);
const InlineTitle = compiled.exports.default;
function harness(initial) {
  hooks = [];
  let value = initial, commits = [];
  const render = () => { cursor = 0; return InlineTitle({ value, label: 'node title', onCommit: next => { commits.push(next); value = next; }, maxLength: 80 }); };
  return { render, get commits() { return commits; }, get value() { return value; } };
}
const h = harness('Old Name');
let el = h.render();
assert.equal(el.tag, 'button');
assert.ok(el.props['aria-label'].includes('Old Name'));
let stopped = false;
el.props.onPointerDown({ stopPropagation() { stopped = true; } });
assert.ok(stopped, 'title clicks must not start a node drag');
el.props.onClick({ stopPropagation() {} });
el = h.render();
assert.equal(el.tag, 'input');
assert.equal(el.props.value, 'Old Name');
el.props.onChange({ target: { value: '  New Name  ' } });
el = h.render();
el.props.onBlur();
el = h.render();
assert.equal(el.tag, 'button');
assert.equal(h.value, 'New Name');
assert.deepEqual(h.commits, ['New Name']);
// Escape must close and discard rather than writing a second revision.
el.props.onClick({ stopPropagation() {} });
el = h.render();
el.props.onChange({ target: { value: 'Should not persist' } });
el = h.render();
el.props.onKeyDown({ key: 'Escape', stopPropagation(){}, preventDefault(){}, currentTarget: { blur(){ el.props.onBlur(); } } });
el = h.render();
assert.equal(el.tag, 'button');
assert.equal(h.value, 'New Name');
assert.equal(h.commits.length, 1);
// Empty names must keep the existing title.
el.props.onClick({ stopPropagation() {} });
el = h.render();
el.props.onChange({ target: { value: '   ' } });
el = h.render();
el.props.onBlur();
el = h.render();
assert.equal(h.value, 'New Name');
// Enter commits the new title.
el.props.onClick({ stopPropagation() {} });
el = h.render();
el.props.onChange({ target: { value: 'Saved By Enter' } });
el = h.render();
el.props.onKeyDown({ key: 'Enter', stopPropagation(){}, preventDefault(){}, currentTarget: { blur(){ el.props.onBlur(); } } });
el = h.render();
assert.equal(h.value, 'Saved By Enter');
assert.equal(h.commits.length, 2);
// Graph title uses the same component, and both canvas surfaces are hooked up.
const node = fs.readFileSync(path.resolve(__dirname, '../src/components/canvasComponents/node.jsx'),'utf8');
const canvas = fs.readFileSync(path.resolve(__dirname, '../src/components/canvasComponents/canvas-label.jsx'),'utf8');
const editor = fs.readFileSync(path.resolve(__dirname, '../src/pages/editor.jsx'),'utf8');
assert.ok(node.includes('onRename(node.id, title)'));
assert.ok(canvas.includes('onCommit={onRename}'));
assert.ok(editor.includes('onRename={(id, title) => updateNode(id, { title })}'));
console.log('Inline title: click, drag protection, blur save, Escape cancel, empty-name prevention, Enter save, node/canvas wiring all passed.');
