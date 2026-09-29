export interface Mismatch {
  check: string;
  detail: string;
}

export type DomRegion =
  'header' | 'body' | 'toolbar' | 'table-other' | 'overlay' | 'page';

export type LabEventKind = 'scenario' | 'manual' | 'passive';

export type RenderTiming = 'profiler' | 'frames';

export interface LabEnvironment {
  nodeEnv: string;
  reactBuild: 'development' | 'production' | 'unknown';
  strictMode: boolean | null;
  timing: RenderTiming;
  /** Production build without `--no-mangling`: unnamed components are missing from the counts. */
  namesMinified: boolean;
  /** Table components seen, and whether React Compiler output ran for each. */
  compiled: Record<string, boolean>;
}

export interface LabEvent {
  id: number;
  kind: LabEventKind;
  label: string;
  startedAt: number;
  wallMs: number;
  /** Longest gap between two animation frames while the event was open. */
  maxFrameMs: number;
  /** Frames that took longer than 50ms. */
  longFrames: number;
  timing: RenderTiming;
  /** React commits under `profiler`; animation frames that saw a render under `frames`. */
  commits: number;
  /** Profiler `actualDuration`; `null` when the build has no profiling. */
  renderMs: number | null;
  notes: string[];
  renders: Record<string, number>;
  mounts: Record<string, number>;
  unmounts: Record<string, number>;
  mutations: Partial<Record<DomRegion, number>>;
  /** Writes to the data-table stores and lab query-cache actions, by name. */
  stores: Record<string, number>;
  mismatches: Mismatch[];
}
