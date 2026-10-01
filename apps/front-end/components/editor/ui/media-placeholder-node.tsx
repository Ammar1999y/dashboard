'use client';

import type { TPlaceholderElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import * as React from 'react';

import {
  PlaceholderPlugin,
  PlaceholderProvider,
  updateUploadHistory,
} from '@platejs/media/react';
import { PlateElement, useEditorPlugin, withHOC } from 'platejs/react';
import { useFilePicker } from 'use-file-picker';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Icon } from '@/components/ui/icon';
import { useUploadFile } from '@/components/editor/hooks/use-upload-file';
import {
  MEDIA_TYPE_BY_NODE,
  mediaConfig,
  toAcceptList,
} from '@/components/editor/media-config';

export const PlaceholderElement = withHOC(
  PlaceholderProvider,
  function PlaceholderElement(props: PlateElementProps<TPlaceholderElement>) {
    const { editor, element } = props;

    const { api } = useEditorPlugin(PlaceholderPlugin);

    const { isUploading, progress, uploadedFile, uploadFile, uploadingFile } =
      useUploadFile();

    const loading = isUploading && uploadingFile;

    const mediaType = MEDIA_TYPE_BY_NODE[element.mediaType] ?? 'file';
    const config = mediaConfig[mediaType];
    const accept = React.useMemo(() => toAcceptList(config.accept), [config]);

    const isImage = mediaType === 'image';

    const imageRef = React.useRef<HTMLImageElement>(null);

    const { openFilePicker } = useFilePicker({
      accept,
      multiple: true,
      onFilesSelected: (data: { plainFiles?: File[] }) => {
        if (!data.plainFiles || data.plainFiles.length === 0) return;

        const firstFile = data.plainFiles[0];
        const restFiles = data.plainFiles.slice(1);

        replaceCurrentPlaceholder(firstFile);

        if (restFiles.length > 0) {
          // Typed as a `FileList`, but `insert.media` only iterates it.
          editor
            .getTransforms(PlaceholderPlugin)
            .insert.media(restFiles as unknown as FileList);
        }
      },
    });

    const replaceCurrentPlaceholder = React.useCallback(
      (file: File) => {
        void uploadFile(file, mediaType);
        api.placeholder.addUploadingFile(element.id as string, file);
      },
      [api.placeholder, element.id, mediaType, uploadFile]
    );

    React.useEffect(() => {
      if (!uploadedFile) return;

      const path = editor.api.findPath(element);

      editor.tf.withoutSaving(() => {
        editor.tf.removeNodes({ at: path });

        const node = {
          children: [{ text: '' }],
          initialHeight: imageRef.current?.height,
          initialWidth: imageRef.current?.width,
          isUpload: true,
          name: mediaType === 'file' ? uploadedFile.name : '',
          placeholderId: element.id as string,
          type: element.mediaType ?? '',
          url: uploadedFile.url,
        };

        editor.tf.insertNodes(node, { at: path });

        updateUploadHistory(editor, node);
      });

      api.placeholder.removeUploadingFile(element.id as string);
    }, [uploadedFile, element.id, api.placeholder, editor, element, mediaType]);

    // React dev mode will call React.useEffect twice
    const isReplaced = React.useRef(false);

    /** Paste and drop */
    React.useEffect(() => {
      if (isReplaced.current) return;

      isReplaced.current = true;
      const currentFiles = api.placeholder.getUploadingFile(
        element.id as string
      );

      if (!currentFiles) return;

      replaceCurrentPlaceholder(currentFiles);
    }, [api.placeholder, element.id, replaceCurrentPlaceholder]);

    return (
      <PlateElement className='my-1' {...props}>
        {(!loading || !isImage) && (
          <div
            className={cn(
              'flex cursor-pointer select-none items-center rounded-sm bg-muted p-3 pe-9 hover:bg-primary/10'
            )}
            contentEditable={false}
            onClick={() => !loading && openFilePicker()}
          >
            <div className='relative me-3 flex text-muted-foreground/80 [&_svg]:size-6'>
              <Icon icon={config.icon} />
            </div>
            <div className='whitespace-nowrap text-sm text-muted-foreground'>
              <div>
                {loading ? uploadingFile?.name : `إضافة ${config.label}`}
              </div>

              {loading && !isImage && (
                <div className='mt-1 flex items-center gap-1.5'>
                  <div>{formatBytes(uploadingFile?.size ?? 0, 0)}</div>
                  <div>–</div>
                  <div className='flex items-center'>
                    <Icon
                      icon='lucide:loader-circle'
                      className='me-1 size-3.5 animate-spin text-muted-foreground'
                    />
                    {progress}%
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {isImage && loading && (
          <ImageProgress
            file={uploadingFile}
            imageRef={imageRef}
            progress={progress}
          />
        )}

        {props.children}
      </PlateElement>
    );
  }
);

function ImageProgress({
  className,
  file,
  imageRef,
  progress = 0,
}: {
  file: File;
  className?: string;
  imageRef?: React.RefObject<HTMLImageElement | null>;
  progress?: number;
}) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  if (!objectUrl) {
    return null;
  }

  return (
    <div className={cn('relative', className)} contentEditable={false}>
      <img
        alt={file.name}
        className='h-auto w-full rounded-sm object-cover'
        ref={imageRef}
        src={objectUrl}
      />
      {progress < 100 && (
        <div className='absolute bottom-1 flex items-center gap-2 rounded-full bg-black/50 px-1 py-0.5 ltr:left-1 rtl:right-1'>
          <Icon
            icon='lucide:loader-circle'
            className='size-3.5 animate-spin text-muted-foreground'
          />
          <span className='text-xs font-medium text-white'>
            {Math.round(progress)}%
          </span>
        </div>
      )}
    </div>
  );
}
