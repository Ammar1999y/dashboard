import type { TDiscussion } from '@/components/editor/plugins/discussion-kit';
import type { Value } from 'platejs';
import type { PlateEditor } from 'platejs/react';

import * as React from 'react';
import {
  captureOwnerStack,
  memo,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { getCommentKey } from '@platejs/comment';
import { MarkdownPlugin } from '@platejs/markdown';
import { getSuggestionKey } from '@platejs/suggestion';
import { createSlateEditor, KEYS, NodeApi } from 'platejs';
import { createPlateEditor, Plate } from 'platejs/react';
import { create } from 'zustand';

import { Button } from '@/components/ui/button';
import { createBaseEditorKit } from '@/components/editor/editor-base-kit';
import { createEditorKit } from '@/components/editor/editor-kit';
import { discussionPlugin } from '@/components/editor/plugins/discussion-kit';
import { Editor, EditorContainer } from '@/components/editor/ui/editor';

export const TOGGLE_TITLE = 'A toggle title';
export const TOGGLE_CONTENT = 'Hidden inside the toggle';

export const toggleDocument = (): Value => [
  { type: KEYS.p, children: [{ text: 'Before the toggle.' }] },
  { type: KEYS.toggle, id: 'md-toggle', children: [{ text: TOGGLE_TITLE }] },
  { type: KEYS.p, indent: 1, children: [{ text: TOGGLE_CONTENT }] },
  { type: KEYS.p, children: [{ text: 'After the toggle.' }] },
];

/** What Plate's Markdown serializer makes of a toggle, and what reads back. */
export function markdownRoundTrip(value: Value) {
  const editor = createSlateEditor({ plugins: createBaseEditorKit(), value });
  const api = editor.getApi(MarkdownPlugin).markdown;
  const markdown = api.serialize();
  const back = api.deserialize(markdown);
  return {
    markdown,
    back: back.map((node) => ({
      type: 'type' in node ? node.type : 'text',
      text: NodeApi.string(node),
    })),
  };
}

const MarkdownToggleDemo = memo(() => {
  const [{ markdown, back }] = useState(() =>
    markdownRoundTrip(toggleDocument())
  );
  const titleLost = !markdown.includes(TOGGLE_TITLE);

  return (
    <article
      className='rounded-lg border p-4 space-y-3'
      data-lab-issue='markdown-toggle'
    >
      <h3 className='font-semibold'>Markdown export drops toggles</h3>
      <p className='text-sm text-muted-foreground'>
        Markdown has no collapsible block, and <code>@platejs/markdown</code>{' '}
        has no rule for one: it logs <code>Unreachable code</code> and writes
        nothing for the toggle. Its title is gone from the file, and the content
        indented under it comes back as an ordinary paragraph that no longer
        collapses.
      </p>
      <div className='grid gap-3 md:grid-cols-3'>
        <section>
          <h4 className='text-xs font-semibold uppercase text-muted-foreground'>
            Document
          </h4>
          <ul className='text-sm'>
            {toggleDocument().map((node) => (
              <li key={NodeApi.string(node)}>
                <code>{node.type}</code>
                {node.indent ? ` (indent ${String(node.indent)})` : ''}:{' '}
                {NodeApi.string(node)}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h4 className='text-xs font-semibold uppercase text-muted-foreground'>
            Markdown written
          </h4>
          <pre className='whitespace-pre-wrap rounded bg-muted p-2 text-xs'>
            {markdown}
          </pre>
        </section>
        <section>
          <h4 className='text-xs font-semibold uppercase text-muted-foreground'>
            Read back
          </h4>
          <ul className='text-sm'>
            {back.map((node) => (
              <li key={node.text}>
                <code>{node.type}</code>: {node.text}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p
        className={titleLost ? 'text-sm text-error' : 'text-sm text-success'}
        data-lab-reproduced={titleLost}
      >
        {titleLost
          ? `Reproduced: "${TOGGLE_TITLE}" is not in the Markdown.`
          : 'Not reproduced: the toggle title survives.'}
      </p>
    </article>
  );
});
MarkdownToggleDemo.displayName = 'MarkdownToggleDemo';

export interface RenderWrite {
  plugin: string;
  option: string;
  /** React's owner stack at the write: the components rendering it. */
  stack: string;
}

/** Writes to editor options that happened while React was rendering. */
export const useRenderWrites = create<{
  writes: RenderWrite[];
  /** The detector's own check: where each probe found itself. */
  probe: Record<'render' | 'effect' | 'timeout', boolean> | null;
}>(() => ({ writes: [], probe: null }));

/**
 * "Is React rendering right now?" `captureOwnerStack()` cannot tell: React 19
 * sets the owner in effects and event handlers too, in development. The hooks
 * dispatcher can: while a component renders it is that render's, and at any
 * other time the one React leaves behind, sampled here after a commit. Dev
 * only, and an internal: DetectorProbe checks it before anything relies on it.
 */
const reactInternals: unknown = Reflect.get(
  React,
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
);
const currentDispatcher = () =>
  typeof reactInternals === 'object' &&
  reactInternals !== null &&
  'H' in reactInternals
    ? reactInternals.H
    : null;
let idleDispatcher: unknown = null;
const sampleIdleDispatcher = () => {
  idleDispatcher = currentDispatcher();
};
const isRendering = () => {
  const dispatcher = currentDispatcher();
  return dispatcher !== null && dispatcher !== idleDispatcher;
};

/** Renders nothing; records what the detector says in a render, an effect and a timer. */
function DetectorProbe() {
  const inRender = isRendering();
  useEffect(() => {
    const inEffect = isRendering();
    const timer = setTimeout(
      () =>
        useRenderWrites.setState({
          probe: { render: inRender, effect: inEffect, timeout: isRendering() },
        }),
      0
    );
    return () => clearTimeout(timer);
  }, [inRender]);
  return null;
}

const COMMENT_ID = 'render-demo';
const SUGGESTION_ID = 'render-demo-suggestion';

const renderWriteDocument = (userId: string): Value => [
  {
    type: KEYS.p,
    children: [
      { text: 'This paragraph has a ' },
      {
        text: 'commented phrase',
        [KEYS.comment]: true,
        [getCommentKey(COMMENT_ID)]: true,
      },
      { text: ' and a ' },
      {
        text: 'suggested insertion',
        [KEYS.suggestion]: true,
        [getSuggestionKey(SUGGESTION_ID)]: {
          id: SUGGESTION_ID,
          createdAt: Date.now(),
          type: 'insert',
          userId,
        },
      },
      { text: '.' },
    ],
  },
];

const renderWriteDiscussion = (userId: string): TDiscussion => ({
  id: COMMENT_ID,
  comments: [
    {
      id: `${COMMENT_ID}-1`,
      contentRich: [{ type: KEYS.p, children: [{ text: 'A comment.' }] }],
      createdAt: new Date(),
      discussionId: COMMENT_ID,
      isEdited: false,
      userId,
    },
  ],
  createdAt: new Date(),
  isResolved: false,
  userId,
});

const pluginKey = (plugin: unknown) =>
  String(
    typeof plugin === 'object' && plugin !== null && 'key' in plugin
      ? plugin.key
      : plugin
  );

/** Component frames only: webpack's `eval` and host elements say nothing. */
const componentFrames = (stack: string) =>
  [...stack.matchAll(/at ([A-Z][\w.$]*)/g)].map((m) => m[1]).join(' ← ');

let pendingWrites: RenderWrite[] = [];

// Recorded after the render, or the log would itself update a component
// while another renders: the pattern it is there to show.
const flushWrites = () => {
  const writes = pendingWrites;
  pendingWrites = [];
  useRenderWrites.setState((s) => ({ writes: [...s.writes, ...writes] }));
};

/** An editor whose `setOption` records each call made while React renders. */
function createInstrumentedEditor() {
  const editor = createPlateEditor({ plugins: createEditorKit() });
  const userId = editor.getOption(discussionPlugin, 'currentUserId');
  editor.tf.setValue(renderWriteDocument(userId));
  editor.setOption(discussionPlugin, 'discussions', [
    renderWriteDiscussion(userId),
  ]);
  const setOption = editor.setOption.bind(editor);
  editor.setOption = ((plugin: unknown, key: unknown, value: unknown) => {
    if (isRendering()) {
      if (pendingWrites.length === 0) queueMicrotask(flushWrites);
      pendingWrites.push({
        plugin: pluginKey(plugin),
        option: String(key),
        stack: componentFrames(captureOwnerStack() ?? ''),
      });
    }
    return (setOption as (...args: unknown[]) => unknown)(plugin, key, value);
  }) as PlateEditor['setOption'];
  return editor;
}

const moveCommentDown = (editor: PlateEditor) =>
  editor.tf.insertNodes(
    { type: KEYS.p, children: [{ text: 'A paragraph pushed above.' }] },
    { at: [0] }
  );

const RenderWriteLog = memo(() => {
  const writes = useRenderWrites((s) => s.writes);
  const probe = useRenderWrites((s) => s.probe);
  const counts = new Map<string, { count: number; stack: string }>();
  for (const write of writes) {
    const key = `${write.plugin}.${write.option}`;
    const entry = counts.get(key);
    counts.set(key, {
      count: (entry?.count ?? 0) + 1,
      stack: entry?.stack ?? write.stack,
    });
  }

  return (
    <div className='text-sm space-y-1'>
      <p
        className='text-xs text-muted-foreground'
        data-lab-probe={JSON.stringify(probe)}
      >
        Detector self-check:{' '}
        {probe
          ? `render ${probe.render ? 'detected' : 'MISSED'}, effect ${probe.effect ? 'WRONGLY flagged' : 'ignored'}, timer ${probe.timeout ? 'WRONGLY flagged' : 'ignored'}`
          : 'pending'}
      </p>
      <p
        className={writes.length > 0 ? 'text-error' : 'text-success'}
        data-lab-render-writes={writes.length}
      >
        {writes.length > 0
          ? `Regression: ${writes.length} option write(s) during render.`
          : 'No option writes during render.'}
      </p>
      <ul className='list-disc ps-5 font-mono text-xs'>
        {[...counts].map(([write, { count, stack }]) => (
          <li key={write} data-lab-write={write}>
            setOption({write}) ×{count}
            <div className='text-muted-foreground'>{stack || '—'}</div>
          </li>
        ))}
      </ul>
    </div>
  );
});
RenderWriteLog.displayName = 'RenderWriteLog';

export const RENDER_DEMO_ID = 'render-write-demo';

export const RenderWriteGuard = memo(() => {
  const [editor, setEditor] = useState<PlateEditor | null>(null);

  // After a commit, so the idle dispatcher is sampled before the first write.
  useEffect(() => {
    sampleIdleDispatcher();
    setEditor(createInstrumentedEditor());
  }, []);

  const handleMove = useCallback(() => {
    if (editor) moveCommentDown(editor);
  }, [editor]);
  const handleRemount = useCallback(() => {
    useRenderWrites.setState({ writes: [] });
    setEditor(createInstrumentedEditor());
  }, []);

  return (
    <article
      className='rounded-lg border p-4 space-y-3'
      data-lab-guard='render-writes'
    >
      <h3 className='font-semibold'>
        The discussion code writes no state during render
      </h3>
      <p className='text-sm text-muted-foreground'>
        Plate&apos;s template noted which block lists a thread by calling{' '}
        <code>setOption(&apos;uniquePathMap&apos;, …)</code> while a block with
        a comment or a suggestion rendered, which React reports as &quot;Cannot
        update a component while rendering a different component&quot;.{' '}
        <code>useResolvedDiscussion</code> and <code>useResolveSuggestion</code>{' '}
        now read that block from the document instead.
      </p>
      <p className='text-sm text-muted-foreground'>
        This editor records each <code>setOption</code> made while React is
        rendering, with the components on the stack: the list must stay empty on
        a remount and when the thread moves to another block.
      </p>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          onClick={handleMove}
          data-lab-move-comment
        >
          Push the commented paragraph down
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={handleRemount}
          data-lab-remount-demo
        >
          Remount
        </Button>
      </div>
      <div className='rounded-md border' id={RENDER_DEMO_ID}>
        {editor && (
          <Plate editor={editor}>
            <EditorContainer className='max-h-60'>
              <Editor dir='ltr' className='px-12 pb-6' />
            </EditorContainer>
          </Plate>
        )}
        {editor && <DetectorProbe />}
      </div>
      <RenderWriteLog />
    </article>
  );
});
RenderWriteGuard.displayName = 'RenderWriteGuard';

export const KnownIssues = memo(() => (
  <section className='space-y-3'>
    <h2 className='font-semibold'>Known issues (not fixed)</h2>
    <p className='text-sm text-muted-foreground'>
      Each card reproduces the issue live. Their checks, under &quot;Known
      issue&quot; in the results, pass while the issue still reproduces; one
      that stops reproducing has been fixed.
    </p>
    <MarkdownToggleDemo />
  </section>
));
KnownIssues.displayName = 'KnownIssues';
