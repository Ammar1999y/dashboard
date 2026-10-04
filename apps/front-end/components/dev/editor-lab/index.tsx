import type { FixtureId } from './lab-store';
import type { ContentDir } from '@/components/editor/styles';
import type { ThemeMode } from '@/components/theme-customizer/types';

import dynamic from 'next/dynamic';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { downloadBlob, openBlob } from '@/lib/files/download';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { buildEditorDocument } from '@/components/editor/export';
import { createPublishedEditor } from '@/components/editor/published';
import { EditorStatic } from '@/components/editor/ui/static/editor-static';
import { useThemeMode } from '@/components/theme-customizer/theme-provider';

import { runScenarios, SCENARIOS } from './checks';
import { KnownIssues, RenderWriteGuard } from './known-issues';
import { FIXTURES, loadFixture, useLab } from './lab-store';

const PlateEditor = dynamic(() => import('@/components/editor/plate-editor'), {
  ssr: false,
});

const FIXTURE_IDS = Object.keys(FIXTURES) as FixtureId[];
const DIRS: ContentDir[] = ['ltr', 'rtl'];
const THEMES: ThemeMode[] = ['light', 'dark'];
const PANE_CLASS = 'flex min-w-0 flex-col gap-2';
const PANE_BODY_CLASS = 'h-[70vh] overflow-auto rounded-md border';
const COPIED_MS = 1500;

/** Only what "Run all checks" cannot reach: real downloads, menus, typing. */
const MANUAL_CHECKS = [
  'قوائم شريط الأدوات (تحويل إلى، والمحاذاة، والاتجاه، وارتفاع السطر، والوضع): تظهر علامة ✓ في نهاية صف القيمة الحالية.',
  'اختيار ارتفاع السطر «الافتراضي» يزيل ارتفاع السطر المحدد؛ ويعرض مربع حجم الخط «الافتراضي»، وتبدأ أزرار −/+ من القيمة 16.',
  'لون النص وخلفية الخلية يستخدمان لوحة الألوان نفسها؛ يظهر اللون المخصص المحفوظ في كليهما ويبقى بعد إعادة تحميل الصفحة.',
  'يؤدي الضغط على مقبض سحب الكتلة إلى فتح قائمة الكتلة.',
  'انقر بزر الفأرة الأيمن على كتلة: يجب أن يُطبّق التحويل والمحاذاة على جميع الكتل المحددة، وأن يبقى العنوان كما هو عند تحويله إلى نوعه الحالي.',
  'حدد نصًا ثم أضف تعليقًا: يجب أن تعرض المناقشة اسمك وصورتك، لا بيانات مستخدم تجريبي، وأن يعمل حسم التعليق وحذفه.',
  'وضع الاقتراح: تظهر النصوص المضافة باللون الأخضر والمحذوفة باللون الأحمر، ويجب أن يعمل قبول الاقتراح ورفضه.',
  'التصدير → HTML: يُفتح الملف المنزّل دون اتصال، ويطابق مظهر لوحة التصدير، ويعمل الفيديو داخله. التصدير → طباعة: تعرض المعاينة صفحات فاتحة.',
  'التصدير → صورة وPDF: تبدو الصفحة مثل تصدير HTML، من دون تمييز للتعليقات أو ألوان الاقتراحات أو زر المناقشة.',
  'الرموز التعبيرية: يعرض منتقي شريط الأدوات ومنتقي أيقونة مربع التنبيه أسماء التصنيفات ونص البحث وحالة عدم وجود نتائج باللغة العربية.',
  'قائمة الأوامر: اكتب "/" ثم كلمة تطابق مجموعة واحدة فقط؛ يجب أن تختفي المجموعات الأخرى وعناوينها.',
  'الجدول: مرر المؤشر فوق حد أي عمود؛ يجب أن يضيء خط تغيير الحجم العمود كاملًا في جميع الصفوف، بما في ذلك الأعمدة بعد العمود الحادي عشر.',
];

