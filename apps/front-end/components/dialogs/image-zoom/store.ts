import type { FileWithPreview } from '@/components/shared/file-upload';

import { createDialog, DIALOG_URL_IDS } from '@/lib/dialogs';

export const imageZoomDialog = createDialog<FileWithPreview>({
  urlId: DIALOG_URL_IDS.imageZoom,
});
