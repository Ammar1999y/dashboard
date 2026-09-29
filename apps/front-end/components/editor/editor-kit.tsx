'use client';

import { TrailingBlockPlugin } from 'platejs';

import { AlignKit } from './plugins/align-kit';
import { AutoformatKit } from './plugins/autoformat-kit';
import { BasicBlocksKit } from './plugins/basic-blocks-kit';
import { BasicMarksKit } from './plugins/basic-marks-kit';
import { BlockMenuKit } from './plugins/block-menu-kit';
import { BlockPlaceholderKit } from './plugins/block-placeholder-kit';
import { CalloutKit } from './plugins/callout-kit';
import { CodeBlockKit } from './plugins/code-block-kit';
import { ColumnKit } from './plugins/column-kit';
import { CommentKit } from './plugins/comment-kit';
import { DateKit } from './plugins/date-kit';
import { DirKit } from './plugins/dir-kit';
import { DiscussionKit } from './plugins/discussion-kit';
import { DndKit } from './plugins/dnd-kit';
import { DocxKit } from './plugins/docx-kit';
import { EmojiKit } from './plugins/emoji-kit';
import { ExitBreakKit } from './plugins/exit-break-kit';
import { FixedToolbarKit } from './plugins/fixed-toolbar-kit';
import { FloatingToolbarKit } from './plugins/floating-toolbar-kit';
import { FontKit } from './plugins/font-kit';
import { LineHeightKit } from './plugins/line-height-kit';
import { LinkKit } from './plugins/link-kit';
import { ListKit } from './plugins/list-kit';
import { MarkdownKit } from './plugins/markdown-kit';
import { MathKit } from './plugins/math-kit';
import { MediaKit } from './plugins/media-kit';
import { SlashKit } from './plugins/slash-kit';
import { SuggestionKit } from './plugins/suggestion-kit';
import { TableKit } from './plugins/table-kit';
import { TocKit } from './plugins/toc-kit';
import { ToggleKit } from './plugins/toggle-kit';

const EDITOR_KIT = [
  ...BasicBlocksKit,
  ...CodeBlockKit,
  ...TableKit,
  ...ToggleKit,
  ...TocKit,
  ...MediaKit,
  ...CalloutKit,
  ...ColumnKit,
  ...MathKit,
  ...DateKit,
  ...LinkKit,
  ...BasicMarksKit,
  ...FontKit,
  ...ListKit,
  ...AlignKit,
  ...DirKit,
  ...LineHeightKit,
  ...DiscussionKit,
  ...CommentKit,
  ...SuggestionKit,
  ...SlashKit,
  ...AutoformatKit,
  ...BlockMenuKit,
  ...DndKit,
  ...EmojiKit,
  ...ExitBreakKit,
  TrailingBlockPlugin,
  ...DocxKit,
  ...MarkdownKit,
  ...BlockPlaceholderKit,
  ...FixedToolbarKit,
  ...FloatingToolbarKit,
];

// Plate splices a plugin that overrides a core one (the paragraph) out of the
// array an editor is created with, so each editor needs its own copy.
export const createEditorKit = () => [...EDITOR_KIT];
