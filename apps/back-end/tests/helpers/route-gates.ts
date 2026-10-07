/**
 * The gates a function can reach, read off the type checker rather than the
 * text: a call resolves to its declaration whatever the import path or local
 * name. Followed, in any workspace file: function declarations, methods,
 * accessors, constructors under `new`, functions held in a variable, an object
 * property (shorthand included) or a class field, a callee held as any other
 * value through what that value resolves to, and an element-access call with a
 * literal key. `requirePermission`'s window is read from a literal `reauth`
 * at the call. What the analyzer cannot read throws, naming the site, instead
 * of reading as "no gate": unreadable options, `requirePermission` referenced
 * without a call, a computed key over workspace members, and a workspace callee
 * it cannot follow. Interface members and parameters are not followed: their
 * implementation is followed where it is written.
 */
import path from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = path.join(import.meta.dir, '..', '..');

export type Gate = 'window' | 'password' | 'reauthRequired';

/** The calls that define a Better Auth endpoint: the library's, and our keyed wrapper. */
const ENDPOINT_FACTORIES: ReadonlySet<string> = new Set([
  'createAuthEndpoint',
  'pluginEndpoint',
]);

/** Keyed `file#name`, the file relative to the workspace. */
const GATES: ReadonlyMap<string, Gate> = new Map([
  ['lib/auth/reauth/window.ts#requireReauthWindow', 'window'],
  ['lib/auth/login-guard.ts#verifyLoginAttempt', 'password'],
  ['lib/auth/errors.ts#reauthenticationRequired', 'reauthRequired'],
]);

/** Asks for the window only when called with `reauth: true`, read at the call. */
const PERMISSION_CHECK = 'lib/http/session.ts#requirePermission';

/** They restate an error something else raised, so following them proves nothing. */
const ERROR_MAPPERS: ReadonlySet<string> = new Set([
  'lib/auth/errors.ts#toAuthApiError',
  'lib/auth/errors.ts#asAuthError',
]);

export const globFiles = (pattern: string) =>
  Iterator.from(new Bun.Glob(pattern).scanSync(REPO_ROOT)).toArray();

function compilerOptions(): ts.CompilerOptions {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(REPO_ROOT, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        );
      },
    }
  );
  if (!config) throw new Error('tsconfig.json did not parse');
  return config.options;
}

function siteOf(node: ts.Node): string {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart());
  const file = path
    .relative(REPO_ROOT, source.fileName)
    .replaceAll(path.sep, '/');
  return `${file}:${line + 1}`;
}

function staticName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
    ? name.text
    : null;
}

/** Whether a `requirePermission` call asks for the window; throws when unreadable. */
function passesReauth(call: ts.CallExpression): boolean {
  const unreadable = (why: string) =>
    new Error(`${siteOf(call)}: requirePermission ${why}`);
  if (call.arguments.some((argument) => ts.isSpreadElement(argument)))
    throw unreadable('is called with a spread argument');
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options))
    throw unreadable('options are not an inline object literal');
  let reauth = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property))
      throw unreadable('options contain a spread');
    const name = staticName(property.name);
    if (name === null) throw unreadable('options have a computed key');
    if (name !== 'reauth') continue;
    if (!ts.isPropertyAssignment(property))
      throw unreadable('`reauth` is not a property assignment');
    const { kind } = property.initializer;
    if (kind === ts.SyntaxKind.TrueKeyword) reauth = true;
    else if (kind === ts.SyntaxKind.FalseKeyword) reauth = false;
    else throw unreadable('`reauth` is not a literal true or false');
  }
  return reauth;
}

/** What a declaration runs when reached, or null for anything that is not a function. */
function bodyOf(declaration: ts.Declaration): ts.Node | null {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    // An accessor runs on a read or a write, not only on a call.
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration)
  )
    return declaration.body ?? null;
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration)) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  )
    return declaration.initializer;
  return null;
}

