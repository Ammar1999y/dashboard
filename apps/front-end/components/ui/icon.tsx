import type { IconName } from '@/lib/icon-names.generated';
import type { IconProps as IconifyProps } from '@iconify/react';

import { memo, useId } from 'react';

import { Icon as IconifyIcon } from '@iconify/react';

// No `strokeWidth`: Iconify bodies set it on inner elements, where a root
// attribute cannot reach. Use a child selector such as `[&_*]:stroke-[3]`.
export type IconProps = Omit<IconifyProps, 'icon' | 'strokeWidth'> & {
  icon: IconName;
};

// `ssr`: every icon is registered before the first render (see
// scripts/build-icons.ts), so it can draw on the server instead of an empty
// span until mount. `useId`: Iconify's own id fallback is a global counter that
// differs between server and client. The 24px default is lucide's, which
// `size-*` classes and `[&_svg]` rules override.
export const Icon = memo(({ width, height, id, ...props }: IconProps) => {
  const autoId = useId();
  return (
    <IconifyIcon
      ssr
      id={id ?? autoId}
      width={width ?? height ?? 24}
      height={height ?? width ?? 24}
      {...props}
    />
  );
});
Icon.displayName = 'Icon';

export { type IconName } from '@/lib/icon-names.generated';
