# Media manager concepts

Open `index.html` directly in a browser to compare the three designs. No install, build, server or login is needed. The same files are available at `/media-concepts/index.html` when your existing Next.js server is running.

| Concept               | Direction                                                                    |
| --------------------- | ---------------------------------------------------------------------------- |
| [Harbor](harbor.html) | Familiar sidebar, folder ribbon, balanced grid, persistent inspector         |
| [Studio](studio.html) | Warm editorial layout, top navigation, contact sheet, inspector drawer       |
| [Vault](vault.html)   | Dark workspace, nested folder navigator, compact cards, persistent inspector |

All three share an independent local model and interaction engine. They start in Arabic with an English toggle. No data or files are transmitted to the backend; refresh/reset returns to the sample data. Uploaded files remain local to the current page. The dashboard's existing components and routes have not been modified.

Try folder navigation, creation, rename, move and recursive deletion; file preview, download, rename, single-file publish/unpublish, multi-selection, Shift selection, marquee selection, dragging selected files onto a folder, bulk move/delete, search/filter/sort, and dropping local files into an open folder. Right-click cards for actions. Use Ctrl/Command K for search, Ctrl/Command A for selection, F2 to rename one selected file, Escape to clear, Delete for confirmation, and arrow keys to navigate cards.

Selections are capped at 50 files. Root holds folders only. Uploads start private. This demo accepts prepared PNG/WebP/SVG files and PDF/DOCX/XLSX documents within server input-size limits; it does not run the production image-preparation, SVG-sanitization or document-inspection pipeline. Actual integration should retain that existing pipeline, including JPEG/HEIC conversions and rate-limit retries.

Samples are original SVG illustrations and generated one-page PDFs. Displayed sample byte sizes are illustrative metadata. Uploading an actual supported file lets you test local preview/download with that file's real content. Documents show type artwork and a download action, since the backend serves them as attachments. There are no fake sharing, trash, favorite or storage-quota controls. The unfiled view is deliberately empty and explains its dormant backend registry.

[Backend audit](BACKEND-CAPABILITIES.md) describes exact APIs, permissions, formats, limits, lifecycle behavior, missing features and the integration map.

Validation: `node public/media-concepts/verify.cjs --require-all` from the frontend directory. The check covers mutation atomicity, eligibility and bounds plus structural HTML contracts. Syntax checks use `node --check`. These checks do not establish browser appearance, browser interaction or live API connectivity; no application UI test was run under the repository instructions.
