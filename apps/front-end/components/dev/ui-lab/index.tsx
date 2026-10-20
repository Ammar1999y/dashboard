import type { MouseEvent } from 'react';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { useLab } from './lab-store';
import { probes, recordFormEvent } from './probes';
import { runScenarios, SCENARIOS } from './scenarios';

const LINES = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`);
const LIST_ITEMS = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`);

const runAll = () => void runScenarios(SCENARIOS);
const clearResults = () => useLab.setState({ results: [] });
const setSelectValue = (selectValue: string) =>
  useLab.setState({ selectValue });
const setSliderValue = (sliderValue: number[]) =>
  useLab.setState({ sliderValue });
const countOutsideClick = () => {
  probes.outsideClicks += 1;
};
const stopClick = (event: MouseEvent) => event.stopPropagation();
const countTabBlur = () => {
  probes.tabInputBlurs += 1;
};
const preventSubmit = (event: { preventDefault: () => void }) =>
  event.preventDefault();

const MANUAL_CHECKS = [
  'القائمة الجانبية في لوحة التحكم: مرّر بعجلة الفأرة داخل القائمة عندما تكون أطول من الشاشة. يجب أن تتحرك القائمة، وأن يظهر شريط التمرير عند المرور عليها.',
  'قائمة الهاتف: صغّر النافذة إلى عرض الهاتف، وافتح القائمة، ومرّر داخلها بالإصبع أو بالعجلة.',
  'الإعدادات (التخصيص): افتحها ومرّر إلى آخرها. تبقى المسافات بين الأقسام كما كانت، ولا يظهر شريط تمرير أفقي.',
  'المحرر داخل مربع حوار: افتح منتقي لون أو رابط من شريط الأدوات واكتب فيه. يجب أن يبقى المؤشر في الحقل، وأن تعمل عجلة الفأرة داخل القائمة المنبثقة.',
  'تصفية الجدول: افتح «تصفية» ثم اضغط زرًا آخر في شريط الأدوات. تُغلق القائمة المنبثقة وينفّذ الزر عمله من الضغطة نفسها.',
  'القوائم المنسدلة والتقويم داخل النماذج: اختر قيمة بالفأرة ثم بلوحة المفاتيح، وتأكد أن النموذج يحفظها.',
  'شغّل أيضًا «Run all scenarios» في /dev/dialog-lab و /dev/data-table-lab.',
];

const LabLines = () => (
  <ul data-lab-content className='p-3 text-sm'>
    {LINES.map((line) => (
      <li key={line}>{line}</li>
    ))}
  </ul>
);

