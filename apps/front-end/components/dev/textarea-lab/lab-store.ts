import { create } from 'zustand';

export interface LabResult {
  scenario: string;
  check: string;
  ok: boolean;
  detail: string;
}

export interface RowLimits {
  minRows: number;
  maxRows: number;
}

/** The limits each fixture passes, read back by the scenarios' oracle. */
export const LIMITS = {
  rhf: { minRows: 3, maxRows: 6 },
  // Mirrors what font-preview.tsx passes.
  preview: { minRows: 4, maxRows: 10 },
  resize: { minRows: 2, maxRows: 12 },
  fontLoad: { minRows: 2, maxRows: 12 },
  scroll: { minRows: 3, maxRows: 10 },
  tall: { minRows: 3, maxRows: 200 },
} satisfies Record<string, RowLimits>;

export const PREVIEW_DEFAULTS = {
  fontSizeMultiplier: 1,
  lineHeight: 1.6,
  letterSpacing: 0,
};

export const useLab = create<{
  running: string | null;
  results: LabResult[];
  /** The font preview's props, as the font settings drive them. */
  fontSizeMultiplier: number;
  lineHeight: number;
  letterSpacing: number;
  narrow: boolean;
  hidden: boolean;
}>(() => ({
  running: null,
  results: [],
  ...PREVIEW_DEFAULTS,
  narrow: false,
  hidden: false,
}));
