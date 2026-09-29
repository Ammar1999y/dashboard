import { create } from 'zustand';

export interface LabResult {
  scenario: string;
  check: string;
  ok: boolean;
  detail: string;
}

// Module scope on purpose: the navigation scenario leaves the page and comes
// back, which remounts everything under it.
export const useLab = create<{
  running: string | null;
  results: LabResult[];
  pops: string[];
}>(() => ({ running: null, results: [], pops: [] }));
