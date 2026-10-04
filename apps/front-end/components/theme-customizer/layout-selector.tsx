import { memo, useCallback } from 'react';

import { cn } from '@/lib/utils';

import { Label } from '@/components/ui/label';

import { ThemeLayout, useSettingStore, useThemeLayout } from './layout-store';
import { OptionCard } from './option-card';
import { useEditorStore } from './store';
import { StretchToggle } from './stretch-toggle';

function Bar({ className }: { className: string }) {
  return (
    <div
      className={cn(
        'rounded bg-gray-500 group-data-[active=true]:bg-primary',
        className
      )}
    />
  );
}

const CONTENT =
  'mx-auto w-full opacity-20 transition-all duration-300 ease-in-out group-data-[stretch=false]/layouts:w-10';

function VerticalPreview() {
  return (
    <>
      <div className='flex h-full w-5 flex-col gap-1 p-1'>
        <Bar className='size-2 shrink-0' />
        <Bar className='h-1 w-full shrink-0 opacity-50' />
        <Bar className='h-1 max-w-3 shrink-0 opacity-20' />
      </div>
      <div className='flex h-full flex-1 flex-col gap-1 p-1'>
        <Bar className='h-1.5 w-full opacity-20' />
        <Bar className={cn(CONTENT, 'flex-1')} />
      </div>
    </>
  );
}

function MiniPreview() {
  return (
    <>
      <div className='flex h-full w-3 flex-col items-center gap-1 p-1'>
        <Bar className='size-2 shrink-0' />
        <Bar className='h-1 w-full shrink-0 opacity-50' />
        <Bar className='h-1 w-full shrink-0 opacity-20' />
      </div>
      <div className='flex h-full flex-1 flex-col gap-1 p-1'>
        <Bar className='h-1.5 w-full opacity-20' />
        <Bar className={cn(CONTENT, 'flex-1')} />
      </div>
    </>
  );
}

function HorizontalPreview() {
  return (
    <>
      <div className='flex w-full items-center gap-1 p-1'>
        <Bar className='size-2 shrink-0' />
        <Bar className='h-1 w-4 shrink-0 opacity-50' />
        <Bar className='h-1 w-3 shrink-0 opacity-20' />
        <Bar className='h-1 w-3 shrink-0 opacity-20' />
      </div>
      <Bar className='mx-1 h-1.5 opacity-20' />
      <div className='flex w-full flex-1 flex-col p-1'>
        <Bar className={cn(CONTENT, 'h-full')} />
      </div>
    </>
  );
}

const LAYOUT_OPTIONS = [
  {
    layout: ThemeLayout.Vertical,
    label: 'عمودي',
    className: 'flex-row gap-1',
    Preview: VerticalPreview,
  },
  {
    layout: ThemeLayout.Mini,
    label: 'مصغر',
    className: 'flex-row gap-1',
    Preview: MiniPreview,
  },
  {
    layout: ThemeLayout.Horizontal,
    label: 'أفقي',
    className: 'flex-col',
    Preview: HorizontalPreview,
  },
] as const;

type LayoutOptionProps = (typeof LAYOUT_OPTIONS)[number] & { active: boolean };

const LayoutOption = memo(
  ({ layout, label, className, Preview, active }: LayoutOptionProps) => {
    const handleClick = useCallback(() => {
      useSettingStore.getState().actions.setThemeLayout(layout);
    }, [layout]);

    return (
      <OptionCard
        active={active}
        aria-label={label}
        onClick={handleClick}
        className={cn('h-16', className)}
      >
        <Preview />
      </OptionCard>
    );
  }
);
LayoutOption.displayName = 'LayoutOption';

const LayoutSelector = memo(() => {
  const themeLayout = useThemeLayout();
  const containerStretch = useEditorStore((s) => s.containerStretch);

  return (
    <div className='space-y-3'>
      <Label className='font-medium' title='التخطيط' />
      <div
        data-stretch={containerStretch}
        className='group/layouts grid grid-cols-3 gap-4'
      >
        {LAYOUT_OPTIONS.map((option) => (
          <LayoutOption
            key={option.layout}
            {...option}
            active={themeLayout === option.layout}
          />
        ))}
      </div>
      <StretchToggle containerStretch={containerStretch} />
    </div>
  );
});
LayoutSelector.displayName = 'LayoutSelector';

export { LayoutSelector };
