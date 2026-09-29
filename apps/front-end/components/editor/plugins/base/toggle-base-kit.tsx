import { BaseTogglePlugin } from '@platejs/toggle';

import {
  ToggleElementStatic,
  ToggleSwitchStatic,
  withEnclosingToggles,
} from '@/components/editor/ui/static/toggle-node-static';

export const BaseToggleKit = [
  BaseTogglePlugin.configure({
    inject: {
      isBlock: true,
      nodeProps: { transformProps: withEnclosingToggles },
    },
    render: { aboveNodes: ToggleSwitchStatic },
  }).withComponent(ToggleElementStatic),
];
