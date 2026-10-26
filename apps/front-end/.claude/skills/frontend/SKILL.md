---
name: frontend
description: >
  High-performance React component architecture and optimization standards.
  Use this skill whenever building, modifying, or reviewing React components,
  custom hooks, Zustand stores, or frontend logic. Triggers on: React components,
  state management, useCallback, useMemo, memo, re-render optimization,
  component splitting, container/presentational pattern, Zustand selectors,
  Tailwind styling, framer-motion animations, or frontend file organization.
  Apply these rules for any React/Next.js component work, even single-component changes.
---

Optimize where it pays. Every abstraction, memo, store, or lazy boundary must
earn its complexity with a real gain in performance, maintainability, or
readability — when a simpler structure does the same job, ship the simpler one.

## Architecture

### Single Responsibility

One purpose per unit:

- **UI components**: presentation only
- **Container components**: logic / data fetching
- **Custom hooks**: reusable logic
- **Utility functions**: pure computation

### Container / Presentational

Separate fetching from rendering when the view is reused with different data, or
when the gating is itself logic worth reading on its own. Otherwise one component: applied as
a default this pattern doubles the file count for a view that has one consumer.

```typescript
// Worth it: the view is rendered from two different sources
function UserListContainer() {
  const { data, isLoading } = useQuery({...});
  return <UserListView data={data} isLoading={isLoading} />;
}

function UserListView({ data, isLoading }) {
  if (isLoading) return <Skeleton />;
  return <ul>{data.map(...)}</ul>;
}
```

### Component size

Split when the split earns it: a part that is reused, a part that should memoize
against its own props, or a part with a life of its own (its own state, its own
query). Length is a prompt to look, never the reason — one component that reads
top to bottom beats four files that exist only to be shorter.

### File organization

```
types/               # shared, cross-feature types
components/
├── ui/              # primitives, no app-state imports
├── shared/          # cross-feature components
└── [feature]/       # one folder per feature
    ├── index.tsx    # the feature
    ├── [part].tsx   # its named parts
    ├── store.ts     # its store
    └── types.ts     # feature-internal types
```

- **File names**: always `kebab-case`.
- **Types location**: root `types/` is for API payloads and cross-cutting app types. A type tied to one component or feature stays with it.
- **Where a thing lives is decided by what it imports, not by what it is called.** A helper that reaches into app services is not a pure utility, and anything importing `components/` is neither. Keep that direction one-way and lint it.

The concrete folders — which root directories exist and what each may import — are per-project. See the project's own layout skill.

---

## State (Zustand)

Prefer Zustand over React Context for any non-trivial shared state. Context re-renders every consumer on every change; Zustand subscribes per-slice.

### Atomic selectors

Select the smallest slice. `useShallow` is only for selectors that build a new
object/array on each call — wrapping a primitive (or an already-stable reference
like a Zustand `actions` object) in it is useless indirection. For those selectors
it is mandatory, not optional. To re-render only on a specific condition, compute
it inside the selector and return the primitive result. No `useShallow` needed.

```typescript
import { useShallow } from 'zustand/shallow';

// GOOD — primitive: plain selector, Object.is bail-out is enough
const count = useStore((s) => s.count);

// GOOD — derive the check inside the selector: re-renders only when the boolean flips,
// not on every change to s.user
const isBob = useStore((s) => s.user.name === 'Bob');

// GOOD — selector builds a new object: useShallow stops needless re-renders
const { name, role } = useStore(
  useShallow((s) => ({ name: s.name, role: s.role }))
);

// GOOD — selector builds a new array (map/filter/slice/Object.keys/[a, b]): useShallow required
const activeIds = useStore(
  useShallow((s) => s.items.filter((i) => i.active).map((i) => i.id))
);

// BAD — no selector: re-renders on any state change
const { count } = useStore();

// BAD — useShallow around a primitive (incl. a derived boolean): overhead, zero benefit
const count = useStore(useShallow((s) => s.count));
const isBob = useStore(useShallow((s) => s.user.name === 'Bob'));

// BAD — new object/array without useShallow: new reference every call → re-renders on every store update
const ids = useStore((s) => s.items.map((i) => i.id));
```

### `getState()` in callbacks

When you need store state (and/or its setter) only inside an event handler — not for rendering — read it via `getState()` so the component doesn't subscribe and won't re-render when it changes. Keeps deps empty.

```typescript
// GOOD — no subscription, no re-renders, no deps
const handleUpdate = useCallback((layout: string) => {
  const settings = useSettingStore.getState().settings;
  const setSettings = useSettingStore.getState().actions.setSettings;
  setSettings({ ...settings, layout });
}, []);

// BAD — subscribes + creates dep
const handleUpdate = useCallback(
  (layout: string) => {
    setSettings({ ...settings, layout });
  },
  [settings, setSettings]
);
```

### Localize state to the smallest leaf

If a state value drives one input or one sub-tree only, it must live inside that sub-tree — not on the parent.

```typescript
// BAD — whole screen re-renders on each toggle
function LoginScreen() {
  const [show, setShow] = useState(false);
  return <input type={show ? 'text' : 'password'} />;
}

// GOOD — only PasswordInput re-renders
const PasswordInput = memo(() => {
  const [show, setShow] = useState(false);
  // ...
});
```

### Isolate frequently-updating state in a side-effect component

