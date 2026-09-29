'use client';

import type { BaseSuggestionConfig } from '@platejs/suggestion';
import type { ExtendConfig } from 'platejs';

import { BaseSuggestionPlugin } from '@platejs/suggestion';
import { isSlateEditor, isSlateString } from 'platejs';
import { toTPlatePlugin } from 'platejs/react';

import {
  SuggestionLeaf,
  SuggestionLineBreak,
} from '@/components/editor/ui/suggestion-node';

import { discussionPlugin } from './discussion-kit';

export type SuggestionConfig = ExtendConfig<
  BaseSuggestionConfig,
  {
    activeId: string | null;
    hoverId: string | null;
  }
>;

export const suggestionPlugin = toTPlatePlugin<SuggestionConfig>(
  BaseSuggestionPlugin,
  ({ editor }) => ({
    options: {
      activeId: null,
      currentUserId: editor.getOption(discussionPlugin, 'currentUserId'),
      hoverId: null,
    },
  })
).configure({
  handlers: {
    // unset active suggestion when clicking outside of suggestion
    onClick: ({ api, event, setOption, type }) => {
      let leaf = event.target as HTMLElement;
      let isSet = false;

      const isBlockLeaf = leaf.dataset.blockSuggestion === 'true';

      const unsetActiveSuggestion = () => {
        setOption('activeId', null);
        isSet = true;
      };

      if (!isBlockLeaf && !isSlateString(leaf)) {
        unsetActiveSuggestion();
      }

      while (leaf.parentElement && !isSlateEditor(leaf.parentElement)) {
        const isBlockSuggestion = leaf.dataset.blockSuggestion === 'true';

        if (isBlockSuggestion || leaf.classList.contains(`slate-${type}`)) {
          const suggestionEntry = api.suggestion?.node({
            isText: !isBlockSuggestion,
          });

          if (!suggestionEntry) {
            unsetActiveSuggestion();

            break;
          }

          const id = api.suggestion?.nodeId(suggestionEntry[0]);
          setOption('activeId', id ?? null);

          isSet = true;

          break;
        }

        leaf = leaf.parentElement;
      }

      if (!isSet) unsetActiveSuggestion();
    },
  },
  render: {
    belowNodes: SuggestionLineBreak,
    node: SuggestionLeaf,
  },
});

export const SuggestionKit = [suggestionPlugin];