const setDir = (dir: ContentDir) => useLab.setState({ dir });
const reset = () => loadFixture(useLab.getState().fixture);
const runAll = () => void runScenarios(SCENARIOS);

function buildReport() {
  const { results, fixture, dir } = useLab.getState();
  const failed = results.filter((r) => !r.ok);
  return [
    `# Editor lab — ${new Date().toISOString()}`,
    `fixture ${fixture}, dir ${dir}, ${navigator.userAgent}`,
    `${results.length - failed.length}/${results.length} checks passed`,
    '',
    ...results.map(
      (r) =>
        `- ${r.ok ? 'ok ' : 'FAIL'} ${r.group} — ${r.check}${r.detail ? ` (${r.detail})` : ''}`
    ),
  ].join('\n');
}

const FixtureButton = memo(({ id }: { id: FixtureId }) => {
  const active = useLab((s) => s.fixture === id);
  const handleClick = useCallback(() => loadFixture(id), [id]);
  return (
    <Button
      size='sm'
      variant={active ? 'default' : 'outline'}
      onClick={handleClick}
    >
      {FIXTURES[id].label}
    </Button>
  );
});
FixtureButton.displayName = 'FixtureButton';

const ThemeButton = memo(({ theme }: { theme: ThemeMode }) => {
  const { mode, setMode } = useThemeMode();
  const handleClick = useCallback(() => setMode(theme), [setMode, theme]);
  return (
    <Button
      size='sm'
      variant={mode === theme ? 'default' : 'outline'}
      onClick={handleClick}
      data-lab-theme={theme}
    >
      {theme}
    </Button>
  );
});
ThemeButton.displayName = 'ThemeButton';

const DirButton = memo(({ dir }: { dir: ContentDir }) => {
  const active = useLab((s) => s.dir === dir);
  const handleClick = useCallback(() => setDir(dir), [dir]);
  return (
    <Button
      size='sm'
      variant={active ? 'default' : 'outline'}
      onClick={handleClick}
    >
      {dir}
    </Button>
  );
});
DirButton.displayName = 'DirButton';

const Controls = memo(() => {
  const running = useLab((s) => s.running);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(buildReport()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  }, []);

  return (
    <section className='flex flex-wrap items-center gap-2'>
      <h1 className='me-4 text-lg font-bold'>Editor lab</h1>
      <span className='text-sm text-muted-foreground'>document</span>
      {FIXTURE_IDS.map((id) => (
        <FixtureButton key={id} id={id} />
      ))}
      <span className='ms-4 text-sm text-muted-foreground'>direction</span>
      {DIRS.map((dir) => (
        <DirButton key={dir} dir={dir} />
      ))}
      <span className='ms-4 text-sm text-muted-foreground'>theme</span>
      {THEMES.map((theme) => (
        <ThemeButton key={theme} theme={theme} />
      ))}
      <span className='ms-4' />
      <Button
        size='sm'
        disabled={running !== null}
        onClick={runAll}
        data-lab-run
      >
        Run all checks
      </Button>
      <Button size='sm' variant='outline' onClick={reset}>
        Reset editor
      </Button>
      <Button size='sm' variant='outline' onClick={handleCopy}>
        {copied ? 'Copied' : 'Copy report'}
      </Button>
      {running && (
        <span className='text-sm text-muted-foreground'>
          running: {running}
        </span>
      )}
    </section>
  );
});
Controls.displayName = 'Controls';

const handleEditorChange = (value: unknown) =>
  useLab.setState((s) => ({
    value: Array.isArray(value) ? value : s.value,
    changes: s.changes + 1,
  }));

/** Keyed by `editorKey`: each mount seeds the editor with the lab's value. */
function EditorInstance({ dir }: { dir: ContentDir }) {
  const [seed] = useState(() => useLab.getState().value);
  return <PlateEditor content={seed} dir={dir} onChange={handleEditorChange} />;
}