When a parent must react to fast-changing store state (e.g. fire a callback on change) but you don't want the parent's UI to re-render, put the subscription in a separate `memo`'d component that returns `null` and only runs the effect.

```typescript
// Subscribes; renders nothing
const ChangeHandler = memo(({ onDataChange }) => {
  const state = useStore((s) => s.state);
  useEffect(() => {
    onDataChange?.(state);
  }, [state, onDataChange]);
  return null;
});

// No subscription here — UI doesn't re-render when state changes
function MainComponent({ onDataChange }) {
  return (
    <>
      <ChangeHandler onDataChange={onDataChange} />
      <ActualUI />
    </>
  );
}
```

### SEO-critical content never comes from a client store

SSR/Next.js projects: anything crawlers must see has to be in the first HTML
response — render it from server data (SSG/SSR props, RSC) and pass it down as
props. A module-level Zustand store initializes with defaults on the server
(and is shared across requests), and state populated on the client arrives
only after hydration — either way the content is missing from the initial
HTML. Zustand is for client/UI state; crawlable content comes from the server.

---

## Memoization

Memoize when a component re-renders frequently with the same props, has expensive renders, or is a list item with stable data. Always add `displayName`.

```typescript
const MyComponent = memo(({ prop }: Props) => <div>{prop}</div>);
MyComponent.displayName = 'MyComponent';
```

### Memoize icons / third-party components used in hot paths

If a component or icon comes from an external library and renders inside a frequently-updating tree, wrap it in `memo` once at the import site (only when it doesn't take `children` / `ReactNode` props).

```typescript
import { Home as _Home } from 'lucide-react';

const Home = memo(_Home);
Home.displayName = 'Home';
```

### No inline functions/objects/arrays in JSX

```typescript
// BAD
<Button onClick={() => handle(id)} />
<Component style={{ color: 'red' }} />

// GOOD
const onClick = useCallback(() => handle(id), [id]);
const style = useMemo(() => ({ color: 'red' }), []);
```

Hoist truly static objects to module scope instead of `useMemo`.

### Don't `memo` components with `children` / `ReactNode` props

`memo`'s shallow compare always fails on `children` (new JSX every render). Move the wrapping into a children-less memoizable component:

```typescript
// BAD — memo is wasted
const BottomSheet = memo(({ children, isOpen, onClose }) => ...);

// GOOD
function BottomSheet({ children, isOpen, onClose }) { /* ... */ }

const AidSheet = memo(({ isOpen, onClose }: Props) => (
  <BottomSheet isOpen={isOpen} onClose={onClose}>
    <AidForm onSubmit={onClose} />
  </BottomSheet>
));
AidSheet.displayName = 'AidSheet';
```

Same rule for any prop typed `ReactNode` (`footer`, `header`, etc.).

### Don't extract a free function only to wrap it in `useCallback`

```typescript
// BAD — useless indirection
const handle = () => store.getState().actions.go();
const onClick = useCallback(handle, []);

// GOOD
const onClick = useCallback(() => store.getState().actions.go(), []);
```

Extract at module scope only when the body is reused, or genuinely too long inline.

### Code splitting

```typescript
const Heavy = lazy(() => import('./heavy'));
```

Use for route-level components, heavy non-critical components, conditional libs.

One lazy boundary per subtree. A component rendered only inside an already-lazy
parent is code-split with it — wrapping it in another `lazy()` adds a
chunk-request waterfall and a second fallback for zero bundle win. Editing the
contents of a lazy component never requires making those contents lazy too.

---

## Animations (framer-motion)

Always use `Variants`. Never inline `initial` / `animate` / `exit` / `transition`.

```typescript
import { motion, type Variants } from 'framer-motion';

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } },
};

<motion.div variants={fadeUp} initial="hidden" animate="show" />
```

For per-index delays use the function form + `custom`:

```typescript
const item: Variants = {
  hidden: { opacity: 0 },
  show: (i: number) => ({ opacity: 1, transition: { delay: i * 0.08 } }),
};

<motion.div custom={i} variants={item} initial="hidden" animate="show" />
```

`whileTap` / `whileHover` aren't variants — hoist the object as a module const.

Share common variants from one shared module (e.g. `lib/motion.ts`).

---

## Styling

### Design tokens, not magic values

Repeated visual values live once as tokens (CSS variables + Tailwind config);
components consume them. That is what makes theming and a global `--font-scale`
work.

- Colors: semantic tokens (`bg-background`, `border-border`). Raw palette only
  where the color deliberately ignores theming.
- Typography: always a scale step, never `text-[13px]`.
- Spacing, radius, shadows: the same. An arbitrary value is for a genuine
  one-off; needed twice, it becomes a token.
- Direction-dependent utilities must mirror. Whether that means logical
  utilities or `rtl:` / `ltr:` pairs depends on the project's browser targets —
  the project's layout skill decides.

Where lint enforces this, the error names the exact replacement; don't restate
the table here.

### CSS performance

- Use CSS `[data-*]` attributes for visibility/state instead of toggling state in React.
- Prefer CSS transitions over JS animations.
- Tailwind first; CSS Modules when Tailwind gets too verbose.
- Use inline `style` only when truly dynamic (values from API/state) — even then, hoist or `useMemo`, never literal in JSX.

### Class management

```typescript
import { cn } from '@/lib/utils';

<div className={cn('h-4 w-4 rounded', isActive ? 'bg-primary' : 'bg-gray-500', className)} />
```
