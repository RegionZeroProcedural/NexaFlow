# Nexa Flow v0.8 — Bidirectional Wiring & Node Layout

Nexa Flow is a React-based graph editor with a bounded, pure-expression simulator, configurable Function nodes, typed variable wires, JS/TS/Python export for authored graphs, and a **new source-backed investigation workspace**.

**v0.4 foundation:** import a JavaScript function without executing it; reconstruct control and approximate data dependencies; replay a safe IR simulation; inspect variable history, assert ranges, and trace contributing value versions backward; modify supported expressions and patch the original JavaScript source without changing untouched code.

## Setup

```bash
npm install
npm start
# test suite:
npm run test:ci
```

Requires Node.js 18+. The source-only archive can be copied over the `src/` of the previous Nexa Flow project. The complete archive includes `package.json`, examples and documentation.

## New in v0.8 — reliable click and drag wiring

Node connections now work **from either side**. You can **click an input, then click an output**, or **click an output, then click an input**; Nexa Flow normalizes both sequences to the same directed edge. To drag, hold the left mouse button on either socket, drag to a compatible socket, and **release to connect immediately**. No second click is necessary. Releasing a drag on empty canvas cancels its preview; clicking a socket without dragging leaves the wire armed for the next click. Click the armed socket again, click the canvas, or press Escape to cancel. Clicking another socket on the same side moves the start point.

Sockets now highlight **compatible destinations** when a wire is pending, and the preview snaps to the socket under the pointer. Hit testing accepts both the larger labelled socket hit area and proximity to its center. The proximity radius is constant in screen pixels when zooming. Port typing, NEXT ↔ EXEC/DONE compatibility, single-connection-per-input replacement, self-link prohibition, and cycle detection remain enforced. Incompatible connections show a warning instead of silently disappearing.

**Cleaner node UI:** Text, code snippets, numeric readouts, and labels are truncated within their own content regions; ports have a dedicated bottom area beneath the heading and node body. Long notes scroll inside their cards instead of painting outside them. Tall, configurable Function and gate nodes increase in height to accommodate up to 16 ports. Included example graphs have been repositioned to avoid collisions at the new node sizes. Previously saved graphs keep their user-authored node coordinates, so some may need repositioning after upgrade; no stored topology or node IDs are rewritten.

### Verify wiring

1. Add **Variable** and **Function** nodes (or open **File → EXEC / DONE + Operators demo**).
2. Click `Function in1`, then click `Variable Value`. The wire should appear immediately.
3. Drag `Variable Value` to `Function in2` and release. No other click should be needed.
4. Connect `Start Next → Function EXEC`, then `Function DONE → Process In`; NEXT and execution attachment signals remain compatible.
5. Drag an incompatible socket pair and check that a type warning appears. A drag dropped on empty space should leave no ghost wire.
6. Open a Function with many inputs and inspect the separated code body and labelled connector rows.

**Verification:** 146 dependency-light checks including forward/reverse endpoint normalization, zoom-stable screen-space port targeting, compatibility warnings, node geometry/port clearance, unchanged simulator flows, and existing exported-code execution. All 64 JS/JSX/MJS source files parsed. An actual interactive React browser session **was not available**, so the pointer behavior still needs hands-on confirmation in the target browser.

## New in v0.7 — Control-flow NEXT ↔ Function EXEC / DONE

The **EXEC** input and **DONE** output of every Function now accept both ordinary Boolean connections and control-flow NEXT connections. The connection validator allows **Start/Process NEXT → Function EXEC**, **Function DONE → Process/Decision/End Flow**, and **Function DONE → another Function EXEC**. Data inputs and outputs remain separate and type-checked. This is intentional, port-specific compatibility: it does **not** let arbitrary Boolean nodes wire directly into control-flow ports.

**Execution semantics:** A NEXT connection is an *execution token*, **not** a Boolean that is always true. The Function body is simulated only if the Start/Process/selected Decision branch actually reaches its EXEC port. After the safe, assignment-only body successfully finishes, DONE becomes TRUE and the control-flow trace advances to the next connected flow node or another Function's EXEC. If the branch is inactive, no function call occurs; if parsing or evaluation fails, DONE remains FALSE, execution stops at that Function, and the remainder of that flow path is not visited. A plain Boolean connected to EXEC continues to act as a Boolean trigger as in v0.6. Existing saved projects are compatible.

**New demo:** Open **File → NEXT ↔ Function demo**. It wires:

