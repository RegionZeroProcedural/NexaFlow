/** Only bounded JSON test fixtures enter the source interpreter.
 * Objects and arrays are data, never executable JavaScript or prototypes. */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeTestValue(value, budget = { nodes: 0, seen: new Set() }, depth = 0) {
  if (++budget.nodes > 1600 || depth > 9) return false;
  if (value === null || typeof value === 'string' && value.length <= 5000 ||
      typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object' || budget.seen.has(value)) return false;
  if (Array.isArray(value)) {
    if (value.length > 512) return false;
  } else if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  budget.seen.add(value);
  const entries = Object.entries(value);
  if (entries.length > 128) return false;
  return entries.every(([key, item]) => !BAD_KEYS.has(key) && key.length <= 100 &&
    isSafeTestValue(item, budget, depth + 1));
}

export function parseTestValue(text) {
  if (typeof text !== 'string' || text.length > 6500) throw Error('JSON test value must be at most 6,500 characters');
  let value;
  try { value = JSON.parse(text); }
  catch (_) { throw Error('Enter valid JSON: a primitive, array or object'); }
  if (!isSafeTestValue(value)) throw Error('Unsafe or oversized test value (max 512 array items, depth 9)');
  return value;
}
