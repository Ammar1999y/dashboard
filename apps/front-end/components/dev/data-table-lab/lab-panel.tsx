import type { LabServerMode } from './fake-server';
import type { Scenario } from './scenarios';
import type { LabEvent } from './types';

import { memo, useCallback, useMemo, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { downloadBlob } from '@/lib/files/download';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';

import { LAB_QUERY_KEY, labServer, useLabServer } from './fake-server';
import { useLab } from './lab-store';
import { labRecorder } from './recorder';
import {
  buildReport,
  compiledSummary,
  describeEnvironment,
  mutationSummary,
  tableRenders,
} from './report';
import { createScenarioGroups } from './scenarios';

const DELAYS = [0, 250, 1000];
const MODES: LabServerMode[] = ['ok', 'empty', 'error'];
const COPIED_MS = 1500;

async function runScenarios(scenarios: Scenario[]) {
  if (useLab.getState().running) return;
  try {
    for (const scenario of scenarios) {
      useLab.setState({ running: scenario.title });
      await labRecorder.run(scenario.title, scenario.run, scenario.verify);
    }
  } finally {
    useLab.setState({ running: null });
  }
}

const ScenarioButton = memo(({ scenario }: { scenario: Scenario }) => {
  const running = useLab((s) => s.running !== null);
  const handleClick = useCallback(
    () => void runScenarios([scenario]),
    [scenario]
  );
  return (
    <Button
      size='sm'
      variant='outline'
      disabled={running}
      onClick={handleClick}
      className='h-auto whitespace-normal py-1 text-start text-xs'
    >
      {scenario.title}
    </Button>
  );
});
ScenarioButton.displayName = 'ScenarioButton';

const DelayButton = memo(({ delay }: { delay: number }) => {
  const active = useLabServer((s) => s.delayMs === delay);
  const handleClick = useCallback(() => labServer.setDelay(delay), [delay]);
  return (
    <Button
      size='sm'
      variant={active ? 'default' : 'outline'}
      onClick={handleClick}
    >
      {delay}ms
    </Button>
  );
});
DelayButton.displayName = 'DelayButton';

const ModeButton = memo(({ mode }: { mode: LabServerMode }) => {
  const queryClient = useQueryClient();
  const active = useLabServer((s) => s.mode === mode);
  const handleClick = useCallback(() => {
    labServer.setMode(mode);
    void queryClient.invalidateQueries({ queryKey: [LAB_QUERY_KEY] });
  }, [mode, queryClient]);
  return (
    <Button
      size='sm'
      variant={active ? 'default' : 'outline'}
      onClick={handleClick}
    >
      {mode}
    </Button>
  );
});
ModeButton.displayName = 'ModeButton';

export const LabControls = memo(() => {
  const queryClient = useQueryClient();
  const groups = useMemo(
    () => createScenarioGroups(queryClient),
    [queryClient]
  );
  const all = useMemo(() => groups.flatMap((g) => g.scenarios), [groups]);
  const running = useLab((s) => s.running);
  const hidePassive = useLab((s) => s.hidePassive);
  const [copied, setCopied] = useState(false);

  const handleRunAll = useCallback(() => void runScenarios(all), [all]);
  const handleClear = useCallback(() => useLab.setState({ events: [] }), []);
  const handleTogglePassive = useCallback(
    () => useLab.setState((s) => ({ hidePassive: !s.hidePassive })),
    []
  );
  const handleCopy = useCallback(async () => {
    const { events, env } = useLab.getState();
    await navigator.clipboard.writeText(buildReport(events, env));
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }, []);
  const handleDownload = useCallback(() => {
    const blob = new Blob([JSON.stringify(useLab.getState().events, null, 2)], {
      type: 'application/json',
    });
    downloadBlob(blob, `data-table-lab-${Date.now()}.json`);
  }, []);

  return (
    <section className='rounded-lg border border-border bg-card p-4 space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <h1 className='me-4 text-lg font-bold'>Data-table lab</h1>
        <Button size='sm' disabled={running !== null} onClick={handleRunAll}>
          Run all scenarios
        </Button>
        <Button size='sm' variant='outline' onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy report'}
        </Button>
        <Button size='sm' variant='outline' onClick={handleDownload}>
          Download JSON
        </Button>
        <Button size='sm' variant='outline' onClick={handleClear}>
          Clear log
        </Button>
        <label className='flex items-center gap-2 text-sm'>
          <input
            type='checkbox'
            checked={hidePassive}
            onChange={handleTogglePassive}
          />
          hide passive events
        </label>
      </div>

      <div className='flex flex-wrap items-center gap-2 text-sm'>
        <span className='text-muted-foreground'>server delay</span>
        {DELAYS.map((delay) => (
          <DelayButton key={delay} delay={delay} />
        ))}
        <span className='ms-4 text-muted-foreground'>server mode</span>
        {MODES.map((mode) => (
          <ModeButton key={mode} mode={mode} />
        ))}
      </div>

      <p className='text-sm text-muted-foreground'>
        {running
          ? `running: ${running}`
          : 'idle — interact with the table; each interaction is logged once the UI goes quiet.'}
      </p>

      <Environment />

      <details>
        <summary className='cursor-pointer text-sm font-semibold'>
          Scenarios ({all.length})
        </summary>
        <div className='mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
          {groups.map((group) => (
            <div key={group.title} className='space-y-2'>
              <h2 className='text-sm font-semibold'>{group.title}</h2>
              <div className='flex flex-col items-stretch gap-1'>
                {group.scenarios.map((scenario, i) => (
                  <ScenarioButton
                    key={`${group.title}-${i}`}
                    scenario={scenario}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
});
LabControls.displayName = 'LabControls';

const Environment = memo(() => {
  const env = useLab((s) => s.env);
  const { compiled, plain } = useMemo(() => compiledSummary(env), [env]);
  return (
    <div className='font-mono text-xs text-muted-foreground space-y-1'>
      <div>{describeEnvironment(env)}</div>
      <div>compiled: {compiled.join(', ') || '—'}</div>
      <div>not compiled: {plain.join(', ') || '—'}</div>
    </div>
  );
});
Environment.displayName = 'Environment';

const Chips = memo(({ entries }: { entries: [string, number][] }) =>
  entries.length === 0 ? (
    <span className='text-muted-foreground'>none</span>
  ) : (
    <span className='flex flex-wrap gap-1'>
      {entries.map(([name, count]) => (
        <span
          key={name}
          className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'
        >
          {name}×{count}
        </span>
      ))}
    </span>
  )
);
Chips.displayName = 'Chips';

const EventCard = memo(({ event }: { event: LabEvent }) => {
  const failed = event.mismatches.length > 0;
  const table = useMemo(() => tableRenders(event.renders), [event.renders]);
  const mounted = useMemo(() => tableRenders(event.mounts), [event.mounts]);
  const unmounted = useMemo(
    () => tableRenders(event.unmounts),
    [event.unmounts]
  );
  const other = useMemo(
    () => Object.entries(event.renders).filter((e) => !table.includes(e)),
    [event.renders, table]
  );
  const stores = useMemo(() => Object.entries(event.stores), [event.stores]);

  return (
    <li
      className={cn(
        'rounded-md border p-3 text-sm space-y-2',
        failed ? 'border-destructive' : 'border-border'
      )}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-xs font-bold',
            failed
              ? 'bg-destructive text-destructive-foreground'
              : 'bg-success text-background'
          )}
        >
          {failed ? `FAIL ${event.mismatches.length}` : 'OK'}
        </span>
        <span className='font-mono text-xs text-muted-foreground'>
          #{event.id} {event.kind}
        </span>
        <span className='font-semibold'>{event.label}</span>
      </div>
      <div className='font-mono text-xs text-muted-foreground'>
        {event.commits} {event.timing === 'profiler' ? 'commits' : 'frames'} ·{' '}
        {event.renderMs === null
          ? 'render ms n/a'
          : `${event.renderMs}ms render`}{' '}
        · {event.wallMs}ms wall · max frame {event.maxFrameMs}ms (
        {event.longFrames} over 50ms) · DOM {mutationSummary(event)}
      </div>
      {stores.length > 0 && (
        <div>
          store writes: <Chips entries={stores} />
        </div>
      )}
      {event.notes.length > 0 && (
        <pre className='overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs'>
          {event.notes.join('\n')}
        </pre>
      )}
      {failed && (
        <ul className='list-disc ps-5 text-destructive'>
          {event.mismatches.map((m, i) => (
            <li key={i}>
              <span className='font-semibold'>{m.check}</span>: {m.detail}
            </li>
          ))}
        </ul>
      )}
      <div className='space-y-1'>
        <div>
          rendered: <Chips entries={table} />
        </div>
        {mounted.length > 0 && (
          <div>
            mounted: <Chips entries={mounted} />
          </div>
        )}
        {unmounted.length > 0 && (
          <div>
            unmounted: <Chips entries={unmounted} />
          </div>
        )}
      </div>
      {other.length > 0 && (
        <details>
          <summary className='cursor-pointer text-xs text-muted-foreground'>
            other components rendered ({other.length})
          </summary>
          <Chips entries={other} />
        </details>
      )}
    </li>
  );
});
EventCard.displayName = 'EventCard';

export const LabLog = memo(() => {
  const events = useLab((s) => s.events);
  const hidePassive = useLab((s) => s.hidePassive);
  const visible = useMemo(
    () =>
      events
        .filter(
          (e) => !hidePassive || e.kind !== 'passive' || e.mismatches.length > 0
        )
        .reverse(),
    [events, hidePassive]
  );
  const failures = useMemo(
    () => events.filter((e) => e.mismatches.length > 0).length,
    [events]
  );

  return (
    <section className='space-y-3'>
      <h2 className='text-base font-bold'>
        Log — {events.length} events, {failures} with mismatches
      </h2>
      <ul className='space-y-2'>
        {visible.map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
      </ul>
    </section>
  );
});
LabLog.displayName = 'LabLog';
