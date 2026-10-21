# Nexa Flow v1.2 — Whole-Project Function Microscope

**Import project (src folder).** Use *Import project* in the header (or *File → Import project*). Pick the root of your `src` folder, or at least the folder holding every dependency of the function you care about. All `.js .jsx .mjs .cjs .ts .tsx` files are parsed with Babel (JSX and TypeScript work), and `node_modules`, `dist`, `build`, `.git` and `coverage` are skipped. Every function (top-level, nested callbacks, class methods, object methods) is indexed, ES imports and CommonJS `require` are resolved across files, and a call graph is built.

**Starts at the top.** The microscope opens on the highest-level function it can find: `main()`, a function called at the top of an entry file, or the component rendered with `<App/>`.

**Call board.** The main canvas shows the functions as regular **Function nodes**, with one data input per parameter and dashed call links. Click a function node, or its 🔬 button, to put it under the microscope.

**Microscope page.** A function is disassembled into basic nodes: parameters, reads, literals, declarations, assignments, property reads/writes, arithmetic, comparisons, short-circuit logic, ternaries, object/array/template/JSX construction, project calls, external calls, method calls, `new`, closures, `await`/`yield`, returns, throws, break/continue. These sit inside nested regions for `if`/`else`, `for`/`for-of`/`for-in`/`while`/`do-while`, `switch` cases and `try`/`catch`/`finally`. Calls to other project functions are chips you can dive into (🔬 or double-click).

**Watch real data move.** Enter arguments as any JavaScript expression and press **Run** (F5). The function runs inside a sandboxed AST interpreter that records every value, branch, loop pass, variable write and call. Playback highlights the executing node, animates data along wires, shows taken and skipped branches and loop pass counts, and lists locals, the call stack, console output and each node's value history. *Follow calls* switches the view into whichever function is executing. Keys: → step, ← back, ↓ step over, ↑ step out, Space play/pause.

**Search.** Search function names from the canvas or the microscope header (Ctrl+K or `/`).

**Toolbars.** The canvas and microscope toolbars stay hidden until you hover their tab. Once open, they stay up until the pointer is more than 15 px from the toolbar. Click a tab to pin it open.

**Sandbox limits.** Uploaded code is never compiled or eval'd. Only pure built-ins are reachable. npm packages, DOM, network and unknown globals become `‹external›` placeholders. Built-in prototypes can't be modified, and steps, trace events and call depth are capped. Async code runs in a simplified deterministic order, generators run eagerly, and top-level side-effect statements (such as `main();`) are skipped while a module is set up. Try it with `examples/microscope-demo/src`.

---

# Nexa Flow v1.1 — Readable Control Flow & Rich JavaScript Inspection

This update follows a real ByteFrame `addressAtFileOffset()` / `resolveRelativeTarget()` import. The original source contained safe object-property assignments, optional chaining, `.find()` callbacks, object returns, and linked helpers that Nexa Flow had represented as **Unsupported Source** nodes. The importer now decomposes and safely interprets that **specific supported subset** instead of producing opaque error boxes.

## What's new

**1. Left-to-right control-flow layout.** New imports automatically place operations in successive horizontal columns; conditional paths split into separate vertical lanes and merges follow their predecessors. Layout uses actual card dimensions, reserves space for headings, and avoids overlapping nodes. A **↔ Arrange** button is available in the slide-out Canvas Tools toolbar so you can rearrange an existing imported graph at any time. Arrange changes *presentation coordinates*, not the original JavaScript.

**2. More readable components.** Structured expressions are exposed as separate read-only inspection steps in Control Flow (up to three focused microsteps per statement), including **property reads/writes, optional chains, method calls, arithmetic/comparisons, ternary expressions, object/array literals and template strings**. The complete primitive tree is also available in the **Data Dependencies** tab, which now has its *own collision-free layout* independent of execution geometry. Its atom positions are display-only and cannot overwrite the source graph.

**3. Former error nodes now supported where semantics can be modeled safely.** The importer can recognize and simulate:

- Plain data objects and arrays with restricted own-property access; safe, shallow persistent-style property updates to local objects.
- Optional chaining and supported property lookup/indexing with typed, bounded data.
- Object literals, template literals, arithmetic, comparisons and ternary branches.
- Isolated local helpers and explicitly selected cross-file helpers, including expression-bodied arrow functions.
- Whitelisted pure operations including `Number.isSafeInteger`, `Number.isInteger`, `Array.isArray`, `startsWith`, `endsWith`, `includes`, `toString(radix)`, `toUpperCase`, `toLowerCase`, `Uint8Array.from` (bounded), and an array `.find()` with a simple pure expression callback.

