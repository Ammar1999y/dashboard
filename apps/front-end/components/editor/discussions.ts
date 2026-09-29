import type { TComment, TDiscussion } from './plugins/discussion-kit';
import type { Value } from 'platejs';
import type { PlateEditor } from 'platejs/react';

import { nanoid } from 'platejs';

import { discussionPlugin } from './plugins/discussion-kit';

const read = (editor: PlateEditor) =>
  editor.getOption(discussionPlugin, 'discussions');

const write = (editor: PlateEditor, discussions: TDiscussion[]) =>
  editor.setOption(discussionPlugin, 'discussions', discussions);

const mapDiscussion = (
  editor: PlateEditor,
  id: string,
  update: (discussion: TDiscussion) => TDiscussion
) =>
  write(
    editor,
    read(editor).map((discussion) =>
      discussion.id === id ? update(discussion) : discussion
    )
  );

const newComment = (
  editor: PlateEditor,
  discussionId: string,
  contentRich: Value
): TComment => ({
  id: nanoid(),
  contentRich,
  createdAt: new Date(),
  discussionId,
  isEdited: false,
  userId: editor.getOption(discussionPlugin, 'currentUserId'),
});

const findDiscussion = (editor: PlateEditor, id: string) =>
  read(editor).find((discussion) => discussion.id === id);

/** Starts a thread, or replies to it when it already exists. */
export function addComment(
  editor: PlateEditor,
  discussionId: string,
  contentRich: Value,
  documentContent?: string
) {
  const comment = newComment(editor, discussionId, contentRich);
  if (findDiscussion(editor, discussionId)) {
    mapDiscussion(editor, discussionId, (discussion) => ({
      ...discussion,
      comments: [...discussion.comments, comment],
    }));
    return;
  }
  write(editor, [
    ...read(editor),
    {
      id: discussionId,
      comments: [comment],
      createdAt: comment.createdAt,
      documentContent,
      isResolved: false,
      userId: comment.userId,
    },
  ]);
}

export const updateComment = (
  editor: PlateEditor,
  { discussionId, id }: TComment,
  contentRich: Value
) =>
  mapDiscussion(editor, discussionId, (discussion) => ({
    ...discussion,
    comments: discussion.comments.map((comment) =>
      comment.id === id ? { ...comment, contentRich, isEdited: true } : comment
    ),
  }));

export const removeComment = (
  editor: PlateEditor,
  { discussionId, id }: TComment
) =>
  mapDiscussion(editor, discussionId, (discussion) => ({
    ...discussion,
    comments: discussion.comments.filter((comment) => comment.id !== id),
  }));

export const resolveDiscussion = (editor: PlateEditor, id: string) =>
  mapDiscussion(editor, id, (discussion) => ({
    ...discussion,
    isResolved: true,
  }));

export const removeDiscussion = (editor: PlateEditor, id: string) =>
  write(
    editor,
    read(editor).filter((discussion) => discussion.id !== id)
  );
