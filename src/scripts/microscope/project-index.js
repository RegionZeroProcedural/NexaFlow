/** Whole-project static index: every function (including nested callbacks,
 * class methods and object methods), module imports/exports, a resolved call
 * graph and a ranked list of probable entry points (main(), <App/>, ...).
 * Nothing here executes user code. */
import { parseSource, isSourcePath, forEachChild, FUNCTION_TYPES, unwrapTs } from './parse-source';

export const PROJECT_LIMITS = { files: 800, totalBytes: 16 * 1024 * 1024, fileBytes: 1.5 * 1024 * 1024 };
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.cache|out|vendor|bower_components)(\/|$)/;
const RESOLVE_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx', '/index.mjs'];

export function normalizePath(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
const dirname = path => path.split('/').slice(0, -1).join('/');
const basename = path => path.split('/').pop().replace(/\.[^.]+$/, '');

/** Filter a raw folder selection down to analyzable source files. */
export function selectProjectFiles(entries) {
  const kept = [], skipped = [];
  let total = 0;
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (!path) continue;
    if (IGNORED_DIRS.test(path)) { skipped.push({ path, reason: 'ignored folder' }); continue; }
    if (!isSourcePath(path)) continue;
    if (entry.size > PROJECT_LIMITS.fileBytes) { skipped.push({ path, reason: 'file too large' }); continue; }
    if (kept.length >= PROJECT_LIMITS.files) { skipped.push({ path, reason: 'file limit reached' }); continue; }
    if (total + (entry.size || 0) > PROJECT_LIMITS.totalBytes) { skipped.push({ path, reason: 'project size limit reached' }); continue; }
    total += entry.size || 0;
    kept.push({ ...entry, path });
  }
  return { kept, skipped };
}

function memberText(node) {
  node = unwrapTs(node);
  if (!node) return '';
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  if (node.type === 'PrivateIdentifier' || node.type === 'PrivateName') return `#${node.name || node.id?.name}`;
  if (node.type === 'ChainExpression') return memberText(node.expression);
  if ((node.type === 'MemberExpression' || node.type === 'JSXMemberExpression') && !node.computed) return `${memberText(node.object)}.${memberText(node.property)}`;
  if (node.type === 'MemberExpression' && node.property.type === 'Literal') return `${memberText(node.object)}[${JSON.stringify(node.property.value)}]`;
  if (node.type === 'MemberExpression') return `${memberText(node.object)}[…]`;
  if (node.type === 'CallExpression') return `${memberText(node.callee)}()`;
  return '';
}
const keyName = key => key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : key?.type === 'PrivateIdentifier' || key?.type === 'PrivateName' ? `#${key.name || key.id?.name}` : '[computed]';

function isTestPath(path) { return /(^|\/)(__tests__|__mocks__|test|tests|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path); }

