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
  carouselRef: ReturnType<typeof useEmblaCarousel>[0];
  api: ReturnType<typeof useEmblaCarousel>[1];
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

const Carousel = ({
  orientation = 'horizontal',
  opts,
  setApi,
  plugins,
  className,
  children,
  itemsLength,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> &
  CarouselProps & { itemsLength: number; ref?: React.Ref<HTMLDivElement> }) => {
  const [carouselRef, api] = useEmblaCarousel(
    {
      direction: 'rtl',
      ...opts,
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

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        (event.key === 'ArrowLeft' && document.dir === 'ltr') ||
        (event.key === 'ArrowRight' && document.dir === 'rtl')
      ) {
        event.preventDefault();
        scrollPrev();
      } else if (
        (event.key === 'ArrowRight' && document.dir === 'ltr') ||
        (event.key === 'ArrowLeft' && document.dir === 'rtl')
      ) {
        event.preventDefault();
        scrollNext();
      }
    },
    [scrollPrev, scrollNext]
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
    if (!api || itemsLength <= 1) return;

    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const onPointerDown = () => {
      clearTimeout(resumeTimer);
      api.plugins().autoplay?.stop();
    };
    const onPointerUp = () => {
      if (!api.plugins().autoplay) return;
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => api.plugins().autoplay?.play(), 1000);
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
  }, [api, itemsLength]);

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
        ref={ref}
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
};
Carousel.displayName = 'Carousel';

const CarouselContent = ({
  className,
  ref,
  wrapperClassName,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.Ref<HTMLDivElement>;
  wrapperClassName?: string;
}) => {
  const { carouselRef, orientation } = useCarousel();

  return (
    <div ref={carouselRef} className={cn('overflow-hidden', wrapperClassName)}>
      <div
        ref={ref}
        className={cn(
          'flex',
          orientation === 'horizontal' ? '-ms-4' : '-mt-4 flex-col',
          className
        )}
        {...props}
      />
    </div>
  );
};
CarouselContent.displayName = 'CarouselContent';

const CarouselItem = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.Ref<HTMLDivElement>;
}) => {
  const { orientation } = useCarousel();
  return (
    <div
      ref={ref}
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
};
CarouselItem.displayName = 'CarouselItem';

const CarouselPrevious = ({
  className,
  variant = 'none',
  size = 'icon',
  ref,
  ...props
}: React.ComponentProps<typeof Button>) => {
  const { orientation, scrollPrev, canScrollPrev } = useCarousel();

  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label='السابق'
      className={cn(
        'absolute z-10 size-9 rounded-full bg-white/20 p-2 text-white backdrop-blur-sm duration-300 hover:scale-110 hover:bg-white/30 active:scale-95 ltr:left-2 rtl:right-2',
        orientation === 'horizontal'
          ? 'top-1/2 -translate-y-1/2'
          : '-top-12 -translate-x-1/2 rotate-90',
        className
      )}
      disabled={!canScrollPrev}
      onClick={scrollPrev}
      {...props}
    >
      <Arrow className='size-full' />
    </Button>
  );
};
CarouselPrevious.displayName = 'CarouselPrevious';

const CarouselNext = ({
  className,
  variant = 'none',
  size = 'icon',
  ref,
  ...props
}: React.ComponentProps<typeof Button>) => {
  const { orientation, scrollNext, canScrollNext } = useCarousel();

  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label='التالي'
      className={cn(
        'absolute z-10 size-9 rotate-180 rounded-full bg-white/20 p-2 text-white backdrop-blur-sm duration-300 hover:scale-110 hover:bg-white/30 active:scale-95 ltr:right-2 rtl:left-2',
        orientation === 'horizontal'
          ? 'top-1/2 -translate-y-1/2'
          : '-bottom-12 -translate-x-1/2 rotate-90',
        className
      )}
      disabled={!canScrollNext}
      onClick={scrollNext}
      {...props}
    >
      <Arrow className='size-full' />
    </Button>
  );
};
CarouselNext.displayName = 'CarouselNext';

export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
};
