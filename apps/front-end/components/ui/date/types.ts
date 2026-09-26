export interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

export type DateRangeUpdate = DateRange | ((prev: DateRange) => DateRange);
