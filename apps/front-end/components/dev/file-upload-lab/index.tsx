// Browser status, 2026-10-04: green. In the owner's last full run every
// scenario passed but one, and that failure was the lab's own (toasts left
// over from earlier scenarios), fixed the same day. Update this line after
// each full run in the browser.

import type { UploaderId } from './lab-store';
import type { FileWithPreview } from '@/components/shared/file-upload';
import type { ReactNode } from 'react';

import dynamic from 'next/dynamic';
import { memo, useEffect, useMemo } from 'react';

import { ACCEPT_DOCUMENTS, ACCEPT_IMAGES } from '@/lib/files/accept';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Button } from '@/components/ui/button';
import { FileUpload } from '@/components/shared/file-upload';

import { runScenarios } from './harness';
import { reportFiles, useLab } from './lab-store';
import { BrowserResearch } from './research';
import { GROUPS, SCENARIOS } from './scenarios';

const AUTO_RUN_DELAY_MS = 1000;

const PlateEditor = dynamic(() => import('@/components/editor/plate-editor'), {
  ssr: false,
});

const EMPTY_DOCUMENT: unknown[] = [];
const ignoreChange = () => {};

const runAll = () => void runScenarios(SCENARIOS);
const clearResults = () => useLab.setState({ results: [] });

const GROUP_RUNS = GROUPS.map((group) => ({
  group,
  run: () => void runScenarios(SCENARIOS.filter((s) => s.group === group)),
}));

const MANUAL_CHECKS = [
  'هاتف Android إن توفّر: الرفع من المعرض ومن الكاميرا مباشرة. نافذة الاختيار ونافذة الكاميرا من نظام التشغيل ولا تصل إليهما البرامج النصية.',
  'قارئ الشاشة (اختياري): يُقرأ اسم منطقة الرفع ونص المساعدة. السيناريوهات تتحقق من الدور والاسم والتركيز والمفاتيح، لكن لا تسمع ما ينطقه القارئ.',
];

const onMulti = (files: FileWithPreview[]) => reportFiles('multi', files);
const onSingle = (files: FileWithPreview[]) => reportFiles('single', files);
const onDocuments = (files: FileWithPreview[]) =>
  reportFiles('documents', files);

const Controls = memo(() => {
  const running = useLab((s) => s.running);

  return (
    <section className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Button disabled={running !== null} onClick={runAll}>
          Run all scenarios
        </Button>
        {GROUP_RUNS.map(({ group, run }) => (
          <Button
            key={group}
            variant='outline'
            disabled={running !== null}
            onClick={run}
          >
            {group}
          </Button>
        ))}
        <Button variant='ghost' onClick={clearResults}>
          Clear
        </Button>
      </div>
      {running && (
        <p className='text-sm text-muted-foreground'>Running: {running}</p>
      )}
      <p className='text-sm text-muted-foreground'>
        Nothing here sends a file to the back end. The Real groups download
        their files from GitHub, Wikimedia and jsDelivr, so they need the
        internet.
      </p>
    </section>
  );
});
Controls.displayName = 'Controls';

const Picked = memo(({ id }: { id: UploaderId }) => {
  const files = useLab((s) => s.files[id]);

  return (
    <ul className='text-xs text-muted-foreground space-y-0.5' dir='ltr'>
      {files.map(({ id: key, file }) => (
        <li key={key}>
          {file instanceof File
            ? `${file.name} — ${file.type} — ${formatBytes(file.size)}`
            : `${file.displayName} — ${file.mimeType}`}
        </li>
      ))}
    </ul>
  );
});
Picked.displayName = 'Picked';

interface UploaderProps {
  id: UploaderId;
  title: string;
  children: ReactNode;
}

function Uploader({ id, title, children }: UploaderProps) {
  return (
    <div className='rounded-lg border p-3 space-y-2' data-lab-uploader={id}>
      <h2 className='text-sm font-semibold'>{title}</h2>
      {children}
      <Picked id={id} />
    </div>
  );
}

const Uploaders = memo(() => {
  const key = useLab((s) => s.uploadersKey);

  return (
    <section key={key} className='grid gap-4 md:grid-cols-3' dir='rtl'>
      <Uploader id='multi' title='Images and SVG, up to 3 (the default accept)'>
        <FileUpload maxFiles={3} onFilesChange={onMulti} />
      </Uploader>
      <Uploader id='single' title='One image (a field-array row)'>
        <FileUpload
          maxFiles={1}
          accept={ACCEPT_IMAGES}
          onFilesChange={onSingle}
        />
      </Uploader>
      <Uploader id='documents' title='Documents, up to 5'>
        <FileUpload
          maxFiles={5}
          accept={ACCEPT_DOCUMENTS}
          onFilesChange={onDocuments}
        />
      </Uploader>
    </section>
  );
});
Uploaders.displayName = 'Uploaders';

/** The real editor, for the paste scenario only: it is heavy to keep mounted. */
const EditorProbe = memo(() => {
  const mounted = useLab((s) => s.editorMounted);
  if (!mounted) return null;

  return (
    <section className='h-64 rounded-lg border' data-lab-editor>
      <PlateEditor content={EMPTY_DOCUMENT} onChange={ignoreChange} />
    </section>
  );
});
EditorProbe.displayName = 'EditorProbe';

const Results = memo(() => {
  const results = useLab((s) => s.results);
  const failed = useMemo(() => results.filter((r) => !r.ok).length, [results]);

  if (results.length === 0) return null;

  return (
    <section className='space-y-2' data-lab-results>
      <p
        className={cn('font-semibold', failed ? 'text-error' : 'text-success')}
        data-lab-summary={failed ? 'failed' : 'passed'}
      >
        {failed ? `${failed} failed` : 'All passed'} ({results.length} checks)
      </p>
      <ul className='text-sm space-y-0.5'>
        {results.map((r, i) => (
          <li
            key={`${i}-${r.group}-${r.check}`}
            className={r.ok ? 'text-foreground' : 'text-error'}
            data-lab-ok={r.ok}
          >
            {r.ok ? '✓' : '✗'} <span className='font-medium'>{r.group}</span> —{' '}
            {r.check}
            {r.detail && (
              <code className='ms-2 break-all text-muted-foreground'>
                {r.detail}
              </code>
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
      كل ما يمكن تشغيله آليًا موجود في السيناريوهات أعلاه، ومنه الملفات الحقيقية
      والسحب والإفلات ولوحة المفاتيح. بقي ما يحتاج جهازًا فعليًا.
    </p>
    <ol className='list-decimal ps-6 text-sm space-y-1'>
      {MANUAL_CHECKS.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  </section>
));
ManualChecks.displayName = 'ManualChecks';

const autoRun = () => {
  if (!new URLSearchParams(location.search).has('run')) return;
  const timer = setTimeout(runAll, AUTO_RUN_DELAY_MS);
  return () => clearTimeout(timer);
};

export default function FileUploadLab() {
  useEffect(autoRun, []);

  return (
    <main dir='ltr' className='mx-auto max-w-screen-xl p-4 space-y-6'>
      <h1 className='text-xl font-bold'>File upload lab</h1>
      <Controls />
      <Uploaders />
      <EditorProbe />
      <Results />
      <BrowserResearch />
      <ManualChecks />
    </main>
  );
}
