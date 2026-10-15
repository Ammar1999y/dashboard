import type { MediaContext } from './context';
import type { LibraryFile } from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';

import { toast } from 'sonner';
import {
  MSG_COPY_FAILED,
  MSG_DOWNLOAD_STARTED,
  MSG_LINK_COPIED_PERMANENT,
  MSG_LINK_COPIED_TEMPORARY,
  MSG_PUBLISH_FILE,
  MSG_PUBLISH_WARNING,
  MSG_UNPUBLISH_FILE,
  MSG_UNPUBLISH_WARNING,
} from '@/constants/messages';
import { downloadInFrame } from '@/lib/files/download';
import { setFileVisibility } from '@/lib/media/actions';
import { whileBusy } from '@/lib/media/busy';
import { fetchLibraryFile } from '@/lib/media/queries';
import { toastError } from '@/lib/toast-error';

import { confirmDialog } from './dialogs';
import { trackBusy } from './store';

/** Browsers drop downloads started too close together. */
const DOWNLOAD_GAP_MS = 250;

/**
 * Downloads the files one after another, each from the link its details carry,
 * which forces a download under its current name. In a hidden frame, not a new
 * tab, which only the first of several, before any request, may open.
 */
export async function downloadFiles(
  ctx: MediaContext,
  ids: readonly EntityID[]
) {
  if (ids.length === 0) return;
  try {
    await trackBusy(async () => {
      for (const [index, id] of ids.entries()) {
        if (index > 0)
          await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
        const file = await fetchLibraryFile(ctx.queryClient, id);
        downloadInFrame(file.downloadUrl);
      }
    });
    toast.success(MSG_DOWNLOAD_STARTED(ids.length));
  } catch (error) {
    toastError(error);
  }
}

/**
 * Copies the file's link: a public file's lasts, a private one's is signed now
 * and lasts an hour, which the toast says.
 */
export async function copyLink(ctx: MediaContext, file: LibraryFile) {
  const isPublic = file.bucketType === 'public';
  try {
    if (isPublic) await navigator.clipboard.writeText(file.url);
    else await copySigned(ctx, file.id);
    toast.success(
      isPublic ? MSG_LINK_COPIED_PERMANENT : MSG_LINK_COPIED_TEMPORARY
    );
  } catch (error) {
    toastError(error, MSG_COPY_FAILED);
  }
}

/**
 * Safari lets a click write to the clipboard only while it is still that
 * click, so a link that must first be signed is handed over as a promise.
 * Chrome before 98 takes no promise there, and allows writing after a request.
 */
async function copySigned(ctx: MediaContext, id: EntityID) {
  const url = trackBusy(() =>
    fetchLibraryFile(ctx.queryClient, id, { fresh: true })
  ).then((signed) => signed.url);
  if (typeof ClipboardItem !== 'undefined')
    try {
      const text = url.then(
        (value) => new Blob([value], { type: 'text/plain' })
      );
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': text }),
      ]);
      return;
    } catch {
      // Unsupported here; the write below says what went wrong if it fails too.
    }
  await navigator.clipboard.writeText(await url);
}

/** Publishes or unpublishes, after saying what that does. */
export function confirmVisibility(
  ctx: MediaContext,
  file: Pick<LibraryFile, 'id' | 'displayName'>,
  to: LibraryFile['bucketType']
) {
  const publish = to === 'public';
  confirmDialog.open({
    title: publish ? 'نشر الملف' : 'إلغاء نشر الملف',
    description: (publish ? MSG_PUBLISH_FILE : MSG_UNPUBLISH_FILE)(
      file.displayName
    ),
    warning: publish ? MSG_PUBLISH_WARNING : MSG_UNPUBLISH_WARNING,
    confirmLabel: publish ? 'نشر الملف' : 'إلغاء النشر',
    pendingLabel: publish ? 'جاري النشر...' : 'جاري إلغاء النشر...',
    run: () =>
      trackBusy(() =>
        whileBusy([file.id], () =>
          setFileVisibility(ctx.queryClient, file.id, to)
        )
      ),
  });
}
