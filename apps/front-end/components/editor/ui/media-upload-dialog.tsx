import type { MediaType } from '@/components/editor/media-config';
import type { DialogStore } from '@/lib/dialogs';
import type { UploadedFile } from '@/types/upload';
import type { FileRejection } from 'react-dropzone';

import { memo, useCallback, useId, useMemo, useState } from 'react';

import { insertImage, insertMediaEmbed } from '@platejs/media';
import { useEditorRef } from 'platejs/react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { MIB } from '@app/shared/validation/constants';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StoreDialog } from '@/components/dialogs/store-dialog';
import { useUploadFile } from '@/components/editor/hooks/use-upload-file';
import { mediaConfig } from '@/components/editor/media-config';
import {
  getAcceptedFormats,
  getHelperText,
  toastRejections,
} from '@/components/shared/file-upload/file-utils';

interface MediaUploadFormProps {
  dialog: DialogStore<MediaType>;
  type: MediaType;
}

// Rendered inside the dialog content, which unmounts once the close animation
// ends: each opening starts from an empty form.
const MediaUploadForm = memo(({ dialog, type }: MediaUploadFormProps) => {
  const editor = useEditorRef();
  const urlInputId = useId();
  const [url, setUrl] = useState('');
  const config = mediaConfig[type];

  const insertMedia = useCallback(
    (mediaUrl: string) => {
      if (type === 'image') insertImage(editor, mediaUrl);
      // Video, audio and files embed until each has an insert of its own.
      else insertMediaEmbed(editor, { url: mediaUrl, type });
    },
    [editor, type]
  );

  const onUploadComplete = useCallback(
    (file: UploadedFile) => {
      // Closed while uploading: the user cancelled the insert.
      if (dialog.getPayload() === null) return;
      insertMedia(file.url);
      dialog.close();
      toast.success('تم رفع الملف بنجاح');
    },
    [dialog, insertMedia]
  );

  const { uploadFile, isUploading, progress } = useUploadFile({
    onUploadComplete,
  });

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const [file] = acceptedFiles;
      if (file) void uploadFile(file, type);
    },
    [uploadFile, type]
  );

  const limits = useMemo(
    () => ({
      maxSizeMB: config.maxSizeMB,
      maxFiles: 1,
      formats: getAcceptedFormats(config.accept),
    }),
    [config]
  );

  const onDropRejected = useCallback(
    (rejections: FileRejection[]) => toastRejections(rejections, limits),
    [limits]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: config.accept,
    maxFiles: limits.maxFiles,
    maxSize: config.maxSizeMB * MIB,
    multiple: false,
  });

  const handleUrlChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setUrl(event.target.value),
    []
  );

  const handleLinkSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!url) return;
      insertMedia(url);
      dialog.close();
    },
    [dialog, insertMedia, url]
  );

  return (
    <Tabs defaultValue='upload' className='w-full'>
      <TabsList className='grid w-full grid-cols-2'>
        <TabsTrigger value='upload'>رفع من الجهاز</TabsTrigger>
        <TabsTrigger value='link'>رابط خارجي</TabsTrigger>
      </TabsList>

      <TabsContent value='upload' className='mt-4'>
        <div
          {...getRootProps()}
          className={cn(
            'flex h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors',
            isDragActive
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-primary/50'
          )}
        >
          <input {...getInputProps()} />
          {isUploading ? (
            <div className='flex flex-col items-center gap-2'>
              <Icon
                icon='lucide:loader-circle'
                className='size-8 animate-spin text-primary'
              />
              <p className='text-sm text-muted-foreground'>
                جاري الرفع... {progress}%
              </p>
            </div>
          ) : (
            <>
              <Icon
                icon='solar:cloud-upload-bold-duotone'
                className='size-10 text-muted-foreground'
              />
              <p className='text-sm font-medium'>
                اسحب الملف هنا أو انقر للاختيار
              </p>
              <p className='text-xs text-muted-foreground'>
                {getHelperText(limits)}
              </p>
            </>
          )}
        </div>
      </TabsContent>

      <TabsContent value='link' className='mt-4'>
        <form onSubmit={handleLinkSubmit} className='flex flex-col gap-4'>
          <div className='grid gap-2'>
            <Label htmlFor={urlInputId} title={`رابط ${config.label}`} />
            <div className='relative'>
              <Icon
                icon='solar:link-linear'
                className='absolute top-2.5 size-4 text-muted-foreground ltr:right-3 rtl:left-3'
              />
              <Input
                id={urlInputId}
                placeholder={`https://example.com/${type}...`}
                className='pe-9'
                value={url}
                onChange={handleUrlChange}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type='submit' disabled={!url}>
              إضافة
            </Button>
          </DialogFooter>
        </form>
      </TabsContent>
    </Tabs>
  );
});
MediaUploadForm.displayName = 'MediaUploadForm';

const MediaUploadDialog = memo(
  ({ dialog }: { dialog: DialogStore<MediaType> }) => {
    const type = dialog.usePayload();

    return (
      <StoreDialog dialog={dialog} className='sm:max-w-[425px]'>
        {type && (
          <>
            <DialogHeader>
              <DialogTitle>إضافة {mediaConfig[type].label}</DialogTitle>
            </DialogHeader>
            <MediaUploadForm dialog={dialog} type={type} />
          </>
        )}
      </StoreDialog>
    );
  }
);
MediaUploadDialog.displayName = 'MediaUploadDialog';

export { MediaUploadDialog };
