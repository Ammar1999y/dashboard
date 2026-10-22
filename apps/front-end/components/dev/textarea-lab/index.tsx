import type { FormEvent, ReactNode } from 'react';

import { memo } from 'react';

import { FormProvider, useForm } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Button } from '@/components/ui/button';
import { fieldSurface } from '@/components/ui/field-surface';
import { FontPreview } from '@/components/dash/settings/fonts/font-preview';
import FormTextarea from '@/components/form/form-textarea';

import { LIMITS, useLab } from './lab-store';
import { runScenarios, SCENARIOS } from './scenarios';

const PREFILLED = Array.from(
  { length: 5 },
  (_, i) => `Saved line ${i + 1}`
).join('\n');

const runAll = () => void runScenarios(SCENARIOS);
const clearResults = () => useLab.setState({ results: [] });
const preventSubmit = (event: { preventDefault: () => void }) =>
  event.preventDefault();

/** The measurement before the fix: collapse to `auto`, with nothing put back. */
const naiveResize = (event: FormEvent<HTMLTextAreaElement>) => {
  const el = event.currentTarget;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
};

const MANUAL_CHECKS = [
  'الصلاحيات (إنشاء وتعديل): حقل الوصف يبدأ الآن بارتفاع ثلاثة أسطر (نحو 82px على سطح المكتب بدل 70px). تأكد أن الشكل مقبول.',
  'إعدادات الخطوط: اكتب عدة أسطر في المعاينة، ثم غيّر الحجم والتباعد وارتفاع السطر. يتبع الحقل النص فورًا، ولم يعد الخط يتحرك بانتقال متدرّج.',
  'غيّر تكبير المتصفح (90% و110% و125%) واكتب في حقل حتى حدّه الأعلى من الأسطر بالضبط: لا يظهر شريط تمرير قبل أن يتجاوز النص الحد.',
  'اكتب بلوحة المفاتيح فعلًا في آخر صفحة طويلة، وفي حقل بلغ حدّه: لا تقفز الصفحة، ويبقى المؤشر ظاهرًا، وCtrl+Z يتراجع كالمعتاد.',
  'الحقل الطويل في هذه الصفحة (أطول من الشاشة): اكتب في منتصفه، ثم الصق نصًا من عدة أسطر، ثم تراجع بـ Ctrl+Z عدة مرات. لا تقفز الصفحة، ويبقى المؤشر والسطر الذي تكتب فيه ظاهرين بعد كل تراجع.',
];

const LabRhf = memo(() => {
  const methods = useForm({
    defaultValues: { notes: '', prefilled: PREFILLED },
  });

  return (
    <FormProvider {...methods}>
      <form className='grid gap-3 sm:grid-cols-2' onSubmit={preventSubmit}>
        <FormTextarea
          name='notes'
          label='react-hook-form'
          data-lab='rhf-notes'
          {...LIMITS.rhf}
        />
        <FormTextarea
          name='prefilled'
          label='Prefilled by defaultValues'
          data-lab='rhf-prefilled'
          {...LIMITS.rhf}
        />
      </form>
    </FormProvider>
  );
});
LabRhf.displayName = 'LabRhf';

const LabPreview = memo(() => {
  const fontSizeMultiplier = useLab((s) => s.fontSizeMultiplier);
  const lineHeight = useLab((s) => s.lineHeight);
  const letterSpacing = useLab((s) => s.letterSpacing);

  return (
    <div data-lab='font-preview'>
      <FontPreview
        fontName={null}
        fontSizeMultiplier={fontSizeMultiplier}
        lineHeight={lineHeight}
        letterSpacing={letterSpacing}
      />
    </div>
  );
});
LabPreview.displayName = 'LabPreview';

const LabResize = memo(() => {
  const narrow = useLab((s) => s.narrow);
  const hidden = useLab((s) => s.hidden);

  return (
    <div className={cn(narrow ? 'w-1/2' : 'w-full', hidden && 'hidden')}>
      <AutosizeTextarea data-lab='resize' dir='ltr' {...LIMITS.resize} />
    </div>
  );
});
LabResize.displayName = 'LabResize';

/** No resizing at all; the scenario sizes it with `rows`. */
const PlainTextarea = ({ name }: { name: string }) => (
  <textarea
    data-lab={name}
    dir='ltr'
    className={cn(
      fieldSurface,
      'block w-full resize-none overflow-hidden px-3 py-2'
    )}
  />
);

