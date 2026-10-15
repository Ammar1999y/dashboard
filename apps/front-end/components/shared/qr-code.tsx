import { memo, useMemo } from 'react';

import { encode } from 'uqr';
import { cn } from '@/lib/utils';

/** The margin a scanner needs around the code, in modules. */
const QUIET_ZONE = 4;

/** One horizontal run of dark modules per path segment. */
function modulesPath(rows: readonly (readonly boolean[])[]) {
  const segments: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      segments.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return segments.join('');
}

interface QrCodeProps {
  value: string;
  /** What the code is for, read to a screen reader. */
  label: string;
  className?: string;
}

/**
 * `value` as a QR code, drawn as one SVG path. Black on white whatever the
 * theme: a scanner reads contrast, not the page's colors.
 */
export const QrCode = memo(({ value, label, className }: QrCodeProps) => {
  const { size, path } = useMemo(() => {
    const { size, data } = encode(value, { ecc: 'M', border: 0 });
    return { size, path: modulesPath(data) };
  }, [value]);
  const extent = size + QUIET_ZONE * 2;

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role='img'
      aria-label={label}
      shapeRendering='crispEdges'
      className={cn('aspect-square bg-white', className)}
    >
      <path
        d={path}
        transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`}
        className='fill-black'
      />
    </svg>
  );
});

QrCode.displayName = 'QrCode';
