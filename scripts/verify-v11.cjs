const fs = require('fs'), path = require('path'), assert = require('assert');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const root = path.resolve(__dirname, '../src'), cache = new Map();
function load(r, origin=path.join(root,'entry.js')) {
 if (!r.startsWith('.')) return require(r);
 const stem=path.resolve(path.dirname(origin),r);
 const f=[stem,stem+'.js',stem+'.jsx',stem+'.mjs'].find(x=>fs.existsSync(x));
 if(!f)throw Error(`Cannot find ${r}`);
 if(cache.has(f))return cache.get(f).exports;
 const m={exports:{}};cache.set(f,m);
 const source=fs.readFileSync(f,'utf8');
 const js=ts.transpileModule(source,{fileName:f.endsWith('.mjs')?f+'.js':f,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 new Function('require','module','exports',js)(r=>load(r,f),m,m.exports);
 return m.exports;
}
const {importJavaScriptFunction,exportImportedJavaScript,listJavaScriptFunctions}=load('./scripts/javascript-import.js');
const {simulateImportedProgram}=load('./scripts/forensics.js');
const {isValidGraph,NODE_TYPES,getNodeHeight}=load('./data/node-types.js');
const {layoutSourceData}=load('./scripts/flow-layout.js');
const {readableFunctionOutline}=load('./scripts/readable-outline.js');
const {parseTestValue,isSafeTestValue}=load('./scripts/test-values.js');
const src=fs.readFileSync(path.join(__dirname,'../examples/byteframe-address-mapping.js'),'utf8');
let n=0;
function check(ok,name){assert.ok(ok,name);++n;}
const names=listJavaScriptFunctions(src).map(f=>f.name);
check(names.join(',')==='safe,toHex,addressAtFileOffset,resolveRelativeTarget','function picker finds four functions');
const graphs=names.slice(2).map((_,index)=>importJavaScriptFunction(src,'byteframe-address-mapping.js',index+2));
for(const g of graphs){
 check(isValidGraph(g),'graph validates');
 check(g.nodes.every(node=>NODE_TYPES[node.type]),'every generated node has presentation');
 check(g.nodes.every(node=>Number.isFinite(node.x)&&Number.isFinite(node.y)),'all nodes positioned');
 check(exportImportedJavaScript(g)===src,'source preserved when unchanged');
 check(g.nodes.filter(node=>node.type==='source-opaque').length===0, 'ByteFrame fragment generates no generic error nodes');
 check(g.nodes.some(x=>x.type==='source-method'),'methods decomposed');
 check(g.nodes.some(x=>x.type==='source-property-read'),'property lookups decomposed');
 check(g.nodes.some(x=>x.type==='source-object'),'object literals decomposed');
 check(g.nodes.filter(x=>x.inspectOnly).length>3,'subexpression microsteps added');
 check(g.nodes.some(x=>x.x>400),'horizontal layout extends across multiple columns');
 let collisions=0;
 const filtered=g.nodes.filter(x=>!['source-value','source-operator','source-member','source-ternary','source-call-expr'].includes(x.type));
 for(let i=0;i<filtered.length;i++)for(let j=i+1;j<filtered.length;j++){
  const a=filtered[i],b=filtered[j],A=NODE_TYPES[a.type],B=NODE_TYPES[b.type];
  if(a.x < b.x+B.width && a.x+A.width>b.x && a.y<b.y+getNodeHeight(b) && a.y+getNodeHeight(a)>b.y){ collisions++; console.log('COLLISION',a.id,a.type,a.x,a.y,'WITH',b.id,b.type,b.x,b.y); }
 }
 check(collisions===0,`no control node overlaps (${collisions})`);
 for(const edge of g.edges){
  const a=g.nodes.find(n=>n.id===edge.source),b=g.nodes.find(n=>n.id===edge.target);
  check(b.x > a.x,`control edge ${edge.id} progresses left to right`);
 }

 const dataNodes=layoutSourceData(g.nodes,g.program.dataEdges);
 check(dataNodes.length>0, 'separate data view contains source references and atoms');
 let atomsOverlap=0;
 for(let i=0;i<dataNodes.length;i++)for(let j=i+1;j<dataNodes.length;j++){
  const a=dataNodes[i],b=dataNodes[j],A=NODE_TYPES[a.type],B=NODE_TYPES[b.type];
  if(a.x<b.x+B.width && a.x+A.width>b.x && a.y<b.y+getNodeHeight(b) && a.y+getNodeHeight(a)>b.y)atomsOverlap++;
 }
 check(atomsOverlap===0, `separate data view has no node overlaps (${atomsOverlap})`);
 check(dataNodes.every(node=>node.x>=100 && node.y>=150), 'readable data view stays within visible bounds');
 const originalPositions=new Map(g.nodes.map(node=>[node.id, `${node.x}:${node.y}`]));
 check(dataNodes.some(node=>originalPositions.get(node.id)!==`${node.x}:${node.y}`), 'data layout uses independent coordinates without altering the saved control graph');
 const outline=readableFunctionOutline(g.program);
 check(outline.includes(`function ${g.program.functionName}(`) && outline.includes('if ('), 'readable AST outline includes meaningful scopes');
 check(outline.includes('return {') || g.program.functionName==='resolveRelativeTarget', 'structured readable output for object returns');

}
function run(g,values){const copy={...g,program:{...g.program,inputValues:values}};return simulateImportedProgram(copy);}
const pe={format:'PE32+',imageBase:4194304,sections:[{name:'.text',start:512,size:512,rva:4096},{name:'.rdata',start:1024,size:500,rva:8192}]};
const elf={format:'ELF64',sections:[{name:'.text',start:100,size:90,virtualAddress:4096}]};
const peRes=run(graphs[0],{structure:pe,fileOffset:530});

check(peRes.skippedOperations===0,'PE result fully interpreted');
check(peRes.environment.$return?.kind==='PE','PE result has kind');
check(peRes.environment.$return?.rva===4114,'PE RVA exact');
check(peRes.environment.$return?.virtualAddress===4198418,'PE VA exact');
const elfRes=run(graphs[0],{structure:elf,fileOffset:120});

check(elfRes.skippedOperations===0,'ELF result interpreted');
check(elfRes.environment.$return?.virtualAddress===4116,'ELF VA exact');
const unmapped=run(graphs[0],{structure:pe,fileOffset:5});
check(unmapped.environment.$return===null,'unmapped yields null');
const rel=run(graphs[1],{structure:pe,startFileOffset:530,instruction:{size:5,displacement:10}});

check(rel.skippedOperations===0,'relative PE resolved without skipped nodes');
check(rel.environment.$return?.rva===4129,'correct relative target rva');
check(rel.environment.$return?.fileOffsetTarget===545,'correct target file offset');
check(graphs.every(g=>g.nodes.every(node=>node.type!=='source-opaque')), 'ByteFrame snippet uses no opaque error nodes');
const changed=importJavaScriptFunction(src,'byteframe-address-mapping.js',2);
const objectReturn=changed.nodes.find(node=>node.type==='source-return' && node.expressionText?.includes("kind:'PE'"));
check(Boolean(objectReturn), 'structured PE return is recognized as editable expression');
objectReturn.expressionText=objectReturn.expressionText.replace('section:item.name','section:item.name || "anonymous"');
const patched=exportImportedJavaScript(changed);
check(patched.includes('section:item.name || "anonymous"'),'structured expression edit exports correctly');
check(patched.includes('const toHex = value => `0x${value.toString(16).toUpperCase()}`;'),'unrelated helper remains untouched');
check(!src.includes('"anonymous"'), 'original imported source remains unchanged');

const structuredInput = parseTestValue(JSON.stringify(pe));
check(isSafeTestValue(structuredInput),'nested PE JSON input validates');
check(isValidGraph({...graphs[0],program:{...graphs[0].program,inputValues:{structure:structuredInput,fileOffset:530}}}),'structured source input can save in graph project');
let rejected=false;try{parseTestValue('{"__proto__":{"polluted":true}}')}catch(e){rejected=true};
check(rejected,'prototype pollution key rejected');
check(parseTestValue('[1,2,3]').length===3,'safe arrays are supported');
console.log(`PASS ${n} source layout, zero overlaps, PE/ELF/relative simulation, safe fixtures, source export assertions`);
