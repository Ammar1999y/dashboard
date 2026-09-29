import type { CommitRenders } from './render-probe';
import type {
  DomRegion,
  LabEnvironment,
  LabEvent,
  LabEventKind,
  Mismatch,
  RenderTiming,
} from './types';
import type { QueryClient } from '@tanstack/react-query';

import { runChecks } from './checks';
import {
  isTableComponent,
  REGION_CHECKS,
  REGION_COMPONENTS,
} from './component-names';
import { LAB_QUERY_KEY } from './fake-server';
import { LAB_PROFILER_ID, useLab } from './lab-store';
import { hasChanges, RenderProbe } from './render-probe';
import { watchStores } from './store-watch';

// Manual input waits out the search box's 800ms debounce before it is judged.
const QUIET_MS: Record<LabEventKind, number> = {
  scenario: 350,
  manual: 900,
  passive: 900,
};

const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="tooltip"]';

const PANEL_SELECTOR = '[data-lab-panel]';

const CONTROL_SELECTOR =
  'button, input, [role="option"], [role="menuitem"], [role="combobox"], [cmdk-item]';

const LONG_FRAME_MS = 50;

// Named through `displayName`, which survives minification; if even this one
// is missing, the build dropped component names altogether.
const UNNAMED_PROBE = 'DataTableFrame';

/** `?probe=frames` forces the production-build measurement path in any build. */
const FORCE_FRAMES_PARAM = 'probe';

export type NoteFn = (text: string) => void;

interface OpenEvent {
  kind: LabEventKind;
  label: string;
  startedAt: number;
  lastFrameAt: number | null;
  maxFrameMs: number;
  longFrames: number;
  commits: number;
  renderMs: number;
  renders: Map<string, number>;
  mounts: Map<string, number>;
  unmounts: Map<string, number>;
  mutations: Partial<Record<DomRegion, number>>;
  stores: Map<string, number>;
  notes: string[];
  acting: boolean;
  verify?: () => Mismatch[];
}

const merge = (into: Map<string, number>, from: Map<string, number>) => {
  for (const [name, count] of from)
    into.set(name, (into.get(name) ?? 0) + count);
};

const toRecord = (map: Map<string, number>) =>
  Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));

function describe(event: Event, target: Element): string {
  const column = target
    .closest('[data-slot="table-head"]')
    ?.querySelector<HTMLElement>('[data-lab-col]')?.dataset.labCol;
  const control = target.closest(CONTROL_SELECTOR);
  const text = control?.classList.contains('resize-handler')
    ? 'resize handle'
    : (control?.getAttribute('aria-label') ??
      control?.getAttribute('placeholder') ??
      control?.textContent?.trim().slice(0, 40) ??
      '');
  const action =
    event.type === 'keydown'
      ? control?.tagName === 'INPUT'
        ? 'type'
        : `key ${(event as KeyboardEvent).key}`
      : 'press';
  return [action, column && `header[${column}]`, text && `"${text}"`]
    .filter(Boolean)
    .join(' ');
}

/**
 * For each region the checker found wrong: did its DOM change at all, and which
 * of its components rendered. "Rendered, DOM untouched" is reused output.
 */
function diagnose(
  open: OpenEvent,
  mismatches: Mismatch[],
  compiled: Record<string, boolean>
): string[] {
  return (['header', 'body'] as const).flatMap((region) => {
    if (!mismatches.some((m) => REGION_CHECKS[region].test(m.check))) return [];
    const rendered = [...open.renders]
      .filter(([name]) => REGION_COMPONENTS[region].test(name))
      .map(
        ([name, count]) =>
          `${name}×${count} ${compiled[name] ? '(compiled)' : '(not compiled)'}`
      );
    const mutations = open.mutations[region] ?? 0;
    const dom =
      mutations === 0
        ? 'DOM untouched'
        : `DOM changed (${mutations} mutations) but still wrong`;
    const who =
      rendered.length === 0
        ? `no ${region} component rendered`
        : `rendered: ${rendered.join(', ')}`;
    return [`${region}: ${dom}; ${who}`];
  });
}

class LabRecorder {
  private probe = new RenderProbe(
    () => useLab.getState().root,
    LAB_PROFILER_ID
  );
  private open: OpenEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanQueued = false;
  private frameLoop: number | null = null;
  private profilerSeen = false;
  private forceFrames = false;
  private waiters: ((event: LabEvent) => void)[] = [];
  private nextId = 1;
  private isFetching: () => boolean = () => false;

