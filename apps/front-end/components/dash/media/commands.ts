import type { Clip } from './clip';
import type { MediaContext } from './context';
import type { Item } from './items';
import type { Mode, View } from './store';
import type { IconName } from '@/components/ui/icon';
import type { SortId } from '@/lib/media/listing';
import type { BucketType } from '@app/shared/validation/enums';

import { useMemo } from 'react';

import { useShallow } from 'zustand/shallow';
import { mediaKeys } from '@/lib/media/api';
import { useCapabilities } from '@/lib/media/capabilities';
import { isFolderKey } from '@/lib/media/keys';
import { filterCount, NO_FILTERS } from '@/lib/media/listing';
import { hasInlinePreview } from '@/lib/media/schemas';
import { getSelection, useSelection } from '@/lib/media/selection';
import { setUploadsOpen, useUploads } from '@/lib/media/upload-queue';

import { useMediaAccess } from './access';
import { askForFoldersOnly } from './ask';
import { getClip, useClip } from './clip';
import {
  deleteDialog,
  pdfPreviewDialog,
  quickLookDialog,
  shortcutsDialog,
} from './dialogs';
import { confirmVisibility, copyLink, downloadFiles } from './file-ops';
import { isProcessing } from './format';
import {
  canDeleteItem,
  canEditItem,
  describeItems,
  findItem,
  itemParent,
  useItems,
} from './items';
import {
  clearSearch,
  clearSelection,
  columnOrder,
  enterFolder,
  goTo,
  goUp,
  historyGo,
  selectAll,
  setFilters,
  setMode,
  setSearchScope,
  setSort,
  setView,
  showInFolder,
  viewColumn,
} from './navigation';
import {
  cancelCut,
  cut,
  pasteInto,
  pasteTarget,
  startNewFolder,
  startRename,
} from './operations';
import { getBrowser, isResults, useBrowser } from './store';

/** What decides which commands are offered, read once per render or keystroke. */
export interface CommandState {
  items: readonly Item[];
  folders: number;
  files: number;
  clip: Clip | null;
  view: View;
  mode: Mode;
  query: string;
  results: boolean;
  /** Folders opened from the root; the root alone is 1. */
  depth: number;
  canGoBack: boolean;
  canGoForward: boolean;
  searchScope: 'all' | 'folder';
  inFolder: boolean;
  filtersActive: boolean;
  canPublish: boolean;
  visibilities: readonly BucketType[];
  access: ReturnType<typeof useMediaAccess>;
}

type CommandGroup =
  'ملف' | 'تحديد' | 'تنقل' | 'عرض' | 'بحث' | 'ترتيب' | 'مساعدة';

export interface Command {
  id: string;
  label: string;
  icon: IconName;
  /** As written, with `Mod` for Ctrl or ⌘. */
  kbd?: string;
  group: CommandGroup;
  danger?: boolean;
  enabled: (state: CommandState) => boolean;
  run: (ctx: MediaContext, state: CommandState) => void;
}

const one = (state: CommandState) =>
  state.items.length === 1 ? state.items[0] : undefined;

const oneFile = (state: CommandState) => {
  const item = one(state);
  return item?.kind === 'file' ? item.file : undefined;
};

const oneFolder = (state: CommandState) => {
  const item = one(state);
  return item?.kind === 'folder' ? item.folder : undefined;
};

const canSetVisibility = (state: CommandState, to: BucketType) => {
  const file = oneFile(state);
  return (
    !!file &&
    file.bucketType !== to &&
    !isProcessing(file) &&
    state.canPublish &&
    state.visibilities.includes(to)
  );
};

