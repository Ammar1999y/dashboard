import type { CarouselOptions, CarouselPlugin } from '@/components/ui/carousel';

import Image from 'next/image';
import { memo, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel';

const OPTIONS: CarouselOptions = {
  loop: true,
  dragFree: false,
  align: 'start',
  skipSnaps: false,
};

const AUTOPLAY_DELAY_MS = 4000;

interface CarouselImage {
  url?: string | null;
}

interface ImagesCarouselProps {
  images: CarouselImage[];
  /** The alt text of every image. */
  title: string;
}

/**
 * One image as it is, several as an autoplaying carousel. Lazy-load this
 * component where it is used: the carousel library is its whole weight.
 */
const ImagesCarousel = memo(({ images, title }: ImagesCarouselProps) => {
  const shown = images.filter((image) => image.url);
  const [plugins, setPlugins] = useState<CarouselPlugin>([]);
  const carousel = shown.length > 1;

  useEffect(() => {
    if (!carousel) return;
    let current = true;
    void import('embla-carousel-autoplay').then(({ default: autoplay }) => {
      if (current) setPlugins([autoplay({ delay: AUTOPLAY_DELAY_MS })]);
    });
    return () => {
      current = false;
    };
  }, [carousel]);

  if (shown.length === 0) return null;
  if (!carousel) {
    return (
      <ImageItem url={shown[0].url} title={title} first className='mb-4' />
    );
  }

  return (
    <Carousel className='relative mb-4 w-full' opts={OPTIONS} plugins={plugins}>
      <CarouselContent>
        {shown.map((image, index) => (
          <CarouselItem key={index} className='group basis-full'>
            <ImageItem url={image.url} title={title} first={index === 0} />
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  );
});

ImagesCarousel.displayName = 'ImagesCarousel';

export default ImagesCarousel;

interface ImageItemProps {
  url: CarouselImage['url'];
  title: string;
  /** Loaded eagerly: it is the one on screen first. */
  first?: boolean;
  className?: string;
}

const ImageItem = memo(({ url, title, first, className }: ImageItemProps) =>
  url ? (
    <Image
      src={url}
      alt={title}
      width={400}
      height={300}
      className={cn(
        'h-64 w-full rounded-lg object-cover shadow-md sm:h-80 md:h-96 lg:h-72',
        className
      )}
      loading={first ? 'eager' : 'lazy'}
      priority={first}
      fetchPriority={first ? 'high' : 'auto'}
    />
  ) : null
);

ImageItem.displayName = 'ImagesCarouselItem';
