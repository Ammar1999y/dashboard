'use client';

import type { Value } from 'platejs';

import { memo, useEffect } from 'react';

import { KEYS } from 'platejs';
import { createPlatePlugin, useEditorRef } from 'platejs/react';
import { useSession } from '@/lib/auth/use-session';

import { UNKNOWN_USER_NAME } from '@/components/editor/labels';
import { BlockDiscussion } from '@/components/editor/ui/block-discussion';

export type TComment = {
  id: string;
  contentRich: Value;
  createdAt: Date;
  discussionId: string;
  isEdited: boolean;
  userId: string;
};

export type TDiscussion = {
  id: string;
  comments: TComment[];
  createdAt: Date;
  isResolved: boolean;
  userId: string;
  documentContent?: string;
};

export type TDiscussionUser = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

/** Stands in for the author until the session resolves. */
const ANONYMOUS_USER: TDiscussionUser = {
  id: 'anonymous',
  name: UNKNOWN_USER_NAME,
};

/**
 * Threads live in this plugin's options only: there is no discussions API yet,
 * so they are gone on reload while the comment marks stay in the document.
 */
export const discussionPlugin = createPlatePlugin({
  key: 'discussion',
  options: {
    currentUserId: ANONYMOUS_USER.id,
    discussions: [] as TDiscussion[],
    users: { [ANONYMOUS_USER.id]: ANONYMOUS_USER } as Record<
      string,
      TDiscussionUser
    >,
  },
})
  .configure({
    render: { aboveNodes: BlockDiscussion },
  })
  .extendSelectors(({ getOption }) => ({
    currentUser: (): TDiscussionUser =>
      getOption('users')[getOption('currentUserId')] ?? ANONYMOUS_USER,
    user: (id: string): TDiscussionUser | undefined => getOption('users')[id],
  }));

export const DiscussionKit = [discussionPlugin];

/** Makes the signed-in user the author of new comments and suggestions. */
export const CurrentUserSync = memo(() => {
  const editor = useEditorRef();
  const user = useSession().data?.user;
  const id = user?.id;
  const name = user?.name;
  const image = user?.image;

  useEffect(() => {
    if (!id) return;
    editor.setOption(discussionPlugin, 'users', {
      ...editor.getOption(discussionPlugin, 'users'),
      [id]: { id, name: name || UNKNOWN_USER_NAME, avatarUrl: image },
    });
    editor.setOption(discussionPlugin, 'currentUserId', id);
    editor.setOption({ key: KEYS.suggestion }, 'currentUserId', id);
  }, [editor, id, name, image]);

  return null;
});
CurrentUserSync.displayName = 'CurrentUserSync';
