'use client';

import { memo, useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import {
  arrayMove,
  restrictToFirstScrollableAncestor,
  restrictToVerticalAxis,
  restrictToWindowEdges,
  SortableList,
  SortableListHandle,
  SortableListItem,
  verticalListSortingStrategy,
} from '.';

interface User {
  id: string;
  name: string;
  email: string;
}

const INITIAL_USERS: User[] = [
  { id: '1', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '2', name: 'سارة', email: 'sara@example.com' },
  { id: '3', name: 'محمد', email: 'mohammed@example.com' },
  { id: '4', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '5', name: 'سارة', email: 'sara@example.com' },
  { id: '6', name: 'محمد', email: 'mohammed@example.com' },
  { id: '7', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '8', name: 'سارة', email: 'sara@example.com' },
  { id: '9', name: 'محمد', email: 'mohammed@example.com' },
  { id: '10', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '11', name: 'سارة', email: 'sara@example.com' },
  { id: '12', name: 'محمد', email: 'mohammed@example.com' },
];

const MODIFIERS = [
  restrictToVerticalAxis,
  restrictToWindowEdges,
  restrictToFirstScrollableAncestor,
];

const getUserId = (user: User) => user.id;

export function SortableListExample() {
  const [users, setUsers] = useState(INITIAL_USERS);

  const handleMove = useCallback(
    (from: number, to: number) => setUsers((prev) => arrayMove(prev, from, to)),
    []
  );

  const handleRemove = useCallback(
    (id: string) => setUsers((prev) => prev.filter((user) => user.id !== id)),
    []
  );

  const renderOverlay = useCallback(
    (user: User) => <UserCard user={user} />,
    []
  );

  return (
    <SortableList
      items={users}
      getId={getUserId}
      onMove={handleMove}
      modifiers={MODIFIERS}
      strategy={verticalListSortingStrategy}
      renderOverlay={renderOverlay}
    >
      <div className='flex flex-col gap-2 p-5'>
        {users.map((user) => (
          <SortableListItem key={user.id} id={user.id}>
            <UserCard user={user} onRemove={handleRemove} />
          </SortableListItem>
        ))}
      </div>
    </SortableList>
  );
}

interface UserCardProps {
  user: User;
  /** Absent on the drag overlay copy. */
  onRemove?: (id: string) => void;
}

const UserCard = memo(({ user, onRemove }: UserCardProps) => {
  const handleRemove = useCallback(
    () => onRemove?.(user.id),
    [onRemove, user.id]
  );

  return (
    <div className='flex items-center gap-3 rounded-md border bg-muted p-4'>
      <SortableListHandle asChild>
        <Button variant='ghost' size='icon' aria-label='سحب لإعادة الترتيب'>
          <Icon
            icon='solar:grip-vertical-linear'
            className='size-5 text-muted-foreground'
          />
        </Button>
      </SortableListHandle>
      <div className='flex-1'>
        <p>{user.name}</p>
        <p className='text-sm text-muted-foreground'>{user.email}</p>
      </div>
      {onRemove && (
        <Button
          variant='destructiveGhost'
          size='icon'
          aria-label='حذف'
          onClick={handleRemove}
        >
          <Icon icon='solar:trash-bin-trash-linear' className='size-5' />
        </Button>
      )}
    </div>
  );
});

UserCard.displayName = 'UserCard';
