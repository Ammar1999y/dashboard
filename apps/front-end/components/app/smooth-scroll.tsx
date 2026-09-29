import type { LenisRef } from 'lenis/react';

import { memo, useEffect, useRef } from 'react';

import { cancelFrame, frame } from 'framer-motion';
import { ReactLenis } from 'lenis/react';

// Driven from framer-motion's frame loop, so scroll and animation share a tick.
const OPTIONS = { autoRaf: false };

const SmoothScroll = memo(() => {
  const lenisRef = useRef<LenisRef>(null);

  useEffect(() => {
    const update = ({ timestamp }: { timestamp: number }) =>
      lenisRef.current?.lenis?.raf(timestamp);
    frame.update(update, true);
    return () => cancelFrame(update);
  }, []);

  return <ReactLenis root options={OPTIONS} ref={lenisRef} />;
});

SmoothScroll.displayName = 'SmoothScroll';

export default SmoothScroll;
