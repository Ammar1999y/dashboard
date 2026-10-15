import type { LibraryFile } from '@/lib/media/schemas';
import type { CSSProperties } from 'react';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MSG_PRIVATE_IMAGE } from '@/constants/messages';
import { decodeBlurhash } from '@/lib/media/blurhash';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';

import { mimeLabel } from './format';
import styles from './media.module.css';

const SVG_MIME = 'image/svg+xml';

/** A stable hue per file, for the colour behind an image while it loads. */
function hueOf(id: string) {
  let hue = 0;
  for (const character of id)
    hue = (hue * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return hue;
}

const hueStyle = (id: string): CSSProperties =>
  ({ '--h': hueOf(id) }) as CSSProperties;

/** Document tiles keep their type's colour in either theme. */
const DOC_TONES: Readonly<Record<string, string>> = {
  'application/pdf': 'from-red-400 to-red-700',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'from-blue-400 to-blue-700',
  'application/msword': 'from-blue-400 to-blue-700',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'from-green-400 to-green-700',
  'application/vnd.ms-excel': 'from-green-400 to-green-700',
};

const docTone = (mimeType: string) =>
  DOC_TONES[mimeType] ?? 'from-slate-400 to-slate-600';

/** A document as a coloured tile with its type; `large` adds the page glyph. */
export const DocTile = memo(
  ({
    mimeType,
    large = false,
    className,
  }: {
    mimeType: string;
    large?: boolean;
    className?: string;
  }) => (
    <span
      className={cn(
        'flex shrink-0 flex-col items-center justify-center gap-1 bg-gradient-to-b font-mono font-semibold text-white',
        docTone(mimeType),
        className
      )}
    >
      {large ? (
        <>
          <Icon icon='lucide:file-text' className='size-9 opacity-90' />
          <b className='text-sm'>{mimeLabel(mimeType)}</b>
        </>
      ) : (
        // Drawn, not typeset: the label scales with the icon it sits in.
        <svg viewBox='0 0 20 20' className='size-full' aria-hidden>
          <text
            x='10'
            y='12.2'
            fontSize='5.5'
            textAnchor='middle'
            fill='currentColor'
          >
            {mimeLabel(mimeType)}
          </text>
        </svg>
      )}
    </span>
  )
);

DocTile.displayName = 'DocTile';

/** The folder glyph, filled with the theme's colour. */
export const FolderGlyph = memo(({ className }: { className?: string }) => (
  <Icon
    icon='lucide:folder'
    className={cn('shrink-0 text-primary [&_*]:fill-primary/25', className)}
  />
));

FolderGlyph.displayName = 'FolderGlyph';

const BLURHASH_SIZE = 32;
const decoded = new Map<string, Uint8ClampedArray | null>();

function pixelsOf(hash: string) {
  if (!decoded.has(hash))
    decoded.set(hash, decodeBlurhash(hash, BLURHASH_SIZE, BLURHASH_SIZE));
  return decoded.get(hash) ?? null;
}

/** A blurhash, drawn once per hash and kept for every tile that shows it. */
const Blurhash = memo(({ hash }: { hash: string }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const pixels = pixelsOf(hash);
    const context = canvas.current?.getContext('2d');
    if (!pixels || !context) return;
    const image = context.createImageData(BLURHASH_SIZE, BLURHASH_SIZE);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
  }, [hash]);
  return (
    <canvas
      ref={canvas}
      width={BLURHASH_SIZE}
      height={BLURHASH_SIZE}
      className='block size-full'
    />
  );
});

Blurhash.displayName = 'Blurhash';

const LockBadge = memo(({ large }: { large: boolean }) => (
  <span
    className={cn(
      'absolute bottom-0 grid place-items-center bg-black/60 text-white ltr:right-0 rtl:left-0',
      large
        ? 'size-[22px] ltr:rounded-tl-lg rtl:rounded-tr-lg'
        : 'size-2.5 ltr:rounded-tl rtl:rounded-tr'
    )}
  >
    <Icon icon='lucide:lock' className={large ? 'size-3' : 'size-[7px]'} />
  </span>
));

LockBadge.displayName = 'LockBadge';

/** An image whose link failed, or a private one without a blurhash. */
const NeutralTile = ({ large }: { large: boolean }) => (
  <span className='grid size-full place-items-center border bg-muted text-muted-foreground/70'>
    <Icon icon='lucide:image' className={large ? 'size-1/3' : 'size-3/5'} />
  </span>
);

interface FileThumbProps {
  file: Pick<
    LibraryFile,
    'id' | 'kind' | 'mimeType' | 'url' | 'bucketType' | 'blurhash'
  >;
  /** Fills its box, as a grid tile does, rather than a row's icon slot. */
  fill?: boolean;
  className?: string;
}

/**
 * What a list shows for a file. A public image is the image itself; a private
 * one is its blurhash and a lock, its real image only where it is opened; a
 * document is a tile of its type.
 */
export const FileThumb = memo(
  ({ file, fill = false, className }: FileThumbProps) => {
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const failed = useCallback(() => setFailedUrl(file.url), [file.url]);
    const style = useMemo(() => hueStyle(file.id), [file.id]);
    const box = cn(
      'relative block shrink-0 overflow-hidden',
      fill ? 'size-full' : 'size-5 rounded',
      className
    );

    if (file.kind !== 'image')
      return (
        <DocTile
          mimeType={file.mimeType}
          large={fill}
          className={cn(box, fill ? 'rounded-none' : 'rounded')}
        />
      );

    if (file.bucketType !== 'public') {
      const hash = file.mimeType === SVG_MIME ? null : file.blurhash;
      return (
        <span className={box} title={MSG_PRIVATE_IMAGE} style={style}>
          {hash ? <Blurhash hash={hash} /> : <NeutralTile large={fill} />}
          <LockBadge large={fill} />
        </span>
      );
    }

    return (
      <span className={cn(box, styles.hue)} style={style}>
        {failedUrl === file.url ? (
          <NeutralTile large={fill} />
        ) : (
          <img
            src={file.url}
            alt=''
            loading='lazy'
            draggable={false}
            onError={failed}
            className='block size-full object-cover'
          />
        )}
      </span>
    );
  }
);

FileThumb.displayName = 'FileThumb';
