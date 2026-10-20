/**
 * Between `svg-jobs.ts` and the thread it starts, `svg-worker.ts`: neither may
 * import the other's values, or the main thread loads the SVG libraries.
 */
export interface SvgJob {
  id: number;
  op: 'sanitize' | 'optimize';
  markup: string;
}

export const SVG_WORKER_READY = 'ready';
