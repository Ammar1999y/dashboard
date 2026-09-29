import * as React from 'react';

import { composeEventHandlers } from '@radix-ui/primitive';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

const CLOSE_DELAY = 300;

interface TooltipActions {
  hold: () => void;
  release: () => void;
  dismiss: () => void;
}

const noop = () => {};

const TooltipActionsContext = React.createContext<TooltipActions>({
  hold: noop,
  release: noop,
  dismiss: noop,
});

/**
 * Open is driven here, not by Radix, because Radix ignores touch: a tap holds
 * the tooltip open until focus or the pointer leaves both trigger and content,
 * and the close delay bridges the gap between the two.
 */
function useTooltipOpen(delayDuration: number) {
  const [open, setOpen] = React.useState(false);
  const [held, setHeld] = React.useState(false);

  React.useEffect(() => {
    if (held === open) return;
    const delay = held ? delayDuration : CLOSE_DELAY;
    if (delay === 0) {
      setOpen(held);
      return;
    }
    const timer = setTimeout(() => setOpen(held), delay);
    return () => clearTimeout(timer);
  }, [held, open, delayDuration]);

  const actions = React.useMemo<TooltipActions>(
    () => ({
      hold: () => setHeld(true),
      release: () => setHeld(false),
      dismiss: () => {
        setHeld(false);
        setOpen(false);
      },
    }),
    []
  );

  return { open, actions };
}

function Tooltip({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const { open, actions } = useTooltipOpen(delayDuration);

  return (
    <TooltipPrimitive.Provider data-slot='tooltip-provider'>
      <TooltipActionsContext.Provider value={actions}>
        <TooltipPrimitive.Root open={open} data-slot='tooltip' {...props} />
      </TooltipActionsContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

function TooltipTrigger({
  className,
  onPointerEnter,
  onPointerLeave,
  onClick,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const { hold, release } = React.useContext(TooltipActionsContext);

  const handlePointerEnter = composeEventHandlers(onPointerEnter, hold);
  const handlePointerLeave = composeEventHandlers(onPointerLeave, release);
  const handleClick = composeEventHandlers(onClick, hold);
  const handleFocus = composeEventHandlers(onFocus, hold);
  const handleBlur = composeEventHandlers(onBlur, release);

  return (
    <TooltipPrimitive.Trigger
      data-slot='tooltip-trigger'
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={cn('rounded-sm', className)}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  onPointerEnter,
  onPointerLeave,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const { hold, release, dismiss } = React.useContext(TooltipActionsContext);

  const handlePointerEnter = composeEventHandlers(onPointerEnter, hold);
  const handlePointerLeave = composeEventHandlers(onPointerLeave, release);
  const handleEscapeKeyDown = composeEventHandlers(onEscapeKeyDown, dismiss);

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot='tooltip-content'
        sideOffset={sideOffset}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onEscapeKeyDown={handleEscapeKeyDown}
        className={cn(
          'z-50 w-fit origin-[--radix-tooltip-content-transform-origin] text-balance rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className
        )}
        {...props}
      >
        <TooltipPrimitive.Arrow className='size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-sm bg-popover fill-popover' />
        <div className='relative'>{children}</div>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/**
 * For a control whose only visible content is an icon: `label` is both its
 * accessible name and its tooltip. The child must forward props, as for any
 * `asChild` trigger.
 */
function LabelTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-label={label}>
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <p className='text-sm'>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, LabelTooltip };
