'use client';

import type { BlockTypeItem } from './block-types';
import type { NodeEntry, Path, SlateEditor, TElement } from 'platejs';
import type { PlateEditor } from 'platejs/react';

import { insertCallout } from '@platejs/callout';
import {
  insertCodeBlock,
  toggleCodeBlock,
  unwrapCodeBlock,
} from '@platejs/code-block';
import { insertDate } from '@platejs/date';
import { insertColumnGroup, toggleColumnGroup } from '@platejs/layout';
import { triggerFloatingLink } from '@platejs/link/react';
import { insertEquation, insertInlineEquation } from '@platejs/math';
import {
  insertAudioPlaceholder,
  insertFilePlaceholder,
  insertMedia,
  insertVideoPlaceholder,
} from '@platejs/media';
import { SuggestionPlugin } from '@platejs/suggestion/react';
import { TablePlugin } from '@platejs/table/react';
import { insertToc } from '@platejs/toc';
import { ElementApi, KEYS, PathApi } from 'platejs';

import { THREE_COLUMNS } from './block-types';

const insertList = (editor: PlateEditor, type: string) => {
  editor.tf.insertNodes(
    editor.api.create.block({
      indent: 1,
      listStyleType: type,
    }),
    { select: true }
  );
};

const insertBlockMap: Record<
  string,
  (editor: PlateEditor, type: string) => void
> = {
  [KEYS.listTodo]: insertList,
  [KEYS.ol]: insertList,
  [KEYS.ul]: insertList,
  [THREE_COLUMNS]: (editor) =>
    insertColumnGroup(editor, { columns: 3, select: true }),
  [KEYS.audio]: (editor) => insertAudioPlaceholder(editor, { select: true }),
  [KEYS.callout]: (editor) => insertCallout(editor, { select: true }),
  [KEYS.codeBlock]: (editor) => insertCodeBlock(editor, { select: true }),
  [KEYS.equation]: (editor) => insertEquation(editor, { select: true }),
  [KEYS.file]: (editor) => insertFilePlaceholder(editor, { select: true }),
  [KEYS.img]: (editor) =>
    insertMedia(editor, {
      select: true,
      type: KEYS.img,
    }),
  [KEYS.mediaEmbed]: (editor) =>
    insertMedia(editor, {
      select: true,
      type: KEYS.mediaEmbed,
    }),
  [KEYS.table]: (editor) =>
    editor.getTransforms(TablePlugin).insert.table({}, { select: true }),
  [KEYS.toc]: (editor) => insertToc(editor, { select: true }),
  [KEYS.video]: (editor) => insertVideoPlaceholder(editor, { select: true }),
};

const insertInlineMap: Record<
  string,
  (editor: PlateEditor, type: string) => void
> = {
  [KEYS.date]: (editor) => insertDate(editor, { select: true }),
  [KEYS.inlineEquation]: (editor) =>
    insertInlineEquation(editor, '', { select: true }),
  [KEYS.link]: (editor) => triggerFloatingLink(editor, { focused: true }),
};

type InsertBlockOptions = {
  upsert?: boolean;
};

const insertBlock = (
  editor: PlateEditor,
  type: string,
  options: InsertBlockOptions = {}
) => {
  const { upsert = false } = options;

  editor.tf.withoutNormalizing(() => {
    const block = editor.api.block();

    if (!block) return;

    const [currentNode, path] = block;
    const isCurrentBlockEmpty = editor.api.isEmpty(currentNode);
    const currentBlockType = getBlockType(currentNode);

    const isSameBlockType = type === currentBlockType;

    if (upsert && isCurrentBlockEmpty && isSameBlockType) {
      return;
    }

    if (type in insertBlockMap) {
      insertBlockMap[type](editor, type);
    } else {
      editor.tf.insertNodes(editor.api.create.block({ type }), {
        at: PathApi.next(path),
        select: true,
      });
    }

    if (!isSameBlockType) {
      editor.getApi(SuggestionPlugin).suggestion.withoutSuggestions(() => {
        editor.tf.removeNodes({ previousEmptyBlock: true });
      });
    }
  });
};

const insertInlineElement = (editor: PlateEditor, type: string) => {
  insertInlineMap[type]?.(editor, type);
};

/** Inserts a menu item: inline at the cursor, a block after the current one. */
export function insertItem(
  editor: PlateEditor,
  item: BlockTypeItem,
  options?: InsertBlockOptions
) {
  if (item.inline) insertInlineElement(editor, item.value);
  else insertBlock(editor, item.value, options);
}

const setList = (
  editor: PlateEditor,
  type: string,
  entry: NodeEntry<TElement>
) => {
  editor.tf.setNodes(
    editor.api.create.block({
      indent: 1,
      listStyleType: type,
    }),
    {
      at: entry[1],
    }
  );
};

const setBlockMap: Record<
  string,
  (editor: PlateEditor, type: string, entry: NodeEntry<TElement>) => void
> = {
  [KEYS.listTodo]: setList,
  [KEYS.ol]: setList,
  [KEYS.ul]: setList,
  [THREE_COLUMNS]: (editor) => toggleColumnGroup(editor, { columns: 3 }),
  [KEYS.codeBlock]: (editor) => toggleCodeBlock(editor),
};

export const setBlockType = (
  editor: PlateEditor,
  type: string,
  { at }: { at?: Path } = {}
) => {
  editor.tf.withoutNormalizing(() => {
    const setEntry = (entry: NodeEntry<TElement>) => {
      const [node, path] = entry;

      if (node[KEYS.listType]) {
        editor.tf.unsetNodes([KEYS.listType, 'indent'], { at: path });
      }
      if (type in setBlockMap) {
        return setBlockMap[type](editor, type, entry);
      }
      if (node.type !== type) {
        editor.tf.setNodes({ type }, { at: path });
      }
    };

    if (at) {
      const entry = editor.api.node<TElement>(at);

      if (entry) {
        setEntry(entry);

        return;
      }
    }

    const blocks = editor.api.blocks<TElement>({ mode: 'lowest' });
    for (const entry of blocks) setEntry(entry);
  });
};

export const getBlockType = (block: TElement) => {
  if (block[KEYS.listType]) {
    if (block[KEYS.listType] === KEYS.ol) {
      return KEYS.ol;
    }
    if (block[KEYS.listType] === KEYS.listTodo) {
      return KEYS.listTodo;
    }
    return KEYS.ul;
  }

  return block.type;
};

const RESET_TO_PARAGRAPH = new Set<string>([
  ...KEYS.heading,
  KEYS.blockquote,
  KEYS.callout,
]);

const BLOCK_FORMAT_PROPS = [
  'align',
  'dir',
  KEYS.lineHeight,
  KEYS.indent,
  KEYS.listType,
];

/** Marks and block formats off the selection; formatted blocks become paragraphs. */
export function clearFormatting(editor: SlateEditor) {
  editor.tf.removeMarks();
  // A code block holds code lines, so it is unwrapped rather than retyped.
  unwrapCodeBlock(editor);
  editor.tf.unsetNodes(BLOCK_FORMAT_PROPS, {
    match: (node) => ElementApi.isElement(node),
  });
  editor.tf.setNodes(
    { type: KEYS.p },
    {
      match: (node) =>
        ElementApi.isElement(node) && RESET_TO_PARAGRAPH.has(node.type),
    }
  );
}