The **real source code never executes** inside Nexa Flow. Only a restricted AST evaluator with step, recursion, data-shape and collection limits runs. Unknown methods, object getters, external calls, unsafe property writes and unsupported syntax remain **unverified** rather than silently imitated. Loops and labeled `continue` are still unsupported; no claims of full JavaScript parity are made.

**4. Readable, indented function outline.** The Forensics Inspector includes a collapsible **READABLE FUNCTION OUTLINE**, derived from the parsed AST with indented `if`/`else`, declarations and returned object properties. It is an *inspection aid*, not automatically rewritten JavaScript. **The original source remains byte-for-byte unchanged on an unedited export**, and supported expression edits patch only the exact expression ranges. Structural graph rewiring remains non-exportable.

**5. Structured debugging inputs.** Test parameters can now be bounded JSON objects/arrays, not only numbers, Booleans and strings. Safe fixture validation rejects cycles, unsafe keys, oversized arrays and excessive nesting. Results show readable JSON summaries in the inspector and Watch waterfall rather than `[object Object]`.

## Try the actual ByteFrame address-mapping example

In the complete project, open **File → Import JS file(s)…** and choose `examples/byteframe-address-mapping.js`. Select **`addressAtFileOffset`** or **`resolveRelativeTarget`**. The example is the source supplied during debugging (with its helper declarations). Use **Run** and the Watch/Provenance inspector, or **↔ Arrange** to reposition the graph automatically.

Try **`addressAtFileOffset`** with these JSON test inputs:

```json
structure = {"format":"PE32+","imageBase":4194304,"sections":[{"name":".text","start":512,"size":512,"rva":4096}]}
fileOffset = 530
```

Expected restricted-IR return: `{"kind":"PE","rva":4114,"virtualAddress":4198418,"section":".text"}`.

For an ELF example, use `{"format":"ELF64","sections":[{"name":".text","start":100,"size":90,"virtualAddress":4096}]}` and `fileOffset = 120`; its result includes `virtualAddress: 4116`.

For **`resolveRelativeTarget`**, reuse the PE `structure` and set `startFileOffset = 530`, `instruction = {"size":5,"displacement":10}`. The returned `rva` should be `4129` and `fileOffsetTarget` should be `545`. These cases are covered by an automated regression test.

## Verification and important limitations

Run from the complete project:

```bash
npm install
npm start
node scripts/verify-v11.cjs
```

The dedicated v1.1 checks cover **180 assertions** for imported ByteFrame functions, correct PE/ELF mapping, relative-target arithmetic, structured inputs, zero opaque nodes for this sample, zero node overlaps in both display modes, left-to-right edges, original-source integrity and structured-expression patching. The previous v1.0/v1.0.1 suites also passed (146 runtime/layout checks, 45 cross-file tests, 35 import tests and 34 concise-arrow tests, with overlapping coverage). A full React production build and interactive pointer test were **not performed** because the React app dependencies were unavailable in this environment.

*Limitations:* JSON cannot directly represent `Uint8Array`; inputs for that case require an eventual typed-data fixture interface. An unknown method or unsupported loop remains a labeled unverified node. Some real JavaScript capabilities (closures, DOM operations, arbitrary side effects, asynchronous execution, object prototypes/getters and labeled jumps) are deliberately excluded from the restricted interpreter. The pretty outline does not rewrite or reformat the original file on export. Use a proper JavaScript runtime/debugger to confirm production behavior.

---

# Nexa Flow v1.0.1 — Concise Arrow-Function Import Fix

**Fixes the “Function must have a `{ ... }` statement body” import error for valid expression-bodied arrow functions.** Both forms now import:

```javascript
const double = x => x * 2;           // implicit return
const doubleWithBlock = x => { return x * 2; };
export default (a, b) => a + b;      // anonymous default export
```

The function picker identifies **expression body / implicit return** or **block body** and no longer disables brace-free arrows. The focused graph gets a source-linked Return node with the original expression offsets, and the restricted interpreter can compute supported pure expressions. Expression editing patches **only the expression in the original source**, without inserting braces or changing surrounding imports, comments or other functions.

