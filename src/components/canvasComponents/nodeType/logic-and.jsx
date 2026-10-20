import React from 'react';
export function GateBody({ type, value, inputCount = 2 }) {
  const formula = { and: 'A  ∧  B', or: 'A  ∨  B', not: '¬ A', xor: 'A  ⊕  B', nand: '¬ (A ∧ B)', nor: '¬ (A ∨ B)', xnor: '¬ (A ⊕ B)' };
  return <div className="gate-body"><span className="gate-formula">{type !== 'not' && inputCount > 2 ? `${inputCount} inputs · ${type.toUpperCase()}` : formula[type]}</span><span className={`result-pill ${value === null ? 'unknown' : value ? 'true' : 'false'}`}>{value === null ? '—' : value ? 'TRUE' : 'FALSE'}</span></div>;
}
export default function LogicAnd(props) { return <GateBody type="and" {...props}/>; }
