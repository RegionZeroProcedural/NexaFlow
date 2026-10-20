// Dependency-light, offline regression checks: use globally installed TypeScript
// to transpile this app's ES module sources without executing React or user code.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const cp = require('child_process');
const ts = (() => { try { return require('typescript'); } catch (_) { return require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); } })();
const root = path.join(__dirname, '..');
const testOut = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-flow-verify-'));
let parseCount = 0, testCount = 0;
function check(result, message) { assert.ok(result, message); testCount++; }
function filesAt(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesAt(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
for (const p of filesAt(path.join(root, 'src')).filter(p => /\.(jsx?|mjs)$/.test(p))) {
  const contents = fs.readFileSync(p, 'utf8');
  const file = ts.createSourceFile(p, contents, ts.ScriptTarget.ES2022, true, p.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw Error(`${p}: ${file.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  parseCount++;
}
const moduleCache = new Map();
function localRequire(request, origin) {
  if (!request.startsWith('.')) return require(request);
  const entry = path.resolve(path.dirname(origin), request);
  const file = [entry, `${entry}.js`, `${entry}.jsx`, `${entry}.mjs`].find(candidate => fs.existsSync(candidate));
  if (!file) throw Error(`Missing module ${request} from ${origin}`);
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const module = { exports: {} }; moduleCache.set(file, module);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file.endsWith('.mjs') ? file + '.js' : file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText;
  (new Function('require', 'module', 'exports', compiled))((r) => localRequire(r, file), module, module.exports);
  return module.exports;
}
const load = p => localRequire(`./${p}`, path.join(root, 'src', '__base.js'));
const defs = load('data/node-types.js');
const { simulateControlFlow } = load('scripts/simulate-control-flow.js');
const { prepareWaterfallRun } = load('scripts/waterfall.js');
const { generateCode } = load('scripts/generate-code.js');
const { findNearbyPort } = load('scripts/connection-utils.js');
const { operatorsExampleGraph } = load('data/operators-example.js');
const { variablesExampleGraph } = load('data/variables-example.js');
const { exampleGraph } = load('data/example.js');
check(defs.isValidGraph(operatorsExampleGraph), 'EXEC/DONE demo is structurally valid');
check(defs.isValidGraph(variablesExampleGraph), 'legacy v0.5 demo is still valid');
check(simulateControlFlow(exampleGraph).issues.length === 0, 'original example still works');
const run = simulateControlFlow(operatorsExampleGraph);
check(run.portValues['op-multiply:out'] === 70, 'operator multiplies variables');
check(run.portValues['op-function:out1'] === 77, 'function receives operator output');
check(run.portValues['op-function:done'] === true, 'DONE becomes true on success');
check(run.conditions['op-conditional'] === true, 'decision sees DONE true');
check(run.trace.some(step => step.nodeId === 'op-success'), 'success branch executes');
check(run.functionCompletions.length === 1, 'function completed once');
check(run.issues.length === 0, `no unintended simulator warnings: ${run.issues}`);
const waterfall = prepareWaterfallRun(operatorsExampleGraph, run);
check(waterfall.trace.some(step => step.type === 'function-completion'), 'completion timeline step present');
check(waterfall.waterfallSamples.some(s => s.value === true && s.watchName === 'Waterfall: DONE'), 'DONE watch captures true');
check(waterfall.waterfallSamples.some(s => s.value === 77), 'value Watch captures 77');
const completedAt = waterfall.trace.findIndex(step => step.type === 'function-completion');
const doneAt = waterfall.trace.findIndex(step => step.type === 'watch-sample' && step.title === 'Waterfall: DONE');
check(completedAt >= 0 && completedAt < doneAt, 'Function completion appears before DONE watch');

// Internal function state is observable at EACH assignment, not just on return.
const multi = JSON.parse(JSON.stringify(operatorsExampleGraph));
multi.nodes.find(n => n.id === 'op-function').code = [
  'total = in1',
  'total = total + 5',
  'out1 = total',
  'out1 = out1 + 2',
  'out2 = out1 >= 75',
].join('\n');
const multiWatch = multi.nodes.find(n => n.id === 'op-total-watch');
multiWatch.traceVariable = 'all';
const multiResult = simulateControlFlow(multi);
check(multiResult.portValues['op-function:out1'] === 77, 'reassignment changes final output');
check(multiResult.functionChanges.length === 5, 'every internal assignment is recorded');
check(multiResult.functionChanges[1].previousValue === 70 && multiResult.functionChanges[1].value === 75, 'local variable retains historical old value');
check(multiResult.functionChanges[1].variables.total === 75 && multiResult.functionChanges[0].variables.total === 70, 'snapshots are immutable');
const multiTimeline = prepareWaterfallRun(multi, multiResult);
const observedAll = multiTimeline.waterfallSamples.filter(sample => sample.watchId === 'op-total-watch');
check(observedAll.length === 5, 'connected Watch records every Function assignment');
check(observedAll.map(sample => sample.value).join(',') === '70,75,75,77,true', 'Watch records locals, outputs and boolean changes in assignment order');
check(observedAll[1].previousValue === 70 && observedAll[1].sourceLine === 2, 'Watch shows previous/current value with code line');
check(multiTimeline.trace[observedAll[0].step - 2]?.type === 'function-assignment', 'Watch observation follows its corresponding assignment');
check(multiTimeline.trace.findIndex(step => step.type === 'function-completion') > observedAll[observedAll.length - 1].step - 1, 'DONE only AFTER all watched assignment steps');
const outMode = JSON.parse(JSON.stringify(multi));
outMode.nodes.find(n => n.id === 'op-total-watch').traceVariable = 'port';
const outObserved = prepareWaterfallRun(outMode, simulateControlFlow(outMode)).waterfallSamples.filter(s => s.watchId === 'op-total-watch');
check(outObserved.length === 2 && outObserved.map(s => s.value).join(',') === '75,77', 'port-only Watch sees successive out1 writes');
const namedMode = JSON.parse(JSON.stringify(multi));
namedMode.nodes.find(n => n.id === 'op-total-watch').traceVariable = 'named';
namedMode.nodes.find(n => n.id === 'op-total-watch').traceVariableName = 'total';
check(defs.isValidGraph(namedMode), 'named-local watch selector survives project validation');
const namedObserved = prepareWaterfallRun(namedMode, simulateControlFlow(namedMode)).waterfallSamples.filter(s => s.watchId === 'op-total-watch');
check(namedObserved.length === 2 && namedObserved.map(s => s.value).join(',') === '70,75', 'named-local Watch monitors successive writes');
const rebound = JSON.parse(JSON.stringify(operatorsExampleGraph));
rebound.nodes.find(node => node.id === 'op-function').code = 'in1 = in1 + 3\nout1 = in1\nout2 = true';
const reboundRun = simulateControlFlow(rebound);
check(reboundRun.portValues['op-function:out1'] === 73, 'Function can rebind an input locally');
check(reboundRun.portValues['op-multiply:out'] === 70, 'Function cannot mutate its upstream source');
const reboundSamples = prepareWaterfallRun(rebound, reboundRun).waterfallSamples.filter(s => s.watchId === 'op-total-watch');
check(reboundSamples[0].variable.includes('in1') && reboundSamples[0].value === 73, 'Watch sees a local parameter change');
check(multiResult.functionChanges[1].dependencyEvents.includes(multiResult.functionChanges[0].id), 'function provenance links previous local value');


const prevented = JSON.parse(JSON.stringify(operatorsExampleGraph));
prevented.nodes.find(node => node.id === 'op-trigger').value = false;
const failed = simulateControlFlow(prevented);
check(failed.portValues['op-function:done'] === false, 'DONE false when EXEC false');
check(failed.portValues['op-function:out1'] == null, 'data outputs unknown when not triggered');
check(failed.trace.some(step => step.nodeId === 'op-failure'), 'blocked execution takes false branch');
check(!failed.functionCompletions.length, 'disabled function does not produce execution event');
const errGraph = JSON.parse(JSON.stringify(operatorsExampleGraph));
errGraph.nodes.find(node => node.id === 'op-function').code = 'out1 = fetch("https://example.com")';
const broken = simulateControlFlow(errGraph);
check(broken.portValues['op-function:done'] === false, 'DONE false after parser error');
check(broken.issues.some(i => i.includes('unsupported') || i.includes('Unknown') || i.includes('Unsupported')), 'unsafe code rejected');
for (const type of defs.DATA_OPERATORS) {
  const inputs = { add: [5, 3, 8], subtract: [5, 3, 2], multiply: [5, 3, 15], divide: [6, 3, 2], modulo: [5, 3, 2], power: [2, 3, 8], negate: [5, null, -5], concat: ['Ne', 'xa', 'Nexa'] }[type];
  const operator = { ...defs.createNode(type), id: 'op' };
  const a = { ...defs.createNode('variable'), id: 'a', dataType: typeof inputs[0], dataValue: inputs[0] };
  const b = { ...defs.createNode('variable'), id: 'b', dataType: typeof inputs[1], dataValue: inputs[1] };
  const edges = [{ id: 'x', source: 'a', sourcePort: 'out', target: 'op', targetPort: 'a' }];
  if (type !== 'negate') edges.push({ id: 'y', source: 'b', sourcePort: 'out', target: 'op', targetPort: 'b' });
  const graph = { nodes: type === 'negate' ? [a, operator] : [a, b, operator], edges };
  check(defs.isValidGraph(graph), `${type} accepts wired value data`);
  check(simulateControlFlow(graph).portValues['op:out'] === inputs[2], `${type} produces correct value`);
}
const port = defs.getNodePorts(operatorsExampleGraph.nodes.find(n => n.id === 'op-function'));
check(port.inputs.some(p => p.id === 'execute' && p.kind === 'boolean'), 'EXEC separate Boolean port');
check(port.outputs.some(p => p.id === 'done' && p.kind === 'boolean'), 'DONE separate Boolean port');
check(defs.getFunctionDataInputs(operatorsExampleGraph.nodes.find(n => n.id === 'op-function')).length === 2, 'input parser excludes EXEC');
const fnNode = operatorsExampleGraph.nodes.find(n => n.id === 'op-function');
const fnExec = defs.portPosition(fnNode, 'execute', 'in');
const nearby = findNearbyPort(operatorsExampleGraph.nodes, fnExec.x + 6, fnExec.y - 4, { left: 0, top: 0 }, {x:0,y:0}, 1, 'out');
check(nearby && nearby.portId === 'execute', 'loose pointer hit-testing finds the EXEC port');
for (const language of ['javascript', 'typescript', 'python']) {
  const code = generateCode(operatorsExampleGraph, language);
  check(code.includes('invoke_function') && code.includes('done') && code.includes('data_operator'), `export ${language} preserves trigger, done and operators`);
  const ext = { javascript: 'js', typescript: 'ts', python: 'py' }[language];
  const dest = path.join(testOut, `NexaFlow-v0.6-export-check.${ext}`);
  fs.writeFileSync(dest, code);
  if (ext === 'py') {
    const proc = cp.spawnSync('python', [dest], { encoding: 'utf8' });
    check(proc.status === 0, `generated Python executes: ${proc.stderr}`);
  } else if (ext === 'js') {
    const proc = cp.spawnSync('node', [dest], { encoding: 'utf8' });
    check(proc.status === 0, `generated JavaScript executes: ${proc.stderr}`);
  } else {
    const compiled = ts.transpileModule(code, { fileName: dest, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    check(!compiled.diagnostics?.length, 'TypeScript export transpiles');
    const tsPath = path.join(testOut, 'NexaFlow-v0.6-export-check.ts.js');
    fs.writeFileSync(tsPath, compiled.outputText);
    const proc = cp.spawnSync('node', [tsPath], { encoding: 'utf8' });
    check(proc.status === 0, `generated TypeScript compiled output runs: ${proc.stderr}`);
  }
}

// v0.7 NEXT ↔ EXEC / DONE control sequencing and generated-code verification.
const { flowFunctionExample } = load('data/flow-function-example.js');
check(defs.isValidGraph(flowFunctionExample), 'NEXT/EXEC/DONE example passes import-time validation');
const getPort = (id, portId, dir) => defs.getNodePorts(flowFunctionExample.nodes.find(n => n.id === id))[dir].find(p => p.id === portId);
check(defs.canConnectPorts(getPort('seq-start', 'out', 'outputs'), getPort('seq-a', 'execute', 'inputs')), 'NEXT accepts EXEC');
check(defs.canConnectPorts(getPort('seq-a', 'done', 'outputs'), getPort('seq-middle', 'in', 'inputs')), 'DONE accepts Flow input');
check(defs.canConnectPorts(getPort('seq-middle', 'out', 'outputs'), getPort('seq-b', 'execute', 'inputs')), 'Process NEXT accepts EXEC');
check(defs.canConnectPorts(getPort('seq-b', 'done', 'outputs'), getPort('seq-end', 'in', 'inputs')), 'DONE accepts End Flow input');
check(!defs.canConnectPorts(defs.getNodePorts({ type: 'boolean' }).outputs[0], getPort('seq-end', 'in', 'inputs')), 'regular Boolean cannot masquerade as a control-flow Next');
check(defs.isControlEdge(flowFunctionExample, flowFunctionExample.edges.find(e => e.id === 'seq-e1')), 'NEXT to EXEC is control, not a data dependency');
check(!defs.isControlEdge(flowFunctionExample, flowFunctionExample.edges.find(e => e.id === 'seq-e9')), 'DONE to Watch remains Boolean data');
const sequential = simulateControlFlow(flowFunctionExample);
check(sequential.issues.length === 0, `sequential demo should not warn: ${sequential.issues.join('; ')}`);
check(sequential.trace.map(s => s.nodeId).join(',') === 'seq-start,seq-a,seq-middle,seq-b,seq-end', 'both Functions become control-flow steps between NEXT nodes');
check(sequential.portValues['seq-a:done'] === true && sequential.portValues['seq-b:done'] === true, 'each Function completes after a control token');
check(sequential.portValues['seq-a:out1'] === 45 && sequential.portValues['seq-b:out1'] === 90, 'Functions pass transformed data across a Watch');
check(sequential.functionCompletions.length === 2, 'each Function invokes just once');
const water = prepareWaterfallRun(flowFunctionExample, sequential);
check(water.waterfallSamples.some(x => x.watchId === 'seq-b-watch' && x.value === true), 'waterfall observes DONE of flow-triggered Function');
check(water.waterfallSamples.some(x => x.watchId === 'seq-a-watch' && x.value === 45), 'waterfall observes flow-triggered Function local variable');
check(water.trace.findIndex(x => x.nodeId === 'seq-a' && x.type === 'function') < water.trace.findIndex(x => x.nodeId === 'seq-a' && x.type === 'function-assignment'), 'waterfall assignments display after flow-function execution step');
check(water.trace.findIndex(x => x.nodeId === 'seq-b' && x.type === 'function') < water.trace.findIndex(x => x.type === 'watch-sample' && x.title === 'Watch DONE'), 'DONE watch displays after second function control step');
const badSeq = JSON.parse(JSON.stringify(flowFunctionExample));
badSeq.nodes.find(n => n.id === 'seq-a').code = 'out1 = fetch("https://invalid.example")';
const stopped = simulateControlFlow(badSeq);
check(stopped.portValues['seq-a:done'] === false, 'unsupported function cannot mark DONE true');
check(stopped.trace.map(s => s.nodeId).join(',') === 'seq-start,seq-a', 'failed Function stops NEXT chain, no false success');
check(stopped.functionCompletions.length === 0, 'failed Function is never marked complete');

const directChain = JSON.parse(JSON.stringify(flowFunctionExample));
directChain.edges = directChain.edges.filter(e => !['seq-e2', 'seq-e3'].includes(e.id));
directChain.edges.push({id:'seq-direct', source:'seq-a', sourcePort:'done', target:'seq-b', targetPort:'execute'});
check(defs.isValidGraph(directChain), 'Function DONE -> next Function EXEC is valid');
check(defs.isControlEdge(directChain, directChain.edges.find(e=>e.id === 'seq-direct')), 'Function DONE -> EXEC advances control');
const directResult = simulateControlFlow(directChain);
check(directResult.trace.map(x => x.nodeId).join(',') === 'seq-start,seq-a,seq-b,seq-end', 'direct Function -> Function chain executes in order');
check(directResult.portValues['seq-b:out1'] === 90, 'direct function chain preserves data payload');
const directJs = generateCode(directChain, 'javascript');
const directExecution = cp.spawnSync('node', ['-e', `${directJs}\nconsole.log(JSON.stringify(functionCache.get('seq-b')));`], {encoding: 'utf8'});
check(directExecution.status === 0 && directExecution.stdout.includes('"out1":90'), 'generated JS runs direct Function -> Function chain');

const blocked = JSON.parse(JSON.stringify(flowFunctionExample));
const startEdge = blocked.edges.find(e => e.id === 'seq-e1');
blocked.nodes.push({id:'seq-gate', type:'conditional',x:55,y:1300,title:'Condition',inputCount:1,conditionMode:'and',description:''}, {id:'seq-false',type:'end',x:400,y:1300,title:'Skipped',description:''}, {id:'seq-false-signal',type:'boolean',x:30,y:1540,title:'False condition',value:false,description:''});
startEdge.target = 'seq-gate'; startEdge.targetPort = 'in';
blocked.edges.push({id:'seq-y',source:'seq-gate',sourcePort:'true',target:'seq-a',targetPort:'execute'}, {id:'seq-n',source:'seq-gate',sourcePort:'false',target:'seq-false',targetPort:'in'}, {id:'seq-c',source:'seq-false-signal',sourcePort:'out',target:'seq-gate',targetPort:'condition'});
check(defs.isValidGraph(blocked), 'conditional NEXT trigger remains structurally valid');
const unselected = simulateControlFlow(blocked);
check(unselected.trace.map(s => s.nodeId).join(',') === 'seq-start,seq-gate,seq-false', 'unselected NEXT never triggers the Function');
check(unselected.portValues['seq-a:done'] === false && !unselected.functionCompletions.length, 'inactive branch leaves Function DONE FALSE');
for (const language of ['javascript', 'typescript', 'python']) {
  const code = generateCode(flowFunctionExample, language);
  check(code.includes('control_active') || code.includes('controlActive'), `${language} export includes NEXT token handling`);
  const file = path.join(testOut, `NexaFlow-v0.7-sequencing.${language === 'python' ? 'py' : language === 'typescript' ? 'ts' : 'js'}`);
  fs.writeFileSync(file, code);
  if (language === 'javascript') {
    const proc = cp.spawnSync('node', ['-e', `${code}\nconsole.log(JSON.stringify([functionCache.get('seq-a'), functionCache.get('seq-b')]));`], {encoding:'utf8'});
    check(proc.status === 0, `generated JS NEXT sequencing executes: ${proc.stderr}`);
    check(proc.stdout.includes('"out1":90'), `generated JS actually executed chained Function: ${proc.stdout}`);
  } else if (language === 'python') {
    const proc = cp.spawnSync('python', ['-c', `${code}\nprint(_function_cache)`], {encoding:'utf8'});
    check(proc.status === 0, `generated Python NEXT sequencing executes: ${proc.stderr}`);
    check(proc.stdout.includes("'out1': 90"), `generated Python actually executed chained Function: ${proc.stdout}`);
  } else {
    const compiled = ts.transpileModule(code, {fileName: file, compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}, reportDiagnostics: true});
    check(!compiled.diagnostics?.length, 'generated TS syntax compiles');
    const proc = cp.spawnSync('node', ['-e', compiled.outputText+'\nconsole.log(JSON.stringify(functionCache.get("seq-b")));'], {encoding: 'utf8'});
    check(proc.status === 0 && proc.stdout.includes('"out1":90'), `generated TS actually executes chained Function: ${proc.stderr} ${proc.stdout}`);
  }
}


// v0.8 bidirectional wiring, true pointer-up drop, zoom-stable hit areas,
// and node body/port separation across variable port-count configurations.
const { orderPortPair } = load('scripts/connection-utils.js');
const reverse = orderPortPair({nodeId:'function',portId:'in1',direction:'in'}, {nodeId:'number',portId:'out',direction:'out'});
check(reverse && reverse.source === 'number' && reverse.target === 'function' && reverse.targetPort === 'in1', 'starting at input produces normalized output->input connection');
const forward = orderPortPair({nodeId:'number',portId:'out',direction:'out'}, {nodeId:'function',portId:'in1',direction:'in'});
check(JSON.stringify(forward) === JSON.stringify(reverse), 'wiring is independent of which port the user clicks first');
check(orderPortPair({nodeId:'x',portId:'a',direction:'in'}, {nodeId:'y',portId:'b',direction:'in'}) === null, 'same-direction ports rejected');
check(orderPortPair({nodeId:'x',portId:'a',direction:'out'}, {nodeId:'x',portId:'b',direction:'in'}) === null, 'self-wiring rejected');
const numNode = {...defs.createNode('variable',20,20), id:'test-number', dataValue:15};
const functionNode = {...defs.createNode('function',390,90), id:'test-func'};
const numberPos = defs.portPosition(numNode, 'out','out');
const functionPos = defs.portPosition(functionNode, 'in1','in');
const originOut = {nodeId:numNode.id, portId:'out', direction:'out'};
const originIn = {nodeId:functionNode.id, portId:'in1', direction:'in'};
const nearInput = findNearbyPort([numNode,functionNode], functionPos.x + 3, functionPos.y - 2, {left:0,top:0}, {x:0,y:0}, 1, 'out', 35, originOut);
check(nearInput && nearInput.nodeId === functionNode.id && nearInput.portId === 'in1' && nearInput.compatible, 'output-side drag auto-resolves the correct input');
const nearOutput = findNearbyPort([numNode,functionNode], numberPos.x - 4, numberPos.y + 3, {left:0,top:0}, {x:0,y:0}, 1, 'in', 35, originIn);
check(nearOutput && nearOutput.nodeId === numNode.id && nearOutput.portId === 'out' && nearOutput.compatible, 'input-side drag auto-resolves the correct output');
const zoom = .45, pan = {x:39,y:97}, rect={left:120,top:50};
const zoomHit = findNearbyPort([numNode,functionNode], rect.left+functionPos.x*zoom+pan.x+15, rect.top+functionPos.y*zoom+pan.y, rect,pan,zoom,'out',35,originOut);
check(zoomHit && zoomHit.portId === 'in1', 'hit target radius remains usable when zoomed out');
const boolNode = {...defs.createNode('boolean', 300, 0), id:'test-bool'};
const functionNodeStrict = {...functionNode, portTypes:{in1:'number'}};
const boolPos = defs.portPosition(boolNode, 'out','out');
const mismatch = findNearbyPort([boolNode,functionNodeStrict], boolPos.x, boolPos.y, {left:0,top:0}, {x:0,y:0}, 1, 'in',35,originIn);
check(mismatch && mismatch.compatible === false, 'incompatible port is detectable for feedback');
for (const type of ['start','process','conditional','end','boolean','and','or','not','output','watch','variable','compare','add','source-operation']) {
  const n = type === 'source-operation' ? {id:'o',type,x:0,y:0,title:'source'} : defs.createNode(type);
  const ports = defs.getNodePorts(n);
  check([...ports.inputs,...ports.outputs].every(p=>p.top >= 158), `${type} sockets below content rail`);
  check(defs.getNodeHeight(n) >= Math.max(0,...ports.inputs.map(p=>p.top),...ports.outputs.map(p=>p.top))+29,`${type} has footer space after its bottom socket`);
}
for (const count of [0,1,2,8,16]) {
  const f = {...defs.createNode('function'), inputCount:count,outputCount:count};
  const ports=defs.getNodePorts(f);
  check([...ports.inputs,...ports.outputs].every(p=>p.top>=190),`function(${count}) sockets start after body`);
  check(defs.getNodeHeight(f) > Math.max(...ports.inputs.map(p=>p.top),...ports.outputs.map(p=>p.top)),`function(${count}) fits last port`);
}
console.log(`PASS: ${parseCount} parsed source files; ${testCount} offline runtime/export/port-layout assertions.`);

