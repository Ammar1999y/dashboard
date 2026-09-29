'use client';

import type {
  AnyPluginConfig,
  TSuggestionData,
  TSuggestionText,
} from 'platejs';
import type { PlateLeafProps, RenderNodeWrapper } from 'platejs/react';

import * as React from 'react';

import { PlateLeaf, useEditorPlugin, usePluginOption } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';
import { suggestionPlugin } from '@/components/editor/plugins/suggestion-kit';
import { suggestionVariants } from '@/components/editor/styles';

export function SuggestionLeaf(props: PlateLeafProps<TSuggestionText>) {
  const { api, setOption } = useEditorPlugin(suggestionPlugin);
  const leaf = props.leaf;

  const leafId: string = api.suggestion.nodeId(leaf) ?? '';
  const activeSuggestionId = usePluginOption(suggestionPlugin, 'activeId');
  const hoverSuggestionId = usePluginOption(suggestionPlugin, 'hoverId');
  const dataList = api.suggestion.dataList(leaf);

  const hasRemove = dataList.some((data) => data.type === 'remove');
  const hasActive = dataList.some((data) => data.id === activeSuggestionId);
  const hasHover = dataList.some((data) => data.id === hoverSuggestionId);

  const diffOperation = { type: hasRemove ? 'delete' : 'insert' } as const;

  const Component = ({ delete: 'del', insert: 'ins', update: 'span' } as const)[
    diffOperation.type
  ];

  return (
    <PlateLeaf
      {...props}
      as={Component}
      attributes={{
        ...props.attributes,
        onMouseEnter: () => setOption('hoverId', leafId),
        onMouseLeave: () => setOption('hoverId', null),
      }}
      className={cn(
        suggestionVariants({
          active: hasActive || hasHover,
          remove: hasRemove,
        }),
        props.className
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}

export const SuggestionLineBreak: RenderNodeWrapper<AnyPluginConfig> = ({
  api,
  element,
}) => {
  if (!api.suggestion.isBlockSuggestion(element)) return;

  const suggestionData = element.suggestion as TSuggestionData;

  return function Component({ children }) {
    return (
      <SuggestionLineBreakContent suggestionData={suggestionData}>
        {children}
      </SuggestionLineBreakContent>
    );
  };
};

const LINE_BREAK_MARK_STYLE = { bottom: 3.5, height: 21 };

function SuggestionLineBreakContent({
  children,
  suggestionData,
}: {
  children: React.ReactNode;
  suggestionData: TSuggestionData;
}) {
  const activeSuggestionId = usePluginOption(suggestionPlugin, 'activeId');
  const hoverSuggestionId = usePluginOption(suggestionPlugin, 'hoverId');
  const { setOption } = useEditorPlugin(suggestionPlugin);

  const variant = suggestionVariants({
    active:
      activeSuggestionId === suggestionData.id ||
      hoverSuggestionId === suggestionData.id,
    remove: suggestionData.type === 'remove',
  });

  if (suggestionData.isLineBreak) {
    return (
      <>
        {children}
        <span
          className={cn('absolute text-justify', variant)}
          contentEditable={false}
          style={LINE_BREAK_MARK_STYLE}
        >
          <Icon icon='lucide:corner-down-left' className='mt-0.5 size-4' />
        </span>
      </>
    );
  }

  return (
    <div
      className={variant}
      data-block-suggestion='true'
      onMouseEnter={() => setOption('hoverId', suggestionData.id)}
      onMouseLeave={() => setOption('hoverId', null)}
    >
      {children}
    </div>
  );
}
