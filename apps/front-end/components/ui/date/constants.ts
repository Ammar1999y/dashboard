export const PRESETS = [
  { name: 'today', label: 'اليوم' },
  { name: 'yesterday', label: 'امس' },
  { name: 'last7', label: 'أخر 7 أيام' },
  { name: 'thisWeek', label: 'هذا الأسبوع' },
  { name: 'lastWeek', label: 'الاسبوع الماضي' },
  { name: 'thisMonth', label: 'هذا الشهر' },
  { name: 'lastMonth', label: 'الشهر الماضي' },
] as const;

export type PresetName = (typeof PRESETS)[number]['name'];

export const isPresetName = (value: string): value is PresetName =>
  PRESETS.some((preset) => preset.name === value);

export const DEFAULT_DATE_LOCALE = 'ar-u-ca-gregory';

export const DATE_PLACEHOLDER = 'اختر التاريخ';
