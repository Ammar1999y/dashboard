import type { UploadItem, UploadStatus } from '@/lib/media/upload-queue';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import {
  MSG_UPLOAD_CONVERTED_WEBP,
  MSG_UPLOAD_INTO,
  MSG_UPLOAD_STORED_PRIVATE,
  MSG_UPLOAD_SVG_CONVERTED,
  MSG_UPLOAD_WAITING,
  MSG_UPLOADS_EMPTY,
} from '@/constants/messages';
import { resolveFileType } from '@/lib/files/accept';
import {
  cancelAllUploads,
  cancelUpload,
  clearFinishedUploads,
  isActiveUpload,
  retryUpload,
  setUploadsOpen,
  useUploads,
} from '@/lib/media/upload-queue';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LabelTooltip } from '@/components/ui/tooltip';

import styles from './media.module.css';
import { DocTile } from './thumb';

const STATUS_TEXT: Readonly<Record<UploadStatus, string>> = {
  waiting: 'انتظار',
  uploading: 'جارٍ الرفع',
  limited: 'انتظار حد الرفع',
  done: 'تم',
  failed: 'فشل',
  cancelled: 'أُلغي',
};

const STATUS_TONE: Partial<Record<UploadStatus, string>> = {
  done: 'text-success-dark',
  failed: 'text-destructive',
  limited: 'text-warning-dark',
  uploading: 'text-primary',
};

const TICK_MS = 500;

const Countdown = memo(({ until }: { until: number }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className='inline-flex items-center gap-1 text-warning-dark'>
      <Icon icon='lucide:timer' className='size-3' />
      {MSG_UPLOAD_WAITING(Math.max(1, Math.ceil((until - now) / 1000)))}
    </span>
  );
});

Countdown.displayName = 'Countdown';

const Detail = memo(({ item }: { item: UploadItem }) => {
  if (item.status === 'uploading')
    return (
      <span
        className={cn(
          'h-1 min-w-[60px] flex-1 rounded bg-border',
          styles.indeterminate
        )}
      />
    );
  if (item.status === 'limited' && item.retryAt !== undefined)
    return <Countdown until={item.retryAt} />;
  if (item.status === 'failed')
    return <span className='text-destructive'>{item.error}</span>;
  if (item.status !== 'done' || !item.result) return null;
  const stored = item.result;
  let text = MSG_UPLOAD_STORED_PRIVATE;
  if (item.converted) text = MSG_UPLOAD_SVG_CONVERTED;
  else if (
    stored.mimeType === 'image/webp' &&
    stored.sizeBytes < item.file.size
  )
    text = MSG_UPLOAD_CONVERTED_WEBP(
      formatBytes(item.file.size, 1),
      formatBytes(stored.sizeBytes, 1)
    );
  return <span className='text-success-dark'>{text}</span>;
});

Detail.displayName = 'Detail';

const Row = memo(({ item }: { item: UploadItem }) => {
  const queryClient = useQueryClient();
  const cancel = useCallback(() => cancelUpload(item.id), [item.id]);
  const retry = useCallback(
    () => retryUpload(queryClient, item.id),
    [queryClient, item.id]
  );
  const active = isActiveUpload(item);
  const again = item.status === 'failed' || item.status === 'cancelled';
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2 py-[7px] hover:bg-foreground/5',
        item.status === 'cancelled' && 'opacity-60'
      )}
    >
      {item.preview ? (
        <span className='size-8 shrink-0 overflow-hidden rounded-md'>
          <img
            src={item.preview}
            alt=''
            draggable={false}
            className='size-full object-cover'
          />
        </span>
      ) : (
        <DocTile
          mimeType={resolveFileType(item.file)}
          className='size-8 rounded-md'
        />
      )}
      <div className='flex min-w-0 flex-1 flex-col gap-[3px]'>
        <div className='flex min-w-0 items-center gap-2'>
          <span
            className='min-w-0 flex-1 truncate'
            dir='auto'
            title={item.file.name}
          >
            {item.file.name}
          </span>
          <span
            className={cn(
              'shrink-0 text-xs text-muted-foreground',
              STATUS_TONE[item.status]
            )}
          >
            {STATUS_TEXT[item.status]}
          </span>
        </div>
        <div className='flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <span className='text-muted-foreground/70'>
            {MSG_UPLOAD_INTO(item.folderName)} ·{' '}
            <span dir='ltr' className='num bidi-isolate'>
              {formatBytes(item.file.size, 1)}
            </span>
          </span>
          <Detail item={item} />
        </div>
      </div>
      {active && (
        <LabelTooltip label='إلغاء'>
          <Button
            variant='ghost'
            size='none'
            className='size-6'
            onClick={cancel}
          >
            <Icon icon='lucide:x' className='size-4' />
          </Button>
        </LabelTooltip>
      )}
      {again && (
        <LabelTooltip label='إعادة المحاولة'>
          <Button
            variant='ghost'
            size='none'
            className='size-6'
            onClick={retry}
          >
            <Icon icon='lucide:rotate-ccw' className='size-4' />
          </Button>
        </LabelTooltip>
      )}
    </div>
  );
});