```
Start NEXT → Function A EXEC → Function A DONE → Process In
             → Process NEXT → Function B EXEC → Function B DONE → End In
```

Number variables are supplied to Function A through typed inputs, and the result passes through a Watch into Function B. Watch data remains independent of NEXT signals. The waterfall now places assignment/Watch events **after their Function's control-flow step**, and DONE readings only after completion. Failed or bypassed flow-triggered Functions don't spuriously run during preview.

**Generated code:** JavaScript, TypeScript, and Python code skeletons retain this sequencing. The generated runner activates flow-triggered Functions only on entry and follows DONE only when TRUE. The expression subset and isolation restrictions below still apply; no arbitrary code is executed inside the simulator.

**Validation:** 100 dependency-light offline regression assertions passed, including the v0.6 tests, conditional branch skipping, failed Function blocking NEXT, chained Function calls, Watch playback, and generated JavaScript, Python and TypeScript evaluation. All 64 JavaScript/JSX/MJS source files passed a TypeScript syntax parser. The React GUI was **not** exercised in a full browser session (npm dependencies unavailable here); pointer interaction should be verified in the target browser.

## New in v0.6 — Wiring, variable operators, EXEC / DONE and function history

**Connection handling has been updated:** drag an output port onto a compatible input port **and release**, or click the first port, release anywhere, and click the second port. The pending wire remains visible after mouse release instead of disappearing. Press **Esc** or click blank canvas to cancel. A generous release hit radius handles slight pointer misses. Incompatible or cyclic connections display an error; each input still accepts one incoming wire, replacing its previous connection when rewired.

**Typed Variable nodes and operators:** Add **Variable** (number/string/Boolean) nodes from the **Functions & Data** library. Add operators from the new **Operators** category: Add, Subtract, Multiply, Divide, Modulo, Power, Negate and Join Text. Wire Variable outputs to operator inputs, operators to Function data inputs (`in1`, `in2`…), and Function outputs (`out1`…) to Watch/Compare/other typed nodes. All calculations use the safe, bounded expression interpreter. Missing/invalid operands produce UNKNOWN, rather than evaluating arbitrary code.

**Dedicated function execution signal:** Each Function has its own Boolean **EXEC** input and **DONE** output, separate from its configurable data inputs/outputs. Fresh Function nodes default to **EXEC must receive TRUE**. Wire a Boolean node (or Boolean Variable or comparison) to EXEC. A Function with false/unconnected EXEC never interprets its body, emits unknown data outputs and keeps DONE false. A successfully simulated function sends DONE true **after its last assignment**. For previously saved graphs, *Auto (legacy flows)* remains available under Function → Properties → Execution trigger. If parsing fails, DONE stays false. DONE appears in the visual playback when execution completes; the Inspector does not prematurely show DONE before playback reaches completion.

**Live assignment history in Watch:** Attach a Watch to a Function data output. Open that Watch's **Properties → Function Variable History** selector:

* **All function variables (default):** Observe each assignment to `in1`, `out1`, or any local such as `subtotal` or `total`, even when that local is not exposed through an output port.
* **Connected output only:** See each successive write to the attached `outN` port, rather than only its final value.
* **Specific variable:** Enter/select the name of a local, parameter, or output to trace, e.g. `subtotal`.

The bottom waterfall records each assignment's previous/current value and code line, and advances **one step per change** during playback. It records the Function's completion event *after* these changes; a Watch on DONE records TRUE after completion. Rewind and Reset retain previously recorded samples until another Run. Assignment provenance links each change to the previous value version of variables read by its expression. To see the feature immediately, load **File → EXEC / DONE + Operators demo** and press **Run**; the Function calculates a subtotal, updates it with tax, writes outputs and sets DONE. Select **Waterfall: total** to experiment with filtering.

**Scope of mutations:** A Function may reassign `in1` (a local parameter) or another local variable; that does **not** mutate the upstream Variable node, just as reassignment of a primitive function parameter does not mutate its caller in JavaScript. To make a changed value available to the rest of the graph, assign an `outN` variable and connect that output. Watches on the Function observe its internal assignments via the trace, not by executing arbitrary code. Only direct Function output watches (and simple Watch/Assert pass-through chains) provide intermediate assignment histories currently; transformations after the Function still compute their final result once per run. Watch readings advance with **simulated trace replay**, not live JavaScript execution.

## New in v0.5 — Watch Waterfall inspector

The **Watch Waterfall** is a docked inspector at the **bottom of the application**. It is open by default and can be collapsed without clearing its data. It tracks readings from wired Watch nodes and presents them in two synchronized forms: **per-Watch lanes on a horizontal step timeline** and an **append-only list of observed variable values**, types and validation states.

