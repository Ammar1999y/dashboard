import type { PresetName } from '../constants';
import type { DateRange } from '../types';

import { useCallback, useMemo } from 'react';

import { down, useMediaQuery } from '@/hooks/use-media-query';

import { PRESETS } from '../constants';
import { getPresetRange, parseInitialDate } from '../utils';
import { useDatePopoverState } from './use-date-popover-state';

interface UseDateRangeStateProps {
  initialDateFrom?: Date | string;
  initialDateTo?: Date | string;
  onChange?: (range: DateRange) => void;
}

const SMALL_SCREEN = down('lg');

const startOfDay = (date: Date | number) => new Date(date).setHours(0, 0, 0, 0);

const isSameDayRange = (a: DateRange, b: DateRange) =>
  !!a.from &&
  !!b.from &&
  startOfDay(a.from) === startOfDay(b.from) &&
  startOfDay(a.to ?? 0) === startOfDay(b.to ?? 0);

// Whichever bound exists: an upper-only range must still open on its month.
const rangeAnchor = (range: DateRange) => range.from ?? range.to;

const previousMonth = () => {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth() - 1, 1);
};

export const useDateRangeState = ({
  initialDateFrom,
  initialDateTo,
  onChange,
}: UseDateRangeStateProps) => {
  const {
    value: range,
    setDraft: setRange,
    ...state
  } = useDatePopoverState<DateRange>({
    initialValue: () => ({
      from: parseInitialDate(initialDateFrom),
      to: parseInitialDate(initialDateTo),
    }),
    anchorOf: rangeAnchor,
    fallbackMonth: previousMonth,
    onChange,
  });

  const isSmallScreen = useMediaQuery(SMALL_SCREEN);

  const setPreset = useCallback(
    (preset: PresetName) => setRange(getPresetRange(preset)),
    [setRange]
  );

  const selectedPreset = useMemo(
    () =>
      PRESETS.find((preset) =>
        isSameDayRange(range, getPresetRange(preset.name))
      )?.name,
    [range]
  );

  return {
    ...state,
    range,
    setRange,
    selectedPreset,
    setPreset,
    isSmallScreen,
  };
};
