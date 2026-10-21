import React from 'react';
import { CODE_LANGUAGES, DATA_TYPES, getNodePorts, getFunctionDataInputs, isFunctionNode, LOGIC_GATES, MAX_PORTS, NODE_SHAPES } from '../data/node-types';
import { parseSafeExpression, listJavaScriptFunctions, validateSourceExpression, moduleCallableNames } from '../scripts/javascript-import';
import { parseFunctionBody, valueType } from '../scripts/function-language';

function Counter({ label, value, min, max, onChange }) {
  return <div className="port-counter"><span>{label}</span><div><button type="button" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} aria-label={`Remove ${label.toLowerCase()}`}>−</button><strong>{value}</strong><button type="button" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} aria-label={`Add ${label.toLowerCase()}`}>+</button></div></div>;
}

export function showValue(value) {
  if (value == null) return 'UNKNOWN';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json?.length > 230 ? `${json.slice(0, 227)}…` : json || '[structured value]';
    } catch (_) { return '[structured value]'; }
  }
  return String(value);
}

export default function NodeConfig({ node, graph, updateNode, preview, simulation, visibleSteps = 0 }) {
  const custom = isFunctionNode(node), gate = LOGIC_GATES.includes(node.type), decision = node.type === 'conditional';
  const variable = node.type === 'variable', compare = node.type === 'compare', sourceNode = node.type.startsWith('source-'), watchNode = ['watch', 'assert'].includes(node.type);
  if (!custom && !gate && !decision && !variable && !compare && !sourceNode && !watchNode) return null;
  const set = props => updateNode(node.id, props);
  let error = '';
  if (custom) {
    try { parseFunctionBody(node.code, getFunctionDataInputs(node).length, getNodePorts(node).outputs.filter(p => p.kind !== 'boolean').length); }
    catch (e) { error = e.message; }
  }
  const changeType = (port, type) => set({ portTypes: { ...(node.portTypes || {}), [port]: type } });
  return <>
    {sourceNode && <div className="property-section"><div className="property-label">SOURCE IMPORT • LINE {node.sourceLine || '—'}</div>{node.expressionText !== undefined && !node.sourceCallCondition && !['source-operator', 'source-value', 'source-member', 'source-ternary', 'source-call-expr', 'source-call', 'source-update'].includes(node.type) && <><label className="field-label">Editable expression<textarea aria-label="Imported expression" rows={4} spellCheck="false" value={node.expressionText} onChange={e => set({ expressionText: e.target.value, title: node.statementKind === 'return' ? `return ${e.target.value}` : node.statementKind === 'test' ? `if ${e.target.value}` : `${node.variableName} = ${e.target.value}` })}/></label>{(() => { try { validateSourceExpression(node.expressionText, graph?.program?.source ? moduleCallableNames(graph.program.source) : null); return <p className="node-code-status success">✓ Restricted expression • simulation and source patch enabled.</p>; } catch (e) { return <p className="node-code-status error">⚠ {e.message}. Export blocked.</p>; } })()}</>}{['source-operator','source-value','source-member','source-ternary','source-call-expr'].includes(node.type) && <div className="node-code-status success">Read-only expression component: {node.expressionText}. Select its parent assignment or condition to edit and reimport to refresh the atom diagram.</div>}{node.sourceCallCondition && <div className="node-code-status">Read-only condition containing a Function Dependency. The interpreter can follow the TRUE/FALSE path when every necessary helper is safely interpreted. Otherwise it takes UNKNOWN and taints the affected variables.</div>}{node.type === 'source-call' && <div className="dependency-inspector"><div className="node-code-status">Linked call: <strong>{node.calleeName}</strong> • {node.dependencyPath || 'unresolved'} • {node.dependencyStatus || 'unresolved'}</div><p className="config-help">This is a compact function dependency, not its expanded implementation. Arguments are interpreted from the parent function's variables. Resolved local pure calls use the bounded isolated interpreter; unsupported or unresolved dependencies produce UNKNOWN without executing native JavaScript.</p><code>{node.callSource || node.title}</code>{(() => {
      const source = graph?.program?.workspaceFiles?.[node.dependencyPath];
      if (!source) return null;
      const chosen = listJavaScriptFunctions(source).find(fn => fn.name === node.dependencyName);
      if (!chosen) return null;
      return <details className="dependency-source-preview"><summary>Preview {node.dependencyName}() from {node.dependencyPath} (lines {chosen.line}–{chosen.endLine})</summary><pre>{source.split('\n').slice(chosen.line - 1, Math.min(chosen.endLine, chosen.line + 69)).join('\n')}</pre><small>Read-only reference. This source is NOT executed, imported, or modified by the current focused-function export.</small></details>;
    })()}</div>}{['source-opaque','source-loop','source-switch','source-try','source-throw','source-await'].includes(node.type) && <div className="node-code-status error">Unsupported: {node.unsupportedReason}. Preserved exactly; skipped during simulation. Following values may be UNKNOWN and execution is unverified.</div>}<p className="config-help">Changes to source-backed connections and nodes do not round-trip. Only expression edits are safely written back to JavaScript in this release.</p></div>}
    {node.type === 'watch' && (() => {
      const sourceEdge = graph?.edges.find(e => e.target === node.id && e.targetPort === 'in');
      const source = graph?.nodes.find(n => n.id === sourceEdge?.source);
      const watchingFunction = source && isFunctionNode(source) && sourceEdge.sourcePort !== 'done';
      let variableNames = [];
      if (watchingFunction) {
        try {
          const parsed = parseFunctionBody(source.code, getFunctionDataInputs(source).length,
            getNodePorts(source).outputs.filter(p => p.id !== 'done').length);
          variableNames = [...new Set(parsed.statements.map(s => s.name))];
        } catch (_) { /* Display a manual selector even when source has an error. */ }
      }
      return watchingFunction ? <div className="property-section">
        <div className="property-label">FUNCTION VARIABLE HISTORY</div>
        <p className="config-help">This Watch is wired to <strong>{source.title}:{sourceEdge.sourcePort}</strong>. Inspect each variable assignment during the function, not just its final output.</p>
        <label className="field-label">Record changes<select aria-label="Watch function changes" value={node.traceVariable || 'all'} onChange={e => set({ traceVariable: e.target.value })}>
          <option value="all">All function variables (including locals)</option>
          <option value="port">Connected output only ({sourceEdge.sourcePort})</option>
          <option value="named">Specific variable</option>
        </select></label>
        {(node.traceVariable === 'named') && <label className="field-label">Variable name<input aria-label="Watched local variable" list={`watch-var-${node.id}`} value={node.traceVariableName || ''} placeholder="e.g. total" onChange={e => set({ traceVariableName: e.target.value })}/><datalist id={`watch-var-${node.id}`}>{variableNames.map(name => <option key={name} value={name}/>)}</datalist></label>}
        <p className="config-help">Each assignment is recorded with its line number, previous value, and new value in the bottom waterfall. Changes are revealed in playback order. DONE emits TRUE only after the body completes.</p>
      </div> : null;
    })()}
    {watchNode && <div className="property-section"><div className="property-label">ASSERTION CONFIGURATION</div><label className="field-label">Condition<select value={node.check || 'range'} onChange={e => set({ check: e.target.value })}><option value="range">In numeric range</option><option value="equals">Equals</option><option value="type">Data type</option></select></label>{node.check === 'range' ? <><label className="field-label">Minimum<input type="number" value={node.min ?? 0} onChange={e => set({ min: Number(e.target.value) })}/></label><label className="field-label">Maximum<input type="number" value={node.max ?? 100} onChange={e => set({ max: Number(e.target.value) })}/></label></> : node.check === 'type' ? <label className="field-label">Expected type<select value={node.expectedType || 'number'} onChange={e => set({ expectedType: e.target.value })}>{['number', 'string', 'boolean'].map(t => <option key={t}>{t}</option>)}</select></label> : <label className="field-label">Expected literal<input value={node.expected || 'true'} onChange={e => set({ expected: e.target.value })}/></label>}<div className="node-code-status">Pure validation of incoming data. Input passes through unchanged. No source code is executed.</div></div>}
    {(custom || gate || decision) && <div className="property-section"><div className="property-label">PORT CONFIGURATION</div>
      <p className="config-help">Add inputs directly instead of chaining gates. Existing port IDs stay stable when the count changes.</p>
      <Counter label="Inputs" value={node.inputCount ?? (decision ? 1 : 2)} min={custom ? 0 : decision ? 1 : 2} max={MAX_PORTS} onChange={inputCount => set({ inputCount })}/>
      {custom && <Counter label="Outputs" value={node.outputCount ?? 1} min={0} max={MAX_PORTS} onChange={outputCount => set({ outputCount })}/>}
      {decision && <label className="field-label configuration-field">Combine tests<select value={node.conditionMode || 'and'} onChange={e => set({ conditionMode: e.target.value })}><option value="and">AND — all true</option><option value="or">OR — any true</option><option value="xor">XOR — odd parity</option></select></label>}
      {(gate || decision) && <small className="config-footnote">Supports up to 16 simultaneous signals.</small>}
    </div>}
    {variable && <div className="property-section"><div className="property-label">VARIABLE VALUE</div>
      <label className="field-label">Data type<select value={node.dataType || 'number'} onChange={e => { const type = e.target.value; set({ dataType: type, dataValue: type === 'number' ? 0 : type === 'boolean' ? false : '' }); }}><option value="number">Number</option><option value="string">String</option><option value="boolean">Boolean</option></select></label>
      {node.dataType === 'boolean' ? <label className="field-label">Value<select value={String(node.dataValue)} onChange={e => set({ dataValue: e.target.value === 'true' })}><option value="true">TRUE</option><option value="false">FALSE</option></select></label>
        : <label className="field-label">Value<input aria-label="Variable value" type={node.dataType === 'number' ? 'number' : 'text'} value={node.dataValue ?? ''} onChange={e => { const value = node.dataType === 'number' ? Number(e.target.value) : e.target.value; if (node.dataType !== 'number' || Number.isFinite(value)) set({ dataValue: value }); }}/></label>}
      <div className="node-output-list"><div><code>{node.title || 'Variable'}</code><span>{showValue(node.dataValue)}</span></div></div>
    </div>}
    {compare && <div className="property-section"><div className="property-label">COMPARISON</div><label className="field-label">Operator<select value={node.comparison || '=='} onChange={e => set({ comparison: e.target.value })}>{['==', '!=', '>', '>=', '<', '<='].map(op => <option key={op} value={op}>{op}</option>)}</select></label>
      <p className="config-help">Compare data values from two variable or function nodes. Output is Boolean; incompatible or missing operands produce UNKNOWN.</p>
      <div className="node-output-list"><div><code>out</code><span>{showValue(preview.values[node.id])}</span></div></div>
    </div>}
    {custom && <>
      <div className="property-section"><div className="property-label">APPEARANCE</div><label className="field-label">Node shape<select value={node.shape || 'rounded'} onChange={e => set({ shape: e.target.value })}>{NODE_SHAPES.map(shape => <option value={shape.id} key={shape.id}>{shape.name}</option>)}</select></label></div>
      <div className="property-section"><div className="property-label">FUNCTION INTERFACE</div><label className="field-label">Execution trigger<select value={node.triggerMode || "auto"} onChange={e => set({ triggerMode: e.target.value })}><option value="signal">EXEC must receive TRUE</option><option value="auto">Auto (legacy flows)</option></select></label><p className="config-help">EXEC accepts a Boolean TRUE or a control-flow NEXT connection. DONE becomes TRUE only when the function finishes successfully, and may connect to the next flow node (including another Function EXEC), or to a Boolean Watch/Decision. In control-flow mode, a NEXT triggers the function only when its branch is reached. Data ports remain separate.</p>
        <label className="field-label">Function name<input aria-label="Function name" maxLength={80} value={node.functionName || ''} placeholder="calculate" onChange={e => set({ functionName: e.target.value })}/></label>
        <p className="config-help">Data travels through wires as real values. Type each port for connection validation, or select <strong>any</strong>. Variables are available in the body as <code>in1, in2…</code>; return values by assigning <code>out1, out2…</code>.</p>
        {['inputs', 'outputs'].map(direction => <div key={direction} className="port-type-group"><strong>{direction.toUpperCase()}</strong>{getNodePorts(node)[direction].filter(port => port.id !== 'execute' && port.id !== 'done').map(port => <label className="port-type-row" key={port.id}><code>{port.id}</code><select aria-label={`${port.id} data type`} value={(node.portTypes || {})[port.id] || 'any'} onChange={e => changeType(port.id, e.target.value)}>{DATA_TYPES.map(type => <option value={type} key={type}>{type}</option>)}</select></label>)}</div>)}
      </div>
      <div className="property-section"><div className="property-label">FUNCTION BODY</div>
        <label className="field-label">Source syntax<select value={node.language || 'javascript'} onChange={e => set({ language: e.target.value })}>{CODE_LANGUAGES.map(lang => <option value={lang.id} key={lang.id}>{lang.name}</option>)}</select></label>
        <label className="field-label">Code editor<textarea className="node-code-editor" aria-label="Function body" spellCheck="false" rows={10} maxLength={20000} value={node.code || ''} onChange={e => set({ code: e.target.value })} placeholder={'total = in1 + in2;\nout1 = total;\nout2 = total >= 100;'}/></label>
        <p className="config-help">One assignment per line. Local variables, numbers, strings, Boolean logic, math (+ − * / % **), equality and comparisons work. <strong>This is an explicit, portable expression subset</strong> (including Python <code>and/or/not</code>), not an arbitrary-language parser. No calls, loops, I/O or side effects. The exporter generates an actual callable function in the selected target language.</p>
        {error ? <div className="node-code-status error">⚠ {error}. Export will show this error rather than silently dropping your function.</div> : <div className="node-code-status success">✓ Function body parsed; JS/TS/Python translation available.</div>}
        <div className="node-output-list">{getNodePorts(node).outputs.map(port => { const completed = simulation?.trace.slice(0, visibleSteps).some(step => step.nodeId === node.id && step.type === 'function-completion'); const value = port.id === 'done' ? Boolean(completed) : preview.portValues[`${node.id}:${port.id}`]; return <div key={port.id}><code>{port.id} : {port.id === 'done' ? 'boolean' : (node.portTypes || {})[port.id] || 'any'}</code><span className={valueType(value) === 'unknown' ? 'unknown' : 'true'}>{showValue(value)}</span></div>; })}</div>
        <p className="config-footnote">Source language identifies the authoring syntax. Java, C#, C++, Rust and Go are accepted only when their code stays within this portable subset; target exports currently support JavaScript, TypeScript and Python. Unsupported statements are rejected, not executed.</p>
      </div>
    </>}
  </>;
}
