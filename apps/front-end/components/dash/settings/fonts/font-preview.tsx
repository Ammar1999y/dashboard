import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { MSG_FONT_LOAD_FAILED } from '@/constants/messages';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Label } from '@/components/ui/label';

interface FontPreviewProps {
  fontName: string | null | undefined;
  letterSpacing: number;
  lineHeight: number;
  fontSizeMultiplier: number;
  dir?: 'rtl' | 'ltr' | 'auto';
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed';

const DEFAULT_PREVIEW_TEXT = 'اكتب هنا لمعاينة الخط...';
const BASE_FONT_SIZE_PX = 16;

/** Adds the family's Google Fonts stylesheet, and resolves once it has loaded. */
function loadStylesheet(fontName: string): Promise<void> {
  const id = `google-font-${fontName.replace(/\s+/g, '-')}`;
  const existing = document.querySelector(`#${CSS.escape(id)}`);
  if (existing instanceof HTMLLinkElement && existing.sheet) {
    return Promise.resolve();
  }
  // Still pending, or failed earlier: either way it fires no event we can
  // still count on, so it is replaced.
  existing?.remove();

  const link = Object.assign(document.createElement('link'), {
    id,
    rel: 'stylesheet',
    href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;600;700&display=swap`,
  });
  document.head.append(link);

  return new Promise((resolve, reject) => {
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => reject(new Error(fontName)), {
      once: true,
    });
  });
}

/** Whether the family is usable: a stylesheet that names no such face yields none. */
const loadFont = async (fontName: string) => {
  await loadStylesheet(fontName);
  const faces = await document.fonts.load(
    `${BASE_FONT_SIZE_PX}px "${fontName}"`
  );
  return faces.length > 0;
};

export const FontPreview = memo(
  ({
    fontName,
    letterSpacing,
    lineHeight,
    fontSizeMultiplier,
    dir = 'auto',
  }: FontPreviewProps) => {
    const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
    const [loadState, setLoadState] = useState<LoadState>('idle');

    useEffect(() => {
      if (!fontName) {
        setLoadState('idle');
        return;
      }
      // The answer for a font the user has since switched away from is dropped.
      let current = true;
      setLoadState('loading');
      loadFont(fontName)
        .then((usable) => current && setLoadState(usable ? 'loaded' : 'failed'))
        .catch(() => current && setLoadState('failed'));
      return () => {
        current = false;
      };
    }, [fontName]);

    const handleTextChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        setPreviewText(e.target.value),
      []
    );

    const previewStyle = useMemo(
      () => ({
        fontFamily:
          fontName && loadState === 'loaded'
            ? `"${fontName}", sans-serif`
            : undefined,
        letterSpacing: `${letterSpacing}px`,
        lineHeight,
        fontSize: `${BASE_FONT_SIZE_PX * fontSizeMultiplier}px`,
      }),
      [fontName, loadState, letterSpacing, lineHeight, fontSizeMultiplier]
    );

    return (
      <div className='space-y-2'>
        <Label title='معاينة الخط' />
        <AutosizeTextarea
          value={previewText}
          onChange={handleTextChange}
          placeholder={DEFAULT_PREVIEW_TEXT}
          dir={dir}
          style={previewStyle}
          className='px-4 pb-3 pt-4'
          minRows={4}
          maxRows={10}
        />
        {loadState === 'loading' && (
          <p className='text-xs text-muted-foreground'>جاري تحميل الخط...</p>
        )}
        {loadState === 'failed' && (
          <p className='text-xs text-destructive'>{MSG_FONT_LOAD_FAILED}</p>
        )}
      </div>
    );
  }
);

FontPreview.displayName = 'FontPreview';
