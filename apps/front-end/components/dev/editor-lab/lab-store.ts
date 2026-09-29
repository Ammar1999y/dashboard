import type { ContentDir } from '@/components/editor/styles';
import type { Value } from 'platejs';

import { create } from 'zustand';

import { createFixture, createStressFixture } from './fixture';

export interface LabResult {
  group: string;
  check: string;
  ok: boolean;
  detail: string;
}

export const FIXTURES = {
  full: { label: 'Every node', create: createFixture },
  stress: { label: '300 blocks', create: () => createStressFixture() },
  empty: { label: 'Empty', create: (): Value => [] },
} as const;

export type FixtureId = keyof typeof FIXTURES;

interface LabState {
  fixture: FixtureId;
  dir: ContentDir;
  /** What the editor reported on its last blur; the other panes render it. */
  value: Value;
  /** Remounts the editor with `value` as its initial document. */
  editorKey: number;
  changes: number;
  exportHtml: string;
  exportError: string | null;
  running: string | null;
  results: LabResult[];
}

export const useLab = create<LabState>(() => ({
  fixture: 'full',
  dir: 'ltr',
  value: createFixture(),
  editorKey: 0,
  changes: 0,
  exportHtml: '',
  exportError: null,
  running: null,
  results: [],
}));

export const loadFixture = (fixture: FixtureId) =>
  useLab.setState((s) => ({
    fixture,
    value: FIXTURES[fixture].create(),
    editorKey: s.editorKey + 1,
    changes: 0,
  }));
