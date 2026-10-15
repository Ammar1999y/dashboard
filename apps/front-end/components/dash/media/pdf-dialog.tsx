import { memo } from 'react';

import { MSG_PREVIEW_UNAVAILABLE } from '@/constants/messages';
import { useLibraryFile } from '@/lib/media/queries';

import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { pdfPreviewDialog } from './dialogs';

/** A PDF shown inline from the link its details carry, in the browser's own viewer. */
const PdfBody = memo(({ id }: { id: string }) => {
  const { data: file, error, refetch } = useLibraryFile(id);
  return (
    <>
      <DialogHeader>
        <DialogTitle className='flex items-center gap-2 truncate' dir='auto'>
          <Icon icon='lucide:file-text' className='size-4 shrink-0' />
          {file?.displayName ?? 'معاينة PDF'}
        </DialogTitle>
      </DialogHeader>
      <div className='px-4 pb-4'>
        {error && !file && <ErrorState error={error} refetch={refetch} />}
        {!file && !error && (
          <div className='grid h-[min(64vh,640px)] place-items-center'>
            <Icon
              icon='lucide:loader-circle'
              className='size-8 animate-spin text-primary'
            />
          </div>
        )}
        {file && file.previewUrl === null && (
          <div className='grid h-[min(64vh,640px)] place-items-center text-center text-muted-foreground'>
            <p className='flex items-center gap-2'>
              <Icon icon='lucide:file-x' className='size-5 shrink-0' />
              {MSG_PREVIEW_UNAVAILABLE}
            </p>
          </div>
        )}
        {file?.previewUrl && (
          // No `sandbox`: the browser's PDF viewer needs what one forbids.
          <iframe
            src={file.previewUrl}
            title={`معاينة ${file.displayName}`}
            className='h-[min(64vh,640px)] w-full rounded-lg border bg-white'
          />
        )}
      </div>
    </>
  );
});

PdfBody.displayName = 'PdfBody';

export const PdfPreviewDialog = memo(() => {
  const request = pdfPreviewDialog.usePayload();
  return (
    <StoreDialog dialog={pdfPreviewDialog} className='sm:max-w-[920px]'>
      {request && <PdfBody key={request.id} id={request.id} />}
    </StoreDialog>
  );
});

PdfPreviewDialog.displayName = 'PdfPreviewDialog';
