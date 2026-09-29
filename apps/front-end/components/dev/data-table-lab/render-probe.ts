// Reads React's private fiber tree (React 19). Nothing here is public API: the
// field names are the ones React DevTools reads, re-checked at runtime so a
// React upgrade degrades to "no data" instead of wrong data.

interface Fiber {
  tag: number;
  mode: number;
  type: unknown;
  elementType: unknown;
  memoizedProps: unknown;
  memoizedState: unknown;
  updateQueue: unknown;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
}

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const HOST_ROOT = 3;
const FORWARD_REF = 11;
const PROFILER = 12;
const SIMPLE_MEMO_COMPONENT = 15;
const STRICT_LEGACY_MODE = 8;
// MemoComponent (14) is skipped: its inner component is a child fiber of its own.
const COUNTED_TAGS = new Set([
  FUNCTION_COMPONENT,
  CLASS_COMPONENT,
  FORWARD_REF,
  SIMPLE_MEMO_COMPONENT,
]);

const isFiber = (value: unknown): value is Fiber =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { tag?: unknown }).tag === 'number' &&
  'memoizedProps' in value &&
  'child' in value;

const typeName = (type: unknown): string | undefined => {
  if (typeof type === 'function')
    return (
      (type as { displayName?: string }).displayName || type.name || undefined
    );
  if (typeof type === 'object' && type !== null) {
    const t = type as {
      displayName?: string;
      type?: unknown;
      render?: unknown;
    };
    return t.displayName || typeName(t.type) || typeName(t.render);
  }
  return undefined;
};

const fiberName = (fiber: Fiber) =>
  typeName(fiber.elementType) ?? typeName(fiber.type) ?? '(anonymous)';

const fiberOf = (node: Element): Fiber | null => {
  const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
  const fiber: unknown = key
    ? (node as unknown as Record<string, unknown>)[key]
    : null;
  return isFiber(fiber) ? fiber : null;
};

const currentRootOf = (node: Element): Fiber | null => {
  let fiber = fiberOf(node);
  while (fiber?.return) fiber = fiber.return;
  if (fiber?.tag !== HOST_ROOT) return null;
  const root = fiber.stateNode as { current?: unknown } | null;
  return isFiber(root?.current) ? root.current : null;
};

// A compiled component keeps its `useMemoCache` slots on the update queue, in
// development and production builds alike.
const isCompiled = (fiber: Fiber) => {
  const queue = fiber.updateQueue as { memoCache?: unknown } | null;
  return typeof queue === 'object' && queue?.memoCache != null;
};

export interface CommitRenders {
  renders: Map<string, number>;
  mounts: Map<string, number>;
  unmounts: Map<string, number>;
}

export interface ReactEnvironment {
  reactBuild: 'development' | 'production' | 'unknown';
  strictMode: boolean | null;
}

export const hasChanges = (result: CommitRenders) =>
  result.renders.size > 0 || result.mounts.size > 0 || result.unmounts.size > 0;

const bump = (map: Map<string, number>, name: string) =>
  map.set(name, (map.get(name) ?? 0) + 1);

/**
 * Diffs the Profiler's subtree between commits. A function component that ran
 * gets a fresh hook list (`memoizedState`) or props object; one that bailed out
 * keeps both, so identity tells the two apart without instrumenting anything.
 */
export class RenderProbe {
  private ids = new WeakMap<Fiber, number>();
  private nextId = 1;
  private last = new Map<
    number,
    { state: unknown; props: unknown; name: string }
  >();
  private seen = new Set<number>();
  private compiledNames = new Map<string, boolean>();
  private env: ReactEnvironment = { reactBuild: 'unknown', strictMode: null };

  constructor(
    private readonly anchor: () => Element | null,
    private readonly profilerId: string
  ) {}

  private findProfiler(): Fiber | null {
    const anchor = this.anchor();
    const root = anchor ? currentRootOf(anchor) : null;
    const stack: Fiber[] = root ? [root] : [];
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber) break;
      if (
        fiber.tag === PROFILER &&
        (fiber.memoizedProps as { id?: unknown } | null)?.id === this.profilerId
      )
        return fiber;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return null;
  }

  private idOf(fiber: Fiber): { id: number; isNew: boolean } {
    const known =
      this.ids.get(fiber) ??
      (fiber.alternate ? this.ids.get(fiber.alternate) : undefined);
    const id = known ?? this.nextId++;
    this.ids.set(fiber, id);
    if (fiber.alternate) this.ids.set(fiber.alternate, id);
    return { id, isNew: known === undefined };
  }

  scan(): CommitRenders {
    const result: CommitRenders = {
      renders: new Map(),
      mounts: new Map(),
      unmounts: new Map(),
    };
    const profiler = this.findProfiler();
    if (!profiler) return result;
    this.env = {
      reactBuild: '_debugOwner' in profiler ? 'development' : 'production',
      strictMode: (profiler.mode & STRICT_LEGACY_MODE) !== 0,
    };

    const seen = new Set<number>();
    const stack: Fiber[] = profiler.child ? [profiler.child] : [];
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber) break;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
      if (!COUNTED_TAGS.has(fiber.tag)) continue;

      const name = fiberName(fiber);
      if (!this.compiledNames.get(name))
        this.compiledNames.set(name, isCompiled(fiber));
      const { id, isNew } = this.idOf(fiber);
      const previous = this.last.get(id);
      if (isNew || !previous) bump(result.mounts, name);
      else if (
        previous.state !== fiber.memoizedState ||
        previous.props !== fiber.memoizedProps
      )
        bump(result.renders, name);
      this.last.set(id, {
        state: fiber.memoizedState,
        props: fiber.memoizedProps,
        name,
      });
      seen.add(id);
    }

    for (const id of this.seen) {
      if (seen.has(id)) continue;
      const entry = this.last.get(id);
      if (entry) bump(result.unmounts, entry.name);
      this.last.delete(id);
    }
    this.seen = seen;
    return result;
  }

  environment(): ReactEnvironment {
    return this.env;
  }

  /** Every component name seen so far, and whether React Compiler output ran for it. */
  compiled(): Record<string, boolean> {
    return Object.fromEntries(this.compiledNames);
  }
}