const ScrollAreas = memo(() => (
  <section className='grid gap-3 sm:grid-cols-2'>
    <ScrollArea data-lab='scroll-element' className='h-32 rounded-md border'>
      <div data-lab-content className='p-3 text-sm space-y-2'>
        {LINES.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </ScrollArea>
    <ScrollArea data-lab='scroll-component' className='h-32 rounded-md border'>
      <LabLines />
    </ScrollArea>
    <ScrollArea data-lab='scroll-siblings' className='h-32 rounded-md border'>
      <p data-lab-content className='p-3 text-sm font-medium'>
        Two siblings
      </p>
      <LabLines />
    </ScrollArea>
    <ScrollArea
      data-lab='scroll-spaced'
      className='h-32 rounded-md border'
      viewportClassName='p-3 space-y-6'
    >
      {LINES.slice(0, 8).map((line) => (
        <section data-lab-content key={line} className='text-sm'>
          {line}
        </section>
      ))}
    </ScrollArea>
  </section>
));
ScrollAreas.displayName = 'ScrollAreas';

const LabDialog = memo(() => (
  <Dialog>
    <DialogTrigger asChild>
      <Button data-lab='open-dialog' variant='outline'>
        Dialog with a popover
      </Button>
    </DialogTrigger>
    <DialogContent
      data-lab='dialog'
      aria-describedby='ui-lab-dialog-extra'
      className='max-w-md p-6'
    >
      <DialogTitle>Dialog</DialogTitle>
      <DialogDescription data-lab='dialog-description'>
        A modal dialog.
      </DialogDescription>
      <p id='ui-lab-dialog-extra' className='text-sm'>
        It also names this paragraph.
      </p>
      <Popover>
        <PopoverTrigger asChild>
          <Button data-lab='dialog-popover-trigger' variant='outline'>
            Popover
          </Button>
        </PopoverTrigger>
        <PopoverContent data-lab='dialog-popover' className='space-y-2'>
          <Input data-lab='dialog-popover-input' placeholder='Type here' />
          <ul
            data-lab='dialog-popover-list'
            className='max-h-24 overflow-y-auto text-sm'
          >
            {LIST_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </DialogContent>
  </Dialog>
));
LabDialog.displayName = 'LabDialog';

const OutsidePress = memo(() => (
  <section className='flex flex-wrap gap-2'>
    <Popover>
      <PopoverTrigger asChild>
        <Button data-lab='outside-trigger' variant='outline'>
          Popover
        </Button>
      </PopoverTrigger>
      <PopoverContent data-lab='outside-popover' className='text-sm'>
        Press outside.
      </PopoverContent>
    </Popover>
    <Button
      data-lab='outside-plain'
      variant='outline'
      onClick={countOutsideClick}
    >
      Plain button
    </Button>
    <Button data-lab='outside-stopper' variant='outline' onClick={stopClick}>
      Stops its click
    </Button>
  </section>
));
OutsidePress.displayName = 'OutsidePress';

const LabTooltip = memo(() => (
  <section className='flex items-center gap-3'>
    <Tooltip>
      <TooltipTrigger asChild aria-describedby='ui-lab-tooltip-extra'>
        <Button data-lab='tooltip-trigger' variant='outline'>
          Tooltip
        </Button>
      </TooltipTrigger>
      <TooltipContent>Tooltip text</TooltipContent>
    </Tooltip>
    <p id='ui-lab-tooltip-extra' className='text-sm text-muted-foreground'>
      Also describes the button.
    </p>
  </section>
));
LabTooltip.displayName = 'LabTooltip';

const LabForm = memo(() => {
  const selectValue = useLab((s) => s.selectValue);
  const sliderValue = useLab((s) => s.sliderValue);

  return (
    <form
      data-lab='form'
      className='grid gap-3 rounded-md border p-3'
      onClick={recordFormEvent}
      onChange={recordFormEvent}
      onInput={recordFormEvent}
      onSubmit={preventSubmit}
    >
      <label className='flex items-center gap-2 text-sm'>
        <Checkbox data-lab='form-checkbox' name='agree' /> Checkbox
      </label>
      <label className='flex items-center gap-2 text-sm'>
        <Switch data-lab='form-switch' name='notify' /> Switch
      </label>
      <Slider
        data-lab='form-slider'
        name='level'
        max={100}
        value={sliderValue}
        onValueChange={setSliderValue}
      />
      <Select name='choice' value={selectValue} onValueChange={setSelectValue}>
        <SelectTrigger data-lab='form-select'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='a'>Option A</SelectItem>
          <SelectItem value='b'>Option B</SelectItem>
        </SelectContent>
      </Select>
    </form>
  );
});
LabForm.displayName = 'LabForm';

const LabTabs = memo(() => (
  <Tabs data-lab='tabs' defaultValue='a'>
    <TabsList>
      <TabsTrigger data-lab='tab-a' value='a'>
        First
      </TabsTrigger>
      <TabsTrigger data-lab='tab-b' value='b'>
        Second
      </TabsTrigger>
    </TabsList>
    <TabsContent value='a'>
      <Input
        data-lab='tab-input'
        placeholder='Focus me'
        onBlur={countTabBlur}
      />
    </TabsContent>
    <TabsContent value='b' className='text-sm'>
      Second panel
    </TabsContent>
  </Tabs>
));
LabTabs.displayName = 'LabTabs';

const LabMenu = memo(() => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button data-lab='menu-trigger' variant='outline'>
        Menu
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent data-lab='menu'>
      <DropdownMenuItem>First</DropdownMenuItem>
      <DropdownMenuItem>Second</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
));
LabMenu.displayName = 'LabMenu';

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
      تمرير العجلة الحقيقي واللمس وشكل العناصر لا تقيسها البرامج النصية، فافحصها
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

export default function UiLab() {
  return (
    <main dir='ltr' className='mx-auto max-w-3xl p-4 space-y-6'>
      <h1 data-lab='heading' className='text-xl font-bold'>
        UI primitives lab
      </h1>
      <Controls />
      <Results />
      <ScrollAreas />
      <section className='flex flex-wrap items-center gap-2'>
        <LabDialog />
        <LabMenu />
      </section>
      <OutsidePress />
      <LabTooltip />
      <LabForm />
      <LabTabs />
      <ManualChecks />
    </main>
  );
}