Helpers imported from other provided files can also have concise arrow bodies. For supported pure expressions, the safe bounded interpreter evaluates those helpers without executing the uploaded JavaScript. Unsupported concise returns (for example, object literals, JSX, React components, external API calls, and async/generator semantics) are shown as **unverified/unsupported** where the file parses; they never run or fabricate a successful result. JSX and TypeScript remain outside this Acorn parser's syntax support and now produce more descriptive parse errors, rather than the misleading missing-braces restriction.

**Try it:** Import `examples/concise-arrow-functions.js`. Choose `double`, `total`, or `safePrice`, set test inputs in Forensics and run. Choose `record` to see an unsupported object-literal return preserved, flagged, and stopped safely. Source file size and 16-simple-parameter limits are unchanged.

**Checks:** 34 new arrow-function regression assertions passed, plus 226 existing offline assertions in the v0.8–v1.0 test suites (combined 260). All JS/JSX/MJS source files passed parser-level syntax inspection. As in earlier releases, the interactive React browser build could not be exercised because npm dependencies are not installed here.

---

# Nexa Flow v1.0 — Focused JavaScript Function Microscope

**Changes from v0.9.1:**

- **Slide-out toolbars:** Canvas tools at the **upper-right edge** and simulator controls at the **bottom-left edge** collapse into labeled tabs. Move your pointer near a tab to reveal it, or click to pin it open. The controls remain keyboard-accessible; reduced-motion settings disable transitions.
- **Multi-file JavaScript importing:** File → **Import JS file(s)…** selects one or more `.js` / `.mjs` files. File → **Import JS folder…** preserves relative paths (supported browsers). Select the entry file, then the **individual function under investigation**.
- **Collapsed dependency functions:** A call to another selected function becomes a **Function Dependency** node, not an expansion of that helper's entire body. Static relative named/default ES imports are resolved across selected files; calls inside arithmetic expressions and `if` conditions are represented as compact dependencies too. Other files are not silently fetched from disk, packages, or the network. Multiple calls in one expression are shown as multiple references.
- **More precise JavaScript node types:** Source Call, Variable Declaration (uninitialized), Assignment Update (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `++`, `--`), Ternary Expression, Property Lookup, Call Expression, and explicit unsupported Loop, Switch, Try/Catch, Throw, and Await nodes. The new read-only primitives show under **Data Dependencies**. The focused function remains the editable CFG.
- **Bounded, isolated call simulation:** A linked helper with simple parameters, arithmetic, assignments, branching, nested supported calls, and returns can be interpreted using a small whitelisted AST model. This is **not native execution**. Arbitrary JS, I/O, APIs, imports, loops and side effects are never executed. Missing or unsupported calls yield UNKNOWN and warnings, while safely independent later statements continue approximately.
- **Dependency source preview:** Select a linked function node → Inspector to view its source definition and file location without expanding it onto the canvas.
- **Source-preserving JavaScript export:** Supported expression-only edits in the focused function patch the original entry file. Dependent source files remain unchanged. Structural rewiring cannot round-trip as JavaScript.

### Try the multi-file example

1. Run `npm install` and `npm start`.
2. File → Import JS folder → choose `examples/javascript-project`.
3. Select `src/checkout.js` → `calculateCheckout`.
4. In the Forensics Inspector, set price `20`, quantity `2`, discount `10` and run.
5. Inspect linked `getSubtotal`, `discountPrice`, and `tax` nodes, open Data Dependencies, and watch the variable history. A supported pure calculation returns **39.4** without executing the uploaded code.

**Limits:** 24 source files, 900 KB total, 150 KB per file, 240 imported CFG nodes. ES module `import` with string literal relative paths works; dynamic imports, npm packages, CommonJS require, wildcard imports, class methods, closures, JSX and TypeScript syntax are not resolved in this iteration. Function bodies with non-simple parameters are not importable. Other files must be explicitly selected by the user. Unsupported/unknown effects are clearly marked, and simulated results after them are approximate. No browser security sandbox is claimed—this interpreter does not execute user JavaScript at all.

---

# Nexa Flow v0.9.1 — Click-to-Rename Titles

**Inline title editing:** Click any node's title (including Functions, imported source nodes, and Notes) to rename the visible node right on the canvas. The large **flow/project title** above the canvas is now editable by clicking it, too; the existing header project-name field still works.

