/**
 * `reauth` and `checksPassword` decide what a route's 401 and 429 publish, so
 * each is held to what its handler can reach. `tests/helpers/route-gates.ts`
 * says what the analyzer follows; a call site it cannot read fails here rather
 * than reading as "no gate".
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { Gate } from '@/tests/helpers/route-gates';

import { BINDINGS } from '@/modules';
import {
  createRouteGateAnalyzer,
  globFiles,
  REPO_ROOT,
} from '@/tests/helpers/route-gates';

import { PASSWORD_PROOF_PATHS } from '@/lib/auth/path-policy';
import { gateAsksReauth } from '@/lib/http/admit';
import { BETTER_AUTH_PASSWORD_LOCKOUT_PATHS } from '@/lib/http/openapi/better-auth-tables';

import { compareCodeUnits } from '@/utils/text';

const bindingFiles = globFiles('modules/**/*.ts');
const authFiles = globFiles('lib/auth/**/*.ts');
const FIXTURE = 'tests/fixtures/_route-gates-handler.ts';

const sorted = (values: Iterable<string>) =>
  [...values].toSorted(compareCodeUnits);

interface MethodGates {
  label: string;
  reauth: boolean;
  checksPassword: boolean;
  gates: ReadonlySet<Gate>;
}

/**
 * Filled once: the checker resolves lazily, so whichever case ran first used
 * to pay for every file its handler reaches, and timed out under load. Per
 * binding: its handler's reach, plus what its gate asks for.
 */
const byBindingFile = new Map<string, MethodGates[]>();
const endpoints: { path: string; gates: ReadonlySet<Gate> }[] = [];
const fixture = new Map<string, ReadonlySet<Gate> | Error>();

beforeAll(async () => {
  const analyzer = createRouteGateAnalyzer([
    ...bindingFiles,
    ...authFiles,
    FIXTURE,
  ]);
  for (const file of bindingFiles) {
    // eslint-disable-next-line no-unsanitized/method -- a module the glob above found in this repository
    const module: Record<string, unknown> = await import(
      path.join(REPO_ROOT, file)
    );
    const methods = analyzer
      .initializers(file)
      .entries()
      .flatMap(([name, initializer]) => {
        const binding = BINDINGS.find((entry) => entry === module[name]);
        if (!binding) return [];
        const gates = new Set(analyzer.reach(initializer));
        // The gate asks for the window itself on a plain permission route.
        if (gateAsksReauth(binding)) gates.add('window');
        return [
          {
            label: binding.key,
            reauth: binding.entry.policy.reauth,
            checksPassword: binding.entry.policy.checksPassword,
            gates,
          },
        ];
      })
      .toArray();
    byBindingFile.set(file, methods);
  }
  for (const file of authFiles)
    for (const endpoint of analyzer.authEndpoints(file))
      endpoints.push({
        path: endpoint.path,
        gates: analyzer.reach(endpoint.handler),
      });
  for (const [name, initializer] of analyzer.initializers(FIXTURE)) {
    try {
      fixture.set(name, analyzer.reach(initializer));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      fixture.set(name, error);
    }
  }
  // Several times this hook's cost measured with the integration tier running
  // alongside; the figures are in `reports/remaining-issues-fix-review-resolution.md` (#7).
}, 120_000);

describe('every route declares the gates its handler reaches', () => {
  test.each(bindingFiles)('%s', (file) => {
    const methods = byBindingFile.get(file) ?? [];
    for (const method of methods) {
      expect(method.reauth, method.label).toBe(method.gates.has('window'));
      expect(method.checksPassword, method.label).toBe(
        method.gates.has('password')
      );
    }
  });

  test('no binding was left out', () => {
    const checked = new Set(
      byBindingFile
        .values()
        .flatMap((methods) => methods.map((method) => method.label))
    );
    expect(
      BINDINGS.map((binding) => binding.key).filter((key) => !checked.has(key))
    ).toEqual([]);
  });

  test('the Better Auth lockout list is every endpoint that checks the password, and every one that can ask for it', () => {
    expect(endpoints.length).toBeGreaterThan(0);

    // A proof the hook takes (`PASSWORD_PROOF_PATHS`), or one the endpoint
    // asks for itself.
    const checksPassword = [
      ...PASSWORD_PROOF_PATHS,
      ...endpoints.filter((e) => e.gates.has('password')).map((e) => e.path),
    ];
    const asksForIt = [
      ...PASSWORD_PROOF_PATHS,
      ...endpoints
        .filter((e) => e.gates.has('reauthRequired') || e.gates.has('window'))
        .map((e) => e.path),
    ];
    const published = sorted(BETTER_AUTH_PASSWORD_LOCKOUT_PATHS);
    expect(published).toEqual(sorted(new Set(checksPassword)));
    expect(published).toEqual(sorted(new Set(asksForIt)));
  });
});

describe('the analyzer, on one fixture function per shape', () => {
  const gatesOf = (name: string) => {
    const result = fixture.get(name);
    if (!(result instanceof Set)) throw new Error(`${name}: ${String(result)}`);
    return sorted(result);
  };

  test.each<[string, Gate[]]>([
    ['reauthTrue', ['window']],
    ['reauthFalse', []],
    ['reauthAbsent', []],
    ['viaObjectProperty', ['window']],
    ['viaClassField', ['password']],
    ['viaClassMethod', ['window']],
    ['viaShorthandProperty', ['window']],
    ['viaDestructuredProperty', ['window']],
    ['viaGetter', ['window']],
    ['viaLiteralKey', ['window']],
    ['viaLateAssignment', ['window']],
    ['viaConstructor', ['window']],
    ['permissionByShorthand', ['window']],
  ])('%s', (name, gates) => {
    expect(gatesOf(name)).toEqual(gates);
  });

  test.each([
    [
      'optionsByReference',
      'requirePermission options are not an inline object literal',
    ],
    ['optionsBySpread', 'requirePermission options contain a spread'],
    [
      'reauthByExpression',
      'requirePermission `reauth` is not a literal true or false',
    ],
    [
      'reauthShorthand',
      'requirePermission `reauth` is not a property assignment',
    ],
    ['spreadArguments', 'requirePermission is called with a spread argument'],
    [
      'checkByReference',
      'requirePermission is referenced without being called',
    ],
    [
      'permissionThroughProperty',
      'requirePermission is referenced without being called',
    ],
    [
      'optionsBehindLiteralKey',
      'requirePermission options are not an inline object literal',
    ],
    ['viaComputedKey', 'calls through a computed key'],
    [
      'viaUnassigned',
      `calls ${FIXTURE}#unassigned, which the analyzer cannot follow`,
    ],
  ])('%s fails, naming the site', (name, why) => {
    const result = fixture.get(name);
    expect(result).toBeInstanceOf(Error);
    const message = result instanceof Error ? result.message : '';
    expect(message).toStartWith(`${FIXTURE}:`);
    expect(message).toInclude(`: ${why}`);
  });
});
