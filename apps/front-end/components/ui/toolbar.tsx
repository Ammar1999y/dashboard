import type { VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { Children } from 'react';

import { composeEventHandlers } from '@radix-ui/primitive';
import * as ToolbarPrimitive from '@radix-ui/react-toolbar';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

import { useIsClient } from '@/hooks/use-is-client';
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

function Toolbar({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarPrimitive.Root>) {
  return (
    <ToolbarPrimitive.Root
      className={cn('relative flex select-none items-center', className)}
      {...props}
    />
  );
}

function ToolbarToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarPrimitive.ToolbarToggleGroup>) {
  return (
    <ToolbarPrimitive.ToolbarToggleGroup
      className={cn('flex items-center', className)}
      {...props}
    />
  );
}

const toolbarButtonVariants = cva(
  "inline-flex cursor-pointer hover:text-foreground items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm outline-none transition-[color,box-shadow] hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-accent aria-checked:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-9 min-w-9 px-2',
        lg: 'h-10 min-w-10 px-2.5',
        sm: 'h-8 min-w-8 px-1.5',
      },
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground',
      },
    },
  }
);

const dropdownArrowVariants = cva(
  'inline-flex items-center justify-center font-medium text-foreground text-sm transition-colors disabled:pointer-events-none disabled:opacity-50 ltr:rounded-r-md rtl:rounded-l-md',
  {
    defaultVariants: {
      size: 'sm',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-9 w-6',
        lg: 'h-10 w-8',
        sm: 'h-8 w-4',
      },
      variant: {
        default:
          'bg-transparent hover:bg-muted hover:text-muted-foreground aria-checked:bg-accent aria-checked:text-accent-foreground',
        outline:
          'border border-input border-s-0 bg-transparent hover:bg-accent hover:text-accent-foreground',
      },
    },
  }
);

type ToolbarButtonProps = {
  isDropdown?: boolean;
  pressed?: boolean;
} & Omit<React.ComponentProps<typeof ToolbarToggleItem>, 'asChild' | 'value'> &
  VariantProps<typeof toolbarButtonVariants>;

const ToolbarButton = withTooltip(function ToolbarButton({
  children,
  className,
  isDropdown,
  pressed,
  size = 'sm',
  variant,
  ...props
}: ToolbarButtonProps) {
  return typeof pressed === 'boolean' ? (
    <ToolbarToggleGroup disabled={props.disabled} type='single' value='single'>
      <ToolbarToggleItem
        size={size}
        variant={variant}
        className={cn(isDropdown && 'justify-between gap-1 pe-1', className)}
        value={pressed ? 'single' : ''}
        {...props}
      >
        {isDropdown ? (
          <>
            <div className='flex flex-1 items-center gap-2 whitespace-nowrap'>
              {children}
            </div>
            <div>
              <Icon
                icon='solar:alt-arrow-down-linear'
                className='size-3.5 text-muted-foreground'
                data-icon
              />
            </div>
          </>
        ) : (
          children
        )}
      </ToolbarToggleItem>
    </ToolbarToggleGroup>
  ) : (
    <ToolbarPrimitive.Button
      className={cn(
        toolbarButtonVariants({
          size,
          variant,
        }),
        isDropdown && 'pe-1',
        className
      )}
      {...props}
    >
      {children}
    </ToolbarPrimitive.Button>
  );
});

