import type { TResolvedSuggestion } from '@platejs/suggestion';
import type { SlateEditor, TCommentText, Value } from 'platejs';

import {
  getCommentKeys,
  getDraftCommentKey,
  getTransientCommentKey,
} from '@platejs/comment';
import {
  BaseSuggestionPlugin,
  getInlineSuggestionData,
  getSuggestionKey,
  getSuggestionKeys,
  keyId2SuggestionId,
  rejectSuggestion,
} from '@platejs/suggestion';
import { createSlateEditor, ElementApi, KEYS, TextApi } from 'platejs';

import { readDate } from './date';
import { createBaseEditorKit } from './editor-base-kit';

function pendingSuggestionIds(editor: SlateEditor) {
  const api = editor.getApi(BaseSuggestionPlugin).suggestion;
  const ids = new Set<string>();
  const nodes = editor.api.nodes({ at: [], mode: 'all' });
  for (const [node] of nodes) {
    if (TextApi.isText(node)) {
      for (const key of getSuggestionKeys(node)) {
        ids.add(keyId2SuggestionId(key));
      }
    } else if (ElementApi.isElement(node)) {
      const data = editor.api.isInline(node)
        ? getInlineSuggestionData(node)
        : api.isBlockSuggestion(node)
          ? node.suggestion
          : undefined;
      if (data) ids.add(data.id);
    }
  }
  return ids;
}

function rejectPendingSuggestions(editor: SlateEditor) {
  for (const id of pendingSuggestionIds(editor)) {
    // `rejectSuggestion` reads only `keyId` and `suggestionId`; the rest is
    // what its type requires.
    const description: TResolvedSuggestion = {
      createdAt: new Date(0),
      keyId: getSuggestionKey(id),
      suggestionId: id,
      type: 'insert',
      userId: '',
    };
    rejectSuggestion(editor, description);
  }
}

function removeComments(editor: SlateEditor) {
  const entries = [
    ...editor.api.nodes<TCommentText>({ at: [], match: TextApi.isText }),
  ];
  editor.tf.withoutNormalizing(() => {
    for (const [node, path] of entries) {
      const keys = getCommentKeys(node);
      if (keys.length === 0 && !node[KEYS.comment]) continue;
      editor.tf.unsetNodes(
        [...keys, KEYS.comment, getDraftCommentKey(), getTransientCommentKey()],
        { at: path }
      );
    }
  });
}

const EQUATION_TYPES = new Set<string>([KEYS.equation, KEYS.inlineEquation]);

/** A node that only asks the author to fill it in: its prompt is editor chrome. */
const isUnfilled = (node: unknown) => {
  if (!ElementApi.isElement(node)) return false;
  if (EQUATION_TYPES.has(node.type)) {
    return (
      typeof node.texExpression !== 'string' || node.texExpression.trim() === ''
    );
  }
  return node.type === KEYS.date && readDate(node.date) === null;
};

const removeUnfilled = (editor: SlateEditor) =>
  editor.tf.removeNodes({ at: [], match: isUnfilled, mode: 'all' });

/**
 * The document as readers outside the dashboard see it: comments and pending
 * suggestions are the editors' own discussion, so every suggestion is
 * rejected (an insertion is dropped, a removal stays as plain text) and every
 * comment mark is removed; a node still waiting to be filled in is dropped.
 * Static views and every export render from this.
 */
export function createPublishedEditor(value: Value) {
  const editor = createSlateEditor({ plugins: createBaseEditorKit(), value });
  rejectPendingSuggestions(editor);
  removeComments(editor);
  removeUnfilled(editor);
  return editor;
}
