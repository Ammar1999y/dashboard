/**
 * Read by `tests/unit/route-auth-flags.test.ts` through the type checker and
 * never run: one function per shape the gate analyzer must follow or refuse.
 */
import type { HandlerInput } from '@/lib/http/contract';

import { verifyLoginAttempt } from '@/lib/auth/login-guard';
import { requireReauthWindow } from '@/lib/auth/reauth/window';
import { requirePermission } from '@/lib/http/session';

const OPTIONS = { resource: 'users', action: 'edit' } as const;
const flag = Math.random() > 0.5;

export const reauthTrue = (ctx: HandlerInput) =>
  requirePermission(ctx, { resource: 'users', action: 'edit', reauth: true });

export const reauthFalse = (ctx: HandlerInput) =>
  requirePermission(ctx, { resource: 'users', action: 'edit', reauth: false });

export const reauthAbsent = (ctx: HandlerInput) =>
  requirePermission(ctx, { resource: 'users', action: 'edit' });

const steps = {
  check: async (userId: string, sessionId: string) =>
    requireReauthWindow(userId, sessionId),
};

export const viaObjectProperty = () => steps.check('user', 'session');

class Gatekeeper {
  verify = (options: Parameters<typeof verifyLoginAttempt>[0]) =>
    verifyLoginAttempt(options);

  async check(userId: string, sessionId: string) {
    await requireReauthWindow(userId, sessionId);
  }
}

export const viaClassField = (
  options: Parameters<typeof verifyLoginAttempt>[0]
) => new Gatekeeper().verify(options);

export const viaClassMethod = () => new Gatekeeper().check('user', 'session');

export const optionsByReference = (ctx: HandlerInput) =>
  requirePermission(ctx, OPTIONS);

export const optionsBySpread = (ctx: HandlerInput) =>
  requirePermission(ctx, { ...OPTIONS, reauth: true });

export const reauthByExpression = (ctx: HandlerInput) =>
  requirePermission(ctx, { resource: 'users', action: 'edit', reauth: flag });

export const reauthShorthand = (ctx: HandlerInput) => {
  const reauth = flag;
  return requirePermission(ctx, { resource: 'users', action: 'edit', reauth });
};

export const spreadArguments = (ctx: HandlerInput) =>
  requirePermission(...([ctx, OPTIONS] as const));

export const checkByReference = (ctx: HandlerInput) =>
  [ctx].map((each) => requirePermission.call(null, each, OPTIONS));

async function checkWindow(userId: string, sessionId: string) {
  await requireReauthWindow(userId, sessionId);
}

const shorthand = { checkWindow };

export const viaShorthandProperty = () =>
  shorthand.checkWindow('user', 'session');

const { checkWindow: destructured } = shorthand;

export const viaDestructuredProperty = () => destructured('user', 'session');

const gate = {
  get run() {
    return () => requireReauthWindow('user', 'session');
  },
};

export const viaGetter = () => gate.run();

const keyed = { check: () => requireReauthWindow('user', 'session') };

export const viaLiteralKey = () => keyed['check']();

export const viaComputedKey = (key: 'check') => keyed[key]();

let late: (() => Promise<void>) | undefined;

export function armLate() {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- the shape under test
  late = () => requireReauthWindow('user', 'session');
}

export const viaLateAssignment = () => late?.();

let unassigned: (() => Promise<void>) | undefined;

export const viaUnassigned = () => unassigned?.();

let reassigned = async () => {};
reassigned = async () => {
  await requireReauthWindow('user', 'session');
};

export const viaReassignedBinding = () => reassigned();

const replaceable = { run: async () => {} };
// eslint-disable-next-line unicorn/no-immediate-mutation -- the shape under test
replaceable.run = async () => {
  await requireReauthWindow('user', 'session');
};

export const viaReassignedProperty = () => replaceable.run();

const holder = { run: async () => {} };
let { run: unpacked } = holder;
unpacked = async () => {
  await requireReauthWindow('user', 'session');
};

export const viaReassignedDestructuredBinding = () => unpacked();

let swapped = async () => {};
[swapped] = [async () => requireReauthWindow('user', 'session')];

export const viaDestructuringWrite = () => swapped();

const queued: Array<() => unknown> = [];
// eslint-disable-next-line unicorn/no-immediate-mutation, unicorn/no-top-level-side-effects -- the shape under test
queued.push(() => requireReauthWindow('user', 'session'));

export const viaIndexedCollection = () => queued[0]?.();

const libraryTyped: Array<typeof queueMicrotask> = [];

export const viaLibraryTypedElement = () => libraryTyped[0]?.(() => {});

const pipeline = [async () => requireReauthWindow('user', 'session')];

export const viaLoopElement = async () => {
  for (const step of pipeline) await step();
};

export const viaCallbackParameter = () => {
  pipeline.forEach((each) => void each());
};

const registry = new Map([['x', () => requireReauthWindow('user', 'session')]]);

export const viaReturnedValue = () => registry.get('x')?.();

let injected = async () => {};

export function inject(next: () => Promise<void>) {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- the shape under test
  injected = next;
}

// eslint-disable-next-line unicorn/no-top-level-side-effects -- the shape under test
inject(async () => {
  await requireReauthWindow('user', 'session');
});

export const viaSetterInjection = () => injected();

let replaced = async () => {};

function replace(next: () => Promise<void>) {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- the shape under test
  replaced = next;
}

export const setters = { replace };

export const viaEscapedSetter = () => replaced();

const assigned = { run: async () => {} };
// eslint-disable-next-line unicorn/no-immediate-mutation, unicorn/no-top-level-side-effects -- the shape under test
Object.assign(assigned, {
  run: async () => {
    await requireReauthWindow('user', 'session');
  },
});

export const viaObjectAssign = () => assigned.run();

class WithConstructor {
  constructor() {
    void requireReauthWindow('user', 'session');
  }
}

export const viaConstructor = () => new WithConstructor();

const named = { requirePermission };

export const permissionByShorthand = (ctx: HandlerInput) =>
  named.requirePermission(ctx, {
    resource: 'users',
    action: 'edit',
    reauth: true,
  });

const aliased = { perm: requirePermission };

export const permissionThroughProperty = (ctx: HandlerInput) =>
  aliased.perm(ctx, { resource: 'users', action: 'edit', reauth: true });

const checkers = {
  permission: (ctx: HandlerInput) => requirePermission(ctx, OPTIONS),
};

export const optionsBehindLiteralKey = (ctx: HandlerInput) =>
  checkers['permission'](ctx);
