'use client';

import type {
  TComment,
  TDiscussionUser,
} from '@/components/editor/plugins/discussion-kit';
import type { Value } from 'platejs';

import * as React from 'react';

import { getCommentKey, getDraftCommentKey } from '@platejs/comment';
import { CommentPlugin, useCommentId } from '@platejs/comment/react';
import { KEYS, nanoid, NodeApi } from 'platejs';
import {
  Plate,
  useEditorPlugin,
  useEditorRef,
  usePlateEditor,
  usePluginOption,
} from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { formatCommentDate } from '@/components/editor/date';
import {
  addComment,
  removeComment,
  removeDiscussion,
  resolveDiscussion,
  updateComment,
} from '@/components/editor/discussions';
import { UNKNOWN_USER_NAME } from '@/components/editor/labels';
import { BasicMarksKit } from '@/components/editor/plugins/basic-marks-kit';
import { discussionPlugin } from '@/components/editor/plugins/discussion-kit';
import { UserAvatar } from '@/components/shared/user-avatar';

import { Editor, EditorContainer } from './editor';

/** The avatar, name and age line that heads a comment or a suggestion. */
export function AuthorLine({
  user,
  createdAt,
  edited = false,
  actions,
}: {
  user: TDiscussionUser | undefined;
  createdAt: Date;
  edited?: boolean;
  actions?: React.ReactNode;
}) {
  const name = user?.name ?? UNKNOWN_USER_NAME;

  return (
    <div className='relative flex items-center'>
      <UserAvatar name={name} image={user?.avatarUrl} className='size-5' />
      <h4 className='mx-2 text-sm font-semibold leading-none'>{name}</h4>
      <div className='text-xs leading-none text-muted-foreground/80'>
        <span className='me-1'>{formatCommentDate(createdAt)}</span>
        {edited && <span>(معدل)</span>}
      </div>
      {actions && (
        <div className='absolute top-0 flex gap-1 ltr:right-0 rtl:left-0'>
          {actions}
        </div>
      )}
    </div>
  );
}

const useCommentEditor = (id: string, value: Value = []) =>
  usePlateEditor({ id, plugins: [...BasicMarksKit], value }, [value]);

export function Comment({
  comment,
  discussionLength,
  documentContent,
  editingId,
  index,
  setEditingId,
  showDocumentContent = false,
}: {
  comment: TComment;
  discussionLength: number;
  editingId: string | null;
  index: number;
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  documentContent?: string;
  showDocumentContent?: boolean;
}) {
  const editor = useEditorRef();
  const { tf } = useEditorPlugin(CommentPlugin);
  const userInfo = usePluginOption(discussionPlugin, 'user', comment.userId);
  const currentUserId = usePluginOption(discussionPlugin, 'currentUserId');
  const commentEditor = useCommentEditor(comment.id, comment.contentRich);

  const [hovering, setHovering] = React.useState(false);
  const [dropdownOpen, setDropdownOpen] = React.useState(false);

  const isMyComment = currentUserId === comment.userId;
  const isFirst = index === 0;
  const isLast = index === discussionLength - 1;
  const isEditing = editingId === comment.id;

  const onCancel = () => {
    setEditingId(null);
    commentEditor.tf.replaceNodes(comment.contentRich, {
      at: [],
      children: true,
    });
  };

  const onSave = () => {
    updateComment(editor, comment, commentEditor.children);
    setEditingId(null);
  };

  const onResolve = () => {
    resolveDiscussion(editor, comment.discussionId);
    tf.comment.unsetMark({ id: comment.discussionId });
  };

  const onRemove = () => {
    removeComment(editor, comment);
    if (discussionLength !== 1) return;
    tf.comment.unsetMark({ id: comment.discussionId });
    removeDiscussion(editor, comment.discussionId);
  };

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <AuthorLine
        user={userInfo}
        createdAt={new Date(comment.createdAt)}
        edited={comment.isEdited}
        actions={
          isMyComment &&
          (hovering || dropdownOpen) && (
            <>
              {isFirst && (
                <Button
                  className='h-6 p-1 text-muted-foreground'
                  onClick={onResolve}
                  type='button'
                  variant='ghost'
                  aria-label='حل النقاش'
                >
                  <Icon icon='solar:check-read-linear' className='size-4' />
                </Button>
              )}

              <CommentMoreDropdown
                dropdownOpen={dropdownOpen}
                onEdit={() => setEditingId(comment.id)}
                onEditClosed={() =>
                  setTimeout(
                    () => commentEditor.tf.focus({ edge: 'endEditor' }),
                    0
                  )
                }
                onRemove={onRemove}
                setDropdownOpen={setDropdownOpen}
              />
            </>
          )
        }
      />

      {isFirst && showDocumentContent && (
        <div className='relative mt-1 flex ps-8 text-sm'>
          {discussionLength > 1 && (
            <div className='absolute top-[5px] h-full w-0.5 shrink-0 bg-muted ltr:left-3 rtl:right-3' />
          )}
          <div className='my-px w-0.5 shrink-0 bg-highlight' />
          {documentContent && <div className='ms-2'>{documentContent}</div>}
        </div>
      )}

      <div className='relative my-1 ps-6'>
        {!isLast && (
          <div className='absolute top-0 h-full w-0.5 shrink-0 bg-muted ltr:left-3 rtl:right-3' />
        )}
        <Plate editor={commentEditor} readOnly={!isEditing}>
          <EditorContainer variant={isEditing ? 'commentField' : 'comment'}>
            <Editor variant='comment' />

            {isEditing && (
              <div className='flex shrink-0 gap-1'>
                <CommentActionButton
                  icon='solar:close-linear'
                  label='إلغاء'
                  onClick={onCancel}
                  tone='muted'
                />
                <CommentActionButton
                  icon='solar:check-read-linear'
                  label='حفظ'
                  onClick={onSave}
                  tone='primary'
                />
              </div>
            )}
          </EditorContainer>
        </Plate>
      </div>
    </div>
  );
}

