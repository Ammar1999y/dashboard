'use client';

import type {
  TComment,
  TDiscussion,
} from '@/components/editor/plugins/discussion-kit';
import type { TResolvedSuggestion } from '@platejs/suggestion';
import type { NodeEntry, Path, TElement, TSuggestionText } from 'platejs';

import * as React from 'react';

import {
  acceptSuggestion,
  getSuggestionKey,
  keyId2SuggestionId,
  rejectSuggestion,
} from '@platejs/suggestion';
import { SuggestionPlugin } from '@platejs/suggestion/react';
import { ElementApi, KEYS, PathApi, TextApi } from 'platejs';
import { useEditorPlugin, usePluginOption } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { blockTypeLabel } from '@/components/editor/block-types';
import { discussionPlugin } from '@/components/editor/plugins/discussion-kit';
import { suggestionPlugin } from '@/components/editor/plugins/suggestion-kit';

import { AuthorLine, Comment, CommentCreateForm } from './comment';

export interface ResolvedSuggestion extends TResolvedSuggestion {
  comments: TComment[];
}

const BLOCK_SUGGESTION = '__block__';
const LINE_BREAK_LABEL = 'فاصل أسطر';

const LIST_LABELS: Record<string, string> = {
  [KEYS.listTodo]: blockTypeLabel(KEYS.listTodo),
  [KEYS.ol]: blockTypeLabel(KEYS.ol),
};

/** What a suggested block change names the block as. */
const describeBlock = (node: TElement) => {
  const listType = node[KEYS.listType];
  if (typeof listType === 'string' && node.type === KEYS.p) {
    return LIST_LABELS[listType] ?? blockTypeLabel(KEYS.ul);
  }
  return blockTypeLabel(node.type);
};

const splitSuggestionText = (text = '') =>
  text === BLOCK_SUGGESTION
    ? [LINE_BREAK_LABEL]
    : text.split(BLOCK_SUGGESTION).filter(Boolean);

function SuggestionLine({
  label,
  text,
  className,
}: {
  label: string;
  text: string | undefined;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-2 text-sm', className)}>
      <span className='text-muted-foreground'>{label}</span>
      <span>{text || LINE_BREAK_LABEL}</span>
    </div>
  );
}

const lines = (text: string | undefined, label: string) =>
  splitSuggestionText(text).map((line, index) => (
    <SuggestionLine key={`${label}-${index}`} label={label} text={line} />
  ));

function SuggestionSummary({ suggestion }: { suggestion: ResolvedSuggestion }) {
  switch (suggestion.type) {
    case 'remove': {
      return lines(suggestion.text, 'حذف:');
    }
    case 'insert': {
      return lines(suggestion.newText, 'إضافة:');
    }
    case 'replace': {
      const [replaced = '', ...removed] = splitSuggestionText(suggestion.text);
      return (
        <>
          {splitSuggestionText(suggestion.newText).map((line, index) => (
            <SuggestionLine
              className='text-primary/80'
              key={`with-${index}`}
              label='بـ:'
              text={line}
            />
          ))}
          <SuggestionLine label='استبدال:' text={replaced} />
          {removed.map((line, index) => (
            <SuggestionLine key={`removed-${index}`} label='حذف:' text={line} />
          ))}
        </>
      );
    }
    case 'update': {
      const changes = [
        ...Object.keys(suggestion.properties).map((key) => `−${key}`),
        ...Object.keys(suggestion.newProperties).map((key) => `+${key}`),
      ];
      return (
        <SuggestionLine
          label={`تنسيق: ${changes.join(' ')}`}
          text={suggestion.newText}
        />
      );
    }
  }
}

