import Link from 'next/link';
import { memo, useEffect, useState } from 'react';

import { isDialogEntry } from '@/lib/dialogs';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { DialogClose, DialogTitle } from '@/components/ui/dialog';
import { DialogToggle } from '@/components/dialogs/dialog-toggle';
import { StoreDialog } from '@/components/dialogs/store-dialog';
import { themeCustomizerDialog } from '@/components/theme-customizer/store';

import {
  LAB_PATH,
  labInner,
  labLocal,
  labOuter,
  labRecord,
  labSide,
} from './dialogs';
import { useLab } from './lab-store';
import { runScenarios, SCENARIOS } from './scenarios';

const READOUT_MS = 250;
const MAX_POPS = 20;

const SHARED_LINK = `${LAB_PATH}?module=lab-outer&module=lab-inner`;

const openOuter = () => labOuter.open();
const openInner = () => labInner.open();
const openLocal = () => labLocal.open();
const openRecord1 = () => labRecord.open({ id: 1, name: 'Record 1' });
const openRecord2 = () => labRecord.open({ id: 2, name: 'Record 2' });
const runAll = () => void runScenarios(SCENARIOS);
const clearResults = () => useLab.setState({ results: [], pops: [] });

const MANUAL_CHECKS = [
  `الرابط المشترك: افتح ${SHARED_LINK} في علامة تبويب جديدة، واضغط مرة واحدة في أي مكان، ثم اضغط زر الرجوع في المتصفح أو الهاتف. يُغلق مربع الحوار الداخلي، ثم الخارجي، ثم تغادر الصفحة. إذا لم تضغط داخل الصفحة أولًا، فسيتجاوز المتصفح إدخالات السجل التي أضافتها الصفحة ويغادر فورًا؛ فهذا سلوك أمني يمنع الصفحات من احتجاز زر الرجوع ولا يمكن للصفحة تجاوزه.`,
  'الرابط: اضغط الرابط الموجود أسفل هذه القائمة. يُفتح مربعا الحوار، ثم يغلق زر الرجوع الداخلي أولًا فالخارجي، وتبقى في هذه الصفحة. ضغطة رجوع أخرى تغادر الصفحة مباشرة، فلا تبقى نسخة ثانية منها في السجل.',
  'مربعا حوار متداخلان: افتح الخارجي، ثم افتح الداخلي من خلاله، واضغط زر الرجوع مرتين. يجب أن يُغلق الأحدث أولًا.',
  'اختبار الهاتف: افتح الإعدادات واضغط «اللوحة الجانبية». تُغلق الإعدادات وتبقى اللوحة الجانبية مفتوحة. يغلقها زر الرجوع وتبقى في هذه الصفحة.',
  'زر الإغلاق (X): افتح مربع الحوار الخارجي، واضغط إغلاق (X)، ثم اضغط زر الرجوع. يجب أن تنتقل مباشرة إلى الصفحة السابقة من أول ضغطة.',
  'رابط الصفحة: افتح مربع الحوار الخارجي واضغط رابط /dash، ثم اضغط زر الرجوع مرة واحدة. يجب أن تعود إلى هنا من دون أي مربع حوار مفتوح.',
  'لوحة المفاتيح: استخدم Tab للوصول إلى زر «الخارجي»، ثم اضغط Enter وبعدها Escape. يجب أن يعود التركيز إلى زر «الخارجي».',
];

const LabClose = memo(() => (
  <DialogClose asChild>
    <Button variant='outline' data-lab-close>
      Close (X)
    </Button>
  </DialogClose>
));
LabClose.displayName = 'LabClose';

const LabDialogs = memo(() => {
  const record = labRecord.usePayload();

  return (
    <>
      <StoreDialog dialog={labOuter} data-lab='outer' className='max-w-md p-6'>
        <DialogTitle>Outer dialog</DialogTitle>
        <div className='flex flex-wrap gap-2'>
          <Button data-lab-open-inner onClick={openInner}>
            Open inner dialog
          </Button>
          <Button asChild variant='outline'>
            <Link href='/dash' data-lab-link>
              Link to /dash
            </Link>
          </Button>
          <LabClose />
        </div>
      </StoreDialog>

      <StoreDialog dialog={labInner} data-lab='inner' className='max-w-sm p-6'>
        <DialogTitle>Inner dialog</DialogTitle>
        <LabClose />
      </StoreDialog>

      <StoreDialog
        dialog={labSide}
        data-lab='side'
        modal={false}
        side='right'
        className='w-72 p-6'
      >
        <DialogTitle>Side sheet</DialogTitle>
        <p className='text-sm text-muted-foreground'>
          Non-modal, like the mobile menu.
        </p>
        <LabClose />
      </StoreDialog>

      <StoreDialog
        dialog={labRecord}
        data-lab='record'
        className='max-w-sm p-6'
      >
        <DialogTitle>{record?.name}</DialogTitle>
        <p className='text-sm text-muted-foreground'>Payload id {record?.id}</p>
        <LabClose />
      </StoreDialog>

      <StoreDialog dialog={labLocal} data-lab='local' className='max-w-sm p-6'>
        <DialogTitle>Local dialog (not in the URL)</DialogTitle>
        <LabClose />
      </StoreDialog>
    </>
  );
});
LabDialogs.displayName = 'LabDialogs';