- **Enter** saves the new title; **Escape** cancels changes; clicking anywhere else saves.
- Empty/whitespace-only names are ignored, and titles are limited to 80 characters.
- Clicking an editable node title will not drag the node or open the Inspector. Click the rest of the node heading to drag, and double-click elsewhere on the node to open the Inspector.
- Node title edits participate in Undo/Redo and existing local autosave. The project title stays synchronized with the header and local autosave.
- Renaming an imported/source node changes its *display label*, not its original JavaScript function identifier or the contents of the source file. Likewise, renaming a Function node's display title does not automatically rename its configured exported function symbol; use the Function inspector for that.
- No changes were made to graph execution, source importing, port compatibility, or code generation.

Quick check: add a Variable or Function node, **click its name**, type a different label, press Enter, then use Undo. Click the large canvas title to rename the project, click outside to save, and verify the header title updates.

Development verification: `node scripts/verify-inline-title.cjs` checks the interaction contract using a lightweight React-hook shim (requires `typescript` to be resolvable in Node); `node scripts/verify-v08.cjs` and `node scripts/verify-v09.cjs` check existing logic. The full React application was not interactively browser-tested in this environment.

---

# Nexa Flow v0.9 — Selective Source Import & Safe Continuation

v0.9 adds selectable JavaScript functions, an expanded primitive data-flow view, and a conservative **skip-with-UNKNOWN** path for unsupported statements. The imported code is NEVER executed. Existing Function/Variable nodes, execution signals, Watch waterfall, Forensics Mode and source-preserving JavaScript export remain available.

## New: import an individual function from a JavaScript file

1. In Nexa Flow click **Import JS** (or **File → Import JavaScript function…**).
2. Choose a local `.js` / `.mjs` file up to 150 KB. Nexa Flow parses it with bundled Acorn without running it or importing modules.
3. A **Choose a function** dialog lists top-level function declarations, exported functions, and named `const`/`let` function/arrow expressions (including line numbers and parameter names). Select the function to investigate. Block-bodied and expression-bodied arrow functions are accepted; functions still require ≤16 simple parameters.
4. Switch between **Control flow** (entry, assignments, conditions, returns, unsupported blocks) and **Data dependencies** (read-only operator and variable/literal cards, connected by dashed dependency lines). Source arithmetic, comparisons, logical expressions and ternaries are broken into inspectable primitives where supported.
5. In the **Forensics** inspector, set parameter values (JSON number/string/boolean/null), add Watch/Assert rules and click **Run** or **Step**. The waterfall and provenance panel continue to track simulated variable revisions.
6. Select an editable source assignment/condition/return in the control-flow view to change a supported expression. Exporting JavaScript patches only those expressions; all other functions, unsupported statements, imports, comments and formatting are preserved from the original source.

Try `examples/import-multiple-functions.js` and choose `calculateShipping` for a fully supported run, `calculateCheckout` to see an unsupported call skipped, or `isolatedUncertainty` to see a safe independent calculation continue while an unknown dependency remains UNKNOWN.

**The primitive operator cards are currently a read-only decomposition, not independently writable executable nodes.** Edit the owning source statement in Properties and reimport the result to rebuild its primitive visualization. Source-backed structural changes or rewiring cannot yet round-trip to code; export blocks them rather than silently losing changes. Native authored graph nodes remain fully editable and connectable as before.

## What "continue after unsupported code" means

- Calls, unrecognized statements, nonportable syntax and external side effects become explicit **Unsupported Source** nodes. Their original JavaScript is retained verbatim.
- The simulator records a **SKIPPED / UNVERIFIED** step, does not execute that statement, and advances to the next determinable control-flow step.
- Variables that the skipped statement might modify are marked **UNKNOWN**. Potential external calls conservatively invalidate previously known variables, so dependent results cannot be misrepresented as proven correct. A subsequent purely simulated assignment with independent operands can still produce a known value.
- If an unsupported condition determines two branches, neither branch is fabricated: both are skipped, possibly affected variables are UNKNOWN, and the simulator continues past the condition with an **approximate-run warning**. If a subsequent condition itself cannot be evaluated, the interpreter stops rather than guessing a branch.
- Unsupported `return` / `throw` cannot fall through to later instructions. An unsupported return yields UNKNOWN and terminates the trace.
- This is **partial static interpretation**, not real JS execution, and not proof that the runtime would traverse the skipped code. The Forensics inspector labels these runs **APPROXIMATE**.

The importer does **not** yet support TypeScript parsing, entire multi-file projects, JavaScript call semantics, callbacks, `this`, closures, async execution, loops, object mutation or property access as executable IR. It supports only the already-documented safe primitive expression/statement subset. This conservative design preserves the isolation boundary: no imported source is allowed networking, file operations, native function calls or system access.

## Quick setup and verification

