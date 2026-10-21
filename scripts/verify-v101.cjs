/** Regression tests for concise arrow bodies, including mixed module imports. */
const fs=require('fs'),path=require('path'),assert=require('assert');
const ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const root=path.resolve(__dirname,'../src');
const cache=new Map();
const local=(req,parent)=>{
 if(!req.startsWith('.'))return require(req);
 const stem=path.resolve(path.dirname(parent),req);
 const f=[stem,stem+'.js',stem+'.jsx',stem+'.mjs'].find(x=>fs.existsSync(x));
 if(!f)throw Error(`Cannot find module ${req} in ${parent}`);
 if(cache.has(f))return cache.get(f).exports;
 const m={exports:{}};cache.set(f,m);
 const text=fs.readFileSync(f,'utf8');
 const out=ts.transpileModule(text,{fileName:f.endsWith('.mjs')?f+'.js':f,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText;
 new Function('require','module','exports',out)((r)=>local(r,f),m,m.exports);
 return m.exports;
};
const load=(p)=>local('./'+p,path.join(root,'entry.js'));
const {listJavaScriptFunctions,importJavaScriptFunction,exportImportedJavaScript}=load('scripts/javascript-import.js');
const {simulateImportedProgram}=load('scripts/forensics.js');
const {createSourceWorkspace}=load('scripts/source-workspace.js');
const {isValidGraph}=load('data/node-types.js');
let checks=0;
function check(v,msg){assert.ok(v,msg); checks++}
const src=`// unrelated source untouched\nexport function block(x) { return x + 1; }\nexport const double = x => x * 2;\nexport const add = (x, y) => x + y;\nexport default value => value > 0 ? value : 0;`;
const candidates=listJavaScriptFunctions(src);
check(candidates.length===4,'function picker shows all four supported forms');
check(candidates.map(f=>f.bodyStyle).join(',')==='block,expression,expression,expression','correctly labels expression bodies');
check(candidates.every(f=>f.supportedBody),'picker allows non-brace arrow functions');
for (const [index, expected, inputs] of [[0,3,{x:2}],[1,8,{x:4}],[2,8,{x:3,y:5}],[3,0,{value:-3}]]) {
 const g=importJavaScriptFunction(src,'arrows.js',index);
 check(isValidGraph(g),`valid CFG ${index}`);
 g.program.inputValues=inputs;
 check(simulateImportedProgram(g).environment.$return===expected,`returns correct value ${index}`);
 check(exportImportedJavaScript(g)===src,`source byte-for-byte identical ${index}`);
 check(g.nodes.some(n=>n.type==='source-return'),`explicit implicit-return node ${index}`);
}
const edit=importJavaScriptFunction(src,'arrows.js',1);
const ret=edit.nodes.find(n=>n.type==='source-return');
check(ret.expressionText==='x * 2','arrow return is a safe source expression');
ret.expressionText='x * 3';
const edited=exportImportedJavaScript(edit);
check(edited.includes('export const double = x => x * 3;'),'surgical source edit with no inserted braces');
check(edited.includes('export function block(x) { return x + 1; }'),'other function untouched');
const objectArrow='const makeObject = x => ({ x, ok: true });';
const object=importJavaScriptFunction(objectArrow,'object.js');
check(isValidGraph(object),'unsupported object literal still imports');
check(object.nodes.some(n=>n.type==='source-object') && object.nodes.some(n=>n.type==='source-return'), 'object literal decomposes into visible source nodes');
check(exportImportedJavaScript(object)===objectArrow,'object literal source preserved');
const objectRun=simulateImportedProgram(object);
check(!objectRun.approximate && objectRun.environment.$return?.ok===true && objectRun.environment.$return?.x===0,'safe object return is interpreted from a missing parameter as null');
const mixed={ 'src/main.js':`import {triple} from './helper.js'; export const compute = x => triple(x) + 1;`, 'src/helper.js':`export const triple = x => x * 3;`};
const workspace=createSourceWorkspace(mixed);
const main=importJavaScriptFunction(mixed['src/main.js'],'src/main.js',0,workspace);
check(isValidGraph(main),'concise arrow with imported helper is valid');
main.program.inputValues={x:4};
check(simulateImportedProgram(main).environment.$return===13,'pure expression-bodied helper interpreted safely');
const asyncSrc='const delayed = async x => x + 1;';
const asyncGraph=importJavaScriptFunction(asyncSrc,'async.js');
const asyncResult=simulateImportedProgram(asyncGraph);
check(isValidGraph(asyncGraph),'async concise arrow imports as unsupported graph');
check(asyncResult.approximate && asyncResult.environment.$return===null,'async promises not misrepresented as sync results');
check(exportImportedJavaScript(asyncGraph)===asyncSrc,'async source preserved');
check(listJavaScriptFunctions('export default () => 42;').length===1,'anonymous default arrow discovered');
const dg=importJavaScriptFunction('export default () => 42;');
check(simulateImportedProgram(dg).environment.$return===42,'anonymous default concise arrow interpreted');
let error='';try{listJavaScriptFunctions('const Component = () => <div>Hello</div>;')}catch(e){error=e.message;}
check(error.includes('does not parse JSX'),'unsupported JSX gets specific guidance');
console.log(`PASS: ${checks} concise arrow and source-integrity assertions.`);
