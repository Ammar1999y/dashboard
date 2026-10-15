import type { NextPage } from 'next';

/** A route's default export, with what `_app` reads off it. */
export type Page<P = object> = NextPage<P> & {
  /** The tab title, before the app name. */
  title?: string;
  /** Rendered without the dashboard layout, and so without its session gate. */
  standalone?: boolean;
  /**
   * Fills the dashboard's `<main>` edge to edge, below the header: no container
   * and no padding, for a page that is its own workspace.
   */
  fullBleed?: boolean;
};