export function BlockSuggestionCard({
  idx,
  isLast,
  suggestion,
}: {
  idx: number;
  isLast: boolean;
  suggestion: ResolvedSuggestion;
}) {
  const { api, editor } = useEditorPlugin(SuggestionPlugin);
  const userInfo = usePluginOption(discussionPlugin, 'user', suggestion.userId);
  const [hovering, setHovering] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const accept = () =>
    api.suggestion.withoutSuggestions(() =>
      acceptSuggestion(editor, suggestion)
    );
  const reject = () =>
    api.suggestion.withoutSuggestions(() =>
      rejectSuggestion(editor, suggestion)
    );

  return (
    <div
      className='relative'
      key={`${suggestion.suggestionId}-${idx}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className='flex flex-col p-4'>
        <AuthorLine
          user={userInfo}
          createdAt={new Date(suggestion.createdAt)}
        />

        <div className='relative mb-4 mt-1 flex flex-col gap-2 ps-8'>
          <SuggestionSummary suggestion={suggestion} />
        </div>

        {suggestion.comments.map((comment, index) => (
          <Comment
            comment={comment}
            discussionLength={suggestion.comments.length}
            editingId={editingId}
            index={index}
            key={comment.id}
            setEditingId={setEditingId}
          />
        ))}

        {hovering && (
          <div className='absolute top-4 flex gap-2 ltr:right-4 rtl:left-4 rtl:flex-row-reverse'>
            <Button
              aria-label='قبول'
              className='size-6 p-1 text-muted-foreground'
              onClick={accept}
              variant='ghost'
            >
              <Icon icon='solar:check-read-linear' className='size-4' />
            </Button>
            <Button
              aria-label='رفض'
              className='size-6 p-1 text-muted-foreground'
              onClick={reject}
              variant='ghost'
            >
              <Icon icon='solar:close-linear' className='size-4' />
            </Button>
          </div>
        )}

        <CommentCreateForm discussionId={suggestion.suggestionId} />
      </div>

      {!isLast && <div className='h-px w-full bg-muted' />}
    </div>
  );
}

export const useResolveSuggestion = (
  suggestionNodes: NodeEntry<TElement | TSuggestionText>[],
  blockPath: Path
) => {
  const discussions = usePluginOption(discussionPlugin, 'discussions');

  const { api, editor } = useEditorPlugin(suggestionPlugin);

  const resolvedSuggestion: ResolvedSuggestion[] = React.useMemo(() => {
    if (suggestionNodes.length === 0) return [];

    const suggestionIds = new Set(
      suggestionNodes
        .flatMap(([node]) => {
          if (TextApi.isText(node)) {
            const dataList = api.suggestion.dataList(node);
            const includeUpdate = dataList.some(
              (data: { id?: string; type?: string }) => data.type === 'update'
            );

            if (!includeUpdate) {
              return api.suggestion.nodeId(node) ?? [];
            }

            return dataList
              .filter(
                (data: { id?: string; type?: string }) => data.type === 'update'
              )
              .map((d: { id?: string; type?: string }) => d.id);
          }
          if (ElementApi.isElement(node)) {
            return api.suggestion.nodeId(node) ?? [];
          }

          return [];
        })
        .filter(Boolean)
    );

    const res: ResolvedSuggestion[] = [];

    suggestionIds.forEach((id) => {
      if (!id) return;

      const entries = [
        ...editor.api.nodes<TElement | TSuggestionText>({
          at: [],
          mode: 'all',
          match: (n) =>
            (n[KEYS.suggestion] && n[getSuggestionKey(id)]) ||
            api.suggestion.nodeId(n as TElement) === id,
        }),
      ];

      // A suggestion across blocks is listed once, by the first of them.
      if (entries[0]?.[1][0] !== blockPath[0]) return;

      // move line break to the end
      entries.sort(([, path1], [, path2]) =>
        PathApi.isChild(path1, path2) ? -1 : 1
      );

      let newText = '';
      let text = '';
      let properties: Record<string, unknown> = {};
      let newProperties: Record<string, unknown> = {};

      // overlapping suggestion
      entries.forEach(([node]) => {
        if (TextApi.isText(node)) {
          const dataList = api.suggestion.dataList(node);

          dataList.forEach(
            (data: {
              id?: string;
              type?: string;
              properties?: Record<string, unknown>;
              newProperties?: Record<string, unknown>;
            }) => {
              if (data.id === id) {
                switch (data.type) {
                  case 'insert': {
                    newText += node.text;

                    break;
                  }
                  case 'remove': {
                    text += node.text;

                    break;
                  }
                  case 'update': {
                    properties = {
                      ...properties,
                      ...data.properties,
                    };

                    newProperties = {
                      ...newProperties,
                      ...data.newProperties,
                    };

                    newText += node.text;

                    break;
                  }
                  // No default
                }
              }
            }
          );
        } else {
          const lineBreakData = api.suggestion.isBlockSuggestion(node)
            ? (
                node as unknown as {
                  suggestion?: {
                    id?: string;
                    type?: string;
                    isLineBreak?: boolean;
                  };
                }
              ).suggestion
            : undefined;

          if (lineBreakData?.id === keyId2SuggestionId(id)) {
            if (lineBreakData.type === 'insert') {
              newText += lineBreakData.isLineBreak
                ? BLOCK_SUGGESTION
                : BLOCK_SUGGESTION +
                  (ElementApi.isElement(node) ? describeBlock(node) : '');
            } else if (lineBreakData.type === 'remove') {
              text += lineBreakData.isLineBreak
                ? BLOCK_SUGGESTION
                : BLOCK_SUGGESTION +
                  (ElementApi.isElement(node) ? describeBlock(node) : '');
            }
          }
        }
      });

      if (entries.length === 0) return;

      const nodeData = api.suggestion.suggestionData(entries[0][0]);

      if (!nodeData) return;

      const comments =
        discussions.find((s: TDiscussion) => s.id === id)?.comments || [];
      const createdAt = new Date(nodeData.createdAt);

      const keyId = getSuggestionKey(id);

      if (nodeData.type === 'update') {
        res.push({
          comments,
          createdAt,
          keyId,
          newProperties,
          newText,
          properties,
          suggestionId: keyId2SuggestionId(id),
          type: 'update',
          userId: nodeData.userId,
        });
      } else if (newText.length > 0 && text.length > 0) {
        res.push({
          comments,
          createdAt,
          keyId,
          newText,
          suggestionId: keyId2SuggestionId(id),
          text,
          type: 'replace',
          userId: nodeData.userId,
        });
      } else if (newText.length > 0) {
        res.push({
          comments,
          createdAt,
          keyId,
          newText,
          suggestionId: keyId2SuggestionId(id),
          type: 'insert',
          userId: nodeData.userId,
        });
      } else if (text.length > 0) {
        res.push({
          comments,
          createdAt,
          keyId,
          suggestionId: keyId2SuggestionId(id),
          text,
          type: 'remove',
          userId: nodeData.userId,
        });
      }
    });

    return res;
  }, [api.suggestion, blockPath, discussions, editor.api, suggestionNodes]);

  return resolvedSuggestion;
};

export const isResolvedSuggestion = (
  suggestion: ResolvedSuggestion | TDiscussion
): suggestion is ResolvedSuggestion => 'suggestionId' in suggestion;