```bash
npm install
npm start

# Offline tests, requiring Node and the globally available TypeScript parser used for development:
node scripts/verify-v08.cjs
node scripts/verify-v09.cjs

# Browser project testing when node_modules are installed:
npm run test:ci
npm run build
```

v0.9 was checked with the v0.8 offline suite (146 assertions, including prior graph behavior) and the new source-import suite (35 assertions), plus TypeScript parser checks on 65 JS/JSX/MJS files. A full `react-scripts` build and interactive browser behavior were not verified in this environment because application dependencies were unavailable. The source-only zip updates your existing `src/` directory; examples and scripts are in the complete package.

---

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

## Try Source Forensics (legacy walkthrough)

1. Open the application, then **Import JS** in the header (or **File → Import JavaScript function…**).
2. Select `examples/order-forensics.js`. The importer parses the file and opens a picker for a supported top-level function. Its statements and conditions appear as source-backed graph nodes.
3. Open **Forensics** in the inspector. Set `price` to `20`, `quantity` to `2` and `discount` to `50` (enter JSON primitives and press Enter or leave the field).
4. Add a validation rule: `variable = total`, `condition = range`, `min = 0`, `max = 100`.
5. Click **Run simulation** or **Step**. Scrub backward/forward using the replay slider. The inspector shows the variable snapshot, assertion failures, event timeline and an execution profile (simulated node visits).
6. Click an assertion or value event to **Trace origin**. Nexa Flow highlights contributing nodes and shows actual value-version dependencies. Control-dependent writes also include the branch condition in their provenance.
7. Click the `discounted` assignment. In **Properties**, replace `subtotal - discount` with `subtotal - 10`. The Forensics panel shows the **original source** and **proposed source export** side by side in sequence. **Code → JavaScript → Download** exports the source with the edited expression patched in place.
8. Switch between **Control flow** and **Data dependencies** above the canvas. Control edges show possible branches; turquoise edges show *static, conservative* variable dependencies. Actual values and executed branches are found in Forensics.

Import `examples/unsupported-operation.js` to see opaque nodes. Calls to `notifyAccounting` are never executed; when execution reaches that node the simulator skips it with a warning and marks potentially affected values UNKNOWN. The original call is preserved in same-language export.

### Source import scope — important limitations

This is **not yet a whole-project reverse compiler**. v0.4 parses one `.js`/`.mjs` file (maximum 150 KB), lets you select a supported function declaration or `const`/`let` function expression/arrow function, including concise expression-bodied arrows, and supports simple identifier parameters (up to 16). JavaScript modules with surrounding imports are accepted, but modules are **not loaded or executed**. Source is parsed with [Acorn](https://github.com/acornjs/acorn), an MIT-licensed parser vendored locally (license in `src/vendor/ACORN-LICENSE.txt`).

Supported source expression IR includes primitive literals, variables, arithmetic, comparisons, unary operators, `&&`, `||`, `??`, and ternary expressions. Supported statements include simple assignments, single-variable declarations, `if` / `else`, and `return`. Some JavaScript coercions and operators are conservatively modeled: when the evaluator cannot faithfully resolve a value, it returns **UNKNOWN (`null`)** rather than pretending to execute real JavaScript. Arrays/objects, destructuring, property access, function calls, loops, closure capture, exceptions, async/await, module logic and other arbitrary JavaScript operations are **opaque**. The visual graph can still display subsequent statements, but simulation records an unverified skipped step at an opaque operation. Calls and side effects never run.

**Same-language source patch export is expression-only.** Changes to imported, supported expressions are inserted at their original source ranges (so unsupported code, whitespace, imports and comments are unchanged). The imported graph can be repositioned, inspected, annotated and saved to `.nflow.json`, but changing its topology, duplicating or deleting nodes cannot yet be translated back to JavaScript; the source exporter blocks these structural edits with an error instead of silently dropping changes. Imported-function cross-language export is **not yet supported**; JavaScript remains the only source-backed round-trip target. The original authored visual graphs still export skeletons to JavaScript, TypeScript or Python via their existing portable subset.

### Simulator isolation

- Source import is strictly **parsing**, not `eval`, `new Function`, module import, `vm` execution or WASM.
- Imported expressions run through a hand-written **intermediate-representation interpreter** restricted to primitive data. No arbitrary JavaScript expressions, functions, network access, file operations or system commands execute inside the simulation.
- Unsupported code is retained as an opaque source reference and is skipped with explicit uncertainty when encountered.
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