/** Opens quick look on the cursor's file, or the first selected, among the column's files. */
export function openQuickLook(ctx: MediaContext, state: CommandState) {
  const fileKeys = state.items
    .filter((item) => item.kind === 'file')
    .map((item) => item.key);
  const { cursor } = getSelection();
  const start =
    cursor.key && fileKeys.includes(cursor.key) ? cursor.key : fileKeys[0];
  if (!start) return;
  const col = viewColumn();
  let keys = columnOrder(ctx.queryClient, col).filter(
    (key) => !isFolderKey(key)
  );
  if (!keys.includes(start)) keys = [start];
  quickLookDialog.open({ keys, index: keys.indexOf(start), col });
}

const SORT_LABELS: Readonly<Record<SortId, string>> = {
  displayName: 'الاسم',
  sizeBytes: 'الحجم',
  mimeType: 'النوع',
  createdAt: 'تاريخ الإضافة',
  updatedAt: 'تاريخ التعديل',
};

export { SORT_LABELS };

const always = () => true;

export const COMMANDS: readonly Command[] = [
  {
    id: 'newfolder',
    label: 'مجلد جديد',
    icon: 'lucide:folder-plus',
    kbd: 'Alt+N',
    group: 'ملف',
    enabled: (s) => s.access.canCreate,
    run: (ctx) => startNewFolder(ctx),
  },
  {
    id: 'upload',
    label: 'رفع ملفات…',
    icon: 'lucide:upload',
    kbd: 'Alt+U',
    group: 'ملف',
    enabled: (s) => s.access.canCreate,
    run: (ctx) => ctx.pickFiles({}),
  },
  {
    id: 'uploadfolder',
    label: 'رفع مجلد كامل…',
    icon: 'lucide:folder-up',
    group: 'ملف',
    enabled: (s) => s.access.canCreate,
    run: (ctx) => ctx.pickFiles({ directory: true }),
  },
  {
    id: 'uploadhere',
    label: 'رفع ملفات إلى هذا المجلد…',
    icon: 'lucide:upload',
    group: 'ملف',
    enabled: (s) => s.access.canCreate && !!oneFolder(s),
    run: (ctx, s) => {
      const folder = oneFolder(s);
      if (folder) ctx.pickFiles({ target: folder.id });
    },
  },
  {
    id: 'open',
    label: 'فتح',
    icon: 'lucide:folder-open',
    kbd: 'Enter',
    group: 'ملف',
    enabled: (s) => !!oneFolder(s),
    run: (ctx, s) => {
      const folder = oneFolder(s);
      if (folder) enterFolder(ctx.queryClient, folder.id);
    },
  },
  {
    id: 'preview',
    label: 'معاينة سريعة',
    icon: 'lucide:eye',
    kbd: 'Space',
    group: 'ملف',
    enabled: (s) => s.files > 0,
    run: openQuickLook,
  },
  {
    id: 'pdfpreview',
    label: 'معاينة PDF',
    icon: 'lucide:file-text',
    group: 'ملف',
    enabled: (s) => {
      const file = oneFile(s);
      return !!file && hasInlinePreview(file);
    },
    run: (_ctx, s) => {
      const file = oneFile(s);
      if (file) pdfPreviewDialog.open({ id: file.id });
    },
  },
  {
    id: 'rename',
    label: 'إعادة تسمية',
    icon: 'lucide:pencil',
    kbd: 'F2',
    group: 'ملف',
    enabled: (s) => {
      const item = one(s);
      return !!item && canEditItem(s.access, item);
    },
    run: (ctx) => startRename(ctx),
  },
  {
    id: 'cut',
    label: 'قص للنقل',
    icon: 'lucide:scissors',
    kbd: 'Mod+X',
    group: 'ملف',
    enabled: (s) =>
      s.items.length > 0 &&
      !s.clip?.busy &&
      s.items.every((item) => canEditItem(s.access, item)),
    run: (ctx) => cut(ctx),
  },
  {
    id: 'paste',
    label: 'لصق هنا',
    icon: 'lucide:clipboard-paste',
    kbd: 'Mod+V',
    group: 'ملف',
    enabled: (s) => !!s.clip && !s.clip.busy,
    run: (ctx) => void pasteInto(ctx, pasteTarget(), askForFoldersOnly),
  },
  {
    id: 'cancelcut',
    label: 'إلغاء النقل',
    icon: 'lucide:x',
    kbd: 'Esc',
    group: 'ملف',
    enabled: (s) => !!s.clip && !s.clip.busy,
    run: () => cancelCut(),
  },
  {
    id: 'delete',
    label: 'حذف نهائي…',
    icon: 'lucide:trash-2',
    kbd: 'Delete',
    group: 'ملف',
    danger: true,
    enabled: (s) =>
      s.items.length > 0 &&
      s.items.every((item) => canDeleteItem(s.access, item)),
    run: (_ctx, s) =>
      deleteDialog.open({ keys: s.items.map(({ key }) => key) }),
  },
  {
    id: 'download',
    label: 'تنزيل',
    icon: 'lucide:download',
    group: 'ملف',
    enabled: (s) => s.files > 0 && s.folders === 0,
    run: (ctx, s) =>
      void downloadFiles(
        ctx,
        s.items.flatMap((item) => (item.kind === 'file' ? [item.file.id] : []))
      ),
  },
  {
    id: 'copylink',
    label: 'نسخ الرابط',
    icon: 'lucide:link',
    group: 'ملف',
    enabled: (s) => !!oneFile(s),
    run: (ctx, s) => {
      const file = oneFile(s);
      if (file) void copyLink(ctx, file);
    },
  },
  {
    id: 'publish',
    label: 'نشر الملف…',
    icon: 'lucide:globe',
    group: 'ملف',
    enabled: (s) => canSetVisibility(s, 'public'),
    run: (ctx, s) => {
      const file = oneFile(s);
      if (file) confirmVisibility(ctx, file, 'public');
    },
  },
  {
    id: 'unpublish',
    label: 'إلغاء النشر…',
    icon: 'lucide:eye-off',
    group: 'ملف',
    enabled: (s) => canSetVisibility(s, 'private'),
    run: (ctx, s) => {
      const file = oneFile(s);
      if (file) confirmVisibility(ctx, file, 'private');
    },
  },
  {
    id: 'showin',
    label: 'إظهار في المجلد',
    icon: 'lucide:folder-open',
    group: 'ملف',
    enabled: (s) => {
      const item = one(s);
      return (
        s.results &&
        !!item &&
        !(item.kind === 'file' && itemParent(item) === null)
      );
    },
    run: (ctx, s) => {
      const item = one(s);
      if (item) showInFolder(ctx.queryClient, item.key);
    },
  },
  {
    id: 'selectall',
    label: 'تحديد الكل',
    icon: 'lucide:square-check',
    kbd: 'Mod+A',
    group: 'تحديد',
    enabled: always,
    run: (ctx) => selectAll(ctx.queryClient),
  },
  {
    id: 'clear',
    label: 'إلغاء التحديد',
    icon: 'lucide:x',
    kbd: 'Esc',
    group: 'تحديد',
    enabled: (s) => s.items.length > 0,
    run: () => clearSelection(),
  },
  {
    id: 'refresh',
    label: 'تحديث',
    icon: 'lucide:refresh-cw',
    group: 'عرض',
    enabled: always,
    run: (ctx) =>
      void ctx.queryClient.invalidateQueries({ queryKey: mediaKeys.all }),
  },
  {
    id: 'back',
    label: 'السابق',
    icon: 'lucide:arrow-right',
    kbd: 'Mod+[',
    group: 'تنقل',
    enabled: (s) => s.canGoBack,
    run: () => historyGo(-1),
  },
  {
    id: 'forward',
    label: 'التالي',
    icon: 'lucide:arrow-left',
    kbd: 'Mod+]',
    group: 'تنقل',
    enabled: (s) => s.canGoForward,
    run: () => historyGo(1),
  },
  {
    id: 'up',
    label: 'المجلد الأب',
    icon: 'lucide:folder-up',
    kbd: 'Backspace',
    group: 'تنقل',
    enabled: (s) => s.results || s.depth > 1,
    run: () => goUp(),
  },
  {
    id: 'home',
    label: 'الانتقال إلى الجذر',
    icon: 'lucide:house',
    group: 'تنقل',
    enabled: always,
    run: (ctx) => goTo(ctx.queryClient, null),
  },
  {
    id: 'view-columns',
    label: 'عرض: أعمدة',
    icon: 'lucide:columns-3',
    kbd: 'Alt+1',
    group: 'عرض',
    enabled: always,
    run: () => setView('columns'),
  },
  {
    id: 'view-grid',
    label: 'عرض: شبكة',
    icon: 'lucide:layout-grid',
    kbd: 'Alt+2',
    group: 'عرض',
    enabled: always,
    run: () => setView('grid'),
  },
  {
    id: 'view-list',
    label: 'عرض: قائمة',
    icon: 'lucide:list',
    kbd: 'Alt+3',
    group: 'عرض',
    enabled: always,
    run: () => setView('list'),
  },
  {
    id: 'inspector',
    label: 'إظهار/إخفاء لوحة التفاصيل',
    icon: 'lucide:panel-right',
    kbd: 'Alt+I',
    group: 'عرض',
    enabled: always,
    run: () =>
      useBrowser.setState(({ inspector }) => ({ inspector: !inspector })),
  },
  {
    id: 'view-folders',
    label: 'العرض: المجلدات',
    icon: 'lucide:folder-open',
    group: 'عرض',
    enabled: (s) => s.mode !== 'folders',
    run: () => setMode('folders'),
  },
  {
    id: 'view-allfiles',
    label: 'العرض: كل الملفات',
    icon: 'lucide:file-image',
    group: 'عرض',
    enabled: (s) => s.mode !== 'all',
    run: () => setMode('all'),
  },
  {
    id: 'view-unfiled',
    label: 'العرض: غير مصنّفة',
    icon: 'lucide:file-question',
    group: 'عرض',
    enabled: (s) => s.mode !== 'unfiled',
    run: () => setMode('unfiled'),
  },
  {
    id: 'search',
    label: 'بحث بالاسم',
    icon: 'lucide:search',
    kbd: '/',
    group: 'بحث',
    enabled: always,
    run: () =>
      document.querySelector<HTMLInputElement>('[data-media-search]')?.focus(),
  },
  {
    id: 'scope-all',
    label: 'البحث في: كل المكتبة',
    icon: 'lucide:search',
    group: 'بحث',
    enabled: (s) => s.inFolder && s.searchScope !== 'all',
    run: () => setSearchScope('all'),
  },
  {
    id: 'scope-folder',
    label: 'البحث في: هذا المجلد فقط',
    icon: 'lucide:folder-open',
    group: 'بحث',
    enabled: (s) => s.inFolder && s.searchScope !== 'folder',
    run: () => setSearchScope('folder'),
  },
  {
    id: 'clearfilters',
    label: 'إزالة كل عوامل التصفية',
    icon: 'lucide:x',
    group: 'بحث',
    enabled: (s) => s.filtersActive,
    run: () => setFilters(NO_FILTERS),
  },
  {
    id: 'clearsearch',
    label: 'مسح البحث',
    icon: 'lucide:x',
    group: 'بحث',
    enabled: (s) => !!s.query,
    run: () => clearSearch(),
  },
  ...(Object.keys(SORT_LABELS) as SortId[]).map((id): Command => ({
    id: `sort-${id}`,
    label: `ترتيب حسب: ${SORT_LABELS[id]}`,
    icon: 'lucide:arrow-up-down',
    group: 'ترتيب',
    enabled: always,
    run: () => setSort(id, getBrowser().sort.desc),
  })),
  {
    id: 'sort-dir',
    label: 'عكس اتجاه الترتيب',
    icon: 'lucide:arrow-up-down',
    group: 'ترتيب',
    enabled: always,
    run: () => {
      const { sort } = getBrowser();
      setSort(sort.id, !sort.desc);
    },
  },
  {
    id: 'upqueue',
    label: 'عرض قائمة الرفع',
    icon: 'lucide:upload',
    group: 'ملف',
    enabled: () => useUploads.getState().items.length > 0,
    run: () => setUploadsOpen(true),
  },
  {
    id: 'shortcuts',
    label: 'اختصارات لوحة المفاتيح',
    icon: 'lucide:keyboard',
    kbd: '?',
    group: 'مساعدة',
    enabled: always,
    run: () => shortcutsDialog.open(),
  },
];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

