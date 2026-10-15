import type { PagePermission } from '@/types/permission';
import type {
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';

import {
  DASHBOARD_PAGE_LABELS,
  PERMISSION_ACTION_LABELS,
} from '@app/shared/messages/permissions';
import {
  DASHBOARD_PAGE_NAMES,
  getAvailablePermissions,
  OWN_ACTION_MAP,
} from '@app/shared/permissions/constants';
import { actorHoldsAction } from '@app/shared/permissions/scope';
import {
  MSG_PERM_ALLOWED,
  MSG_PERM_CELL,
  MSG_PERM_COLUMN_APPLIED,
  MSG_PERM_COLUMN_CLEARED,
  MSG_PERM_COLUMN_GRANTED,
  MSG_PERM_COLUMN_SKIPPED,
  MSG_PERM_DEPENDENTS_ADJUSTED,
  MSG_PERM_LOWERED_TO,
  MSG_PERM_NOT_GRANTED,
  MSG_PERM_NOT_GRANTED_ON,
  MSG_PERM_NOT_OFFERED,
  MSG_PERM_OPTION_LOCKED,
  MSG_PERM_PAGE_SUMMARY,
  MSG_PERM_PREREQUISITES,
  MSG_PERM_REVOKED,
  MSG_PERM_ROW_CLEARED,
  MSG_PERM_ROW_GRANTED,
  MSG_PERM_SPECIAL_CELL,
  MSG_PERM_VIEW_LOCKED,
  MSG_PERM_VIEW_RAISED,
  PERMISSION_RAISE_CAUSES,
  PERMISSION_SCOPE_LABELS,
  PERMISSION_SCOPE_PHRASES,
  PERMISSION_VERB_LABELS,
} from '@/constants/messages';

/**
 * The matrix as the owner reads it: one cell per page and verb, each at a
 * level. A verb with an own-records variant has three levels (none, own, all);
 * any other is on or off, stored as 0 or 2.
 */
export const PAGES = DASHBOARD_PAGE_NAMES;
export const VERBS = ['view', 'edit', 'delete', 'create', 'special'] as const;

export type Verb = (typeof VERBS)[number];
export type Level = 0 | 1 | 2;
export type TriState = 'none' | 'mixed' | 'all';

export interface CellRef {
  page: DashboardPage;
  verb: Verb;
}

export interface CellDef extends CellRef {
  kind: 'scope' | 'binary';
  levels: readonly Level[];
  /** What level 2 grants, and all a binary cell grants. */
  action: PermissionAction;
  /** What level 1 grants. */
  own?: PermissionAction;
}

export type PageLevels = Readonly<Partial<Record<Verb, Level>>>;
export type Levels = Readonly<Record<DashboardPage, PageLevels>>;

export const VERB_LABELS: Record<Verb, string> = PERMISSION_VERB_LABELS;

const SCOPED_VERBS = [
  'view',
  'edit',
  'delete',
] as const satisfies readonly (keyof typeof OWN_ACTION_MAP & Verb)[];
const NON_SPECIAL = new Set<PermissionAction>([
  'create',
  ...SCOPED_VERBS,
  ...SCOPED_VERBS.map((verb) => OWN_ACTION_MAP[verb]),
]);
const SCOPED_VERB_SET = new Set<Verb>(SCOPED_VERBS);
/** The writes a lower view can take away. */
const DEPENDENT_VERBS = ['edit', 'delete', 'special'] as const;

const SCOPED_LEVELS: readonly Level[] = [0, 1, 2];
const BINARY_LEVELS: readonly Level[] = [0, 2];

/**
 * The reads each write needs, any one of them. Mirrors the refinement on
 * `pagePermissionSchema` in `@app/shared/validation/permissions`: a matrix the
 * UI produces must be one the server accepts.
 */
const VIEW_GATES: Partial<
  Record<PermissionAction, readonly PermissionAction[]>
> = {
  edit: ['view'],
  delete: ['view'],
  publish: ['view'],
  editOwn: ['view', 'viewOwn'],
  deleteOwn: ['view', 'viewOwn'],
};

/**
 * The page's actions outside view, edit, delete and create. The matrix has one
 * column for them, so it shows the first; a test holds every page to one.
 */
export const specialActionsOf = (page: DashboardPage): PermissionAction[] =>
  getAvailablePermissions(page).filter((action) => !NON_SPECIAL.has(action));

function buildCell(page: DashboardPage, verb: Verb): CellDef | null {
  const offered = getAvailablePermissions(page);
  if (verb === 'special') {
    const [action] = specialActionsOf(page);
    return action
      ? { page, verb, kind: 'binary', levels: BINARY_LEVELS, action }
      : null;
  }
  if (verb === 'create') {
    return offered.includes('create')
      ? { page, verb, kind: 'binary', levels: BINARY_LEVELS, action: 'create' }
      : null;
  }
  if (!offered.includes(verb)) return null;
  const own = OWN_ACTION_MAP[verb];
  return offered.includes(own)
    ? { page, verb, kind: 'scope', levels: SCOPED_LEVELS, action: verb, own }
    : { page, verb, kind: 'binary', levels: BINARY_LEVELS, action: verb };
}

const CELLS = {} as Record<DashboardPage, Record<Verb, CellDef | null>>;
const PAGE_VERBS = {} as Record<DashboardPage, readonly Verb[]>;
for (const page of PAGES) {
  const cells = {} as Record<Verb, CellDef | null>;
  for (const verb of VERBS) cells[verb] = buildCell(page, verb);
  CELLS[page] = cells;
  PAGE_VERBS[page] = VERBS.filter((verb) => cells[verb]);
}

export const cellDef = (page: DashboardPage, verb: Verb): CellDef | null =>
  CELLS[page][verb];

/** The verbs `page` offers, in column order. */
export const verbsOf = (page: DashboardPage): readonly Verb[] =>
  PAGE_VERBS[page];

/** The pages that offer `verb`, in row order. */
export const pagesOf = (verb: Verb): DashboardPage[] =>
  PAGES.filter((page) => CELLS[page][verb]);

export const cellKey = ({ page, verb }: CellRef) => `${page}.${verb}`;

export function emptyLevels(): Levels {
  const levels = {} as Record<DashboardPage, PageLevels>;
  for (const page of PAGES) {
    levels[page] = Object.fromEntries(
      PAGE_VERBS[page].map((verb) => [verb, 0])
    );
  }
  return levels;
}

export const levelOf = (
  levels: Levels,
  page: DashboardPage,
  verb: Verb
): Level => levels[page][verb] ?? 0;

const withLevel = (
  levels: Levels,
  page: DashboardPage,
  verb: Verb,
  level: Level
): Levels => ({ ...levels, [page]: { ...levels[page], [verb]: level } });

export const actionAt = (def: CellDef, level: Level): PermissionAction =>
  level === 1 && def.own ? def.own : def.action;

/** The action label a cell grants at `level`: «تعديل الخاص». */
export function actionLabelAt(page: DashboardPage, verb: Verb, level: Level) {
  const def = cellDef(page, verb);
  return def ? PERMISSION_ACTION_LABELS[actionAt(def, level)] : '';
}

const normalize = (def: CellDef, level: Level): Level =>
  def.kind === 'binary' && level > 0 ? 2 : level;

/** Every page, each with exactly the actions it offers, as booleans. */
export function toPagePermissions(levels: Levels): PagePermission[] {
  return PAGES.map((page) => {
    const permissions: Partial<Record<PermissionAction, boolean>> = {};
    const offered = getAvailablePermissions(page);
    const verbs = PAGE_VERBS[page];
    for (const action of offered) permissions[action] = false;
    for (const verb of verbs) {
      const def = CELLS[page][verb];
      const level = levelOf(levels, page, verb);
      if (def && level > 0) permissions[actionAt(def, level)] = true;
    }
    return { name: page, permissions };
  });
}

function grantedLevel(
  def: CellDef,
  granted: PagePermission['permissions']
): Level {
  if (granted[def.action] === true) return 2;
  return def.own && granted[def.own] === true ? 1 : 0;
}

/**
 * The levels `pages` grant, matched by name; a page left out grants nothing.
 * An all-records grant wins over its own-records variant, as on the server.
 */
export function toLevels(pages: readonly PagePermission[]): Levels {
  const levels = {} as Record<DashboardPage, PageLevels>;
  for (const page of PAGES) {
    const granted = pages.find((p) => p.name === page)?.permissions ?? {};
    const pageLevels: Partial<Record<Verb, Level>> = {};
    const verbs = PAGE_VERBS[page];
    for (const verb of verbs) {
      const def = CELLS[page][verb];
      if (def) pageLevels[verb] = grantedLevel(def, granted);
    }
    levels[page] = pageLevels;
  }
  return levels;
}

export function changedCells(a: Levels, b: Levels): CellRef[] {
  const changed: CellRef[] = [];
  for (const page of PAGES) {
    const verbs = PAGE_VERBS[page];
    for (const verb of verbs) {
      if (levelOf(a, page, verb) !== levelOf(b, page, verb))
        changed.push({ page, verb });
    }
  }
  return changed;
}

/** Whether two page lists grant the same, read the way the matrix reads them. */
export const samePermissions = (
  a: readonly PagePermission[] | undefined,
  b: readonly PagePermission[] | undefined
): boolean => changedCells(toLevels(a ?? []), toLevels(b ?? [])).length === 0;

/**
 * Whether the signed-in user may grant `level` on a cell: they must hold the
 * action it confers, where holding an all-records action covers its
 * own-records variant (`actorHoldsAction`, the rule the server applies).
 */
export function canGrant(
  grants: ActorPermissions,
  page: DashboardPage,
  verb: Verb,
  level: Level
): boolean {
  if (level === 0) return true;
  const def = cellDef(page, verb);
  if (!def) return false;
  const action = actionAt(def, normalize(def, level));
  return (
    getAvailablePermissions(page).includes(action) &&
    actorHoldsAction(grants[page], action)
  );
}

export function maxGrant(
  grants: ActorPermissions,
  page: DashboardPage,
  verb: Verb
): Level {
  const levels = cellDef(page, verb)?.levels ?? [];
  let best: Level = 0;
  for (const level of levels)
    if (canGrant(grants, page, verb, level)) best = level;
  return best;
}

/** The view level a cell at `level` needs. */
export function requiredView(
  page: DashboardPage,
  verb: Verb,
  level: Level
): Level {
  const def = cellDef(page, verb);
  if (!def || level === 0 || verb === 'view') return 0;
  const gates = VIEW_GATES[actionAt(def, normalize(def, level))];
  if (!gates) return 0;
  return gates.includes('viewOwn') && cellDef(page, 'view')?.kind === 'scope'
    ? 1
    : 2;
}

/** The cells a cell needs, and the cells that need it, on its own page. */
export function relations(
  page: DashboardPage,
  verb: Verb
): { requires: Verb[]; neededBy: Verb[] } {
  if (!cellDef(page, verb)) return { requires: [], neededBy: [] };
  if (verb === 'view') {
    return {
      requires: [],
      neededBy: DEPENDENT_VERBS.filter(
        (v) => cellDef(page, v) && requiredView(page, v, 2) > 0
      ),
    };
  }
  return {
    requires: requiredView(page, verb, 2) > 0 ? ['view'] : [],
    neededBy: [],
  };
}

export type Relation = 'self' | 'prerequisite' | 'dependent';

/** How the cell under the pointer or focus relates to this one. */
export function relationTo(
  active: CellRef | null,
  page: DashboardPage,
  verb: Verb
): Relation | null {
  if (!active || active.page !== page) return null;
  if (active.verb === verb) return 'self';
  const { requires, neededBy } = relations(page, active.verb);
  if (requires.includes(verb)) return 'prerequisite';
  if (neededBy.includes(verb)) return 'dependent';
  return null;
}

export function prerequisiteText(page: DashboardPage, verb: Verb): string {
  const def = cellDef(page, verb);
  if (!def) return MSG_PERM_NOT_OFFERED;
  if (verb === 'create') return MSG_PERM_PREREQUISITES.create;
  if (verb === 'special') {
    return requiredView(page, verb, 2) > 0
      ? MSG_PERM_PREREQUISITES.requiresView(
          PERMISSION_ACTION_LABELS[def.action]
        )
      : MSG_PERM_PREREQUISITES.none;
  }
  if (verb === 'view') {
    const { neededBy } = relations(page, 'view');
    return neededBy.length > 0
      ? MSG_PERM_PREREQUISITES.viewDependents(neededBy.includes('special'))
      : MSG_PERM_PREREQUISITES.viewAlone;
  }
  return def.kind === 'scope'
    ? MSG_PERM_PREREQUISITES.scoped
    : MSG_PERM_PREREQUISITES.binary;
}

function raiseCause(verb: Verb, level: Level): string {
  if (verb === 'edit')
    return level === 2
      ? PERMISSION_RAISE_CAUSES.editAll
      : PERMISSION_RAISE_CAUSES.editOwn;
  if (verb === 'delete')
    return level === 2
      ? PERMISSION_RAISE_CAUSES.deleteAll
      : PERMISSION_RAISE_CAUSES.deleteOwn;
  return PERMISSION_RAISE_CAUSES.publish;
}

export interface CellChange {
  ok: boolean;
  changed: boolean;
  levels: Levels;
  /** What changed besides the cell asked for, in sentences. */
  notes: string[];
  /** Why the change was refused. */
  reason?: string;
}

/**
 * Sets one cell and keeps its page valid: raising a write raises the view it
 * needs, and lowering a view lowers the writes that needed more. Refuses a
 * raise the user may not grant, including the view it would bring along.
 */
export function setCell(
  levels: Levels,
  page: DashboardPage,
  verb: Verb,
  level: Level,
  grants: ActorPermissions
): CellChange {
  const def = cellDef(page, verb);
  if (!def)
    return {
      ok: false,
      changed: false,
      levels,
      notes: [],
      reason: MSG_PERM_NOT_OFFERED,
    };
  const target = normalize(def, level);
  const current = levelOf(levels, page, verb);
  if (target === current)
    return { ok: true, changed: false, levels, notes: [] };
  if (target > current && !canGrant(grants, page, verb, target)) {
    return {
      ok: false,
      changed: false,
      levels,
      notes: [],
      reason: MSG_PERM_OPTION_LOCKED(actionLabelAt(page, verb, target)),
    };
  }

  let next = withLevel(levels, page, verb, target);
  const notes: string[] = [];
  const pageLabel = DASHBOARD_PAGE_LABELS[page];

  if (verb === 'view' && target < current) {
    const changes: string[] = [];
    for (const dependent of DEPENDENT_VERBS) {
      const dependentDef = cellDef(page, dependent);
      const before = levelOf(next, page, dependent);
      if (
        !dependentDef ||
        before === 0 ||
        requiredView(page, dependent, before) <= target
      )
        continue;
      const kept =
        [...dependentDef.levels]
          .reverse()
          .find(
            (l) => l < before && requiredView(page, dependent, l) <= target
          ) ?? 0;
      next = withLevel(next, page, dependent, kept);
      const from = actionLabelAt(page, dependent, before);
      changes.push(
        kept === 0
          ? MSG_PERM_REVOKED(from)
          : MSG_PERM_LOWERED_TO(from, actionLabelAt(page, dependent, kept))
      );
    }
    if (changes.length > 0) {
      notes.push(
        MSG_PERM_DEPENDENTS_ADJUSTED(
          actionLabelAt(page, 'view', current),
          pageLabel,
          changes
        )
      );
    }
  } else if (verb !== 'view' && target > 0) {
    const need = requiredView(page, verb, target);
    if (levelOf(next, page, 'view') < need) {
      if (!canGrant(grants, page, 'view', need)) {
        return {
          ok: false,
          changed: false,
          levels,
          notes: [],
          reason: MSG_PERM_VIEW_LOCKED(
            actionLabelAt(page, verb, target),
            actionLabelAt(page, 'view', need)
          ),
        };
      }
      next = withLevel(next, page, 'view', need);
      notes.push(
        MSG_PERM_VIEW_RAISED(
          actionLabelAt(page, 'view', need),
          raiseCause(verb, target),
          pageLabel
        )
      );
    }
  }
  return { ok: true, changed: true, levels: next, notes };
}

/**
 * The next level when cycling by `direction`, skipping raises the user may
 * not grant; `null` when no other level is reachable.
 */
export function cycleLevel(
  def: CellDef,
  current: Level,
  direction: 1 | -1,
  grants: ActorPermissions
): Level | null {
  const order = def.levels;
  const start = order.indexOf(current);
  for (let step = 1; step < order.length; step += 1) {
    const index =
      (((start + direction * step) % order.length) + order.length) %
      order.length;
    const level = order[index];
    if (
      level !== undefined &&
      (level < current || canGrant(grants, def.page, def.verb, level))
    )
      return level;
  }
  return null;
}

/** Granted cells of a page, counted in verbs: «view all» is one. */
export const grantedCount = (levels: Levels, page: DashboardPage) =>
  PAGE_VERBS[page].filter((verb) => levelOf(levels, page, verb) > 0).length;

/**
 * `all` once every cell is at the most the user may grant, so a row of
 * options they cannot grant still reads as complete.
 */
function groupState(
  cells: readonly CellRef[],
  levels: Levels,
  grants: ActorPermissions
): TriState {
  let any = false;
  let allAtMax = true;
  for (const { page, verb } of cells) {
    const level = levelOf(levels, page, verb);
    if (level > 0) any = true;
    if (level < maxGrant(grants, page, verb)) allAtMax = false;
  }
  if (!any) return 'none';
  return allAtMax ? 'all' : 'mixed';
}

export const rowState = (
  levels: Levels,
  page: DashboardPage,
  grants: ActorPermissions
) =>
  groupState(
    PAGE_VERBS[page].map((verb) => ({ page, verb })),
    levels,
    grants
  );

export const columnState = (
  levels: Levels,
  verb: Verb,
  grants: ActorPermissions
) =>
  groupState(
    pagesOf(verb).map((page) => ({ page, verb })),
    levels,
    grants
  );

export interface BulkChange {
  levels: Levels;
  notes: string[];
  changed: boolean;
}

/** Every cell of a page at the most the user may grant, or all cleared. */
export function applyRow(
  levels: Levels,
  page: DashboardPage,
  mode: 'grant' | 'clear',
  grants: ActorPermissions
): BulkChange {
  let next = levels;
  const skipped: string[] = [];
  const verbs = PAGE_VERBS[page];
  if (mode === 'grant') {
    for (const verb of verbs) {
      const target = maxGrant(grants, page, verb);
      if (target > levelOf(next, page, verb))
        next = setCell(next, page, verb, target, grants).levels;
      if (target < 2 && levelOf(next, page, verb) < 2)
        skipped.push(actionLabelAt(page, verb, 2));
    }
  } else {
    // Dependents first, so clearing view reports nothing it took along.
    for (const verb of [...verbs].reverse())
      next = setCell(next, page, verb, 0, grants).levels;
  }

  const changed = changedCells(levels, next).length;
  const pageLabel = DASHBOARD_PAGE_LABELS[page];
  const notes: string[] = [];
  if (changed > 0) {
    notes.push(
      mode === 'grant'
        ? MSG_PERM_ROW_GRANTED(pageLabel, changed)
        : MSG_PERM_ROW_CLEARED(pageLabel, changed)
    );
  }
  if (mode === 'grant' && skipped.length > 0)
    notes.push(MSG_PERM_NOT_GRANTED(skipped));
  return { levels: next, notes, changed: changed > 0 };
}

/** One level for a verb on every page that offers it, as far as the user may. */
export function applyColumn(
  levels: Levels,
  verb: Verb,
  level: Level,
  grants: ActorPermissions
): BulkChange {
  let next = levels;
  const extra: string[] = [];
  const skipped: string[] = [];
  for (const page of pagesOf(verb)) {
    const def = cellDef(page, verb);
    if (!def) continue;
    const pageLabel = DASHBOARD_PAGE_LABELS[page];
    if (level === 1 && def.kind === 'binary') {
      extra.push(MSG_PERM_COLUMN_SKIPPED(pageLabel));
      continue;
    }
    const current = levelOf(next, page, verb);
    if (level > current) {
      // The most the user may grant, up to the level asked for.
      const allowed =
        [...def.levels]
          .reverse()
          .find((l) => l <= level && canGrant(grants, page, verb, l)) ?? 0;
      if (allowed < level)
        skipped.push(
          MSG_PERM_NOT_GRANTED_ON(pageLabel, actionLabelAt(page, verb, level))
        );
      if (allowed > current)
        next = setCell(next, page, verb, allowed, grants).levels;
    } else if (level < current) {
      const result = setCell(next, page, verb, level, grants);
      next = result.levels;
      extra.push(...result.notes);
    }
  }

  const changed = changedCells(levels, next).length;
  const notes: string[] = [];
  if (changed > 0) {
    const choice = SCOPED_VERB_SET.has(verb)
      ? PERMISSION_SCOPE_LABELS[level]
      : level > 0
        ? MSG_PERM_COLUMN_GRANTED
        : MSG_PERM_COLUMN_CLEARED;
    notes.push(MSG_PERM_COLUMN_APPLIED(VERB_LABELS[verb], choice, changed));
  }
  notes.push(...extra);
  if (skipped.length > 0) notes.push(MSG_PERM_NOT_GRANTED(skipped));
  return { levels: next, notes, changed: changed > 0 };
}

/** The page's grants as one plain sentence. */
export const summarizePage = (levels: Levels, page: DashboardPage) =>
  MSG_PERM_PAGE_SUMMARY(page, {
    view: levelOf(levels, page, 'view'),
    edit: levelOf(levels, page, 'edit'),
    delete: levelOf(levels, page, 'delete'),
    create: levelOf(levels, page, 'create'),
    special: levelOf(levels, page, 'special'),
    viewScoped: cellDef(page, 'view')?.kind === 'scope',
    offersDelete: !!cellDef(page, 'delete'),
  });

/** What a chip shows at `level`. */
export function chipText(def: CellDef, level: Level): string {
  if (def.verb === 'special') return PERMISSION_ACTION_LABELS[def.action];
  if (def.kind === 'scope') return PERMISSION_SCOPE_LABELS[level];
  return level > 0 ? MSG_PERM_ALLOWED : PERMISSION_SCOPE_LABELS[0];
}

/** A cell's accessible name: page, action and level. */
export function cellLabel(def: CellDef, level: Level): string {
  const page = DASHBOARD_PAGE_LABELS[def.page];
  if (def.verb === 'special')
    return MSG_PERM_SPECIAL_CELL(
      PERMISSION_ACTION_LABELS[def.action],
      page,
      level > 0
    );
  const state =
    def.kind === 'scope'
      ? PERMISSION_SCOPE_PHRASES[level]
      : chipText(def, level);
  return MSG_PERM_CELL(VERB_LABELS[def.verb], page, state);
}
