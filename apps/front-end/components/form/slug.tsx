import { memo } from 'react';

import FormInput from './form-input';

const TOOLTIP =
  'يقبل الأحرف الإنجليزية الصغيرة والأرقام والشرطات (-).\nلا يمكن أن يكون أرقاماً فقط.';

const TIP =
  'سيتم استخدام هذا النص في رابط الصفحة. (مثال: site.com/slug)\nلا يمكن تعديله لاحقاً. في حال عدم توفره، سيتم استخدام المعرف (ID) تلقائياً.';

const SlugInput = memo(
  ({ isEdit = false, className }: { isEdit?: boolean; className?: string }) => (
    <FormInput
      name='slug'
      label='المفتاح (slug)'
      dir='ltr'
      disabled={isEdit}
      tooltip={TOOLTIP}
      tip={TIP}
      classNameField={className}
    />
  )
);

SlugInput.displayName = 'SlugInput';

export { SlugInput };
