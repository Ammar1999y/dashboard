import { create } from 'zustand';

export interface LabResult {
  scenario: string;
  check: string;
  ok: boolean;
  detail: string;
}

export const useLab = create<{
  running: string | null;
  results: LabResult[];
  /** Driven from outside the form, so its changes are programmatic. */
  selectValue: string;
  sliderValue: number[];
}>(() => ({
  running: null,
  results: [],
  selectValue: 'a',
  sliderValue: [20],
}));
