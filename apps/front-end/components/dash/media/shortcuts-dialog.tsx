import { memo } from 'react';

import { MSG_RTL_ARROWS } from '@/constants/messages';

import { Button } from '@/components/ui/button';
import {
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { shortcutsDialog } from './dialogs';

/** Each row: what it does, and its keys; several chords are alternatives. */
const GROUPS: readonly (readonly [
  string,
  readonly (readonly [string, readonly string[]])[],
])[] = [
  [
    'التنقل',
    [
      ['التنقّل بين عناصر العمود', ['↑ ↓']],
      ['دخول المجلد أو الانتقال للعمود التالي', ['←']],
      ['الرجوع إلى العمود السابق', ['→']],
      ['فتح المجلد أو معاينة الملف', ['Enter']],
      ['معاينة سريعة', ['Space']],
      ['المجلد الأب', ['Mod+↑', 'Backspace']],
      ['السابق والتالي في السجل', ['Mod+[', 'Mod+]']],
      ['القفز إلى أول عنصر يبدأ بالحرف', ['حرف']],
    ],
  ],
  [
    'التحديد',
    [
      ['تحديد عنصر', ['نقر']],
      ['إضافة عنصر إلى التحديد أو إزالته', ['Mod+نقر']],
      ['تحديد نطاق', ['Shift+نقر', 'Shift+↑↓']],
      ['تحديد بالمربع', ['سحب على فراغ']],
      ['تحديد الكل', ['Mod+A']],
      ['إلغاء التحديد، ثم النقل المعلّق، ثم الخروج من النتائج', ['Esc']],
    ],
  ],
  [
    'الإجراءات',
    [
      ['إعادة تسمية', ['F2']],
      ['حذف نهائي (مع تأكيد)', ['Delete']],
      ['مجلد جديد', ['Alt+N']],
      ['رفع ملفات', ['Alt+U']],
      ['قص للنقل، ويبقى معلّقاً أثناء التنقل', ['Mod+X']],
      ['لصق في المجلد الحالي', ['Mod+V']],
      ['نقل إلى مجلد، والإبقاء فوقه يفتحه', ['سحب وإفلات']],
      ['قائمة السياق', ['نقر يمين']],
    ],
  ],
  [
    'العرض والبحث',
    [
      ['التركيز على البحث بالاسم', ['/']],
      ['أعمدة، شبكة، قائمة', ['Alt+1', 'Alt+2', 'Alt+3']],
      ['لوحة التفاصيل', ['Alt+I']],
      ['هذه القائمة', ['?']],
    ],
  ],
];

const Sheet = memo(() => (
  <>
    <DialogHeader>
      <DialogTitle className='flex items-center gap-2'>
        <Icon icon='lucide:keyboard' className='size-4' />
        اختصارات لوحة المفاتيح
      </DialogTitle>
    </DialogHeader>
    <div className='min-h-0 overflow-y-auto px-4 space-y-4'>
      <div className='grid grid-cols-2 gap-x-5 gap-y-4 max-md2:grid-cols-1'>
        {GROUPS.map(([title, rows]) => (
          <section key={title}>
            <h5 className='mb-1.5 text-xs font-medium text-primary'>{title}</h5>
            {rows.map(([description, chords]) => (
              <div
                key={description}
                className='flex items-center justify-between gap-2.5 border-b py-1 text-xs'
              >
                <span>{description}</span>
                <span className='inline-flex shrink-0 gap-1'>
                  {chords.map((chord) => (
                    <Kbd key={chord} keys={chord} />
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className='flex items-start gap-2 rounded-md border bg-muted px-2.5 py-2 text-xs text-muted-foreground'>
        <Icon icon='lucide:info' className='mt-0.5 size-4 shrink-0' />
        {MSG_RTL_ARROWS}
      </p>
    </div>
    <DialogFooter className='flex-row justify-end'>
      <Button onClick={shortcutsDialog.close}>تم</Button>
    </DialogFooter>
  </>
));

Sheet.displayName = 'Sheet';

export const ShortcutsDialog = memo(() => (
  <StoreDialog dialog={shortcutsDialog} className='sm:max-w-[580px]'>
    <Sheet />
  </StoreDialog>
));

ShortcutsDialog.displayName = 'ShortcutsDialog';
