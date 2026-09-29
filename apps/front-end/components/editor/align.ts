import type { IconName } from '@/components/ui/icon';
import type { Alignment } from '@platejs/basic-styles';

export const ALIGN_ITEMS: {
  value: Alignment;
  label: string;
  icon: IconName;
}[] = [
  { value: 'start', label: 'بداية السطر', icon: 'lucide:text-align-start' },
  { value: 'center', label: 'وسط', icon: 'lucide:text-align-center' },
  { value: 'end', label: 'نهاية السطر', icon: 'lucide:text-align-end' },
  { value: 'justify', label: 'ضبط', icon: 'lucide:text-align-justify' },
];

export const alignIcon = (value: unknown): IconName =>
  ALIGN_ITEMS.find((item) => item.value === value)?.icon ??
  'lucide:text-align-start';
