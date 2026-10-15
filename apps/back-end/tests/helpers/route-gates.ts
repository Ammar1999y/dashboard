/**
 * The gates a function can reach, read off the type checker rather than the
 * text: a call resolves to its declaration whatever the import path or local
 * name. Followed, in any workspace file: function declarations, methods,
 * accessors, constructors under `new`, functions held in a variable, an object
 * property (shorthand included) or a class field, every value a later write
 * puts there (`Object.assign` with a literal included, and a stored parameter
 * through the arguments its call sites pass), a callee held as any other value
 * through what that value resolves to, and an element-access call with a
 * literal key naming a declared member. `requirePermission`'s window is read
 * from a literal `reauth` at the call. Interface members and parameters are not
 * followed: their implementation is followed where it is written.
 *
 * What the analyzer cannot read throws, naming the site, instead of reading as
 * "no gate": unreadable options, `requirePermission` referenced without a
 * call, a write that is not one whole value, and a workspace callee it cannot
 * follow. So does a call of code held as data outside a parameter: any other
 * element key, a loop element or callback parameter fed from a workspace
 * binding, and the function another call returned (`registry.get(key)()`).
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

/** The assignments whose right side is the whole new value. */
const WHOLE_VALUE_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function unwrapped(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** What a destructuring assignment's left side writes to. */
function patternTargets(node: ts.Expression): ts.Expression[] {
  let target = unwrapped(node);
  // A default: `[a = fallback] = …` writes `a`.
  while (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    target = unwrapped(target.left);
  if (ts.isArrayLiteralExpression(target))
    return target.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : patternTargets(
            ts.isSpreadElement(element) ? element.expression : element
          )
    );
  if (ts.isObjectLiteralExpression(target))
    return target.properties.flatMap((property) =>
      ts.isShorthandPropertyAssignment(property)
        ? [property.name]
        : ts.isPropertyAssignment(property)
          ? patternTargets(property.initializer)
          : ts.isSpreadAssignment(property)
            ? patternTargets(property.expression)
            : []
    );
  return [target];
}

function isFunction(node: ts.Node): boolean {
  const value = ts.isExpression(node) ? unwrapped(node) : node;
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value);
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
    isFunction(declaration.initializer)
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

  /** `source` relative to the workspace, or null for a file outside its sources. */
  function workspaceFile(source: ts.SourceFile): string | null {
    const file = path
      .relative(REPO_ROOT, source.fileName)
      .replaceAll(path.sep, '/');
    return source.isDeclarationFile ||
      file.startsWith('..') ||
      file.includes('node_modules/')
      ? null
      : file;
  }

  /** `file#name`, or null for a declaration outside this workspace's sources. */
  function keyOf(declaration: ts.Declaration): string | null {
    const file = workspaceFile(declaration.getSourceFile());
    const name = ts.getNameOfDeclaration(declaration);
    return file !== null && name ? `${file}#${name.getText()}` : null;
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

  function symbolAt(node: ts.Identifier): ts.Symbol | undefined {
    return resolved(
      ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
    );
  }

  /** `Object.assign(…)`, by the global it resolves to, not by spelling alone. */
  function isObjectAssign(call: ts.CallExpression): boolean {
    const callee = unwrapped(call.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== 'assign' ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'Object'
    )
      return false;
    const declarations =
      checker.getSymbolAtLocation(callee.expression)?.declarations ?? [];
    return declarations.some(
      (declaration) => declaration.getSourceFile().isDeclarationFile
    );
  }

  function inWorkspace(declaration: ts.Declaration | undefined): boolean {
    return (
      declaration !== undefined &&
      workspaceFile(declaration.getSourceFile()) !== null
    );
  }

  /**
   * The binding a value is read out of: `steps` in `steps.forEach`, `registry`
   * in `registry.get(…)`. A parameter is followed where its arguments are
   * written.
   */
  function holderKind(
    expression: ts.Expression
  ): 'parameter' | 'workspace' | null {
    let root = unwrapped(expression);
    while (
      ts.isPropertyAccessExpression(root) ||
      ts.isElementAccessExpression(root) ||
      ts.isCallExpression(root) ||
      ts.isNonNullExpression(root)
    )
      root = unwrapped(root.expression);
    if (!ts.isIdentifier(root)) return null;
    const declarations = symbolAt(root)?.declarations ?? [];
    if (declarations.some(ts.isParameter)) return 'parameter';
    return declarations.some(inWorkspace) ? 'workspace' : null;
  }

  /**
   * Whether `call` may run workspace code held as data: read out of a workspace
   * binding (`holder`), or typed by a signature declared here. A method of the
   * receiver's type, such as `text[Symbol.iterator]()`, is a call on a value
   * rather than of one, so only a workspace method counts.
   */
  function mayHoldWorkspaceCode(
    call: ts.CallExpression | ts.NewExpression,
    holder: ts.Expression | undefined
  ): boolean {
    const kind = holder === undefined ? null : holderKind(holder);
    if (kind === 'parameter') return false;
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (
      declaration &&
      (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration))
    )
      return inWorkspace(declaration);
    return kind === 'workspace' || inWorkspace(declaration);
  }

  /**
   * Where a loop element or an inline callback's parameter gets its value: the
   * collection iterated, or the receiver of the call it is passed to. Any other
   * parameter is followed where its arguments are written.
   */
  function dataSource(
    declaration: ts.Declaration
  ): { what: string; holder: ts.Expression | undefined } | null {
    if (
      ts.isVariableDeclaration(declaration) &&
      (ts.isForOfStatement(declaration.parent.parent) ||
        ts.isForInStatement(declaration.parent.parent))
    )
      return {
        what: 'a loop element',
        holder: declaration.parent.parent.expression,
      };
    if (!ts.isParameter(declaration)) return null;
    const callback = declaration.parent;
    if (
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isCallExpression(callback.parent) ||
      !callback.parent.arguments.some((argument) => argument === callback)
    )
      return null;
    const callee = unwrapped(callback.parent.expression);
    return {
      what: 'a callback parameter',
      holder: ts.isPropertyAccessExpression(callee)
        ? callee.expression
        : undefined,
    };
  }

  interface Writes {
    values: ts.Expression[];
    /** Writes whose value is not one expression: destructuring, `+=`, `++`, a loop target. */
    unreadable: ts.Node[];
  }

  const passedArguments = new Map<ts.ParameterDeclaration, Writes>();

  /**
   * What each call site in the workspace passes for `parameter`. Its function
   * referenced other than by a call, called with a spread, or unnamed (an
   * inline callback) is passed values nothing here can see.
   */
  function argumentsFor(parameter: ts.ParameterDeclaration): Writes {
    const cached = passedArguments.get(parameter);
    if (cached) return cached;
    const passed: Writes = { values: [], unreadable: [] };
    passedArguments.set(parameter, passed);
    const fn = parameter.parent;
    const named =
      ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)
        ? fn
        : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
            ts.isVariableDeclaration(fn.parent)
          ? fn.parent
          : undefined;
    const name = named && ts.getNameOfDeclaration(named);
    const position = fn.parameters.indexOf(parameter);
    if (!named || !name || !ts.isIdentifier(name) || parameter.dotDotDotToken) {
      passed.unreadable.push(parameter);
      return passed;
    }
    const visit = (node: ts.Node) => {
      if (
        node !== name &&
        ts.isIdentifier(node) &&
        node.text === name.text &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isExportSpecifier(node.parent) &&
        !ts.isTypeQueryNode(node.parent) &&
        (symbolAt(node)?.declarations ?? []).includes(named)
      ) {
        const call = invocationOf(node);
        const argument =
          call &&
          ts.isCallExpression(call) &&
          !call.arguments.slice(0, position + 1).some(ts.isSpreadElement)
            ? call.arguments[position]
            : null;
        if (argument) passed.values.push(argument);
        else if (argument === null) passed.unreadable.push(node);
      }
      ts.forEachChild(node, visit);
    };
    for (const source of program.getSourceFiles())
      if (workspaceFile(source) !== null) visit(source);
    return passed;
  }

  let writeIndex: Map<ts.Declaration, Writes> | undefined;

  /** Every write to `declaration` anywhere in the workspace, its initializer aside. */
  function writesTo(declaration: ts.Declaration): Writes {
    writeIndex ??= indexWrites();
    return writeIndex.get(declaration) ?? { values: [], unreadable: [] };
  }

  function indexWrites(): Map<ts.Declaration, Writes> {
    const index = new Map<ts.Declaration, Writes>();
    const recordTo = (
      symbol: ts.Symbol | undefined,
      site: ts.Node,
      value: ts.Expression | null
    ) => {
      const declarations = symbol?.declarations ?? [];
      for (const declaration of declarations) {
        const writes = index.get(declaration) ?? { values: [], unreadable: [] };
        index.set(declaration, writes);
        if (value) writes.values.push(value);
        else writes.unreadable.push(site);
      }
    };
    const record = (target: ts.Expression, value: ts.Expression | null) =>
      recordTo(
        ts.isIdentifier(target)
          ? symbolAt(target)
          : ts.isPropertyAccessExpression(target)
            ? checker.getSymbolAtLocation(target.name)
            : ts.isElementAccessExpression(target)
              ? checker.getSymbolAtLocation(target.argumentExpression)
              : undefined,
        target,
        value
      );
    const recordPattern = (pattern: ts.Expression) => {
      for (const target of patternTargets(pattern)) record(target, null);
    };
    // `Object.assign(target, { name: value })` writes `value` to `name`; a
    // source it cannot read property by property writes every property.
    const recordAssign = (call: ts.CallExpression) => {
      const [target, ...sources] = call.arguments;
      if (!target) return;
      const type = checker.getTypeAtLocation(target);
      const property = (name: string) => checker.getPropertyOfType(type, name);
      for (const source of sources) {
        const literal = unwrapped(source);
        if (!ts.isObjectLiteralExpression(literal)) {
          for (const each of checker.getPropertiesOfType(type))
            recordTo(each, source, null);
          continue;
        }
        for (const member of literal.properties) {
          const name = ts.isSpreadAssignment(member)
            ? null
            : staticName(member.name);
          if (name === null) {
            for (const each of checker.getPropertiesOfType(type))
              recordTo(each, member, null);
          } else if (ts.isPropertyAssignment(member))
            recordTo(property(name), member, member.initializer);
          else if (ts.isShorthandPropertyAssignment(member))
            recordTo(property(name), member, member.name);
          else recordTo(property(name), member, null);
        }
      }
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const target = unwrapped(node.left);
        if (
          ts.isArrayLiteralExpression(target) ||
          ts.isObjectLiteralExpression(target)
        )
          recordPattern(target);
        else
          record(
            target,
            WHOLE_VALUE_ASSIGNMENTS.has(node.operatorToken.kind)
              ? node.right
              : null
          );
      } else if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        record(unwrapped(node.operand), null);
      else if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
      )
        recordPattern(node.initializer);
      else if (ts.isCallExpression(node) && isObjectAssign(node))
        recordAssign(node);
      ts.forEachChild(node, visit);
    };
    for (const source of program.getSourceFiles())
      if (workspaceFile(source) !== null) visit(source);
    return index;
  }

  const scanned = new Map<ts.Node, { gates: Gate[]; next: ts.Node[] }>();

  /** The gates `root` names itself, and the code it refers to. */
  function scan(root: ts.Node): { gates: Gate[]; next: ts.Node[] } {
    const cached = scanned.get(root);
    if (cached) return cached;
    const found: { gates: Gate[]; next: ts.Node[] } = { gates: [], next: [] };

    /**
     * Each later write to `declaration`, followed as the declaration itself
     * is: a function always, any value when called. Answers how many were.
     */
    const followWrites = (
      declaration: ts.Declaration,
      key: string,
      invocation: ts.CallExpression | ts.NewExpression | null,
      holdsFunction: boolean
    ): number => {
      const writes = writesTo(declaration);
      // A parameter written here stands for what its call sites pass.
      const values: ts.Expression[] = [];
      const unreadables: ts.Node[] = [...writes.unreadable];
      const pending = [...writes.values];
      const seen = new Set<ts.Node>();
      for (let value = pending.pop(); value; value = pending.pop()) {
        if (seen.has(value)) continue;
        seen.add(value);
        const read = unwrapped(value);
        const parameter = ts.isIdentifier(read)
          ? (symbolAt(read)?.declarations ?? []).find(ts.isParameter)
          : undefined;
        if (!parameter) {
          values.push(value);
          continue;
        }
        const passed = argumentsFor(parameter);
        pending.push(...passed.values);
        unreadables.push(...passed.unreadable);
      }
      const written = values.filter(
        (value) => invocation !== null || isFunction(value)
      );
      const [unreadable] = unreadables;
      if (
        unreadable &&
        (invocation !== null || holdsFunction || written.length > 0)
      )
        throw new Error(
          `${siteOf(unreadable)}: writes ${key} in a form the analyzer cannot follow`
        );
      found.next.push(...written);
      return written.length;
    };

    /** `declaration`, reached at `site`, and invoked by `invocation` if any. */
    const consider = (
      declaration: ts.Declaration,
      site: ts.Node,
      invocation: ts.CallExpression | ts.NewExpression | null
    ): void => {
      const targets = aliasedDeclarations(declaration);
      if (targets) {
        for (const target of targets) consider(target, site, invocation);
        const alias = keyOf(declaration);
        if (alias !== null)
          followWrites(
            declaration,
            alias,
            invocation,
            targets.some((target) => bodyOf(target) !== null)
          );
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
      const written = followWrites(declaration, key, invocation, body !== null);
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
      const source = dataSource(declaration);
      if (source && mayHoldWorkspaceCode(invocation, source.holder))
        throw new Error(
          `${siteOf(site)}: calls ${key}, ${source.what}, which the analyzer cannot follow`
        );
      if (isOpaque(declaration) || written > 0) return;
      throw new Error(
        `${siteOf(site)}: calls ${key}, which the analyzer cannot follow`
      );
    };

    /**
     * `object[key](…)`: a literal key naming a declared member resolves. Any
     * other key, a literal reaching an array or index signature included,
     * throws when the object or the element holds workspace code.
     */
    const considerElementCall = (
      callee: ts.ElementAccessExpression,
      call: ts.CallExpression
    ): void => {
      const type = checker.getTypeAtLocation(callee.expression);
      const argument = callee.argumentExpression;
      const literal =
        ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument);
      const declarations = literal
        ? (checker.getPropertyOfType(type, argument.text)?.declarations ?? [])
        : [];
      if (declarations.length > 0) {
        for (const declaration of declarations)
          consider(declaration, callee, call);
        return;
      }
      const workspaceCode =
        checker
          .getPropertiesOfType(type)
          .some((property) =>
            (property.declarations ?? []).some(inWorkspace)
          ) || mayHoldWorkspaceCode(call, callee);
      if (workspaceCode)
        throw new Error(
          `${siteOf(callee)}: calls through ${literal ? 'an undeclared' : 'a computed'} key, which the analyzer cannot follow`
        );
    };

    /**
     * `inner(…)(…)`: a workspace function's body holds what it returns, and is
     * followed through `inner`. Anything else, such as `registry.get(key)`,
     * returns data.
     */
    const considerReturnedCall = (
      inner: ts.CallExpression,
      call: ts.CallExpression
    ): void => {
      const callee = unwrapped(inner.expression);
      const symbol = ts.isPropertyAccessExpression(callee)
        ? resolved(checker.getSymbolAtLocation(callee.name))
        : ts.isIdentifier(callee)
          ? symbolAt(callee)
          : undefined;
      const declarations = symbol?.declarations ?? [];
      if (
        declarations.some(
          (declaration) => inWorkspace(declaration) && bodyOf(declaration)
        )
      )
        return;
      if (mayHoldWorkspaceCode(call, inner))
        throw new Error(
          `${siteOf(call)}: calls what another call returned, which the analyzer cannot follow`
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
        else if (ts.isCallExpression(callee))
          considerReturnedCall(callee, node);
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