### Quick start

1. Open the default **Order approval flow**. Its **Payment signal** is now a Watch node wired to the Boolean input. Press **Run**. The bottom waterfall fills progressively as execution replay advances. Toggle **Payment received** and press **Run** again to start a clean capture.
2. To see multiple watchers, choose **File → Functions & variables demo**. Its invoice total (`77`) and approval flag (`true`) are each wired to Watch nodes. Watch the two captures appear during the simulation. Change the input Variable values and press Run again. A Watch with an out-of-range number displays a flagged state.
3. You can insert a **Watch** anywhere in a compatible data connection by wiring a data source → Watch `in` and optionally Watch `out` → the next consumer. Set validation to numeric range, equality or data type using **Properties**. A disconnected Watch will not produce a reading.
4. In imported source mode, use the **Forensics → Watch / Assert rules** to watch a named variable. Every simulated write to that variable becomes a new waterfall entry, including the prior value when one exists. Arbitrary JavaScript is never executed.
5. Click a waterfall dot or event to select the originating node. **CSV** exports all captured records so far. The waterfall stays on screen after execution completes, after stepping backward, after Reset, or after editing the graph. Only starting another **Run** (or starting a fresh Step/Play session) replaces the records.

**Playback behavior:** The interpreter still evaluates a finite safe trace synchronously; the interface then *reveals* that trace and the Watch samples at 280 ms per step. “Live” means live **during trace playback**, not observing a separately running process. When Run finishes the waterfall freezes as a record of that run. Pausing freezes progress, and rewinding does not erase captured samples. For imported functions, observations align with their source-operation execution steps; for hand-built graphs, non-Function Watch readings are evaluated once and positioned before their first consuming decision (or just after Start). Function-connected Watch readings follow every captured assignment at its own playback step. This is a **simulation event timeline**, not real elapsed-time profiling. Arbitrary live code execution, automatic upstream Variable mutation and dynamic operator streaming remain future work.

## Try Source Forensics

1. Open the application, then **Import JS** in the header (or **File → Import JavaScript function…**).
2. Select `examples/order-forensics.js`. The importer parses the file and picks **the first supported function**. Its statements and conditions appear as source-backed graph nodes.
3. Open **Forensics** in the inspector. Set `price` to `20`, `quantity` to `2` and `discount` to `50` (enter JSON primitives and press Enter or leave the field).
4. Add a validation rule: `variable = total`, `condition = range`, `min = 0`, `max = 100`.
5. Click **Run simulation** or **Step**. Scrub backward/forward using the replay slider. The inspector shows the variable snapshot, assertion failures, event timeline and an execution profile (simulated node visits).
6. Click an assertion or value event to **Trace origin**. Nexa Flow highlights contributing nodes and shows actual value-version dependencies. Control-dependent writes also include the branch condition in their provenance.
7. Click the `discounted` assignment. In **Properties**, replace `subtotal - discount` with `subtotal - 10`. The Forensics panel shows the **original source** and **proposed source export** side by side in sequence. **Code → JavaScript → Download** exports the source with the edited expression patched in place.
8. Switch between **Control flow** and **Data dependencies** above the canvas. Control edges show possible branches; turquoise edges show *static, conservative* variable dependencies. Actual values and executed branches are found in Forensics.

Import `examples/unsupported-operation.js` to see opaque nodes. Calls to `notifyAccounting` are never executed; when execution reaches that node the simulation stops with a warning. The original call is preserved in same-language export.

### Source import scope — important limitations

