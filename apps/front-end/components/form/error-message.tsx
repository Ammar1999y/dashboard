import { memo } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { fieldMessage } from '@/lib/motion';

import { useFieldError } from './store';

interface ErrorMessageProps {
  name: string;
  /** Help text shown while the field has no error; `\n` breaks the line. */
  tip?: string;
}

export const ErrorMessage = memo(({ name, tip }: ErrorMessageProps) => {
  const errorMessage = useFieldError(name);

  return (
    <AnimatePresence mode='wait'>
      {errorMessage ? (
        <motion.div
          key='error'
          variants={fieldMessage}
          initial='hidden'
          animate='show'
          exit='exit'
          className='select-none text-sm text-destructive'
        >
          <p className='pt-1.5'>{errorMessage}</p>
        </motion.div>
      ) : tip ? (
        <motion.div
          key='tip'
          variants={fieldMessage}
          initial='hidden'
          animate='show'
          exit='exit'
          className='select-none text-sm text-muted-foreground'
        >
          <p className='whitespace-pre-line pt-1.5 leading-snug'>{tip}</p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
});

ErrorMessage.displayName = 'ErrorMessage';
