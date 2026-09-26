import type { DateRange, DateRangeUpdate } from '../types';

import { useCallback, useMemo, useState } from 'react';

import { down, useMediaQuery } from '@/hooks/use-media-query';

import { PRESETS } from '../constants';
import { getDateAdjustedForTimezone, getPresetRange } from '../utils';

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

export const useDateRangeState = ({
  initialDateFrom,
  initialDateTo,
  onChange,
}: UseDateRangeStateProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const [committedRange, setCommittedRange] = useState<DateRange>(() => ({
    from: initialDateFrom
      ? getDateAdjustedForTimezone(initialDateFrom)
      : undefined,
    to: initialDateTo ? getDateAdjustedForTimezone(initialDateTo) : undefined,
  }));

  // Edited while the popover is open; committed only on save.
  const [tempRange, setTempRange] = useState<DateRange>(committedRange);

  const [month, setMonth] = useState<Date>(() => {
    const anchor = rangeAnchor(committedRange);
    if (anchor) return anchor;
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    return lastMonth;
  });

  const range = isOpen ? tempRange : committedRange;

  const setRange = useCallback((update: DateRangeUpdate) => {
    setTempRange((prevRange) => {
      const nextRange =
        typeof update === 'function' ? update(prevRange) : update;
      const anchor = rangeAnchor(nextRange);
      if (anchor) setMonth(new Date(anchor));
      return nextRange;
    });
  }, []);

  const isSmallScreen = useMediaQuery(SMALL_SCREEN);

  const setPreset = useCallback(
    (preset: string) => setRange(getPresetRange(preset)),
    [setRange]
  );

  const selectedPreset = useMemo(
    () =>
      PRESETS.find((preset) =>
        isSameDayRange(range, getPresetRange(preset.name))
      )?.name,
    [range]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setTempRange(committedRange);
        const anchor = rangeAnchor(committedRange);
        if (anchor) setMonth(new Date(anchor));
      }
      setIsOpen(open);
    },
    [committedRange]
  );

  const handleSave = useCallback(() => {
    setCommittedRange(tempRange);
    onChange?.(tempRange);
    setIsOpen(false);
  }, [tempRange, onChange]);

  const handleCancel = useCallback(() => {
    setTempRange(committedRange);
    setIsOpen(false);
  }, [committedRange]);

  return {
    isOpen,
    range,
    setRange,
    month,
    setMonth,
    selectedPreset,
    setPreset,
    isSmallScreen,
    handleOpenChange,
    handleSave,
    handleCancel,
  };
};