const EditorPane = memo(() => {
  const editorKey = useLab((s) => s.editorKey);
  const dir = useLab((s) => s.dir);

  return (
    <section className={PANE_CLASS} data-lab-pane='editor'>
      <h2 className='text-sm font-semibold'>
        Editor{' '}
        <span className='font-normal text-muted-foreground'>
          (the static and export panes update on blur)
        </span>
      </h2>
      <div className='h-[70vh]'>
        <EditorInstance key={editorKey} dir={dir} />
      </div>
    </section>
  );
});
EditorPane.displayName = 'EditorPane';

const StaticPane = memo(() => {
  const value = useLab((s) => s.value);
  const dir = useLab((s) => s.dir);
  const editor = useMemo(() => createPublishedEditor(value), [value]);

  return (
    <section className={PANE_CLASS} data-lab-pane='static'>
      <h2 className='text-sm font-semibold'>
        Static{' '}
        <span className='font-normal text-muted-foreground'>
          (published copy, app stylesheet)
        </span>
      </h2>
      <div className={PANE_BODY_CLASS}>
        <EditorStatic editor={editor} dir={dir} />
      </div>
    </section>
  );
});
StaticPane.displayName = 'StaticPane';

const ExportBuilder = memo(() => {
  const value = useLab((s) => s.value);
  const dir = useLab((s) => s.dir);
  const { mode: theme } = useThemeMode();

  useEffect(() => {
    let current = true;
    buildEditorDocument(value, { dir, theme, title: 'Editor lab' })
      .then((exportHtml) => {
        if (current) useLab.setState({ exportHtml, exportError: null });
      })
      .catch((error: unknown) => {
        if (current) useLab.setState({ exportError: String(error) });
      });
    return () => {
      current = false;
    };
  }, [value, dir, theme]);

  return null;
});
ExportBuilder.displayName = 'ExportBuilder';

const downloadExport = () =>
  downloadBlob(
    new Blob([useLab.getState().exportHtml], { type: 'text/html' }),
    'editor-lab.html'
  );

const openExport = () =>
  openBlob(
    new Blob([useLab.getState().exportHtml], { type: 'text/html' }),
    'noopener'
  );

const ExportPane = memo(() => {
  const html = useLab((s) => s.exportHtml);
  const error = useLab((s) => s.exportError);

  return (
    <section className={PANE_CLASS} data-lab-pane='export'>
      <h2 className='flex items-center gap-2 text-sm font-semibold'>
        Export
        <span className='font-normal text-muted-foreground'>
          ({(html.length / 1024).toFixed(0)} KiB, extracted stylesheet)
        </span>
        <Button
          size='sm'
          variant='ghost'
          className='ms-auto h-6'
          onClick={openExport}
        >
          Open
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-6'
          onClick={downloadExport}
        >
          Download
        </Button>
      </h2>
      {error ? (
        <p className='text-sm text-destructive'>{error}</p>
      ) : (
        // A YouTube player inherits the sandbox and needs scripts to play.
        <iframe
          className={cn(PANE_BODY_CLASS, 'w-full')}
          sandbox='allow-same-origin allow-modals allow-scripts allow-popups allow-popups-to-escape-sandbox'
          srcDoc={html}
          title='export'
        />
      )}
    </section>
  );
});
ExportPane.displayName = 'ExportPane';

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
    <ol className='list-decimal ps-6 text-sm space-y-1'>
      {MANUAL_CHECKS.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  </section>
));
ManualChecks.displayName = 'ManualChecks';

const autoRun = () => {
  if (new URLSearchParams(location.search).has('run')) {
    setTimeout(runAll, 1000);
  }
};

export default function EditorLab() {
  useEffect(autoRun, []);

  return (
    <main dir='ltr' className='mx-auto max-w-screen-2xl p-4 space-y-6'>
      <Controls />
      <ExportBuilder />
      <div className='grid gap-4 xl:grid-cols-3'>
        <EditorPane />
        <StaticPane />
        <ExportPane />
      </div>
      <Results />
      <RenderWriteGuard />
      <KnownIssues />
      <ManualChecks />
    </main>
  );
}
