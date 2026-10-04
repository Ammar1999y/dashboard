const MAX_VISIBLE_PAGES = 5;

/**
 * The page buttons for 1-based `currentPage`, with `'...'` for each gap:
 * `[1, 2, 3, 4, '...', 10]`, `[1, '...', 4, 5, 6, '...', 10]`,
 * `[1, '...', 7, 8, 9, 10]`.
 */
export function getPageNumbers(currentPage: number, totalPages: number) {
  const pages: (number | '...')[] = [];
  const range = (from: number, to: number) => {
    for (let page = from; page <= to; page++) pages.push(page);
  };

  if (totalPages <= MAX_VISIBLE_PAGES) {
    range(1, totalPages);
    return pages;
  }

  pages.push(1);
  if (currentPage <= 3) {
    range(2, 4);
    pages.push('...', totalPages);
  } else if (currentPage >= totalPages - 2) {
    pages.push('...');
    range(totalPages - 3, totalPages);
  } else {
    pages.push('...');
    range(currentPage - 1, currentPage + 1);
    pages.push('...', totalPages);
  }
  return pages;
}
