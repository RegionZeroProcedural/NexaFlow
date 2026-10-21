/** Offline, dependency-light verification for source import v0.9. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const root = path.join(__dirname, '..', 'src');
const cache = new Map();
function localRequire(req, origin) {
  if (!req.startsWith('.')) return require(req);
  const stem = path.resolve(path.dirname(origin), req);
  const file = [stem, stem + '.js', stem + '.jsx', stem + '.mjs'].find(fs.existsSync);
  if (!file) throw Error('Module missing: ' + req);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file.endsWith('.mjs') ? file + '.js' : file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText;
  (new Function('require', 'module', 'exports', output))((r) => localRequire(r, file), mod, mod.exports);
  return mod.exports;
}
const imports = localRequire('./scripts/javascript-import.js', path.join(root, 'entry.js'));
const runtime = localRequire('./scripts/forensics.js', path.join(root, 'entry.js'));
const { isValidGraph } = localRequire('./data/node-types.js', path.join(root, 'entry.js'));
let tests = 0;
const check = (v, label) => { assert.ok(v, label); tests++; };
const sample = fs.readFileSync(path.join(root,'..','examples','import-multiple-functions.js'), 'utf8');
const options = imports.listJavaScriptFunctions(sample);
check(options.length === 3, 'finds all top-level functions');
check(options.map(o => o.name).join(',') === 'calculateShipping,calculateCheckout,isolatedUncertainty', 'preserves source function order');
for (const [index, name] of ['calculateShipping','calculateCheckout','isolatedUncertainty'].entries()) {
  const graph = imports.importJavaScriptFunction(sample,'multi.js',index);
  check(isValidGraph(graph), `${name}: validates`);
  check(graph.program.functionName === name, `${name}: picked correct function`);
  check(imports.exportImportedJavaScript(graph) === sample, `${name}: exact unedited source`);
  check(graph.nodes.some(n => n.type === 'source-value'), `${name}: has primitive leaves`);
  check(graph.nodes.some(n => n.type === 'source-operator'), `${name}: has operator nodes`);
  check(graph.program.dataEdges.some(e => e.variable === 'input'), `${name}: primitive graph links`);
}
const shipping = imports.importJavaScriptFunction(sample,'multi.js',0);
shipping.program.inputValues = {weight:10,distance:100};
const shipResult = runtime.simulateImportedProgram(shipping);
check(shipResult.environment.$return === 45, 'pure shipping computes correctly');
check(shipResult.skippedOperations === 0, 'no unsafe operation to skip');
check(shipResult.issues.length === 0, 'no false warnings on safe source');
const checkout = imports.importJavaScriptFunction(sample,'multi.js',1);
checkout.program.inputValues = {price:20,quantity:2,discount:10};
const checkoutResult = runtime.simulateImportedProgram(checkout);
check(checkoutResult.skippedOperations === 1 && checkoutResult.approximate, 'unsupported call is skipped, flagged');
check(checkoutResult.environment.$return === null, 'possible side effects cause unknown result');
check(checkoutResult.trace.some(e => e.type === 'source-return'), 'continues after unsupported call');
const unknown = imports.importJavaScriptFunction(sample,'multi.js',2);
const unknownResult = runtime.simulateImportedProgram(unknown);
check(unknownResult.environment.independent === 20, 'independent safe statement continues');
check(unknownResult.environment.$return === null, 'unknown tainted result never fabricated');
const unsupportedIf = imports.importJavaScriptFunction('function test(x) { let y = 4; if (x.check()) {y = 5;} else {y = 8;} let z = 21; return z; }');
const ifResult = runtime.simulateImportedProgram(unsupportedIf);
check(ifResult.skippedOperations === 1 && ifResult.approximate, 'unknown condition flagged');
check(ifResult.environment.y === null && ifResult.environment.z === 21, 'unknown branches skipped but independent next step works');
const terminal = imports.importJavaScriptFunction('function terminal(x) {return unsafe(x); let nope = 42;}');
const termResult = runtime.simulateImportedProgram(terminal);
check(termResult.environment.$return === null, 'unsupported return is unknown');
check(!termResult.events.some(e => e.name === 'nope'), 'does not execute unreachable source');
const edited = imports.importJavaScriptFunction(sample, 'multi.js',0);
const node = edited.nodes.find(n => n.variableName === 'base');
node.expressionText = 'weight * 3';
const generated = imports.exportImportedJavaScript(edited);
check(generated.includes('const base = weight * 3;'), 'editable source expression patches correctly');
check(generated.includes('notifyAccounting(discounted);'), 'unrelated unsupported source byte preserved');
check(!sample.includes('weight * 3'), 'original source unchanged');
console.log(`PASS: ${tests} source-picker / primitive-graph / safe-skip / source-roundtrip assertions.`);