This is **not yet a whole-project reverse compiler**. v0.4 parses one `.js`/`.mjs` file (maximum 150 KB), selects its first function declaration or single `const`/`let` function expression/arrow function with a block body, and supports simple identifier parameters (up to 16). JavaScript modules with surrounding imports are accepted, but modules are **not loaded or executed**. Source is parsed with [Acorn](https://github.com/acornjs/acorn), an MIT-licensed parser vendored locally (license in `src/vendor/ACORN-LICENSE.txt`).

Supported source expression IR includes primitive literals, variables, arithmetic, comparisons, unary operators, `&&`, `||`, `??`, and ternary expressions. Supported statements include simple assignments, single-variable declarations, `if` / `else`, and `return`. Some JavaScript coercions and operators are conservatively modeled: when the evaluator cannot faithfully resolve a value, it returns **UNKNOWN (`null`)** rather than pretending to execute real JavaScript. Arrays/objects, destructuring, property access, function calls, loops, closure capture, exceptions, async/await, module logic and other arbitrary JavaScript operations are **opaque**. The visual graph can still display subsequent statements, but simulation **halts** at an opaque operation. Calls and side effects never run.

**Same-language source patch export is expression-only.** Changes to imported, supported expressions are inserted at their original source ranges (so unsupported code, whitespace, imports and comments are unchanged). The imported graph can be repositioned, inspected, annotated and saved to `.nflow.json`, but changing its topology, duplicating or deleting nodes cannot yet be translated back to JavaScript; the source exporter blocks these structural edits with an error instead of silently dropping changes. Imported-function cross-language export is **not yet supported**; JavaScript remains the only source-backed round-trip target. The original authored visual graphs still export skeletons to JavaScript, TypeScript or Python via their existing portable subset.

### Simulator isolation

- Source import is strictly **parsing**, not `eval`, `new Function`, module import, `vm` execution or WASM.
- Imported expressions run through a hand-written **intermediate-representation interpreter** restricted to primitive data. No arbitrary JavaScript expressions, functions, network access, file operations or system commands execute inside the simulation.
- Unsupported code is retained as an opaque source reference and stops the simulated path if encountered.
- Source files, project files and expressions are size- or complexity-bounded; import-time graph topology and typed ports are validated.
- All imported-source parsing and simulation happen locally inside the browser; Nexa Flow is not a hardened sandbox for running untrusted arbitrary programs. **Real custom-function execution remains disabled.** Before adding it, use a separate isolated runtime with memory/CPU budgets, disallowed networking and a strict filesystem boundary. Browser-side parsing alone is not an OS-level sandbox.

## Current visual graph capabilities (from v0.3)

- Canvas: draggable nodes, zoom/pan, minimap, typed connections, undo/redo, grid snapping, project JSON import/export and SVG diagram export.
- Boolean gates (AND, OR, XOR, NAND, NOR, XNOR) support up to 16 inputs; NOT gate; configurable multivariate Decision branches.
- `Variable` nodes carry numbers, strings and booleans; `Compare` nodes compare values; `Monitor` displays them.
- `Function` nodes accept 0–16 typed inputs/outputs, five visual shapes, a language label, and safe assignment-only function bodies with local variables. Graph output generators emit callable JS/TS/Python functions for this portable expression subset; arbitrary code translation is not supported.
- **Watch** and **Assert** nodes take a typed data wire, pass the value through, and check equality, a numeric range, or a data type. Failures show in the Execution inspector. Assert nodes emit validation in exported visual-graph code; Watch passes the value through unchanged.
- `.nflow.json` import/export saves graphs, including imported source, test inputs, debugging rules and source offsets.

### Architecture

```
src/scripts/javascript-import.js  Acorn AST → safe expression IR + source-linked CFG and possible data edges
src/scripts/forensics.js         Bounded IR evaluator, snapshots, value versions, watch rules, backward slices
src/scripts/waterfall.js          Turns Watch samples into safe, staged replay observations
src/scripts/simulate-control-flow.js   v0.3 graph simulation and v0.4 source-simulation dispatch
src/scripts/function-language.js       Portable authored Function node expression subset
src/scripts/generate-code.js            JS/TS/Python visual-graph exporter
src/components/forensics-panel.jsx      Input tests, watches, timeline/provenance, source previews
src/components/waterfall-inspector.jsx   Bottom dock, timeline, variable events, status, CSV
src/components/node-config.jsx          Per-node configuration, including source expression edits
src/data/node-types.js                  Graph model, type checking, validation and ports
```

### Design notes / future work

A source-backed **CFG** describes execution alternatives. A **DFG** conservatively describes possible dependencies. An actual run produces **dynamic value provenance**: each value version records its producing step, original line, expression and dependency event IDs. Following a failed assertion backward shows contributing operations **not a logically guaranteed root cause**. The next logical milestone is a multi-file call graph, full JS semantics, SSA/CFG-based rewrites, deeper variable tracking for loops/closures and explicit source-mapping support for bidirectional structural changes.

## Verification

Source/JSX parsing and local smoke checks exercised importing, simulation, conditions, backward provenance, assert failures, source preservation, edited-expression export and opaque-operation handling. The browser UI was not run in an interactive browser here because the npm registry/dependencies were unavailable in the build environment. Install the dependencies and run `npm run test:ci` and `npm run build` in your development environment before shipping.
#   N e x a F l o w  
 