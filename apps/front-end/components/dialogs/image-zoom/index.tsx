import { Button } from '@/components/ui/button';
import { DialogClose, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { getPreviewUrl } from '@/components/shared/file-upload/file-utils';

import { StoreDialog } from '../store-dialog';
import { imageZoomDialog } from './store';

export default function ImageZoomDialog() {
  const zoomFile = imageZoomDialog.usePayload();

  const src = zoomFile && getPreviewUrl(zoomFile);

  return (
    <StoreDialog
      dialog={imageZoomDialog}
      overlayClassName='bg-black/70 backdrop-blur-lg backdrop-saturate-150'
      className='noSelect h-full grid-rows-[1fr] overflow-hidden border-none bg-transparent p-0 px-12 shadow-none'
      onClick={imageZoomDialog.close}
    >
      <DialogTitle className='sr-only'>{zoomFile?.file.name}</DialogTitle>
      <div className='relative mx-auto flex h-full w-fit items-center justify-center'>
        {src && (
          <img
            src={src}
            alt={zoomFile?.file.name}
            className='h-[--dialog-max-height] w-[calc(100vw-6rem-env(safe-area-inset-left)-env(safe-area-inset-right))] rounded-lg object-contain'
          />
        )}
        <DialogClose asChild>
          <Button
            className='absolute top-3 rounded-full bg-accent text-accent-foreground backdrop-blur-lg ltr:-left-2 ltr:-translate-x-full rtl:-right-2 rtl:translate-x-full'
            size='icon'
            variant='none'
            aria-label='إغلاق'
          >
            <Icon
              icon='solar:close-linear'
              className='size-5 [&_*]:stroke-[3]'
            />
          </Button>
        </DialogClose>
      </div>
    </StoreDialog>
  );
}
