import type { Variants } from 'framer-motion';

/** The reveal shared by everything that slides in under a field. */
export const fieldMessage: Variants = {
  hidden: { opacity: 0, height: 0 },
  show: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
};