/** A value supplied elsewhere: its implementation is followed where it is written. */
function isOpaque(declaration: ts.Declaration): boolean {
  return (
    ts.isPropertySignature(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isParameter(declaration) ||
    // A loop's element or a caught error, supplied like a parameter.
    (ts.isVariableDeclaration(declaration) &&
      (ts.isCatchClause(declaration.parent) ||
        ts.isForOfStatement(declaration.parent.parent) ||
        ts.isForInStatement(declaration.parent.parent))) ||
    (ts.isBindingElement(declaration) &&
      ts.walkUpBindingElementsAndPatterns(declaration).kind ===
        ts.SyntaxKind.Parameter) ||
    // An overload signature: the implementation is among the declarations.
    ((ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
      declaration.body === undefined)
  );
}

/** The call or `new` that `node`, a callee's name, is the callee of. */
function invocationOf(
  node: ts.Node
): ts.CallExpression | ts.NewExpression | null {
  let callee: ts.Node =
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      ? node.parent
      : node;
  while (
    ts.isParenthesizedExpression(callee.parent) ||
    ts.isNonNullExpression(callee.parent)
  )
    callee = callee.parent;
  const { parent } = callee;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === callee
    ? parent
    : null;
}

export interface RouteGateAnalyzer {
  /** Every gate `root` reaches. */
  reach(root: ts.Node): ReadonlySet<Gate>;
  /** Each top-level variable's initializer in `file`, by name. */
  initializers(file: string): Map<string, ts.Expression>;
  /** Each endpoint `file` defines: its literal path and its handler. */
  authEndpoints(file: string): { path: string; handler: ts.Node }[];
}

export function createRouteGateAnalyzer(
  files: readonly string[]
): RouteGateAnalyzer {
  const program = ts.createProgram({
    rootNames: files.map((file) => path.join(REPO_ROOT, file)),
    options: compilerOptions(),
  });
  const checker = program.getTypeChecker();

  /**
   * `pluginEndpoint` (`lib/auth/plugin-endpoint.ts`) hands its own `path` on to
   * `createAuthEndpoint`. That call defines no endpoint: each `pluginEndpoint`
   * call site does, with its literal path and its handler.
   */
  function forwardsWrapperPath(call: ts.CallExpression): boolean {
    const [pathArgument] = call.arguments;
    if (!pathArgument || !ts.isIdentifier(pathArgument)) return false;
    const declaration =
      checker.getSymbolAtLocation(pathArgument)?.valueDeclaration;
    return (
      declaration !== undefined &&
      ts.isParameter(declaration) &&
      ts.isFunctionDeclaration(declaration.parent) &&
      declaration.parent.name?.text === 'pluginEndpoint'
    );
  }

  function sourceFileOf(file: string): ts.SourceFile {
    const source = program.getSourceFile(path.join(REPO_ROOT, file));
    if (!source) throw new Error(`${file} is not in the program`);
    return source;
  }

  /** `file#name`, or null for a declaration outside this workspace's sources. */
  function keyOf(declaration: ts.Declaration): string | null {
    const source = declaration.getSourceFile();
    const file = path
      .relative(REPO_ROOT, source.fileName)
      .replaceAll(path.sep, '/');
    if (
      source.isDeclarationFile ||
      file.startsWith('..') ||
      file.includes('node_modules/')
    )
      return null;
    const name = ts.getNameOfDeclaration(declaration);
    return name ? `${file}#${name.getText()}` : null;
  }

  const resolved = (symbol: ts.Symbol | undefined) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  /**
   * What a shorthand property or a destructured local stands for: the value
   * it names, or the property it reads. Null for any other declaration.
   */
  function aliasedDeclarations(
    declaration: ts.Declaration
  ): readonly ts.Declaration[] | null {
    if (ts.isShorthandPropertyAssignment(declaration))
      return (
        resolved(checker.getShorthandAssignmentValueSymbol(declaration))
          ?.declarations ?? []
      );
    if (
      !ts.isBindingElement(declaration) ||
      !ts.isObjectBindingPattern(declaration.parent) ||
      ts.walkUpBindingElementsAndPatterns(declaration).kind ===
        ts.SyntaxKind.Parameter
    )
      return null;
    const name = declaration.propertyName ?? declaration.name;
    const text =
      ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (text === null) return null;
    const type = checker.getTypeAtLocation(declaration.parent);
    return checker.getPropertyOfType(type, text)?.declarations ?? [];
  }

  /** Every value assigned to a variable declared without one, in its file. */
  function assignedValues(declaration: ts.VariableDeclaration): ts.Node[] {
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const values: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === symbol
      )
        values.push(node.right);
      ts.forEachChild(node, visit);
    };
    if (symbol) visit(declaration.getSourceFile());
    return values;
  }

  function symbolAt(node: ts.Identifier): ts.Symbol | undefined {
    return resolved(
      ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
    );
  }

  const scanned = new Map<ts.Node, { gates: Gate[]; next: ts.Node[] }>();

  /** The gates `root` names itself, and the code it refers to. */
  function scan(root: ts.Node): { gates: Gate[]; next: ts.Node[] } {
    const cached = scanned.get(root);
    if (cached) return cached;
    const found: { gates: Gate[]; next: ts.Node[] } = { gates: [], next: [] };

    /** `declaration`, reached at `site`, and invoked by `invocation` if any. */
    const consider = (
      declaration: ts.Declaration,
      site: ts.Node,
      invocation: ts.CallExpression | ts.NewExpression | null
    ): void => {
      const targets = aliasedDeclarations(declaration);
      if (targets) {
        for (const target of targets) consider(target, site, invocation);
        return;
      }
      const key = keyOf(declaration);
      if (key === null || ERROR_MAPPERS.has(key)) return;
      const gate = GATES.get(key);
      if (gate) {
        found.gates.push(gate);
        return;
      }
      if (key === PERMISSION_CHECK) {
        if (invocation && ts.isCallExpression(invocation)) {
          if (passesReauth(invocation)) found.gates.push('window');
        } else if (!ts.isTypeQueryNode(site.parent))
          throw new Error(
            `${siteOf(site)}: requirePermission is referenced without being called, so its options cannot be read`
          );
        return;
      }
      const body = bodyOf(declaration);
      if (body) {
        found.next.push(body);
        return;
      }
      if (!invocation) return;
      if (
        ts.isClassDeclaration(declaration) ||
        ts.isClassExpression(declaration)
      ) {
        // Construction runs the constructors and the instance field initializers.
        for (const member of declaration.members)
          if (ts.isConstructorDeclaration(member) && member.body)
            found.next.push(member.body);
          else if (
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            // A function a field holds runs when called, not when constructed.
            !ts.isArrowFunction(member.initializer) &&
            !ts.isFunctionExpression(member.initializer) &&
            !member.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
            )
          )
            found.next.push(member.initializer);
        return;
      }
      if (
        (ts.isVariableDeclaration(declaration) ||
          ts.isPropertyAssignment(declaration) ||
          ts.isPropertyDeclaration(declaration)) &&
        declaration.initializer
      ) {
        found.next.push(declaration.initializer);
        return;
      }
      if (isOpaque(declaration)) return;
      const assigned = ts.isVariableDeclaration(declaration)
        ? assignedValues(declaration)
        : [];
      if (assigned.length > 0) {
        found.next.push(...assigned);
        return;
      }
      throw new Error(
        `${siteOf(site)}: calls ${key}, which the analyzer cannot follow`
      );
    };

    /** `object[key](…)`: a literal key resolves; a computed one over workspace members throws. */
    const considerElementCall = (
      callee: ts.ElementAccessExpression,
      call: ts.CallExpression
    ): void => {
      const type = checker.getTypeAtLocation(callee.expression);
      const argument = callee.argumentExpression;
      if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) {
        const declarations =
          checker.getPropertyOfType(type, argument.text)?.declarations ?? [];
        for (const declaration of declarations)
          consider(declaration, callee, call);
        return;
      }
      const workspaceMembers = checker
        .getPropertiesOfType(type)
        .some((property) =>
          (property.declarations ?? []).some(
            (declaration) => keyOf(declaration) !== null
          )
        );
      if (workspaceMembers)
        throw new Error(
          `${siteOf(callee)}: calls through a computed key, which the analyzer cannot follow`
        );
    };

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const invocation = invocationOf(node);
        const declarations = symbolAt(node)?.declarations ?? [];
        for (const declaration of declarations)
          consider(declaration, node, invocation);
      } else if (ts.isCallExpression(node)) {
        let callee: ts.Expression = node.expression;
        while (
          ts.isParenthesizedExpression(callee) ||
          ts.isNonNullExpression(callee)
        )
          callee = callee.expression;
        if (ts.isElementAccessExpression(callee))
          considerElementCall(callee, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    scanned.set(root, found);
    return found;
  }

  return {
    reach(root) {
      const gates = new Set<Gate>();
      const seen = new Set<ts.Node>();
      const pending = [root];
      for (let node = pending.pop(); node; node = pending.pop()) {
        if (seen.has(node)) continue;
        seen.add(node);
        const found = scan(node);
        for (const gate of found.gates) gates.add(gate);
        pending.push(...found.next);
      }
      return gates;
    },

    initializers(file) {
      const found = new Map<string, ts.Expression>();
      for (const statement of sourceFileOf(file).statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations)
          if (declaration.initializer)
            found.set(declaration.name.getText(), declaration.initializer);
      }
      return found;
    },

    authEndpoints(file) {
      const endpoints: { path: string; handler: ts.Node }[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ENDPOINT_FACTORIES.has(node.expression.text) &&
          !forwardsWrapperPath(node)
        ) {
          const [pathArgument] = node.arguments;
          const handler = node.arguments.at(-1);
          // The type, not the syntax: an endpoint re-wrapped from the library
          // passes the library's own `path`.
          const pathType =
            pathArgument && checker.getTypeAtLocation(pathArgument);
          if (!handler || !pathType?.isStringLiteral())
            throw new Error(`${file}: an endpoint whose path is not a literal`);
          endpoints.push({ path: pathType.value, handler });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFileOf(file));
      return endpoints;
    },
  };
}
