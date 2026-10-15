import { create } from 'zustand';

/** Where the menu opens: a point for a right-click, a button's box otherwise. */
export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MenuState {
  open: boolean;
  /** The selection's actions, or the folder's when nothing was under the pointer. */
  kind: 'item' | 'empty';
  anchor: MenuAnchor;
}

export const useItemMenu = create<MenuState>(() => ({
  open: false,
  kind: 'item',
  anchor: { x: 0, y: 0, width: 0, height: 0 },
}));

export const openMenu = (kind: MenuState['kind'], anchor: MenuAnchor) =>
  useItemMenu.setState({ open: true, kind, anchor });

export const closeMenu = () => useItemMenu.setState({ open: false });

export const anchorOf = (element: Element): MenuAnchor => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { x: left, y: top, width, height };
};
