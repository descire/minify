"use strict";

const objectCollapse = require("./object-collapse");
const arrayCollapse = require("./array-collapse");
const setCollapse = require("./set-collapse");

const collapsers = [
  objectCollapse,
  arrayCollapse,
  setCollapse,
];

function getFunctionParent(path, scopeParent) {
  const parent = path.findParent((p) => p.isFunction());
  // don"t traverse higher than the function the var is defined in.
  return parent === scopeParent ? null : parent;
}

function getFunctionReferences(path, scopeParent, references = new Set()) {
  for (let func = getFunctionParent(path, scopeParent); func; func = getFunctionParent(func, scopeParent)) {
    const id = func.node.id;
    const binding = id && func.scope.getBinding(id.name);

    if (!binding) {
      continue;
    }

    binding.referencePaths.forEach((path) => {
      if (!references.has(path)) {
        references.add(path);
        getFunctionReferences(path, scopeParent, references);
      }
    });
  }
  return references;
}

function getIdAndFunctionReferences(name, parent) {
  const binding = parent.scope.getBinding(name);

  return binding.referencePaths.reduce((references, ref) => {
    references.add(ref);
    getFunctionReferences(ref, parent, references);
    return references;
  }, new Set());
}

function validateTopLevel(path) {
  // Ensures the structure is of the form (roughly):
  // {
  //   ...
  //   var foo = expr;
  //   ...
  // }
  // returns null if not of this form
  // otherwise returns [foo as string, ?rval, index of the variable declaration]

  const declarations = path.get("declarations");
  if (declarations.length !== 1) {
    return;
  }

  const declaration = declarations[0];
  const id = declaration.get("id"), init = declaration.get("init");
  if (!id.isIdentifier()) {
    return;
  }

  const parent = path.parentPath;
  if (!parent.isBlockParent() || !parent.isScopable()) {
    return;
  }

  const body = parent.get("body");
  const startIndex = body.indexOf(path);
  if (startIndex === -1) {
    return;
  }

  return [id.node.name, init, startIndex];
}

function collectExpressions(path, checkExprType) {
  // input: ExprStatement => "a | SequenceExpression
  // SequenceExpression => "a list
  // Validates "a is of the right type
  // returns null if found inconsistency, else returns Array<"a>
  if (path.isExpressionStatement()) {
    const exprs = collectExpressions(path.get("expression"), checkExprType);
    return (exprs !== null) ? exprs : null;
  }

  if (path.isSequenceExpression()) {
    const exprs = path.get("expressions")
                      .map((p) => collectExpressions(p, checkExprType));
    if (exprs.some((e) => e === null)) {
      return null;
    } else {
      return exprs.reduce((s, n) => s.concat(n), []);  // === Array.flatten
    }
  }

  if (checkExprType(path)) {
    return [path];
  }

  return null;
}

function getContiguousStatementsAndExpressions(body, start, end, checkExprType, checkExpr) {
  const statements = [];
  let allExprs = [];
  for (let i = start; i < end; i++) {
    const exprs = collectExpressions(body[i], checkExprType);
    if (exprs === null || !exprs.every((e) => checkExpr(e))) {
      break;
    }
    statements.push(body[i]);
    allExprs = allExprs.concat(exprs);
  }
  return [statements, allExprs];
}


module.exports = function({ types: t }) {
  return {
    name: "transform-consecutive-attribute-defs",
    visitor: {
      VariableDeclaration(path) {
        const topLevel = validateTopLevel(path);
        if (topLevel === null) {
          return;
        }

        const [name, init, startIndex] = topLevel;
        const references = getIdAndFunctionReferences(name, path.parentPath);
        const body = path.parentPath.get("body");

        for (let collapser of collapsers) {
          if (!collapser.checkInitType(init)) {
            continue;
          }

          const [statements, exprs] = getContiguousStatementsAndExpressions(
            body,
            startIndex + 1,
            body.length,
            collapser.checkExpressionType,
            collapser.makeCheckExpression(name, references)
          );

          if (statements.length > 0) {
            const addons = exprs.map((e) => collapser.extractAddon(e));
            addons.forEach((addon) => collapser.addAddon(t, addon, init));
            statements.forEach((s) => s.remove());
          }
        }
      },
    },
  };
};