const NaiveTextarea = ({ name }: { name: string }) => (
  <textarea
    data-lab={name}
    dir='ltr'
    rows={LIMITS.scroll.minRows}
    onInput={naiveResize}
    className={cn(
      fieldSurface,
      'block w-full resize-none overflow-hidden px-3 py-2'
    )}
  />
);

const InnerScroller = ({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) => (
  <div
    data-lab={name}
    className='h-56 overflow-y-auto rounded-md border p-3 space-y-3'
  >
    <p className='h-[400px] text-sm text-muted-foreground'>
      Content above the field
    </p>
    {children}
  </div>
);

const LabScroll = memo(() => (
  <section className='grid gap-3 sm:grid-cols-2'>
    <InnerScroller name='inner-control-scroller'>
      <NaiveTextarea name='inner-control' />
    </InnerScroller>
    <InnerScroller name='inner-real-scroller'>
      <AutosizeTextarea data-lab='inner-real' dir='ltr' {...LIMITS.scroll} />
    </InnerScroller>
  </section>
));
LabScroll.displayName = 'LabScroll';

/** Last on the page: the page itself is the scroller its scenario drives. */
const LabPageEnd = memo(() => (
  <section className='space-y-3'>
    <div aria-hidden className='h-[120vh]' />
    <h2 className='font-semibold'>Page end</h2>
    <AutosizeTextarea data-lab='page-real' dir='ltr' {...LIMITS.scroll} />
  </section>
));
LabPageEnd.displayName = 'LabPageEnd';

const Controls = memo(() => {
  const running = useLab((s) => s.running);

  return (
    <section className='flex flex-wrap items-center gap-2'>
      <Button disabled={running !== null} onClick={runAll}>
        Run all scenarios
      </Button>
      <Button variant='ghost' onClick={clearResults}>
        Clear
      </Button>
      {running && (
        <span className='text-sm text-muted-foreground'>
          Running: {running}
        </span>
      )}
    </section>
  );
});
Controls.displayName = 'Controls';

const Results = memo(() => {
  const results = useLab((s) => s.results);
  const failed = results.filter((r) => !r.ok).length;

  if (results.length === 0) return null;

  return (
    <section className='space-y-2'>
      <p
        className={cn('font-semibold', failed ? 'text-error' : 'text-success')}
      >
        {failed ? `${failed} failed` : 'All passed'} ({results.length} checks)
      </p>
      <ul className='text-sm space-y-0.5'>
        {results.map((r, i) => (
          <li
            key={`${i}-${r.check}`}
            className={r.ok ? 'text-foreground' : 'text-error'}
          >
            {r.ok ? '✓' : '✗'} <span className='font-medium'>{r.scenario}</span>{' '}
            — {r.check}
            {r.detail && (
              <code className='ms-2 text-muted-foreground'>{r.detail}</code>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
});
Results.displayName = 'Results';

const ManualChecks = memo(() => (
  <section dir='rtl' className='text-start space-y-2'>
    <h2 className='font-semibold'>فحوصات يدوية</h2>
    <p className='text-sm text-muted-foreground'>
      الكتابة الحقيقية وتكبير المتصفح والشكل لا تقيسها البرامج النصية، فافحصها
      في صفحات التطبيق نفسها.
    </p>
    <ol className='list-decimal ps-6 text-sm space-y-1'>
      {MANUAL_CHECKS.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  </section>
));
ManualChecks.displayName = 'ManualChecks';

export default function TextareaLab() {
  return (
    <main dir='ltr' className='mx-auto max-w-3xl p-4 space-y-6'>
      <h1 className='text-xl font-bold'>Autosize textarea lab</h1>
      <p className='text-sm text-muted-foreground'>
        Each scenario drives the fixtures below and compares the field with a
        hidden copy measured by the lab&apos;s own code. The scenarios need
        network access to Google Fonts.
      </p>
      <Controls />
      <Results />
      <ManualChecks />
      <LabRhf />
      <LabPreview />
      <LabResize />
      <AutosizeTextarea data-lab='font-load' dir='ltr' {...LIMITS.fontLoad} />
      <section className='space-y-2'>
        <h2 className='font-semibold'>Taller than the screen</h2>
        <PlainTextarea name='tall-control' />
        <AutosizeTextarea data-lab='tall' dir='ltr' {...LIMITS.tall} />
      </section>
      <LabScroll />
      <LabPageEnd />
    </main>
  );
}