function ToolbarSplitButton({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarButton>) {
  return (
    <ToolbarButton
      className={cn('group flex gap-0 px-0 hover:bg-transparent', className)}
      {...props}
    />
  );
}

type ToolbarSplitButtonPrimaryProps = React.ComponentProps<'span'> &
  VariantProps<typeof toolbarButtonVariants>;

function ToolbarSplitButtonPrimary({
  children,
  className,
  size = 'sm',
  variant,
  ...props
}: ToolbarSplitButtonPrimaryProps) {
  return (
    <span
      className={cn(
        toolbarButtonVariants({
          size,
          variant,
        }),
        'ltr:rounded-r-none rtl:rounded-l-none',
        'group-data-[pressed=true]:bg-accent group-data-[pressed=true]:text-accent-foreground',
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

// The arrow sits inside the split button, whose own press must not fire.
function ToolbarSplitButtonSecondary({
  className,
  size,
  variant,
  onClick,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof dropdownArrowVariants>) {
  const handleClick = composeEventHandlers(onClick, stopPropagation);

  return (
    <span
      className={cn(
        dropdownArrowVariants({
          size,
          variant,
        }),
        'group-data-[pressed=true]:bg-accent group-data-[pressed=true]:text-accent-foreground',
        className
      )}
      onClick={handleClick}
      role='button'
      {...props}
    >
      <Icon
        icon='solar:alt-arrow-down-linear'
        className='size-3.5 text-muted-foreground'
        data-icon
      />
    </span>
  );
}

function ToolbarToggleItem({
  className,
  size = 'sm',
  variant,
  ...props
}: React.ComponentProps<typeof ToolbarPrimitive.ToggleItem> &
  VariantProps<typeof toolbarButtonVariants>) {
  return (
    <ToolbarPrimitive.ToggleItem
      className={cn(toolbarButtonVariants({ size, variant }), className)}
      {...props}
    />
  );
}

// Children that render nothing (a read-only editor) leave the row `:empty`,
// which hides it and its separator; `:has(button)` did it but is past the
// browserslist.
function ToolbarGroup({
  children,
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('group/toolbar-group relative flex', className)}
      {...props}
    >
      <div className='peer/toolbar-row flex items-center empty:hidden'>
        {children}
      </div>

      <div className='mx-1.5 py-0.5 group-last/toolbar-group:!hidden peer-empty/toolbar-row:hidden'>
        <Separator orientation='vertical' />
      </div>
    </div>
  );
}

type TooltipProps<T extends React.ElementType> = {
  tooltip?: React.ReactNode;
  tooltipContentProps?: Omit<
    React.ComponentProps<typeof TooltipContent>,
    'children'
  >;
  tooltipProps?: Omit<React.ComponentProps<typeof Tooltip>, 'children'>;
  tooltipTriggerProps?: React.ComponentProps<typeof TooltipTrigger>;
} & React.ComponentProps<T>;

function withTooltip<T extends React.ElementType>(Component: T) {
  return function ExtendComponent({
    tooltip,
    tooltipContentProps,
    tooltipProps,
    tooltipTriggerProps,
    ...props
  }: TooltipProps<T>) {
    const isClient = useIsClient();

    const component = <Component {...(props as React.ComponentProps<T>)} />;

    if (tooltip && isClient) {
      return (
        <Tooltip {...tooltipProps}>
          <TooltipTrigger asChild {...tooltipTriggerProps}>
            {component}
          </TooltipTrigger>

          <TooltipContent {...tooltipContentProps}>{tooltip}</TooltipContent>
        </Tooltip>
      );
    }

    return component;
  };
}

/** A group whose items all render nothing is left out, separator and all. */
function ToolbarMenuGroup({
  children,
  className,
  label,
  ...props
}: React.ComponentProps<typeof DropdownMenuRadioGroup> & { label?: string }) {
  if (Children.toArray(children).length === 0) return null;

  return (
    <>
      <DropdownMenuSeparator className='mb-0 shrink-0 first:hidden' />

      <DropdownMenuRadioGroup
        {...props}
        className={cn('group/menu-group my-1.5', className)}
      >
        {label && (
          <DropdownMenuLabel className='select-none text-xs font-semibold text-muted-foreground'>
            {label}
          </DropdownMenuLabel>
        )}
        {children}
      </DropdownMenuRadioGroup>
    </>
  );
}

export {
  Toolbar,
  ToolbarButton,
  toolbarButtonVariants,
  ToolbarGroup,
  ToolbarMenuGroup,
  ToolbarSplitButton,
  ToolbarSplitButtonPrimary,
  ToolbarSplitButtonSecondary,
};
