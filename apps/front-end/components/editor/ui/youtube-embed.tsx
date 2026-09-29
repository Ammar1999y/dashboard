'use client';

import LiteYouTubeEmbed from 'react-lite-youtube-embed';
import { cn } from '@/lib/utils';

// The package's stylesheet as utilities.
const WRAPPER_CLASS = cn(
  'relative block cursor-pointer rounded-sm bg-black bg-cover bg-center [contain:content]',
  '[&.lyt-activated]:before:absolute [&.lyt-activated]:before:top-0 [&.lyt-activated]:before:h-14 [&.lyt-activated]:before:w-full [&.lyt-activated]:before:bg-top [&.lyt-activated]:before:bg-repeat-x [&.lyt-activated]:before:pb-12 [&.lyt-activated]:before:[transition:all_0.2s_cubic-bezier(0,_0,_0.2,_1)]',
  '[&.lyt-activated]:before:bg-[url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAADGCAYAAAAT+OqFAAAAdklEQVQoz42QQQ7AIAgEF/T/D+kbq/RWAlnQyyazA4aoAB4FsBSA/bFjuF1EOL7VbrIrBuusmrt4ZZORfb6ehbWdnRHEIiITaEUKa5EJqUakRSaEYBJSCY2dEstQY7AuxahwXFrvZmWl2rh4JZ07z9dLtesfNj5q0FU3A5ObbwAAAABJRU5ErkJggg==)]',
  'after:block after:pb-[var(--aspect-ratio)] after:content-[""]',
  '[&_>_iframe]:absolute [&_>_iframe]:inset-0 [&_>_iframe]:size-full',
  '[&_>_.lty-playbtn]:z-[1] [&_>_.lty-playbtn]:h-11 [&_>_.lty-playbtn]:w-16 [&_>_.lty-playbtn]:rounded-[14%] [&_>_.lty-playbtn]:bg-[#212121] [&_>_.lty-playbtn]:opacity-80 [&_>_.lty-playbtn]:[transition:all_0.2s_cubic-bezier(0,_0,_0.2,_1)]',
  '[&:hover_>_.lty-playbtn]:bg-[red] [&:hover_>_.lty-playbtn]:opacity-100',
  // A play triangle points right in either direction.
  // eslint-disable-next-line tailwind/class-conventions
  '[&_>_.lty-playbtn]:before:border-y-[11px] [&_>_.lty-playbtn]:before:border-l-[19px] [&_>_.lty-playbtn]:before:border-r-0 [&_>_.lty-playbtn]:before:border-[transparent_transparent_transparent_#fff] [&_>_.lty-playbtn]:before:content-[""]',
  '[&_>_.lty-playbtn]:absolute [&_>_.lty-playbtn]:inset-0 [&_>_.lty-playbtn]:m-auto',
  '[&_>_.lty-playbtn]:before:absolute [&_>_.lty-playbtn]:before:inset-0 [&_>_.lty-playbtn]:before:m-auto [&_>_.lty-playbtn]:before:size-0',
  '[&.lyt-activated]:cursor-[unset]',
  '[&.lyt-activated]:before:pointer-events-none [&.lyt-activated]:before:opacity-0',
  '[&.lyt-activated_>_.lty-playbtn]:pointer-events-none [&.lyt-activated_>_.lty-playbtn]:!opacity-0'
);

export function YoutubeEmbed({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  return (
    <LiteYouTubeEmbed
      id={id}
      title='youtube'
      wrapperClass={cn(WRAPPER_CLASS, className)}
    />
  );
}