Row.displayName = 'Row';

const minimize = () => setUploadsOpen(false);

/** The uploads, at the bottom corner of the library while it has some to show. */
export const UploadPanel = memo(() => {
  const { open, items } = useUploads(
    useShallow((s) => ({ open: s.open, items: s.items }))
  );
  const counts = useMemo(() => {
    const settled = items.filter((item) => !isActiveUpload(item)).length;
    return {
      total: items.length,
      settled,
      done: items.filter(({ status }) => status === 'done').length,
      active: settled < items.length,
    };
  }, [items]);
  const bar = useMemo(
    () => ({
      width: `${counts.total === 0 ? 0 : Math.round((counts.settled / counts.total) * 100)}%`,
    }),
    [counts]
  );
  const close = useCallback(() => {
    if (useUploads.getState().items.some(isActiveUpload)) minimize();
    else clearFinishedUploads();
  }, []);

  if (!open) return null;
  return (
    <div
      role='dialog'
      aria-label='قائمة الرفع'
      className={cn(
        'fixed bottom-[34px] z-40 flex max-h-[60vh] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border bg-card shadow-lg ltr:right-3 rtl:left-3',
        styles.pop
      )}
    >
      <div className='flex items-center gap-1.5 border-b py-2 pe-2.5 ps-2'>
        <b className='flex items-center gap-[7px] font-medium'>
          <Icon icon='lucide:upload' className='size-4' />
          رفع الملفات
        </b>
        <span className='flex-1 px-1.5 text-xs text-muted-foreground'>
          {counts.total > 0 && (
            <>
              <span dir='ltr' className='num bidi-isolate'>
                {counts.done}/{counts.total}
              </span>{' '}
              · {counts.active ? 'جارٍ الرفع' : 'انتهى'}
            </>
          )}
        </span>
        <LabelTooltip label='تصغير'>
          <Button
            variant='ghost'
            size='none'
            className='size-6'
            onClick={minimize}
          >
            <Icon icon='lucide:minus' className='size-4' />
          </Button>
        </LabelTooltip>
        <LabelTooltip label='إغلاق'>
          <Button
            variant='ghost'
            size='none'
            className='size-6'
            onClick={close}
          >
            <Icon icon='lucide:x' className='size-4' />
          </Button>
        </LabelTooltip>
      </div>
      {counts.total > 0 && (
        <div className='h-[3px] bg-border'>
          <i
            className='block h-full bg-primary transition-[width]'
            style={bar}
          />
        </div>
      )}
      <div className='min-h-[60px] overflow-y-auto p-1'>
        {counts.total > 0 ? (
          items.map((item) => <Row key={item.id} item={item} />)
        ) : (
          <div className='flex flex-col items-center gap-1.5 p-5 text-center text-xs text-muted-foreground/70'>
            <Icon icon='lucide:upload' className='size-6' />
            <p>{MSG_UPLOADS_EMPTY}</p>
          </div>
        )}
      </div>
      <div className='flex items-center gap-2 border-t px-3 py-[7px] text-xs text-muted-foreground'>
        <span className='flex-1' />
        {counts.active && (
          <Button
            variant='link'
            size='none'
            className='text-xs'
            onClick={cancelAllUploads}
          >
            إلغاء الكل
          </Button>
        )}
        {counts.settled > 0 && (
          <Button
            variant='link'
            size='none'
            className='text-xs'
            onClick={clearFinishedUploads}
          >
            إزالة المنتهية
          </Button>
        )}
      </div>
    </div>
  );
});

UploadPanel.displayName = 'UploadPanel';
