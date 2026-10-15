import type { MediaContext } from './context';
import type { EntityID } from '@app/shared/types';
import type { ChangeEvent } from 'react';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { validID } from '@app/shared/utils';
import { MSG_INVALID_LINK, MSG_UPLOADS_LEAVE } from '@/constants/messages';
import {
  ACCEPT_DOCUMENTS,
  ACCEPT_IMAGES_WITH_SVG,
  toAcceptList,
} from '@/lib/files/accept';
import {
  EMPTY_SELECTION,
  setSelection,
  useSelection,
} from '@/lib/media/selection';
import {
  disposeUploads,
  isActiveUpload,
  useUploads,
} from '@/lib/media/upload-queue';
import { cn } from '@/lib/utils';

import { useLeaveGuard } from '@/hooks/use-leave-guard';
import { useWidthClass } from '@/hooks/use-width-class';
import { ErrorState } from '@/components/ui/error-state';
import { LoadingState } from '@/components/ui/loading-state';

import { useMediaAccess } from './access';
import { ActionBar } from './action-bar';
import { AskDialog } from './ask-dialog';
import { Browse } from './browse';
import { setClip } from './clip';
import ConfirmDialog from './confirm-dialog';
import { MediaContextValue } from './context';
import { DeleteDialog, InUseDialog } from './delete-dialog';
import { DragOverlays, useDragAndDrop } from './drag-drop';
import { FolderPickerDialog } from './folder-picker';
import { ItemMenu } from './item-menu';
import { Marquee } from './marquee';
import styles from './media.module.css';
import { closeMenu } from './menu-store';
import { PdfPreviewDialog } from './pdf-dialog';
import { QuickLook } from './quick-look';
import { ShortcutsDialog } from './shortcuts-dialog';
import { StatusBar } from './status-bar';
import { resetBrowser } from './store';
import { FOLDER_PARAM, PathSync, RevealSync, UrlSync } from './sync';
import { Toolbar } from './toolbar';
import { pickedFiles, uploadItems } from './upload-ops';
import { UploadPanel } from './upload-panel';
import { useKeyboard } from './use-keyboard';

const INVALID_LINK = new CustomError(MSG_INVALID_LINK, HTTP_STATUS.NOT_FOUND);

const ACCEPT = toAcceptList({
  ...ACCEPT_IMAGES_WITH_SVG,
  ...ACCEPT_DOCUMENTS,
}).join(',');

type Width = 'wide' | 'medium' | 'narrow' | 'compact';

/** Where the prototype's layout breaks, measured on the library itself. */
const widthOf = (pixels: number): Width => {
  if (pixels >= 1100) return 'wide';
  if (pixels >= 900) return 'medium';
  if (pixels >= 700) return 'narrow';
  return 'compact';
};

function Manager({ initialFolder }: { initialFolder: EntityID | null }) {
  // Each visit starts where its link points, with nothing of the last one.
  useState(() => {
    resetBrowser(initialFolder);
    setSelection(EMPTY_SELECTION);
    setClip(null);
    return true;
  });
  const queryClient = useQueryClient();
  const access = useMediaAccess();
  const root = useRef<HTMLDivElement>(null);
  const browse = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<EntityID | null | undefined>(undefined);

  const focusBrowser = useCallback(
    () => browse.current?.focus({ preventScroll: true }),
    []
  );
  const pickFiles = useCallback<MediaContext['pickFiles']>(
    ({ target, directory = false }) => {
      const input = fileInput.current;
      if (!input) return;
      pickTarget.current = target;
      input.value = '';
      input.webkitdirectory = directory;
      input.click();
    },
    []
  );
  const ctx = useMemo<MediaContext>(
    () => ({ queryClient, access, focusBrowser, pickFiles }),
    [queryClient, access, focusBrowser, pickFiles]
  );

  const onPicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.target.files ?? [])];
      if (files.length > 0)
        uploadItems(ctx, pickedFiles(files), pickTarget.current);
    },
    [ctx]
  );

  useKeyboard(ctx, root);
  const dragAndDrop = useDragAndDrop(ctx);
  const width = useWidthClass(root, widthOf, 'wide');
  const multi = useSelection((s) => s.keys.size > 1);
  const uploading = useUploads((s) => s.items.some(isActiveUpload));
  useLeaveGuard(uploading, MSG_UPLOADS_LEAVE);

  useEffect(
    () => () => {
      disposeUploads();
      setSelection(EMPTY_SELECTION);
      setClip(null);
      closeMenu();
    },
    []
  );

  return (
    <MediaContextValue.Provider value={ctx}>
      <div
        ref={root}
        data-width={width}
        data-multi={multi}
        className={cn(
          styles.root,
          'group/fm relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-sm text-foreground'
        )}
        {...dragAndDrop}
      >
        <Toolbar />
        <ActionBar />
        <Browse browseRef={browse} />
        <StatusBar />
        <UploadPanel />
        <DragOverlays />
        <Marquee />
        <ItemMenu />
        <PathSync />
        <UrlSync />
        <RevealSync />
        <input
          ref={fileInput}
          type='file'
          multiple
          hidden
          accept={ACCEPT}
          onChange={onPicked}
        />
        <ConfirmDialog />
        <AskDialog />
        <DeleteDialog />
        <InUseDialog />
        <PdfPreviewDialog />
        <FolderPickerDialog />
        <ShortcutsDialog />
        <QuickLook />
      </div>
    </MediaContextValue.Provider>
  );
}

/** The media library: its folders and files, in columns, a grid or a list. */
export default function MediaLibrary() {
  const { isReady, query } = useRouter();
  if (!isReady) return <LoadingState />;
  const raw = query[FOLDER_PARAM];
  const folder = validID(raw) || null;
  if (raw !== undefined && !folder) return <ErrorState error={INVALID_LINK} />;
  return <Manager key={folder ?? 'root'} initialFolder={folder} />;
}