  private onMutations = (records: MutationRecord[]) => {
    let counted = false;
    for (const record of records) {
      const region = this.region(record.target);
      if (!region) continue;
      const open = this.ensureOpen();
      open.mutations[region] = (open.mutations[region] ?? 0) + 1;
      counted = true;
    }
    if (counted) this.touch();
  };

  private onStoreWrite = (label: string) => {
    const open = this.ensureOpen();
    open.stores.set(label, (open.stores.get(label) ?? 0) + 1);
    this.touch();
  };

  private onInteraction = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(PANEL_SELECTOR)) return;
    const inTable = useLab.getState().root?.contains(target);
    if (
      (!inTable && !target.closest(OVERLAY_SELECTOR)) ||
      this.open?.kind === 'scenario'
    )
      return;

    const label = describe(event, target);
    if (!this.open) this.openEvent('manual', label);
    else if (this.open.kind === 'passive') {
      this.open.kind = 'manual';
      this.open.label = label;
    } else if (!this.open.label.endsWith(label))
      this.open.label += ` → ${label}`;
    this.touch();
  };

  private settle = () => {
    const open = this.open;
    if (!open) return;
    if (open.acting || this.scanQueued || this.isFetching()) {
      this.touch();
      return;
    }
    this.close();
  };

  // Runs every frame while an event is open: the gap between frames is the
  // jank measure in every build, and without Profiler callbacks nothing else
  // announces a commit, so the tree is diffed here too.
  private onFrame = (now: number) => {
    this.frameLoop = null;
    const open = this.open;
    if (!open) return;
    if (open.lastFrameAt !== null) {
      const gap = now - open.lastFrameAt;
      open.maxFrameMs = Math.max(open.maxFrameMs, gap);
      if (gap > LONG_FRAME_MS) open.longFrames++;
    }
    open.lastFrameAt = now;
    if (this.timing() === 'frames') {
      const result = this.probe.scan();
      if (hasChanges(result)) {
        open.commits++;
        this.absorb(result);
        this.touch();
      }
    }
    this.frameLoop = requestAnimationFrame(this.onFrame);
  };

  private timing(): RenderTiming {
    return this.profilerSeen && !this.forceFrames ? 'profiler' : 'frames';
  }

  private environment(): LabEnvironment {
    const { reactBuild, strictMode } = this.probe.environment();
    const seen = this.probe.compiled();
    return {
      nodeEnv: process.env.NODE_ENV ?? 'unknown',
      reactBuild,
      strictMode,
      timing: this.timing(),
      namesMinified: reactBuild === 'production' && !(UNNAMED_PROBE in seen),
      compiled: Object.fromEntries(
        Object.entries(seen).filter(([name]) => isTableComponent(name))
      ),
    };
  }

  private absorb(result: CommitRenders) {
    const open = this.ensureOpen();
    merge(open.renders, result.renders);
    merge(open.mounts, result.mounts);
    merge(open.unmounts, result.unmounts);
  }

  private region(node: Node): DomRegion | null {
    const el = node instanceof Element ? node : node.parentElement;
    if (!el || el.closest(PANEL_SELECTOR)) return null;
    const root = useLab.getState().root;
    if (root?.contains(el)) {
      if (el.closest('[data-slot="table-header"]')) return 'header';
      if (el.closest('[data-slot="table-body"]')) return 'body';
      if (el.closest('[role="toolbar"]')) return 'toolbar';
      return 'table-other';
    }
    return el.closest(OVERLAY_SELECTOR) ? 'overlay' : null;
  }

  /**
   * `baseline` drops whatever rendered before this event started, which only
   * the frame loop can have missed; a passive event is opened by the very
   * change it records, so it never takes one.
   */
  private openEvent(
    kind: LabEventKind,
    label: string,
    baseline = kind !== 'passive'
  ): OpenEvent {
    if (baseline && this.timing() === 'frames') this.probe.scan();
    this.frameLoop ??= requestAnimationFrame(this.onFrame);
    this.open = {
      kind,
      label,
      startedAt: performance.now(),
      lastFrameAt: null,
      maxFrameMs: 0,
      longFrames: 0,
      commits: 0,
      renderMs: 0,
      renders: new Map(),
      mounts: new Map(),
      unmounts: new Map(),
      mutations: {},
      stores: new Map(),
      notes: [],
      acting: kind === 'scenario',
    };
    return this.open;
  }

  private ensureOpen(): OpenEvent {
    return this.open ?? this.openEvent('passive', '(no interaction)');
  }

  private touch() {
    clearTimeout(this.timer);
    const quiet = QUIET_MS[this.open?.kind ?? 'passive'];
    this.timer = setTimeout(this.settle, quiet);
  }

  private close() {
    const open = this.open;
    if (!open) return;
    const timing = this.timing();
    if (timing === 'frames') {
      const result = this.probe.scan();
      if (hasChanges(result)) {
        open.commits++;
        this.absorb(result);
      }
    }
    this.open = null;
    clearTimeout(this.timer);
    if (this.frameLoop !== null) cancelAnimationFrame(this.frameLoop);
    this.frameLoop = null;

    const { table, root, status } = useLab.getState();
    const mismatches: Mismatch[] =
      table && root
        ? runChecks(table, root, status)
        : [{ check: 'lab', detail: 'table not mounted' }];
    mismatches.push(...(open.verify?.() ?? []));
    const env = this.environment();

    const event: LabEvent = {
      id: this.nextId++,
      kind: open.kind,
      label: open.label,
      startedAt: Math.round(open.startedAt),
      wallMs: Math.round(performance.now() - open.startedAt),
      maxFrameMs: Math.round(open.maxFrameMs),
      longFrames: open.longFrames,
      timing,
      commits: open.commits,
      renderMs:
        timing === 'profiler' ? Math.round(open.renderMs * 10) / 10 : null,
      renders: toRecord(open.renders),
      mounts: toRecord(open.mounts),
      unmounts: toRecord(open.unmounts),
      mutations: open.mutations,
      stores: toRecord(open.stores),
      notes: [...open.notes, ...diagnose(open, mismatches, env.compiled)],
      mismatches,
    };
    useLab.setState((s) => ({ events: [...s.events, event], env }));
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(event);
  }

  attach(queryClient: QueryClient): () => void {
    this.isFetching = () =>
      queryClient.isFetching({ queryKey: [LAB_QUERY_KEY] }) > 0;
    this.forceFrames =
      new URLSearchParams(location.search).get(FORCE_FRAMES_PARAM) === 'frames';
    this.probe.scan();
    useLab.setState({ env: this.environment() });

    const unwatch = watchStores(queryClient, this.onStoreWrite);
    const observer = new MutationObserver(this.onMutations);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    document.addEventListener('pointerdown', this.onInteraction, {
      capture: true,
    });
    document.addEventListener('keydown', this.onInteraction, { capture: true });

    return () => {
      unwatch();
      observer.disconnect();
      document.removeEventListener('pointerdown', this.onInteraction, true);
      document.removeEventListener('keydown', this.onInteraction, true);
      clearTimeout(this.timer);
      if (this.frameLoop !== null) cancelAnimationFrame(this.frameLoop);
      this.frameLoop = null;
      this.open = null;
    };
  }

  /** Called from `<Profiler onRender>`, which only fires in development or `next build --profile`. */
  onCommit(actualDuration: number) {
    this.profilerSeen = true;
    if (this.forceFrames) return;
    const open = this.ensureOpen();
    open.commits++;
    open.renderMs += actualDuration;
    if (!this.scanQueued) {
      this.scanQueued = true;
      queueMicrotask(() => {
        this.scanQueued = false;
        this.absorb(this.probe.scan());
      });
    }
    this.touch();
  }

  /** Runs one scripted step and resolves once the UI has gone quiet and been checked. */
  async run(
    label: string,
    action: (note: NoteFn) => void | Promise<void>,
    verify?: () => Mismatch[]
  ): Promise<LabEvent> {
    if (this.open) this.close();
    const open = this.openEvent('scenario', label);
    open.verify = verify;
    const settled = new Promise<LabEvent>((resolve) => {
      this.waiters.push(resolve);
    });
    try {
      await action((text) => {
        open.notes.push(text);
      });
    } catch (error) {
      open.verify = () => [
        { check: 'scenario threw', detail: String(error) },
        ...(verify?.() ?? []),
      ];
    }
    open.acting = false;
    this.touch();
    return settled;
  }
}

export const labRecorder = new LabRecorder();
