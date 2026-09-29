import { cn } from '@/lib/utils';

type OptionCardProps = React.ComponentProps<'button'> & { active: boolean };

// `group` exposes `data-active` to the card's content.
export function OptionCard({ active, className, ...props }: OptionCardProps) {
  return (
    <button
      type='button'
      data-active={active}
      aria-pressed={active}
      className={cn(
        'group flex flex-1 cursor-pointer overflow-hidden rounded-xl border bg-card text-card-foreground opacity-65 shadow-sm transition duration-300 hover:bg-transparent disabled:pointer-events-none data-[active=true]:bg-transparent data-[active=true]:text-primary data-[active=true]:opacity-100',
        className
      )}
      {...props}
    />
  );
}