function CommentActionButton({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: 'solar:close-linear' | 'solar:check-read-linear';
  label: string;
  onClick: () => void;
  tone: 'muted' | 'primary';
}) {
  return (
    <Button
      aria-label={label}
      className='size-7'
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      size='icon'
      variant='ghost'
    >
      <div
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          tone === 'primary' ? 'bg-primary' : 'bg-primary/40'
        )}
      >
        <Icon
          icon={icon}
          className='size-3 text-background [&_*]:stroke-[3px]'
        />
      </div>
    </Button>
  );
}

function CommentMoreDropdown({
  dropdownOpen,
  onEdit,
  onEditClosed,
  onRemove,
  setDropdownOpen,
}: {
  dropdownOpen: boolean;
  onEdit: () => void;
  onEditClosed: () => void;
  onRemove: () => void;
  setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const editSelected = React.useRef(false);

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={setDropdownOpen}
      open={dropdownOpen}
    >
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button
          aria-label='خيارات التعليق'
          className='h-6 p-1 text-muted-foreground'
          variant='ghost'
        >
          <Icon icon='solar:menu-dots-bold' className='size-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className='w-48'
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!editSelected.current) return;
          editSelected.current = false;
          onEditClosed();
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              editSelected.current = true;
              onEdit();
            }}
          >
            <Icon icon='solar:pen-new-square-linear' className='size-4' />
            تعديل التعليق
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRemove}>
            <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
            حذف التعليق
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CommentCreateForm({
  autoFocus = false,
  className,
  discussionId: discussionIdProp,
  focusOnMount = false,
}: {
  autoFocus?: boolean;
  className?: string;
  discussionId?: string;
  focusOnMount?: boolean;
}) {
  const editor = useEditorRef();
  const commentId = useCommentId();
  const discussionId = discussionIdProp ?? commentId;
  const discussions = usePluginOption(discussionPlugin, 'discussions');
  const userInfo = usePluginOption(discussionPlugin, 'currentUser');
  const formId = React.useId();
  const commentEditor = useCommentEditor(formId);
  const [commentValue, setCommentValue] = React.useState<Value>();

  const commentContent = React.useMemo(
    () =>
      commentValue
        ? NodeApi.string({ children: commentValue, type: KEYS.p })
        : '',
    [commentValue]
  );

  React.useEffect(() => {
    if (focusOnMount) commentEditor.tf.focus();
  }, [commentEditor, focusOnMount]);

  const isReply =
    !!discussionId &&
    discussions.some((d) => d.id === discussionId && d.comments.length > 0);

  const onAddComment = React.useCallback(() => {
    if (!commentValue || commentContent.trim().length === 0) return;
    commentEditor.tf.reset();

    if (discussionId) {
      addComment(editor, discussionId, commentValue);
      return;
    }

    const drafts = editor
      .getApi(CommentPlugin)
      .comment.nodes({ at: [], isDraft: true });
    if (drafts.length === 0) return;

    const id = nanoid();
    addComment(
      editor,
      id,
      commentValue,
      drafts.map(([node]) => node.text).join('')
    );
    for (const [, path] of drafts) {
      editor.tf.setNodes(
        { [getCommentKey(id)]: true },
        { at: path, split: true }
      );
      editor.tf.unsetNodes([getDraftCommentKey()], { at: path });
    }
  }, [commentContent, commentEditor.tf, commentValue, discussionId, editor]);

  return (
    <div className={cn('flex w-full items-center gap-2', className)}>
      <div className='shrink-0'>
        <UserAvatar
          name={userInfo.name}
          image={userInfo.avatarUrl}
          className='size-5'
        />
      </div>

      <div className='min-w-0 grow'>
        <Plate
          editor={commentEditor}
          onChange={({ value }) => setCommentValue(value)}
        >
          <EditorContainer variant='commentField'>
            <Editor
              autoComplete='off'
              autoFocus={autoFocus}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                onAddComment();
              }}
              placeholder={isReply ? 'رد...' : 'إضافة تعليق'}
              variant='comment'
            />

            <Button
              aria-label='إرسال'
              className='size-7'
              disabled={commentContent.trim().length === 0}
              onClick={(event) => {
                event.stopPropagation();
                onAddComment();
              }}
              size='icon'
              variant='ghost'
            >
              <Icon icon='solar:arrow-up-linear' className='size-4' />
            </Button>
          </EditorContainer>
        </Plate>
      </div>
    </div>
  );
}