const Controls = memo(() => {
  const running = useLab((s) => s.running);

  return (
    <section className='space-y-3'>
      <div className='flex flex-wrap gap-2'>
        <Button id='lab-open-outer' variant='outline' onClick={openOuter}>
          Outer
        </Button>
        <DialogToggle id='lab-side-toggle' dialog={labSide} variant='outline'>
          Side sheet
        </DialogToggle>
        <DialogToggle
          id='lab-settings-toggle'
          dialog={themeCustomizerDialog}
          variant='outline'
        >
          Settings
        </DialogToggle>
        <Button variant='outline' onClick={openRecord1}>
          Record 1
        </Button>
        <Button variant='outline' onClick={openRecord2}>
          Record 2
        </Button>
        <Button variant='outline' onClick={openLocal}>
          Local
        </Button>
      </div>
      <div className='flex flex-wrap items-center gap-2'>
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
      </div>
    </section>
  );
});
Controls.displayName = 'Controls';

const readHistory = () => ({
  url: `${location.pathname}${location.search}`,
  length: history.length,
  dialogEntry: isDialogEntry(history.state),
});

type HistoryReadout = ReturnType<typeof readHistory>;

// The poll keeps the last reading when nothing changed, so an idle page
// does not re-render on every tick.
const nextReadout = (prev: HistoryReadout): HistoryReadout => {
  const next = readHistory();
  return next.url === prev.url &&
    next.length === prev.length &&
    next.dialogEntry === prev.dialogEntry
    ? prev
    : next;
};

const Readout = memo(() => {
  const [state, setState] = useState(readHistory);
  const pops = useLab((s) => s.pops);

  useEffect(() => {
    const interval = setInterval(() => setState(nextReadout), READOUT_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className='rounded-lg border p-3 text-sm space-y-1'>
      <p>
        URL: <code>{state.url}</code>
      </p>
      <p>
        history.length: <code>{state.length}</code>, current entry:{' '}
        <code>{state.dialogEntry ? "a dialog's" : "the page's"}</code>
      </p>
      <p className='text-muted-foreground'>Back / forward seen:</p>
      <ol className='list-decimal ps-6'>
        {pops.map((pop, i) => (
          <li key={`${i}-${pop}`}>
            <code>{pop}</code>
          </li>
        ))}
      </ol>
    </section>
  );
});
Readout.displayName = 'Readout';

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
    <h2 className='font-semibold'>فحوصات يدوية (زر الرجوع في المتصفح)</h2>
    <p className='text-sm text-muted-foreground'>
      تستطيع البرامج النصية استدعاء history.back() فقط، ويتعامل المتصفح معه
      بطريقة مختلفة عن زر الرجوع الفعلي؛ لذلك يجب تنفيذ هذه الفحوصات يدويًا.
    </p>
    <ol className='list-decimal ps-6 text-sm space-y-1'>
      {MANUAL_CHECKS.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
    <Link className='text-sm text-primary underline' href={SHARED_LINK}>
      {SHARED_LINK}
    </Link>
  </section>
));
ManualChecks.displayName = 'ManualChecks';

const logPop = () =>
  useLab.setState((s) => ({
    pops: [
      ...s.pops.slice(-(MAX_POPS - 1)),
      `${location.pathname}${location.search}`,
    ],
  }));

export default function DialogLab() {
  useEffect(() => {
    addEventListener('popstate', logPop);
    return () => removeEventListener('popstate', logPop);
  }, []);

  return (
    <main dir='ltr' className='mx-auto max-w-3xl p-4 space-y-6'>
      <h1 className='text-xl font-bold'>Dialog lab</h1>
      <Controls />
      <Readout />
      <Results />
      <ManualChecks />
      <LabDialogs />
    </main>
  );
}
