# Theme presets

`presets.ts` is the theme registry used by the existing picker.

Refresh it with the 20 most popular community themes:

```sh
bun run themes:sync
```

The command updates a matching preset by ID, name or label (ignoring case and
surrounding whitespace), preserving its existing ID and any omitted style
tokens. Themes without a match are added. Review and commit the resulting
changes to `presets.ts`.

Every preset then gets the contrast fixes of `scripts/lib/theme-contrast.ts`,
the pairs `scripts/lib/theme-contrast.test.ts` enforces: a color read as text moves
its OKLCH lightness until it reaches 4.5:1, and a `*-foreground` that fails on
its fill becomes the theme's dark or light text color. A preset no fix can
make readable is dropped and named in the output; no other theme is removed.
`bun run themes:sync --offline` applies the fixes to the stored registry
alone, after a change to the rules or the default theme.

`primary` is the brand fill and never moves. Three keys are derived from it in
each mode and written to every preset; the default theme declares its derived
values in `constants/theme.ts`, and the test fails when either drifts:

- `primary-ink`, what `text-primary` paints (and `fill-`, `caret-`,
  `decoration-primary-ink` where primary marks text or an icon): `primary`
  moved the least OKLCH lightness that reads at 4.5:1 on the page surfaces and
  on `primary` tints.
- `primary-light` and `primary-dark`, interaction shades (`bg-primary-light`,
  `bg-primary-dark`): `primary` 0.11 OKLCH lightness lighter or darker, less
  where `primary-foreground` would stop reading on the shade.

Filled buttons hover on `primary-dark`, `secondary-hover` or
`destructive-hover`; linked secondary and destructive badges use the same
hover shades. The latter two are derived from their fills by the same rule.
These fills stay opaque: a translucent fill can cross the contrast threshold
on its surrounding surface even when the solid fill passes.

The command discovers tweakcn's `getCommunityThemes` Server Action from its
public community page. This is an internal upstream protocol. A failed fetch,
unexpected response, or invalid style stops the command before replacing the
registry. The app uses only the bundled presets and makes no runtime requests
to tweakcn. Modern colors are converted to sRGB during import for the app's
existing theme tokens and browser targets.
