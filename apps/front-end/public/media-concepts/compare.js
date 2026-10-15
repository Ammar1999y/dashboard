(() => {
  'use strict';
  const english = {
    badge: 'Local prototypes · sample data',
    eyebrow: 'THREE WAYS TO MAKE SPACE',
    title: 'Your files deserve a better space.',
    intro:
      'Three different file manager experiences, grounded in your actual backend. Open each design, try organizing files, then choose the direction we bring into the dashboard.',
    concepts: '3 concepts',
    interactive: 'Working interactions',
    safe: 'Runs in your browser',
    harborSubtitle: 'Familiar. Clear. Ready for work.',
    harborDescription:
      'Persistent navigation, a folder ribbon, balanced thumbnail cards, and details beside your files. A familiar workspace for a team that needs to find things quickly.',
    sidebar: 'Sidebar navigation',
    balanced: 'Balanced grid',
    persistent: 'Persistent details',
    studioSubtitle: 'More room for the creative work.',
    studioDescription:
      'Top navigation, warm paper colors, and an expansive visual contact sheet. Details slide in when you need them. Designed for creative and content teams.',
    topnav: 'Top navigation',
    gallery: 'Visual gallery',
    drawer: 'Slide-in details',
    vaultSubtitle: 'Focused. Organized. In control.',
    vaultDescription:
      'A dark workspace in three panes: the folder navigator, the files, and the inspector. A compact view for people who organize a large library every day.',
    tree: 'Folder navigator',
    compact: 'Compact workspace',
    dark: 'Dark interface',
    open: 'Try the prototype',
    tryTitle: 'Try the work, not just the look.',
    tryIntro:
      'Every concept shares the same sample data and actions for a fair comparison. Double-click a file to open it, and reset the demo whenever you like.',
    trySelect:
      'Click files, use Ctrl/⌘ and Shift, or drag across the blank gallery area to select multiple files.',
    tryMove:
      'Drag your selection onto a folder, or choose Move. Create a folder, rename it, and reorganize it.',
    tryUpload:
      'Drop PNG, WebP, SVG, PDF, DOCX or XLSX files into an open folder. They are added locally only.',
    tryDetail:
      'Try search (at least 3 characters), filters, previews, download, visibility changes, and deletion with confirmation.',
    backendTitle: 'A new interface. Clear capabilities.',
    supported: 'SUPPORTED NOW',
    supportedTitle: 'The foundation is already here.',
    supportedText:
      'Nested folders and breadcrumbs; search, filters and sorting; rename; move/delete up to 50 files; single folder move; recursive folder delete; single-file visibility; signed downloads and image previews.',
    frontend: 'FRONTEND WORK',
    frontendTitle: 'Interaction makes the difference.',
    frontendText:
      'Grid and gallery layouts, drag/drop, multi-selection and range selection, keyboard shortcuts, context menus, and a multi-file upload queue. These can connect to the existing backend APIs.',
    missing: 'BACKEND DEVELOPMENT',
    missingTitle: 'Some boundaries need a decision.',
    missingText:
      'Recycle bin and restore; file copy and versions; bulk folder or mixed-item moves; favorites, tags and sharing; ZIP download; resumable uploads; document previews and separate thumbnail delivery.',
    noteTitle: 'Details that affect the design',
    noteText:
      'Root contains folders only. Uploads start private. Images and documents can be public or private depending on permissions and storage configuration. Deletion is permanent. Unfiled and usage tracking have contracts, but their source registries are empty. No invented storage quota or server totals.',
    audit: 'Read the backend audit, contracts, limits and integration plan',
    footer:
      'No backend connection. Reloading resets sample data. Open this page directly from disk, or use /media-concepts/index.html on your existing server.',
  };
  const arabic = Object.fromEntries(
    [...document.querySelectorAll('[data-copy]')].map((element) => [
      element.dataset.copy,
      element.textContent,
    ])
  );
  let locale = 'ar';
  document.querySelector('#locale-toggle').addEventListener('click', () => {
    locale = locale === 'ar' ? 'en' : 'ar';
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    const labels = locale === 'ar' ? arabic : english;
    document.querySelectorAll('[data-copy]').forEach((element) => {
      element.textContent = labels[element.dataset.copy];
    });
    document.querySelector('#locale-toggle').textContent =
      locale === 'ar' ? 'EN' : 'عربي';
  });
})();
