import { memo } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export const UserAvatar = memo(
  ({
    name,
    image,
    className,
  }: {
    name: string;
    image?: string | null;
    className: string;
  }) => (
    <Avatar className={className}>
      {image && <AvatarImage src={image} alt='' />}
      <AvatarFallback>{name.trim().charAt(0)}</AvatarFallback>
    </Avatar>
  )
);
UserAvatar.displayName = 'UserAvatar';
