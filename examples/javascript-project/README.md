# Sample JavaScript module folder for Nexa Flow

Use **File → Import JS folder…** to choose the `javascript-project` folder, then select `src/checkout.js` and `calculateCheckout`.

In the focused graph, `getSubtotal`, `discountPrice`, and `tax` become compact **Function Dependency** nodes, including helpers in `lib/pricing.js` and `lib/tax.js`. The interpreter supports this small pure subset and can compute a result without executing the original JavaScript.

Try inputs: `price = 20`, `quantity = 2`, `discount = 10`. The result should be `(40 - 10) * 1.08 + 5 + 2 = 39.4`.

Only functions in the focused entry file appear expanded in the graph. Unsupported code remains source-backed and is never natively executed. Relative imports require the referenced files to be included in the selected folder.
