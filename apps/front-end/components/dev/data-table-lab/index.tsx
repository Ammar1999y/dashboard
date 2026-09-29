import type { ProfilerOnRenderCallback } from 'react';

import { Profiler, useEffect } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { LabControls, LabLog } from './lab-panel';
import { LAB_PROFILER_ID, useLab } from './lab-store';
import { LabTable } from './lab-table';
import { labRecorder } from './recorder';

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) =>
  labRecorder.onCommit(actualDuration);

export default function DataTableLab() {
  const queryClient = useQueryClient();
  const mountKey = useLab((s) => s.mountKey);

  useEffect(() => labRecorder.attach(queryClient), [queryClient]);

  return (
    <main className='mx-auto max-w-screen-2xl p-4 space-y-6'>
      <div data-lab-panel dir='ltr'>
        <LabControls />
      </div>
      <Profiler id={LAB_PROFILER_ID} onRender={onRender}>
        <LabTable key={mountKey} />
      </Profiler>
      <div data-lab-panel dir='ltr'>
        <LabLog />
      </div>
    </main>
  );
}