export function command(id: string): Command {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown media command: ${id}`);
  return found;
}

/** Runs `id` when it is offered now. */
export function runCommand(ctx: MediaContext, id: string, state: CommandState) {
  const cmd = command(id);
  if (cmd.enabled(state)) cmd.run(ctx, state);
}

interface StateSources {
  items: readonly Item[];
  clip: Clip | null;
  browser: Pick<
    ReturnType<typeof getBrowser>,
    | 'view'
    | 'mode'
    | 'query'
    | 'path'
    | 'history'
    | 'historyIndex'
    | 'searchScope'
    | 'filters'
  >;
  canPublish: boolean;
  visibilities: readonly BucketType[];
  access: ReturnType<typeof useMediaAccess>;
}

function buildState({
  items,
  clip,
  browser,
  canPublish,
  visibilities,
  access,
}: StateSources): CommandState {
  const { folders, files } = describeItems(items);
  const results = isResults(browser);
  return {
    items,
    folders: folders.length,
    files: files.length,
    clip,
    view: browser.view,
    mode: browser.mode,
    query: browser.query,
    results,
    depth: browser.path.length,
    canGoBack: browser.historyIndex > 0,
    canGoForward: browser.historyIndex < browser.history.length - 1,
    searchScope: browser.searchScope,
    inFolder:
      browser.mode === 'folders' &&
      browser.path[browser.path.length - 1] !== null &&
      browser.path.length > 1,
    filtersActive: filterCount(browser.filters) > 0,
    canPublish,
    visibilities,
    access,
  };
}

/** The command state now, for a keystroke. */
export function readCommandState(ctx: MediaContext): CommandState {
  const items = [...getSelection().keys].flatMap((key) => {
    const item = findItem(ctx.queryClient, key);
    return item ? [item] : [];
  });
  const { canPublish, visibilities } = useCapabilities.getState();
  return buildState({
    items,
    clip: getClip(),
    browser: getBrowser(),
    canPublish,
    visibilities,
    access: ctx.access,
  });
}

const EMPTY_KEYS: readonly never[] = [];

/** The command state, kept current, for a menu or bar while shown. */
export function useCommandState(
  access: ReturnType<typeof useMediaAccess>
): CommandState {
  const selected = useSelection((s) => s.keys);
  const keys = useMemo(
    () => (selected.size > 0 ? [...selected] : EMPTY_KEYS),
    [selected]
  );
  const found = useItems(keys);
  const clip = useClip((s) => s.clip);
  const browser = useBrowser(
    useShallow((s) => ({
      view: s.view,
      mode: s.mode,
      query: s.query,
      path: s.path,
      history: s.history,
      historyIndex: s.historyIndex,
      searchScope: s.searchScope,
      filters: s.filters,
    }))
  );
  const { canPublish, visibilities } = useCapabilities(
    useShallow((s) => ({
      canPublish: s.canPublish,
      visibilities: s.visibilities,
    }))
  );
  return useMemo(
    () =>
      buildState({
        items: found.flatMap((item) => (item ? [item] : [])),
        clip,
        browser,
        canPublish,
        visibilities,
        access,
      }),
    [found, clip, browser, canPublish, visibilities, access]
  );
}
