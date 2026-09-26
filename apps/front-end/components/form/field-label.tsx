import { memo } from 'react';

import { HelpCircle as _HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const HelpCircle = memo(_HelpCircle);
HelpCircle.displayName = 'HelpCircle';

interface FieldLabelProps {
  title: string;
  htmlFor?: string;
  required?: boolean;
  /** Help icon beside the label; `\n` renders as a line break. */
  tooltip?: string;
  className?: string;
}

/**
 * The label every field component renders. Plain `Label` when there is nothing
 * to explain, label + help icon when there is — the tooltip row carries the
 * bottom margin itself so both variants leave the same gap above the control.
 */
const FieldLabel = memo(
  ({ title, htmlFor, required, tooltip, className }: FieldLabelProps) => {
    if (!tooltip) {
      return (
        <Label
          title={title}
          required={required}
          htmlFor={htmlFor}
          className={className}
        />
      );
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className='mb-2 flex w-fit items-center gap-2'>
            <Label
              title={title}
              required={required}
              htmlFor={htmlFor}
              className={cn('mb-0', className)}
            />
            <HelpCircle className='h-4 w-4 cursor-help text-muted-foreground' />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className='whitespace-pre-line text-xs'>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
);

FieldLabel.displayName = 'FieldLabel';

export { FieldLabel };
