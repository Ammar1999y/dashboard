import type { Transition } from 'framer-motion';
import type { ReactNode } from 'react';

import { useCallback, useState } from 'react';

import { motion } from 'framer-motion';
import useMeasure from 'react-use-measure';
import { create } from 'zustand';
import { cn } from '@/lib/utils';

const HEIGHT_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 34,
};

/**
 * Pauses the height animation: content that changes height continuously (a
 * row being dragged) would otherwise be chased frame by frame.
 */
export const useSmoothHeightStore = create<{
  disabled: boolean;
  setDisabled: (disabled: boolean) => void;
}>((set) => ({
  disabled: false,
  setDisabled: (disabled) => set({ disabled }),
}));

interface SmoothHeightContainerProps {
  children: ReactNode;
  className?: string;
}

/** Animates to its content's measured height. */
export const SmoothHeightContainer = ({
  children,
  className,
}: SmoothHeightContainerProps) => {
  const [ref, bounds] = useMeasure();
  // Clipped only mid-animation, so popovers and focus rings are not cut off at rest.
  const [isAnimating, setIsAnimating] = useState(false);
  const handleAnimationStart = useCallback(() => setIsAnimating(true), []);
  const handleAnimationComplete = useCallback(() => setIsAnimating(false), []);
  const disabled = useSmoothHeightStore((s) => s.disabled);

  return (
    <motion.div
      className={cn('relative', isAnimating && 'overflow-y-clip-safe')}
      animate={{ height: disabled ? 'auto' : bounds.height || 'auto' }}
      transition={HEIGHT_TRANSITION}
      onAnimationStart={handleAnimationStart}
      onAnimationComplete={handleAnimationComplete}
    >
      <div ref={ref} className={className}>
        {children}
      </div>
    </motion.div>
  );
};
