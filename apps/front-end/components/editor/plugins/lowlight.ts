import { all, createLowlight } from 'lowlight';

/** One registry of every grammar, shared by the editor and the export. */
export const lowlight = createLowlight(all);
