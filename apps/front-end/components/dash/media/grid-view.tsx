import type { Listing } from './use-listing';
import type { CSSProperties, ReactNode } from 'react';

import { memo, useMemo } from 'react';

import { ErrorState } from '@/components/ui/error-state';

import styles from './media.module.css';
import { NewFolderTile, useIsNamingIn } from './new-folder';
import { ResultsBanner, useResults } from './results';
import { FolderEmpty, LoadMore, ResultsEmpty } from './states';
import { currentFolder, isResults, useBrowser } from './store';
import { FileTile, FolderTile, SkeletonTiles } from './tile';
import { folderSource, useListing } from './use-listing';

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <>
      <div className='mx-1 mb-2 mt-3 flex items-center gap-2 text-xs text-muted-foreground'>
        <span>{title}</span>
        <span className='num rounded-full border px-1.5 text-xs text-muted-foreground/70'>
          {count}
        </span>
      </div>
      <div className={styles.tiles} data-grid-cells>
        {children}
      </div>
    </>
  );
}

interface PagesProps {
  listing: Listing;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  nextPageError: Error | null;
  fetchNextPage: () => void;
}

const More = memo(
  ({
    listing,
    hasNextPage,
    isFetchingNextPage,
    nextPageError,
    fetchNextPage,
  }: PagesProps) =>
    hasNextPage ? (
      <LoadMore
        remaining={listing.fileTotal - listing.files.length}
        loading={isFetchingNextPage}
        error={nextPageError}
        onLoad={fetchNextPage}
      />
    ) : null
);

More.displayName = 'More';

const FolderGrid = memo(() => {
  const folder = useBrowser((s) => currentFolder(s.path));
  const source = useMemo(() => folderSource(folder), [folder]);
  const {
    listing,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    nextPageError,
    fetchNextPage,
  } = useListing(source);
  const naming = useIsNamingIn(folder);

  let body;
  if (error && !listing)
    body = <ErrorState error={error} refetch={refetch} className='m-4' />;
  else if (!listing)
    body = (
      <div className={styles.tiles}>
        <SkeletonTiles />
      </div>
    );
  else if (
    !naming &&
    listing.folders.length === 0 &&
    listing.files.length === 0
  )
    body = <FolderEmpty folder={folder} />;
  else
    body = (
      <>
        {(listing.folders.length > 0 || naming) && (
          <Section title='المجلدات' count={listing.folders.length}>
            {naming && <NewFolderTile />}
            {listing.folders.map((child) => (
              <FolderTile key={child.id} folder={child} />
            ))}
          </Section>
        )}
        {listing.files.length > 0 && (
          <Section title='الملفات' count={listing.fileTotal}>
            {listing.files.map((file) => (
              <FileTile key={file.id} file={file} />
            ))}
          </Section>
        )}
        <More
          listing={listing}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          nextPageError={nextPageError}
          fetchNextPage={fetchNextPage}
        />
      </>
    );

  return (
    <div
      data-col='grid'
      data-dz={folder ?? 'root'}
      role='listbox'
      aria-multiselectable
      className='min-h-full px-3.5 pb-11 pt-2'
    >
      {body}
    </div>
  );
});

FolderGrid.displayName = 'FolderGrid';

const ResultsGrid = memo(() => {
  const {
    listing,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    nextPageError,
    fetchNextPage,
  } = useResults();

  let body;
  if (error && !listing)
    body = <ErrorState error={error} refetch={refetch} className='m-4' />;
  else if (!listing)
    body = (
      <div className={styles.tiles}>
        <SkeletonTiles />
      </div>
    );
  else if (listing.folders.length === 0 && listing.files.length === 0)
    body = <ResultsEmpty retentionDays={listing.retentionDays} />;
  else
    body = (
      <>
        {listing.folders.length > 0 && (
          <Section title='مجلدات مطابقة' count={listing.folders.length}>
            {listing.folders.map((folder) => (
              <FolderTile key={folder.id} folder={folder} showPath />
            ))}
          </Section>
        )}
        {listing.files.length > 0 && (
          <Section title='ملفات' count={listing.fileTotal}>
            {listing.files.map((file) => (
              <FileTile
                key={file.id}
                file={file}
                showPath
                retentionDays={listing.retentionDays}
              />
            ))}
          </Section>
        )}
        <More
          listing={listing}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          nextPageError={nextPageError}
          fetchNextPage={fetchNextPage}
        />
      </>
    );

  return (
    <>
      <ResultsBanner listing={listing} />
      <div
        data-col='results'
        role='listbox'
        aria-multiselectable
        className='min-h-full px-3.5 pb-11 pt-2'
      >
        {body}
      </div>
    </>
  );
});

ResultsGrid.displayName = 'ResultsGrid';

export const GridView = memo(() => {
  const results = useBrowser(isResults);
  const tileSize = useBrowser((s) => s.tileSize);
  const style = useMemo(
    () => ({ '--tile': `${tileSize}px` }) as CSSProperties,
    [tileSize]
  );
  return (
    <div
      data-scroller
      className='relative min-w-0 flex-1 overflow-auto'
      style={style}
    >
      {results ? <ResultsGrid /> : <FolderGrid />}
    </div>
  );
});

GridView.displayName = 'GridView';
