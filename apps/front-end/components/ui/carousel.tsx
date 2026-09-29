import type { UseEmblaCarouselType } from 'embla-carousel-react';

import * as React from 'react';

import useEmblaCarousel from 'embla-carousel-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import Arrow from '@/components/icons/arrow';

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
export type CarouselOptions = UseCarouselParameters[0];
export type CarouselPlugin = UseCarouselParameters[1];

type CarouselProps = {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: 'horizontal' | 'vertical';
  setApi?: (api: CarouselApi) => void;
};

type CarouselContextProps = {
  carouselRef: UseEmblaCarouselType[0];
  api: CarouselApi;
  scrollPrev: () => void;
  scrollNext: () => void;
  canScrollPrev: boolean;
  canScrollNext: boolean;
} & CarouselProps;

const CarouselContext = React.createContext<CarouselContextProps | null>(null);

function useCarousel() {
  const context = React.useContext(CarouselContext);

  if (!context) {
    throw new Error('useCarousel must be used within a <Carousel />');
  }

  return context;
}

const AUTOPLAY_RESUME_DELAY = 1000;

function Carousel({
  orientation = 'horizontal',
  opts,
  setApi,
  plugins,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & CarouselProps) {
  const direction = opts?.direction ?? 'rtl';
  const [carouselRef, api] = useEmblaCarousel(
    {
      ...opts,
      direction,
      axis: orientation === 'horizontal' ? 'x' : 'y',
    },
    plugins
  );
  const [canScrollPrev, setCanScrollPrev] = React.useState(false);
  const [canScrollNext, setCanScrollNext] = React.useState(false);

  const onSelect = React.useCallback((api: CarouselApi) => {
    if (!api) return;

    setCanScrollPrev(api.canScrollPrev());
    setCanScrollNext(api.canScrollNext());
  }, []);

  const scrollPrev = React.useCallback(() => {
    api?.scrollPrev();
  }, [api]);

  const scrollNext = React.useCallback(() => {
    api?.scrollNext();
  }, [api]);

  // Keys follow the carousel's own direction: under `rtl` the previous slide
  // is to the right.
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const prevKey = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      const nextKey = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      if (event.key === prevKey) {
        event.preventDefault();
        scrollPrev();
      } else if (event.key === nextKey) {
        event.preventDefault();
        scrollNext();
      }
    },
    [direction, scrollPrev, scrollNext]
  );

  React.useEffect(() => {
    if (api && setApi) setApi(api);
  }, [api, setApi]);

  React.useEffect(() => {
    if (!api) return;

    onSelect(api);
    api.on('reInit', onSelect);
    api.on('select', onSelect);

    return () => {
      api.off('reInit', onSelect);
      api.off('select', onSelect);
    };
  }, [api, onSelect]);

  // Autoplay pauses while the pointer is down and resumes a second after it
  // leaves; the pending resume must not outlive the carousel.
  React.useEffect(() => {
    if (!api) return;

    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const onPointerDown = () => {
      clearTimeout(resumeTimer);
      api.plugins().autoplay?.stop();
    };
    const onPointerUp = () => {
      if (!api.plugins().autoplay) return;
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(
        () => api.plugins().autoplay?.play(),
        AUTOPLAY_RESUME_DELAY
      );
    };

    const emblaNode = api.rootNode();
    emblaNode.addEventListener('pointerdown', onPointerDown);
    emblaNode.addEventListener('pointerup', onPointerUp);
    emblaNode.addEventListener('pointerleave', onPointerUp);

    return () => {
      clearTimeout(resumeTimer);
      emblaNode.removeEventListener('pointerdown', onPointerDown);
      emblaNode.removeEventListener('pointerup', onPointerUp);
      emblaNode.removeEventListener('pointerleave', onPointerUp);
    };
  }, [api]);

  const contextValue = React.useMemo<CarouselContextProps>(
    () => ({
      carouselRef,
      api,
      opts,
      orientation,
      scrollPrev,
      scrollNext,
      canScrollPrev,
      canScrollNext,
    }),
    [
      carouselRef,
      api,
      opts,
      orientation,
      scrollPrev,
      scrollNext,
      canScrollPrev,
      canScrollNext,
    ]
  );

  return (
    <CarouselContext.Provider value={contextValue}>
      <div
        onKeyDownCapture={handleKeyDown}
        className={cn('relative', className)}
        role='region'
        aria-roledescription='carousel'
        {...props}
      >
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

function CarouselContent({
  className,
  wrapperClassName,
  ...props
}: React.ComponentProps<'div'> & { wrapperClassName?: string }) {
  const { carouselRef, orientation } = useCarousel();

  return (
    <div ref={carouselRef} className={cn('overflow-hidden', wrapperClassName)}>
      <div
        className={cn(
          'flex',
          orientation === 'horizontal' ? '-ms-4' : '-mt-4 flex-col',
          className
        )}
        {...props}
      />
    </div>
  );
}

function CarouselItem({ className, ...props }: React.ComponentProps<'div'>) {
  const { orientation } = useCarousel();
  return (
    <div
      role='group'
      aria-roledescription='slide'
      className={cn(
        'pointer-events-none min-w-0 shrink-0 grow-0 basis-full select-none',
        orientation === 'horizontal' ? 'ps-4' : 'pt-4',
        className
      )}
      {...props}
    />
  );
}

// `Arrow` points right: toward "previous" under `rtl`, so "next" turns it.
const ARROWS = {
  prev: {
    label: 'السابق',
    horizontal: 'top-1/2 -translate-y-1/2 ltr:left-2 rtl:right-2',
    vertical: '-top-12 inset-x-0 mx-auto -rotate-90',
  },
  next: {
    label: 'التالي',
    horizontal: 'top-1/2 -translate-y-1/2 rotate-180 ltr:right-2 rtl:left-2',
    vertical: '-bottom-12 inset-x-0 mx-auto rotate-90',
  },
} as const;

function CarouselArrow({
  step,
  className,
  variant = 'none',
  size = 'icon',
  ...props
}: React.ComponentProps<typeof Button> & { step: 'prev' | 'next' }) {
  const {
    orientation = 'horizontal',
    scrollPrev,
    scrollNext,
    canScrollPrev,
    canScrollNext,
  } = useCarousel();
  const arrow = ARROWS[step];

  return (
    <Button
      variant={variant}
      size={size}
      aria-label={arrow.label}
      className={cn(
        'absolute z-10 size-9 rounded-full bg-white/20 p-2 text-white backdrop-blur-sm duration-300 hover:scale-110 hover:bg-white/30 active:scale-95',
        arrow[orientation],
        className
      )}
      disabled={step === 'prev' ? !canScrollPrev : !canScrollNext}
      onClick={step === 'prev' ? scrollPrev : scrollNext}
      {...props}
    >
      <Arrow className='size-full' />
    </Button>
  );
}

function CarouselPrevious(props: React.ComponentProps<typeof Button>) {
  return <CarouselArrow step='prev' {...props} />;
}

function CarouselNext(props: React.ComponentProps<typeof Button>) {
  return <CarouselArrow step='next' {...props} />;
}

export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
};