/** Build the project index. `entries` = [{ path, text }]. */
export function buildProject(entries, { name = 'Project' } = {}) {
  const files = Object.create(null);
  const functions = Object.create(null);
  const order = [];
  const classes = Object.create(null); // `${path}::${name}` -> class record
  const parseErrors = [];
  for (const { path, text } of entries) {
    const { ast, errors } = parseSource(text, path);
    if (errors.length) parseErrors.push({ path, message: errors[0] });
    files[path] = { path, text, ast, errors, functionIds: [], bindings: Object.create(null), exports: Object.create(null), exportAll: [], moduleCalls: [], isCommonJs: false };
    if (ast) indexFile(files[path]);
  }

  function addFunction(file, node, hint, parent, extra = {}) {
    const id = `${file.path}#${node.start}`;
    const anonymous = !hint.name;
    const name = hint.name || (hint.label ? hint.label : `anonymous@${node.loc?.start.line ?? '?'}`);
    const fn = {
      id, name, path: file.path, start: node.start, end: node.end,
      line: node.loc?.start.line ?? 0, endLine: node.loc?.end.line ?? 0,
      params: node.params.map(p => file.text.slice(p.start, p.end).replace(/\s+/g, ' ').slice(0, 60)),
      async: Boolean(node.async), generator: Boolean(node.generator),
      kind: extra.kind || (node.type === 'ArrowFunctionExpression' ? 'arrow' : 'function'),
      parentId: parent?.id || null, className: extra.className || null,
      topLevel: !parent, anonymous, node, exportedAs: [],
      qualifiedName: parent ? `${parent.qualifiedName} › ${name}` : name,
      localFunctions: Object.create(null), localInstances: Object.create(null), calls: [], callers: [],
      lines: (node.loc?.end.line ?? 0) - (node.loc?.start.line ?? 0) + 1,
    };
    functions[id] = fn; order.push(id); file.functionIds.push(id);
    if (parent && hint.name && extra.localBinding) parent.localFunctions[hint.name] = id;
    return fn;
  }

  function indexFile(file) {
    const { ast, text } = file;
    const nameOfExpression = node => text.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 48);
    // Module-level bindings for name resolution.
    const registerClass = (classNode, className, owner) => {
      const record = { name: className, path: file.path, superName: classNode.superClass ? memberText(classNode.superClass) : null, ctorId: null, methods: Object.create(null), statics: Object.create(null), node: classNode };
      classes[`${file.path}::${className}`] = record;
      if (!owner) file.bindings[className] = { kind: 'class', key: `${file.path}::${className}` };
      return record;
    };
    const walk = (node, parentFn, hint = {}, classRecord = null) => {
      if (!node || typeof node !== 'object') return;
      if (FUNCTION_TYPES.has(node.type)) {
        const fnHint = node.id?.name ? { name: node.id.name } : hint;
        const fn = addFunction(file, node, fnHint, parentFn, { kind: hint.kind, className: hint.className, localBinding: hint.localBinding || node.type === 'FunctionDeclaration' });
        if (hint.classRecord && hint.methodName) {
          if (hint.methodName === 'constructor') hint.classRecord.ctorId = fn.id;
          else (hint.isStatic ? hint.classRecord.statics : hint.classRecord.methods)[hint.methodName] = fn.id;
        }
        if (!parentFn && fnHint.name && (node.type === 'FunctionDeclaration' || hint.localBinding)) file.bindings[fnHint.name] = { kind: 'function', id: fn.id };
        if (hint.onFunction) hint.onFunction(fn);
        for (const param of node.params) walk(param, fn);
        walk(node.body, fn);
        return;
      }
      if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        const className = node.id?.name || hint.name || `AnonymousClass@${node.loc?.start.line}`;
        const record = registerClass(node, className, parentFn);
        if (parentFn) parentFn.localFunctions[className] = `class:${file.path}::${className}`;
        if (node.superClass) walk(node.superClass, parentFn);
        for (const member of node.body.body) {
          const memberName = keyName(member.key);
          if (member.type === 'MethodDefinition') {
            const kind = member.kind === 'constructor' ? 'constructor' : member.kind === 'get' ? 'getter' : member.kind === 'set' ? 'setter' : 'method';
            walk(member.value, parentFn, { name: `${className}.${memberName}`, kind, className, classRecord: record, methodName: memberName, isStatic: member.static });
          } else if ((member.type === 'PropertyDefinition' || member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') && member.value) {
            walk(member.value, parentFn, { name: `${className}.${memberName}`, kind: 'class-field', className, classRecord: record, methodName: memberName, isStatic: member.static });
          } else if (member.type === 'StaticBlock') walk(member, parentFn);
        }
        return;
      }
      if (node.type === 'ImportDeclaration' && !parentFn) {
        for (const spec of node.specifiers) {
          file.bindings[spec.local.name] = spec.type === 'ImportNamespaceSpecifier'
            ? { kind: 'namespace', source: node.source.value }
            : { kind: 'import', source: node.source.value, imported: spec.type === 'ImportDefaultSpecifier' ? 'default' : keyName(spec.imported) };
        }
        return;
      }
      if (node.type === 'ExportNamedDeclaration' && !parentFn) {
        if (node.source) {
          for (const spec of node.specifiers) file.exports[keyName(spec.exported)] = { kind: 'reexport', source: node.source.value, imported: spec.local ? keyName(spec.local) : 'default' };
          return;
        }
        for (const spec of node.specifiers || []) file.exports[keyName(spec.exported)] = { kind: 'local', local: keyName(spec.local) };
        const decl = node.declaration;
        if (decl?.id?.name) file.exports[decl.id.name] = { kind: 'local', local: decl.id.name };
        if (decl?.type === 'VariableDeclaration') for (const d of decl.declarations) if (d.id.type === 'Identifier') file.exports[d.id.name] = { kind: 'local', local: d.id.name };
        walk(decl, parentFn);
        return;
      }
      if (node.type === 'ExportAllDeclaration' && !parentFn) {
        if (node.exported) file.exports[keyName(node.exported)] = { kind: 'namespace', source: node.source.value };
        else file.exportAll.push(node.source.value);
        return;
      }
      if (node.type === 'ExportDefaultDeclaration' && !parentFn) {
        const decl = node.declaration;
        if (decl.type === 'Identifier') { file.exports.default = { kind: 'local', local: decl.name }; return; }
        const fallback = basename(file.path) === 'index' ? basename(dirname(file.path)) || 'default' : basename(file.path);
        walk(decl, parentFn, { name: decl.id?.name || fallback, localBinding: true, onFunction: fn => { fn.exportedAs.push('default'); file.exports.default = { kind: 'fn', id: fn.id }; } });
        if (decl.type === 'ClassDeclaration' || decl.type === 'ClassExpression') file.exports.default = { kind: 'local', local: decl.id?.name || fallback };
        if (decl.type === 'ObjectExpression') file.exports.default = { kind: 'object', members: objectMembers(decl) };
        return;
      }
      if (node.type === 'VariableDeclarator') {
        const id = node.id;
        const init = unwrapTs(node.init);
        if (id.type === 'Identifier' && init) {
          if (FUNCTION_TYPES.has(init.type) || init.type === 'ClassExpression') { walk(init, parentFn, { name: id.name, localBinding: true }); return; }
          if (!parentFn) {
            if (init.type === 'ObjectExpression') {
              walk(init, parentFn, { objectName: id.name });
              file.bindings[id.name] = { kind: 'object', members: objectMembers(init) };
              return;
            }
            const req = requireSource(init);
            if (req) { file.bindings[id.name] = { kind: 'namespace', source: req, commonjs: true }; file.isCommonJs = true; return; }
            const wrapped = wrappedFunction(init); // memo(() => ...), forwardRef(function ...)
            if (wrapped) { walk(init, parentFn, { name: id.name }); return; }
          } else if (init.type === 'ObjectExpression') { walk(init, parentFn, { objectName: id.name }); return; }
          if (parentFn && init.type === 'NewExpression') parentFn.localInstances[id.name] = init.callee;
          if (!parentFn && init.type === 'NewExpression') file.bindings[id.name] = { kind: 'instance', callee: init.callee };
        }
        if (id.type === 'ObjectPattern' && !parentFn && init) {
          const req = requireSource(init);
          if (req) {
            file.isCommonJs = true;
            for (const prop of id.properties) if (prop.type === 'Property' && prop.value.type === 'Identifier') file.bindings[prop.value.name] = { kind: 'import', source: req, imported: keyName(prop.key) };
            return;
          }
        }
        walk(id, parentFn); walk(node.init, parentFn, { name: id.type === 'Identifier' ? id.name : undefined });
        return;
      }
      if (node.type === 'AssignmentExpression') {
        const leftText = memberText(node.left);
        const right = unwrapTs(node.right);
        if (!parentFn && leftText) {
          const commonName = leftText.replace(/^module\.exports\.?/, '').replace(/^exports\./, '');
          const isExport = /^(module\.exports|exports)(\.|$)/.test(leftText);
          if (isExport) file.isCommonJs = true;
          if (leftText === 'module.exports') {
            if (right.type === 'ObjectExpression') {
              for (const [member, ref] of Object.entries(objectMembers(right))) file.exports[member] = ref;
              file.exports.default = { kind: 'object', members: objectMembers(right) };
              walk(right, parentFn, { objectName: 'module.exports' });
              return;
            }
            if (right.type === 'Identifier') { file.exports.default = { kind: 'local', local: right.name }; return; }
            const req = requireSource(right);
            if (req) { file.exportAll.push(req); return; }
          }
          if (FUNCTION_TYPES.has(right.type) || right.type === 'ClassExpression') {
            const fnName = commonName || basename(file.path);
            walk(right, parentFn, { name: isExport ? fnName : leftText, onFunction: fn => { if (isExport) { const exportName = commonName || 'default'; file.exports[exportName] = { kind: 'fn', id: fn.id }; fn.exportedAs.push(exportName); } else if (/\.prototype\.[\w$]+$/.test(leftText)) { const [cls, , method] = leftText.split('.'); const record = classes[`${file.path}::${cls}`]; if (record) record.methods[method] = fn.id; } } });
            return;
          }
          if (isExport && right.type === 'Identifier') { file.exports[commonName || 'default'] = { kind: 'local', local: right.name }; return; }
        }
        walk(node.left, parentFn);
        walk(node.right, parentFn, { name: leftText && (FUNCTION_TYPES.has(right?.type)) ? leftText.replace(/^this\./, '') : undefined });
        return;
      }
      if (node.type === 'Property' && hint.objectName !== undefined) {
        // fallthrough handled by ObjectExpression below
      }
      if (node.type === 'ObjectExpression') {
        for (const prop of node.properties) {
          if (prop.type === 'Property') {
            const propName = keyName(prop.key);
            const value = unwrapTs(prop.value);
            if (FUNCTION_TYPES.has(value?.type)) {
              walk(value, parentFn, { name: hint.objectName ? `${hint.objectName}.${propName}` : propName, kind: prop.kind === 'get' ? 'getter' : prop.kind === 'set' ? 'setter' : prop.method ? 'method' : undefined });
            } else {
              if (prop.computed) walk(prop.key, parentFn);
              walk(prop.value, parentFn, value?.type === 'ObjectExpression' ? { objectName: hint.objectName ? `${hint.objectName}.${propName}` : propName } : {});
            }
          } else walk(prop, parentFn);
        }
        return;
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'JSXOpeningElement') {
        recordCall(file, parentFn, node);
        const calleeLabel = node.type === 'JSXOpeningElement' ? memberText(node.name) : memberText(node.callee) || 'call';
        if (node.type === 'JSXOpeningElement') {
          for (const attr of node.attributes) {
            if (attr.type === 'JSXAttribute' && attr.value?.type === 'JSXExpressionContainer') walk(attr.value.expression, parentFn, { label: `${calleeLabel} ${attr.name.name || ''} handler`.trim() });
            else walk(attr, parentFn);
          }
          return;
        }
        walk(node.callee, parentFn);
        const short = calleeLabel.split('.').slice(-1)[0].replace('()', '');
        node.arguments.forEach((arg, i) => walk(arg, parentFn, FUNCTION_TYPES.has(unwrapTs(arg)?.type) ? { label: `${short} callback${node.arguments.length > 1 ? ` #${i + 1}` : ''}`, name: hint.name && wrappedFunction(node) ? hint.name : undefined } : {}));
        return;
      }
      if (node.type === 'ExpressionStatement' && !parentFn) {
        // Top-level side-effect statements are entry signals (e.g. main();).
        walk(node.expression, parentFn);
        return;
      }
      forEachChild(node, child => walk(child, parentFn));
    };
    function objectMembers(objectNode) {
      const members = Object.create(null);
      for (const prop of objectNode.properties) {
        if (prop.type !== 'Property') continue;
        const propName = keyName(prop.key);
        const value = unwrapTs(prop.value);
        if (value?.type === 'Identifier') members[propName] = { kind: 'local', local: value.name };
        else if (FUNCTION_TYPES.has(value?.type)) members[propName] = { kind: 'fnNode', node: value };
      }
      return members;
    }
    function requireSource(node) {
      node = unwrapTs(node);
      if (node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') return node.arguments[0].value;
      if (node?.type === 'MemberExpression') return requireSource(node.object);
      return null;
    }
    function wrappedFunction(node) {
      node = unwrapTs(node);
      return node?.type === 'CallExpression' && node.arguments.some(a => FUNCTION_TYPES.has(unwrapTs(a)?.type)) && /^(React\.)?(memo|forwardRef|useCallback|useMemo|observer|connect|styled|withRouter|compose)$/.test(memberText(node.callee)) ? node : null;
    }
    void nameOfExpression;
    for (const statement of ast.body) walk(statement, null);
    // Function nodes inside object members (fnNode) -> resolve ids now that they exist.
    const fixMembers = members => { for (const [k, ref] of Object.entries(members)) if (ref.kind === 'fnNode') members[k] = { kind: 'fn', id: `${file.path}#${ref.node.start}` }; };
    for (const binding of Object.values(file.bindings)) if (binding.kind === 'object') fixMembers(binding.members);
    for (const ref of Object.values(file.exports)) if (ref.kind === 'object') fixMembers(ref.members);
    for (const [k, ref] of Object.entries(file.exports)) if (ref.kind === 'fnNode') file.exports[k] = { kind: 'fn', id: `${file.path}#${ref.node.start}` };
  }

  function recordCall(file, parentFn, node) {
    const site = { node, start: node.start, end: node.end, type: node.type, path: file.path };
    if (parentFn) parentFn.calls.push(site); else file.moduleCalls.push(site);
  }

  // ---------- Resolution ----------
  const filePaths = Object.keys(files);
  const fileSet = new Set(filePaths);
  const topDirs = [...new Set(filePaths.map(p => p.split('/')[0]))];
  function resolveModule(fromPath, request) {
    if (typeof request !== 'string') return null;
    const candidates = [];
    const cleaned = request.replace(/\?.*$/, '');
    if (cleaned.startsWith('.')) candidates.push(normalizePath(`${dirname(fromPath)}/${cleaned}`));
    else {
      const bare = cleaned.replace(/^@\//, '').replace(/^~\//, '');
      for (const dir of topDirs) { candidates.push(normalizePath(`${dir}/${bare}`)); candidates.push(normalizePath(`${dir}/src/${bare}`)); }
      candidates.push(normalizePath(bare));
    }
    for (const base of candidates) {
      if (!base) continue;
      for (const ext of RESOLVE_EXTENSIONS) { if (fileSet.has(base + ext)) return base + ext; }
      const swapped = base.replace(/\.(m?js|jsx)$/, '');
      if (swapped !== base) for (const ext of RESOLVE_EXTENSIONS) if (fileSet.has(swapped + ext)) return swapped + ext;
    }
    return null;
  }
  function resolveExport(path, exportName, depth = 0) {
    const file = files[path];
    if (!file || depth > 12) return null;
    const ref = file.exports[exportName];
    if (ref) {
      if (ref.kind === 'fn') return { kind: 'fn', id: ref.id };
      if (ref.kind === 'object') return { kind: 'object', members: ref.members, path };
      if (ref.kind === 'local') return resolveBinding(path, ref.local, depth + 1);
      if (ref.kind === 'reexport') { const target = resolveModule(path, ref.source); return target ? resolveExport(target, ref.imported, depth + 1) : { kind: 'external', module: ref.source, member: ref.imported }; }
      if (ref.kind === 'namespace') { const target = resolveModule(path, ref.source); return target ? { kind: 'namespace', path: target } : { kind: 'external', module: ref.source }; }
    }
    if (exportName === 'default' && file.isCommonJs) {
      // module.exports.x = ... style modules behave like namespaces when default-imported.
      return { kind: 'namespace', path };
    }
    for (const source of file.exportAll) {
      const target = resolveModule(path, source);
      const found = target && resolveExport(target, exportName, depth + 1);
      if (found) return found;
    }
    // Fall back to a same-named local binding (common with loose CJS exports).
    if (file.isCommonJs && file.bindings[exportName]) return resolveBinding(path, exportName, depth + 1);
    return null;
  }
  function resolveBinding(path, name, depth = 0) {
    const file = files[path];
    const binding = file?.bindings[name];
    if (!binding || depth > 12) return null;
    if (binding.kind === 'function') return { kind: 'fn', id: binding.id };
    if (binding.kind === 'class') return { kind: 'class', key: binding.key };
    if (binding.kind === 'object') return { kind: 'object', members: binding.members, path };
    if (binding.kind === 'namespace') { const target = resolveModule(path, binding.source); return target ? { kind: 'namespace', path: target } : { kind: 'external', module: binding.source }; }
    if (binding.kind === 'import') { const target = resolveModule(path, binding.source); return target ? (resolveExport(target, binding.imported, depth + 1) || { kind: 'missing', module: binding.source, member: binding.imported }) : { kind: 'external', module: binding.source, member: binding.imported }; }
    return null;
  }
  function resolveName(path, fn, name) {
    for (let cursor = fn; cursor; cursor = cursor.parentId ? functions[cursor.parentId] : null) {
      const local = cursor.localFunctions[name];
      if (local) return local.startsWith('class:') ? { kind: 'class', key: local.slice(6) } : { kind: 'fn', id: local };
      if (cursor.node.params.some(p => p.type === 'Identifier' && p.name === name)) return { kind: 'param', name };
    }
    return resolveBinding(path, name);
  }
  function classMethod(classKey, method, isStatic = false, depth = 0) {
    const record = classes[classKey];
    if (!record || depth > 8) return null;
    const id = isStatic ? record.statics[method] : method === 'constructor' ? record.ctorId : record.methods[method];
    if (id) return id;
    if (record.superName) {
      const parent = resolveBinding(record.path, record.superName);
      if (parent?.kind === 'class') return classMethod(parent.key, method, isStatic, depth + 1);
    }
    return null;
  }
  function memberOf(target, member) {
    if (!target) return null;
    if (target.kind === 'namespace') return resolveExport(target.path, member);
    if (target.kind === 'object') { const ref = target.members[member]; if (!ref) return null; return ref.kind === 'fn' ? ref : ref.kind === 'local' ? resolveBinding(target.path, ref.local) : null; }
    if (target.kind === 'class') { const id = classMethod(target.key, member, true); return id ? { kind: 'fn', id } : null; }
    if (target.kind === 'external') return { kind: 'external', module: target.module, member: `${target.member && target.member !== 'default' ? target.member + '.' : ''}${member}` };
    return null;
  }
  function resolveCallee(path, fn, calleeNode) {
    const callee = unwrapTs(calleeNode?.type === 'ChainExpression' ? calleeNode.expression : calleeNode);
    if (!callee) return null;
    if (callee.type === 'Identifier' || callee.type === 'JSXIdentifier') return resolveName(path, fn, callee.name);
    if ((callee.type === 'MemberExpression' || callee.type === 'JSXMemberExpression') && !callee.computed) {
      const member = keyName(callee.property);
      const object = unwrapTs(callee.object);
      if (object.type === 'ThisExpression' || object.type === 'Super') {
        let owner = fn;
        while (owner && !owner.className) owner = owner.parentId ? functions[owner.parentId] : null;
        if (!owner) return null;
        const key = `${owner.path}::${owner.className}`;
        if (object.type === 'Super') {
          const record = classes[key];
          const parent = record?.superName && resolveBinding(record.path, record.superName);
          const id = parent?.kind === 'class' && classMethod(parent.key, member);
          return id ? { kind: 'fn', id } : null;
        }
        const id = classMethod(key, member) || classMethod(key, member, true);
        return id ? { kind: 'fn', id } : null;
      }
      if (object.type === 'Identifier') {
        // `const log = new Logger(); log.write()` -> Logger.prototype.write
        let ctor = null;
        for (let cursor = fn; cursor && !ctor; cursor = cursor.parentId ? functions[cursor.parentId] : null) ctor = cursor.localInstances[object.name] || null;
        if (!ctor && files[path].bindings[object.name]?.kind === 'instance') ctor = files[path].bindings[object.name].callee;
        const cls = ctor && resolveCallee(path, fn, ctor);
        if (cls?.kind === 'class') { const id = classMethod(cls.key, member); return id ? { kind: 'fn', id } : null; }
      }
      return memberOf(resolveCallee(path, fn, object), member);
    }
    return null;
  }
  const toTarget = (resolved, isNew) => {
    if (!resolved) return null;
    if (resolved.kind === 'fn' && functions[resolved.id]) return { targetId: resolved.id };
    if (resolved.kind === 'class') { const id = classMethod(resolved.key, 'constructor'); return { targetId: id || null, className: classes[resolved.key]?.name }; }
    if (resolved.kind === 'external' || resolved.kind === 'missing') return { external: `${resolved.module}${resolved.member && resolved.member !== 'default' ? ' → ' + resolved.member : ''}` };
    void isNew;
    return null;
  };
  const resolveSite = (fn, site) => {
    const callee = site.type === 'JSXOpeningElement' ? site.node.name : site.node.callee;
    if (site.type === 'JSXOpeningElement' && callee.type === 'JSXIdentifier' && /^[a-z]/.test(callee.name)) return null; // DOM element
    const target = toTarget(resolveCallee(site.path, fn, callee), site.type === 'NewExpression');
    return { ...site, label: site.type === 'JSXOpeningElement' ? `<${memberText(callee)}>` : `${site.type === 'NewExpression' ? 'new ' : ''}${memberText(callee) || '(expression)'}`, ...(target || {}) };
  };
  for (const id of order) {
    const fn = functions[id];
    fn.calls = fn.calls.map(site => resolveSite(fn, site)).filter(Boolean);
  }
  for (const id of order) for (const call of functions[id].calls) if (call.targetId && functions[call.targetId] && !functions[call.targetId].callers.includes(id)) functions[call.targetId].callers.push(id);
  const moduleEntryCalls = [];
  for (const file of Object.values(files)) {
    file.moduleCalls = file.moduleCalls.map(site => resolveSite(null, site)).filter(Boolean);
    for (const call of file.moduleCalls) if (call.targetId) moduleEntryCalls.push(call.targetId);
  }
  // Functions that are passed as values (callbacks/handlers referenced by name) count as "used".
  const referenced = new Set(moduleEntryCalls);

  // ---------- Entry point ranking ----------
  const reachCache = new Map();
  const reach = id => {
    if (reachCache.has(id)) return reachCache.get(id);
    const seen = new Set([id]); const stack = [id];
    while (stack.length && seen.size < 5000) { const cur = functions[stack.pop()]; for (const c of cur.calls) if (c.targetId && !seen.has(c.targetId)) { seen.add(c.targetId); stack.push(c.targetId); } }
    reachCache.set(id, seen.size - 1); return seen.size - 1;
  };
  const scored = order.map(id => {
    const fn = functions[id];
    let score = 0;
    const base = fn.name.split('.').pop();
    if (base === 'main') score += 1000 + (fn.topLevel ? 120 : 0);
    if (referenced.has(id)) score += 650;
    if (/^(run|start|init|bootstrap|cli|app|App|index|server|handler)$/i.test(base)) score += 120;
    if (/(^|\/)(index|main|app|server|cli|entry)\.[cm]?[jt]sx?$/i.test(fn.path)) score += 140;
    if (!fn.callers.length) score += 150;
    if (fn.topLevel) score += 80; else score -= 300;
    if (fn.anonymous) score -= 200;
    score += Math.min(reach(id), 400) * 1.5;
    score -= fn.path.split('/').length * 3;
    if (isTestPath(fn.path)) score -= 700;
    return { id, score };
  }).sort((a, b) => b.score - a.score);
  const entryCandidates = scored.slice(0, 15).map(s => s.id);

  return {
    name, files, functions, order, classes, parseErrors,
    entryCandidates, rootId: entryCandidates[0] || null,
    stats: { files: filePaths.length, functions: order.length, calls: order.reduce((n, id) => n + functions[id].calls.length, 0) },
    resolveModule, resolveExport, resolveBinding, classMethod,
  };
}

/** Ranked fuzzy-ish search over function names, qualified names and files. */
export function searchFunctions(project, query, limit = 40) {
  if (!project) return [];
  const q = query.trim().toLowerCase();
  const all = project.order.map(id => project.functions[id]);
  if (!q) return project.entryCandidates.map(id => project.functions[id]).concat(all.filter(f => f.topLevel && !project.entryCandidates.includes(f.id))).slice(0, limit);
  const results = [];
  for (const fn of all) {
    const name = fn.name.toLowerCase(), base = name.split('.').pop(), qualified = fn.qualifiedName.toLowerCase(), path = fn.path.toLowerCase();
    let score = -1;
    if (base === q || name === q) score = 100;
    else if (base.startsWith(q) || name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (qualified.includes(q)) score = 40;
    else if (path.includes(q)) score = 20;
    else {
      // subsequence match: "clcTot" -> calculateTotal
      let i = 0; for (const ch of name) if (ch === q[i]) i++;
      if (i === q.length) score = 10;
    }
    if (score >= 0) results.push({ fn, score: score + (fn.topLevel ? 5 : 0) - (fn.anonymous ? 8 : 0) });
  }
  return results.sort((a, b) => b.score - a.score || a.fn.name.length - b.fn.name.length).slice(0, limit).map(r => r.fn);
}

/** Source text of a function. */
export const functionSource = (project, fn) => project.files[fn.path].text.slice(fn.start, fn.end);
