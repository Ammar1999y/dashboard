'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

import { Button, buttonVariants } from '@/components/ui/button';
import { ColorPickerContent } from '@/components/ui/color-picker';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarMenuGroup } from '@/components/ui/toolbar';
import {
  DEFAULT_COLORS,
  useCustomColors,
} from '@/components/editor/hooks/use-custom-colors';

const INITIAL_CUSTOM_COLOR = '#000000';

const ColorSwatch = React.memo(
  ({
    selected,
    value,
    onSelect,
  }: {
    selected: boolean;
    value: string;
    onSelect: (color: string) => void;
  }) => {
    const style = React.useMemo(() => ({ backgroundColor: value }), [value]);
    const handleSelect = React.useCallback(
      (event: Event) => {
        event.preventDefault();
        onSelect(value);
      },
      [onSelect, value]
    );

    return (
      <DropdownMenuItem
        aria-label={value}
        className={cn(
          buttonVariants({ size: 'icon', variant: 'outline' }),
          'my-1 flex size-6 items-center justify-center rounded-full border border-solid border-border p-0 transition-all hover:scale-125',
          selected && 'border-2 border-primary'
        )}
        onSelect={handleSelect}
        style={style}
      />
    );
  }
);
ColorSwatch.displayName = 'ColorSwatch';

function ColorSwatches({
  className,
  color,
  colors,
  onSelect,
}: {
  className?: string;
  color?: string;
  colors: string[];
  onSelect: (color: string) => void;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[repeat(10,1fr)] place-items-center gap-x-1',
        className
      )}
    >
      {colors.map((value) => (
        <ColorSwatch
          key={value}
          onSelect={onSelect}
          selected={color?.toUpperCase() === value}
          value={value}
        />
      ))}
    </div>
  );
}

/**
 * The palette both color menus show: a custom picker, the colors saved from
 * it, and the default grid. `onSelect` is expected to close the menu.
 */
export function ColorMenuContent({
  color,
  onClear,
  onSelect,
}: {
  color?: string;
  onClear?: () => void;
  onSelect: (color: string) => void;
}) {
  const { customColors, addCustomColor, clearCustomColors } = useCustomColors();
  const [pickerColor, setPickerColor] = React.useState(
    color || INITIAL_CUSTOM_COLOR
  );

  return (
    <div className='flex flex-col'>
      <ToolbarMenuGroup>
        <div className='flex flex-col gap-1 px-2'>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className='w-full justify-start gap-2'>
              <Icon icon='solar:add-linear' className='size-4' />
              <span>إضافة لون مخصص</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className='w-auto p-3' sideOffset={8}>
              <div className='flex flex-col gap-3'>
                <ColorPickerContent
                  value={pickerColor}
                  onChange={setPickerColor}
                />
                <div className='flex w-full gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    className='flex-1'
                    onClick={(event) => {
                      event.preventDefault();
                      setPickerColor(color || INITIAL_CUSTOM_COLOR);
                    }}
                  >
                    إلغاء
                  </Button>
                  <Button
                    size='sm'
                    className='flex-1'
                    disabled={!pickerColor}
                    onClick={() => {
                      addCustomColor(pickerColor);
                      onSelect(pickerColor);
                    }}
                  >
                    حفظ واختيار
                  </Button>
                </div>
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {onClear && (
            <DropdownMenuItem
              className='w-full justify-start gap-2'
              onClick={onClear}
            >
              <Icon icon='solar:eraser-linear' className='size-4' />
              <span>مسح اللون</span>
            </DropdownMenuItem>
          )}
        </div>
      </ToolbarMenuGroup>

      {customColors.length > 0 && (
        <ToolbarMenuGroup label='ألوان مخصصة'>
          <div className='flex flex-col gap-2 px-2'>
            <ColorSwatches
              color={color}
              colors={customColors}
              onSelect={onSelect}
            />
            <DropdownMenuItem
              className='justify-center text-xs text-muted-foreground focus:text-destructive'
              onClick={(event) => {
                event.preventDefault();
                clearCustomColors();
              }}
            >
              مسح الألوان المخصصة
            </DropdownMenuItem>
          </div>
        </ToolbarMenuGroup>
      )}

      <ToolbarMenuGroup label='ألوان افتراضية'>
        <ColorSwatches
          className='px-2'
          color={color}
          colors={DEFAULT_COLORS}
          onSelect={onSelect}
        />
      </ToolbarMenuGroup>
    </div>
  );
}
