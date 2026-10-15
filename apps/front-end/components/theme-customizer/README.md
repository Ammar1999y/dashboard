# Theme presets

`presets.ts` is the theme registry used by the existing picker.

Refresh it with the 20 most popular community themes:

```sh
bun run themes:sync
```

The command updates a matching preset by ID, name or label (ignoring case and
surrounding whitespace), preserving its existing ID and any omitted style
tokens. Themes without a match are added. Existing themes are never removed.
Review and commit the resulting changes to `presets.ts`.

The command discovers tweakcn's `getCommunityThemes` Server Action from its
public community page. This is an internal upstream protocol. A failed fetch,
unexpected response, or invalid style stops the command before replacing the
registry. The app uses only the bundled presets and makes no runtime requests
to tweakcn. Modern colors are converted to sRGB during import for the app's
existing theme tokens and browser targets.
