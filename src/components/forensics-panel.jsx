import React, { useEffect, useRef, useState } from 'react';
import { showValue } from './node-config';
import { traceValueOrigins } from '../scripts/forensics';
import { exportImportedJavaScript } from '../scripts/javascript-import';

const exampleRule = () => ({ id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`, variable: '', check: 'range', min: 0, max: 100, expected: 'true', expectedType: 'number' });
const pretty = value => value == null ? 'UNKNOWN' : showValue(value);

export default function ForensicsPanel({ graph, selection, simulation, visibleSteps, updateProgram, jumpToNode, highlightOrigin, onHighlight, preview }) {
  const sourceRef = useRef(null);
  const [chosenEvent, setChosenEvent] = useState(null);
  const [draftParams, setDraftParams] = useState({});
  const [inputError, setInputError] = useState('');
  const program = graph.program;
  useEffect(() => {
    setDraftParams(Object.fromEntries((program?.parameters || []).map(name => [name, JSON.stringify(program.inputValues?.[name] ?? null)])));
    setInputError('');
  }, [program?.inputValues, program?.parameters]);
  const result = simulation || preview;
  const shownStep = simulation ? visibleSteps : result.trace.length;
  const seenEvents = (result.events || []).filter(e => e.step <= shownStep);
  const recentSnapshot = result.snapshots?.[Math.max(0, shownStep - 1)] || {};
  const sourceNode = graph.nodes.find(n => n.id === selection?.id);
  useEffect(() => {
    if (!sourceRef.current || !program || !Number.isInteger(sourceNode?.sourceStart)) return;
    sourceRef.current.focus({ preventScroll: true });
    sourceRef.current.setSelectionRange(sourceNode.sourceStart, sourceNode.sourceEnd);
  }, [sourceNode?.id, program, sourceNode?.sourceStart, sourceNode?.sourceEnd]);
  if (!program) return <div className="forensic-panel"><p>Import a JavaScript function to inspect its source, step through variables, and set watch rules. Existing visual flows support Watch and Assert nodes.</p><div className="forensic-callout">No arbitrary source code is executed. Unsupported syntax is preserved for export and flagged during simulation.</div></div>;
  const params = program.parameters || [];
  let patchedSource = '', patchIssue = '';
  try { patchedSource = exportImportedJavaScript(graph); } catch (e) { patchIssue = e.message; }
  const chosen = seenEvents.find(e => e.id === chosenEvent);
  const roots = chosen ? traceValueOrigins(seenEvents, chosen.id) : [];
  return <div className="forensic-panel">
    <div className="forensic-callout"><strong>FORENSICS MODE</strong><br/>Imported JavaScript • IR interpreter only. No filesystem, network, calls, imports or user-code execution. <strong>Data lines are static approximations</strong>; backward traces use actual simulated value versions.</div>
    <div className="property-label">TEST PARAMETERS</div>
    {params.length === 0 ? <small>No function parameters.</small> : params.map(name => <label className="field-label" key={name}>{name}<input aria-label={`Test value ${name}`} value={draftParams[name] ?? JSON.stringify(program.inputValues?.[name] ?? null)} onChange={e => setDraftParams(current => ({ ...current, [name]: e.target.value }))} onBlur={() => {
      try {
        const value = JSON.parse(draftParams[name]);
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Only JSON primitives allowed');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Number must be finite');
        updateProgram({ inputValues: { ...program.inputValues, [name]: value } }); setInputError('');
      } catch (err) { setInputError(`Invalid ${name}: ${err.message}. Use JSON primitives.`); }
    }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/></label>)}
    {inputError && <div className="node-code-status error" role="alert">{inputError}</div>}
    <div className="forensic-small">Enter JSON primitives, e.g. <code>25</code>, <code>true</code>, <code>"premium"</code>. Invalid partial input is not committed.</div>
    <div className="property-label forensic-heading">WATCH / ASSERT RULES</div>
    {(program.watchRules || []).map(rule => <div className="watch-rule" key={rule.id}>
      <label className="field-label">Variable<select aria-label="Watched variable" value={rule.variable} onChange={e => updateProgram({ watchRules: program.watchRules.map(r => r.id === rule.id ? { ...r, variable: e.target.value } : r) })}><option value="">Select variable</option>{[...new Set([...params, ...graph.nodes.map(n => n.variableName).filter(Boolean), '$return'])].map(name => <option value={name} key={name}>{name}</option>)}</select></label>
      <label className="field-label">Condition<select value={rule.check} onChange={e => updateProgram({ watchRules: program.watchRules.map(r => r.id === rule.id ? { ...r, check: e.target.value } : r) })}><option value="range">Inside numerical range</option><option value="equals">Equals</option><option value="type">Has type</option></select></label>
      {rule.check === 'range' ? <div className="watch-range">{['min', 'max'].map(field => <label key={field}>{field}<input type="number" value={rule[field]} onChange={e => updateProgram({ watchRules: program.watchRules.map(r => r.id === rule.id ? { ...r, [field]: Number(e.target.value) } : r) })}/></label>)}</div> : rule.check === 'type' ? <select value={rule.expectedType} onChange={e => updateProgram({ watchRules: program.watchRules.map(r => r.id === rule.id ? { ...r, expectedType: e.target.value } : r) })}>{['number', 'boolean', 'string'].map(t => <option key={t}>{t}</option>)}</select> : <input aria-label="Expected value" value={rule.expected} onChange={e => updateProgram({ watchRules: program.watchRules.map(r => r.id === rule.id ? { ...r, expected: e.target.value } : r) })}/>}
      <button type="button" className="forensic-light-button" onClick={() => updateProgram({ watchRules: program.watchRules.filter(r => r.id !== rule.id) })}>Remove</button>
    </div>)}
    <button type="button" className="forensic-light-button" onClick={() => updateProgram({ watchRules: [...(program.watchRules || []), { ...exampleRule(), variable: params[0] || graph.nodes.find(n => n.variableName)?.variableName || '$return' }] })}>+ Add validation rule</button>
    <div className="property-label forensic-heading">VARIABLE SNAPSHOT {simulation ? `(STEP ${shownStep})` : '(PREVIEW)'}</div>
    <div className="snapshot-list">{Object.keys(recentSnapshot).length ? Object.entries(recentSnapshot).map(([name, value]) => <div key={name}><code>{name}</code><strong>{pretty(value)}</strong></div>) : <p>Run or step through the function to inspect variable values.</p>}</div>
    <div className="property-label forensic-heading">ASSERTION RESULTS ({result.assertions?.length || 0})</div>
    {(result.assertions || []).filter(a => !simulation || a.step <= shownStep).map(a => <button type="button" className="assertion-entry" key={a.id} onClick={() => { setChosenEvent(a.eventId); onHighlight(traceValueOrigins(result.events, a.eventId).map(e => e.nodeId).filter(Boolean)); jumpToNode(a.nodeId); }}><strong>⚠ {a.name}: {pretty(a.value)}</strong><small>{a.message} · step {a.step ?? 'data'}</small><span>Trace origin →</span></button>)}
    <div className="property-label forensic-heading">VALUE PROVENANCE ({seenEvents.length})</div>
    <div className="value-event-list">{seenEvents.map(e => <button type="button" key={e.id} className={chosenEvent === e.id ? 'chosen' : ''} onClick={() => { setChosenEvent(e.id); onHighlight(traceValueOrigins(seenEvents, e.id).map(x => x.nodeId).filter(Boolean)); jumpToNode(e.nodeId); }}><span>#{e.step} · {e.name}</span><strong>{pretty(e.value)}</strong><small>{e.operation}</small></button>)}</div>
    {chosen && <div className="origin-trace"><div className="property-label">BACKWARD SLICE: {chosen.name}</div>{roots.map((e, index) => <button type="button" key={e.id} onClick={() => jumpToNode(e.nodeId)}><span>{index + 1}. {e.name}: {pretty(e.value)}</span><small>{e.operation}{e.sourceLine ? ` • line ${e.sourceLine}` : ''}</small></button>)}<small>This lists contributing value versions, not a guaranteed root-cause diagnosis.</small><button type="button" className="forensic-light-button" onClick={() => { setChosenEvent(null); onHighlight([]); }}>Clear trace</button></div>}
    <div className="property-label forensic-heading">EXECUTION PROFILER</div>
    <div className="snapshot-list">{Object.entries(result.profiles || {}).map(([id, count]) => <button className="profile-row" key={id} onClick={() => jumpToNode(id)}><span>{graph.nodes.find(n => n.id === id)?.title || id}</span><strong>{count} visit{count === 1 ? '' : 's'}</strong></button>)}</div>
    <p className="forensic-small">Profile counts are from the simulated IR path, not real JavaScript CPU or wall-clock measurements.</p>
    <div className="property-label forensic-heading">ORIGINAL SOURCE (READ-ONLY)</div>
    <textarea ref={sourceRef} className="source-preview" readOnly spellCheck="false" value={program.source} aria-label="Original JavaScript source"/>
    <div className="property-label forensic-heading">PROPOSED SOURCE EXPORT</div>
    {patchIssue ? <div className="node-code-status error">Source export blocked: {patchIssue}</div> : <textarea className="source-preview" readOnly spellCheck="false" value={patchedSource} aria-label="Proposed patched source"/>}
    <p className="forensic-small">Selecting an imported node selects the matching source span. Edit a supported expression in Properties; JavaScript export applies only those edits to the original text. Source remains untouched for unsupported operations.</p>
    {highlightOrigin?.length > 0 && <p className="forensic-small">Highlighted provenance nodes: {highlightOrigin.length}</p>}
  </div>;
}
