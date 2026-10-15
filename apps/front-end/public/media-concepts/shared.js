(function () {
  'use strict';

  class ConceptError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  const normalizeName = (value, folder = false) => {
    const name = String(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (
      !name ||
      name.length > (folder ? 100 : 150) ||
      /[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(name) ||
      (folder && ['.', '..'].includes(name))
    )
      throw new ConceptError('invalidName');
    return name;
  };

  function seed() {
    const folders = [
      { id: 'brand', name: 'Brand studio', parentId: null },
      { id: 'projects', name: 'Projects', parentId: null },
      { id: 'documents', name: 'Documents', parentId: null },
      { id: 'campaign', name: 'Autumn campaign', parentId: 'brand' },
      { id: 'identity', name: 'Visual identity', parentId: 'brand' },
      { id: 'archive', name: 'Previous editions', parentId: 'brand' },
      { id: 'website', name: 'Website refresh', parentId: 'projects' },
    ].map((folder) => ({
      ...folder,
      createdBy: 'demo-user',
      createdAt: '2026-10-01T09:00:00Z',
      updatedAt: '2026-10-05T11:00:00Z',
    }));
    const samples = [
      ['f1', 'Dune — landscape.svg', 'dune', 'brand', 'public', 148_200],
      ['f2', 'Forma — campaign.svg', 'forma', 'brand', 'private', 102_400],
      ['f3', 'Olive — texture.svg', 'olive', 'brand', 'private', 86_200],
      ['f4', 'Brand guidelines.pdf', 'pdf', 'brand', 'private', 820_000],
      ['f5', 'Arc — composition.svg', 'arc', 'brand', 'public', 96_200],
      ['f6', 'Coast — illustration.svg', 'coast', 'brand', 'private', 176_400],
      ['f7', 'Lookbook — cover.svg', 'lookbook', 'brand', 'private', 124_200],
      ['f8', 'Creative brief.pdf', 'pdf', 'brand', 'private', 426_000],
      ['f9', 'Launch — artwork.svg', 'forma', 'campaign', 'private', 88_200],
      ['f10', 'Logo exploration.svg', 'arc', 'identity', 'public', 76_100],
      ['f11', 'Project outline.pdf', 'pdf', 'documents', 'private', 324_000],
      ['f12', 'Homepage concept.svg', 'coast', 'website', 'private', 127_000],
    ];
    const files = samples.map(
      ([id, displayName, visual, folderId, bucketType, size], index) => ({
        id,
        displayName,
        visual,
        folderId,
        bucketType,
        size,
        mimeType: visual === 'pdf' ? 'application/pdf' : 'image/svg+xml',
        kind: visual === 'pdf' ? 'document' : 'image',
        width: null,
        height: null,
        blurhash: null,
        uploadedBy: 'demo-user',
        createdAt: `2026-10-${String(2 + (index % 4)).padStart(2, '0')}T09:00:00Z`,
        updatedAt: `2026-10-${String(2 + (index % 4)).padStart(2, '0')}T11:00:00Z`,
        usedBy: [],
        hiddenUsages: 0,
        transition: null,
        unfiledAt: null,
      })
    );
    return { folders, files };
  }

  function createModel(initial = seed()) {
    const data = structuredClone(initial);
    let sequence = 0;
    const folder = (id) => data.folders.find((item) => item.id === id);
    const file = (id) => data.files.find((item) => item.id === id);
    const governed = (item) =>
      item &&
      (item.folderId !== null ||
        (item.usedBy.length === 0 && !item.hiddenUsages));
    const path = (id) => {
      const result = [];
      const seen = new Set();
      for (let item = folder(id); item; item = folder(item.parentId)) {
        if (seen.has(item.id)) throw new ConceptError('cycle');
        seen.add(item.id);
        result.unshift(item);
      }
      return result;
    };
    const getFiles = (ids) => {
      const unique = [...new Set(ids)];
      if (ids.length === 0 || ids.length > 50)
        throw new ConceptError('batchLimit');
      return unique.map((id) => {
        const item = file(id);
        if (!governed(item)) throw new ConceptError('missing');
        if (item.transition) throw new ConceptError('busy');
        return item;
      });
    };
    const descendants = (id) => {
      const result = new Set([id]);
      let previous = 0;
      while (result.size !== previous) {
        previous = result.size;
        data.folders.forEach((item) => {
          if (result.has(item.parentId)) result.add(item.id);
        });
      }
      return result;
    };
    const checkDestination = (parentId, name, except) => {
      if (parentId !== null && !folder(parentId))
        throw new ConceptError('missing');
      if (
        data.folders.some(
          (item) =>
            item.id !== except &&
            item.parentId === parentId &&
            item.name.toLocaleLowerCase() === name.toLocaleLowerCase()
        )
      )
        throw new ConceptError('duplicateFolder');
      if (
        data.folders.filter(
          (item) => item.parentId === parentId && item.id !== except
        ).length >= 500
      )
        throw new ConceptError('childrenLimit');
    };
    return {
      data,
      folder,
      file,
      path,
      descendants,
      createFolder(name, parentId) {
        const normalized = normalizeName(name, true);
        checkDestination(parentId, normalized);
        if (path(parentId).length >= 10) throw new ConceptError('depthLimit');
        const item = {
          id: `demo-folder-${++sequence}`,
          name: normalized,
          parentId,
          createdBy: 'demo-user',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        data.folders.push(item);
        return item;
      },
      rename(kind, id, name) {
        const item = kind === 'folder' ? folder(id) : file(id);
        if (!item || (kind !== 'folder' && !governed(item)))
          throw new ConceptError('missing');
        if (item.transition) throw new ConceptError('busy');
        const normalized = normalizeName(name, kind === 'folder');
        if (kind === 'folder') checkDestination(item.parentId, normalized, id);
        item[kind === 'folder' ? 'name' : 'displayName'] = normalized;
        item.updatedAt = new Date().toISOString();
      },
      moveFiles(ids, destination) {
        if (!folder(destination)) throw new ConceptError('filesNeedFolder');
        const items = getFiles(ids);
        items.forEach((item) => {
          item.folderId = destination;
          item.unfiledAt = null;
          item.updatedAt = new Date().toISOString();
        });
      },
      moveFolder(id, destination) {
        const item = folder(id);
        if (!item) throw new ConceptError('missing');
        const children = descendants(id);
        if (children.has(destination)) throw new ConceptError('cycle');
        checkDestination(destination, item.name, id);
        const oldDepth = path(id).length;
        const height = Math.max(
          ...[...children].map((child) => path(child).length - oldDepth + 1)
        );
        if (path(destination).length + height > 10)
          throw new ConceptError('depthLimit');
        item.parentId = destination;
        item.updatedAt = new Date().toISOString();
      },
      deleteFiles(ids) {
        const items = getFiles(ids);
        if (items.some((item) => item.usedBy.length || item.hiddenUsages))
          throw new ConceptError('inUse');
        data.files = data.files.filter((item) => !ids.includes(item.id));
      },
      deleteFolder(id, recursive) {
        if (!folder(id)) throw new ConceptError('missing');
        const children = descendants(id);
        const items = data.files.filter((item) => children.has(item.folderId));
        if (!recursive && (children.size > 1 || items.length > 0))
          throw new ConceptError('folderNotEmpty');
        if (children.size - 1 + items.length > 200)
          throw new ConceptError('recursiveLimit');
        if (items.some((item) => item.usedBy.length || item.hiddenUsages))
          throw new ConceptError('inUse');
        if (items.some((item) => item.transition))
          throw new ConceptError('busy');
        data.files = data.files.filter((item) => !children.has(item.folderId));
        data.folders = data.folders.filter((item) => !children.has(item.id));
      },
      setVisibility(id, visibility) {
        const item = file(id);
        if (!governed(item)) throw new ConceptError('missing');
        if (item.transition) throw new ConceptError('busy');
        if (!['private', 'public'].includes(visibility))
          throw new ConceptError('invalidVisibility');
        if (
          visibility === 'private' &&
          item.bucketType !== visibility &&
          item.hasPublicUsage
        )
          throw new ConceptError('publicInUse');
        item.bucketType = visibility;
        item.updatedAt = new Date().toISOString();
      },
      addFile(item) {
        if (!folder(item.folderId)) throw new ConceptError('filesNeedFolder');
        const displayName = normalizeName(item.displayName);
        if (data.files.some((existing) => existing.id === item.id))
          throw new ConceptError('duplicateId');
        data.files.push({
          ...item,
          displayName,
          bucketType: 'private',
          usedBy: [],
          hiddenUsages: 0,
          transition: null,
          unfiledAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    };
  }

  const htmlFragments = new WeakMap();
  const escapeText = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]
    );
  const encodeHTML = (value) => {
    if (htmlFragments.has(value)) return htmlFragments.get(value);
    if (Array.isArray(value)) return value.map(encodeHTML).join('');
    return escapeText(value);
  };
  function escapeHTML(strings, ...values) {
    const fragment = Object.freeze({});
    const html =
      Array.isArray(strings) && Array.isArray(strings.raw)
        ? strings.reduce(
            (result, part, index) =>
              result + encodeHTML(values[index - 1]) + part
          )
        : encodeHTML(strings);
    htmlFragments.set(fragment, html);
    return fragment;
  }
  function unwrapSafeHTML(fragment) {
    if (!htmlFragments.has(fragment))
      throw new TypeError('Expected escaped HTML from a template.');
    return htmlFragments.get(fragment);
  }

  const modelAPI = {
    createModel,
    seed,
    normalizeName,
    ConceptError,
    escapeHTML,
    unwrapSafeHTML,
  };
  if (typeof module !== 'undefined' && module.exports)
    module.exports = modelAPI;
  if (typeof document === 'undefined') return;

  const copy = {
    en: {
      library: 'My library',
      allFiles: 'All files',
      unfiled: 'Unfiled',
      upload: 'Upload files',
      newFolder: 'New folder',
      search: 'Search this view…',
      allTypes: 'All types',
      images: 'Images',
      documents: 'Documents',
      allVisibility: 'Any visibility',
      private: 'Private',
      public: 'Public',
      name: 'Name',
      newest: 'Recently updated',
      size: 'File size',
      folders: 'Folders',
      files: 'Files',
      move: 'Move',
      delete: 'Delete',
      selectAll: 'Select all',
      clearSelection: 'Clear',
      details: 'File details',
      help: 'Capabilities',
      reset: 'Reset demo',
      prototype: 'Interactive prototype · sample data',
      subtitle: 'A little order. A lot of possibility.',
      dropHint: 'Drop files to upload into this folder',
      selectHint:
        'Click to select · Ctrl/⌘ for multiple · Shift for a range · Double-click to open',
      backConcepts: 'All concepts',
      nothingSelected: 'Room for a closer look',
      inspectorHint:
        'Select a file to see its preview, visibility and details.',
      rename: 'Rename',
      preview: 'Preview',
      download: 'Download',
      close: 'Close',
      cancel: 'Cancel',
      save: 'Save',
      moveHere: 'Move here',
      destination: 'Choose a destination',
      root: 'Library',
      fileName: 'File name',
      folderName: 'Folder name',
      selected: 'selected',
      empty: 'A clean canvas',
      noResults: 'No files match these filters.',
      emptyHint: 'Create a folder or add files to get started.',
      rootHint: 'Files live inside folders. Open a folder to upload.',
      unfiledHint:
        'Unfiled is currently dormant: the backend has no registered entity upload purposes or usage sources. When enabled, unreferenced files can be adopted into a folder before the 7-day cleanup.',
      modified: 'Modified',
      created: 'Created',
      location: 'Location',
      visibility: 'Visibility',
      type: 'Type',
      dimensions: 'Dimensions',
      uploader: 'Uploader ID',
      references: 'Used in',
      noReferences: 'No known references',
      referencesHint: 'Backend usage registries are currently empty.',
      publish: 'Make public',
      unpublish: 'Make private',
      deleteConfirm: 'Permanently delete',
      deleteWarning:
        'This permanently deletes the selected sample files. The backend has no recycle bin or restore action.',
      folderDeleteWarning:
        'This removes the folder and everything inside it. The backend blocks referenced or busy files and caps a recursive operation at 200 descendants and files.',
      publishWarning:
        'Public files can be viewed without signing in. This is a local visibility simulation; a live transition may need time to finish.',
      privateWarning:
        'Public URLs can stop working after this change. Private access uses temporary signed URLs. This demo does not contact storage.',
      demoOnly: 'Sample data only. No changes are sent to your backend.',
      moved: 'Moved successfully in this demo.',
      renamed: 'Renamed in this demo.',
      removed: 'Deleted from the demo.',
      createdFolder: 'Folder created in this demo.',
      visibilityChanged: 'Visibility changed in this demo.',
      batchLimit: 'Select between 1 and 50 files for a bulk action.',
      filesNeedFolder:
        'Choose an existing folder. Files cannot live at the library root.',
      invalidName:
        'Use a valid name without slashes or control characters (folder: 100 characters; file: 150).',
      duplicateFolder: 'A folder with this name already exists here.',
      cycle: 'A folder cannot move into itself or a descendant.',
      depthLimit: 'The backend allows at most 10 folder levels.',
      childrenLimit: 'The backend allows at most 500 child folders per parent.',
      recursiveLimit:
        'Recursive deletion is limited to 200 descendants and files.',
      inUse:
        'A referenced file cannot be deleted. The entire operation was stopped.',
      busy: 'A file has a transition in progress. Try again when it finishes.',
      missing: 'This item no longer exists.',
      folderNotEmpty: 'This folder is not empty. Use recursive deletion.',
      publicInUse: 'A public reference prevents making this file private.',
      searchMinimum:
        'Search uses 3–200 characters with an indexable letter or number pattern.',
      foldersTruncated: 'First 20 matching folders shown; refine the search.',
      invalidVisibility: 'Choose public or private visibility.',
      duplicateId: 'This file already exists.',
      uploadTitle: 'Add files to this folder',
      uploadHint:
        'PNG, WebP, SVG, PDF, DOCX or XLSX. Uploads start private. This local demo does not optimize images or validate document content.',
      chooseFiles: 'Choose files',
      queueTitle: 'Local upload queue',
      queued: 'Waiting',
      uploading: 'Adding locally…',
      complete: 'Added locally',
      failed: 'Rejected',
      cancelled: 'Cancelled',
      stop: 'Stop queue',
      retry: 'Retry failed',
      uploadDone: 'Files added locally. No server upload was performed.',
      unsupportedType:
        'Unsupported type. Use PNG, WebP, SVG, PDF, DOCX or XLSX.',
      imageSize: 'Prepared image exceeds 1 MiB.',
      svgSize: 'SVG exceeds 0.4 MiB.',
      documentSize: 'Document exceeds 10 MiB.',
      emptyFile: 'Empty files are not accepted.',
      folderDrop: 'Folder uploads are not supported. Drop individual files.',
      imageDimensions: 'Image exceeds 25 megapixels or 16,383 pixels per side.',
      selectLabel: 'Select file',
      menuLabel: 'More actions',
      openFolder: 'Open folder',
      demoItem: 'Sample file',
      liveFile: 'Local file',
      downloadSample:
        'Sample downloaded. Live files use the backend signed download URL.',
      noDocPreview:
        'Documents are served as downloads by the backend. Inline document previews need additional work.',
      copiedUnsupported:
        'The demo has no remote URL. Live private links expire after one hour.',
      keyboard: 'Keyboard',
      keyboardHint:
        'Ctrl/⌘ A selects visible files. Escape clears selection. F2 renames one file. Delete opens confirmation. Arrow keys navigate cards. Space toggles a focused file.',
      supportTitle: 'What can ship with this design',
      supported: 'Supported by the current backend',
      gaps: 'Needs backend work',
      supportText:
        'Folders and breadcrumbs; global search and filters; file rename; move/delete up to 50 files; single folder move; recursive folder delete; private-first uploads; image previews; single-file visibility; signed downloads; usage detail contracts.',
      gapText:
        'Recycle bin and restore, copying files, favorites and tags, share invitations, bulk folder or mixed-item actions, bulk publish, ZIP download, resumable uploads, thumbnail endpoints and inline document previews.',
      reserved: 'Configured but dormant',
      reservedText:
        'Unfiled and used-in views have contracts, but entity upload purposes and usage sources are not registered yet. Demo assumes full permissions and both visibility buckets. Uploads start private. Live publishing requires media.publish and configured destination buckets.',
      interactionText:
        'Drag files onto a folder to move. Drop local files into an open folder to upload. Click or drag the blank gallery area to select; use Ctrl/⌘ or Shift to extend selection.',
      compare: 'Compare concepts',
      unknownError: 'The action could not complete.',
      tree: 'Folder navigator',
      currentFolder: 'Current folder',
      sortBy: 'Sort files',
      filterType: 'Filter file type',
      filterVisibility: 'Filter visibility',
      searchLabel: 'Search files in the current view',
      toggleLanguage: 'Switch language',
      closeInspector: 'Close details',
      countHint: 'Counts in this demo are derived from sample data.',
      folder: 'Folder',
      selection: 'Selection',
      loadMore: 'Show more',
      hiddenReferences: 'Restricted references',
      copyLink: 'Copy link',
      sampleSize: 'Displayed size is illustrative sample metadata.',
      localSize: 'Original local file size; the backend may optimize images.',
    },
    ar: {
      library: 'مكتبتي',
      allFiles: 'كل الملفات',
      unfiled: 'غير مصنّفة',
      upload: 'رفع ملفات',
      newFolder: 'مجلد جديد',
      search: 'ابحث في هذا العرض…',
      allTypes: 'كل الأنواع',
      images: 'الصور',
      documents: 'المستندات',
      allVisibility: 'كل مستويات الوصول',
      private: 'خاص',
      public: 'عام',
      name: 'الاسم',
      newest: 'آخر تحديث',
      size: 'حجم الملف',
      folders: 'المجلدات',
      files: 'الملفات',
      move: 'نقل',
      delete: 'حذف',
      selectAll: 'تحديد الكل',
      clearSelection: 'إلغاء التحديد',
      details: 'تفاصيل الملف',
      help: 'الإمكانات',
      reset: 'إعادة التجربة',
      prototype: 'نموذج تفاعلي · بيانات تجريبية',
      subtitle: 'مساحة منظّمة. أفكار بلا حدود.',
      dropHint: 'أفلت الملفات لرفعها إلى هذا المجلد',
      selectHint:
        'انقر للتحديد · Ctrl/⌘ لتحديد متعدد · Shift لتحديد نطاق · انقر مرتين للفتح',
      backConcepts: 'كل التصاميم',
      nothingSelected: 'كل التفاصيل، في مكان واحد',
      inspectorHint: 'حدد ملفاً لمعاينته ومعرفة تفاصيله ومستوى الوصول إليه.',
      rename: 'إعادة تسمية',
      preview: 'معاينة',
      download: 'تنزيل',
      close: 'إغلاق',
      cancel: 'إلغاء',
      save: 'حفظ',
      moveHere: 'نقل إلى هنا',
      destination: 'اختر الوجهة',
      root: 'المكتبة',
      fileName: 'اسم الملف',
      folderName: 'اسم المجلد',
      selected: 'محددة',
      empty: 'مساحة لأفكارك',
      noResults: 'لا توجد ملفات تطابق هذه الفلاتر.',
      emptyHint: 'أنشئ مجلداً أو أضف ملفات للبدء.',
      rootHint: 'الملفات تُحفظ داخل مجلدات. افتح مجلداً لرفع الملفات.',
      unfiledHint:
        'هذا العرض غير مفعّل حالياً: لم تُسجّل مصادر استخدام أو أغراض رفع مرتبطة بالسجلات في الخادم. عند تفعيلها، يمكن نقل الملفات غير المستخدمة إلى مجلد قبل حذفها تلقائياً بعد ٧ أيام.',
      modified: 'آخر تعديل',
      created: 'تاريخ الإنشاء',
      location: 'الموقع',
      visibility: 'الوصول',
      type: 'النوع',
      dimensions: 'الأبعاد',
      uploader: 'معرّف الرافع',
      references: 'مستخدم في',
      noReferences: 'لا توجد مراجع معروفة',
      referencesHint: 'سجلات مصادر الاستخدام في الخادم فارغة حالياً.',
      publish: 'جعله عاماً',
      unpublish: 'جعله خاصاً',
      deleteConfirm: 'حذف نهائي',
      deleteWarning:
        'سيُحذف التحديد من البيانات التجريبية نهائياً. الخادم لا يوفر سلة محذوفات أو استعادة.',
      folderDeleteWarning:
        'سيُحذف المجلد ومحتوياته. الخادم يمنع حذف الملفات المستخدمة أو قيد الانتقال، ويحد العملية بـ٢٠٠ ملف ومجلد فرعي.',
      publishWarning:
        'الملفات العامة متاحة دون تسجيل دخول. هذا تغيير تجريبي محلي؛ الانتقال الفعلي قد يستغرق وقتاً.',
      privateWarning:
        'قد تتوقف الروابط العامة بعد التغيير. الوصول الخاص يستخدم روابط مؤقتة موقّعة. هذه التجربة لا تتصل بالتخزين.',
      demoOnly: 'بيانات تجريبية فقط. لا تُرسل أي تغييرات إلى الخادم.',
      moved: 'تم النقل في التجربة.',
      renamed: 'تمت إعادة التسمية في التجربة.',
      removed: 'تم الحذف من التجربة.',
      createdFolder: 'تم إنشاء المجلد في التجربة.',
      visibilityChanged: 'تم تغيير الوصول في التجربة.',
      batchLimit: 'حدد من ملف واحد إلى ٥٠ ملفاً للعملية الجماعية.',
      filesNeedFolder:
        'اختر مجلداً موجوداً. لا يمكن حفظ الملفات في جذر المكتبة.',
      invalidName:
        'أدخل اسماً دون شرطات مائلة أو محارف تحكم (المجلد: ١٠٠ حرف؛ الملف: ١٥٠).',
      duplicateFolder: 'يوجد مجلد بهذا الاسم هنا.',
      cycle: 'لا يمكن نقل المجلد إلى نفسه أو إلى أحد مجلداته الفرعية.',
      depthLimit: 'الخادم يسمح بعمق يصل إلى ١٠ مجلدات.',
      childrenLimit: 'الخادم يسمح بـ٥٠٠ مجلد فرعي لكل مجلد.',
      recursiveLimit: 'الحذف المتكرر محدود بـ٢٠٠ ملف ومجلد فرعي.',
      inUse: 'لا يمكن حذف ملف مستخدم. أُوقفت العملية بالكامل.',
      busy: 'الملف قيد الانتقال. حاول بعد اكتماله.',
      missing: 'هذا العنصر لم يعد موجوداً.',
      folderNotEmpty: 'المجلد غير فارغ. استخدم الحذف مع المحتويات.',
      publicInUse: 'لا يمكن جعل الملف خاصاً ما دام مستخدماً في محتوى عام.',
      searchMinimum: 'البحث يحتاج ٣–٢٠٠ حرف بنمط أحرف أو أرقام قابل للفهرسة.',
      foldersTruncated: 'تظهر أول ٢٠ مجلداً مطابقاً؛ حدّد البحث أكثر.',
      invalidVisibility: 'اختر عاماً أو خاصاً.',
      duplicateId: 'هذا الملف موجود بالفعل.',
      uploadTitle: 'أضف ملفات إلى هذا المجلد',
      uploadHint:
        'PNG وWebP وSVG وPDF وDOCX وXLSX. الملفات تبدأ خاصة. هذه التجربة لا تحسّن الصور أو تتحقق من محتوى المستندات.',
      chooseFiles: 'اختيار ملفات',
      queueTitle: 'قائمة الرفع المحلي',
      queued: 'في الانتظار',
      uploading: 'تُضاف محلياً…',
      complete: 'أُضيف محلياً',
      failed: 'مرفوض',
      cancelled: 'أُلغي',
      stop: 'إيقاف',
      retry: 'إعادة محاولة الفاشل',
      uploadDone: 'أُضيفت الملفات محلياً. لم تُرفع إلى الخادم.',
      unsupportedType:
        'نوع غير مدعوم. استخدم PNG أوWebP أوSVG أوPDF أوDOCX أوXLSX.',
      imageSize: 'الصورة المجهزة تتجاوز ١ MiB.',
      svgSize: 'SVG يتجاوز ٠٫٤ MiB.',
      documentSize: 'المستند يتجاوز ١٠ MiB.',
      emptyFile: 'الملفات الفارغة غير مقبولة.',
      folderDrop: 'رفع المجلدات غير مدعوم. أفلت ملفات منفردة.',
      imageDimensions: 'الصورة تتجاوز ٢٥ ميغابكسل أو ١٦٣٨٣ بكسل لكل جانب.',
      selectLabel: 'تحديد الملف',
      menuLabel: 'إجراءات إضافية',
      openFolder: 'فتح المجلد',
      demoItem: 'ملف تجريبي',
      liveFile: 'ملف محلي',
      downloadSample:
        'تم تنزيل العينة. الملفات الفعلية تستخدم رابط تنزيل موقّع من الخادم.',
      noDocPreview:
        'الخادم يقدم المستندات كتنزيلات. المعاينة داخل المتصفح تحتاج عملاً إضافياً.',
      copiedUnsupported:
        'لا توجد روابط بعيدة في التجربة. الروابط الخاصة الفعلية تنتهي خلال ساعة.',
      keyboard: 'لوحة المفاتيح',
      keyboardHint:
        'Ctrl/⌘ A يحدد الملفات الظاهرة. Escape يلغي التحديد. F2 يعيد تسمية ملف واحد. Delete يفتح التأكيد. الأسهم تتنقل بين الملفات. المسافة تبدّل التحديد.',
      supportTitle: 'ما يمكن تطبيقه مع هذا التصميم',
      supported: 'مدعوم حالياً في الخادم',
      gaps: 'يحتاج تطوير الخادم',
      supportText:
        'المجلدات ومسار التنقل؛ البحث والفلاتر؛ إعادة التسمية؛ نقل وحذف ٥٠ ملفاً؛ نقل مجلد واحد؛ حذف المجلد بمحتوياته؛ الرفع الخاص؛ معاينة الصور؛ تغيير وصول ملف واحد؛ التنزيل الموقّع؛ عقود تفاصيل الاستخدام.',
      gapText:
        'سلة المحذوفات والاستعادة، نسخ الملفات، المفضلة والوسوم، دعوات المشاركة، إجراءات جماعية للمجلدات والعناصر المختلطة، نشر جماعي، تنزيل ZIP، رفع قابل للاستئناف، صور مصغرة ومعاينة المستندات.',
      reserved: 'عقود موجودة وغير مفعّلة',
      reservedText:
        'عرض الملفات غير المصنفة والاستخدام لهما عقود، لكن مصادر الاستخدام وأغراض الرفع لم تُسجّل. التجربة تفترض كامل الصلاحيات وإعداد الحاويتين. الملفات تبدأ خاصة. النشر الفعلي يحتاج media.publish وإعداد حاويات الوجهة.',
      interactionText:
        'اسحب الملفات إلى مجلد لنقلها. أفلت ملفات محلية داخل مجلد مفتوح لإضافتها. انقر أو اسحب فوق المساحة الفارغة للتحديد؛ استخدم Ctrl/⌘ أوShift لتوسيعه.',
      compare: 'مقارنة التصاميم',
      unknownError: 'تعذر إكمال الإجراء.',
      tree: 'متصفح المجلدات',
      currentFolder: 'المجلد الحالي',
      sortBy: 'ترتيب الملفات',
      filterType: 'تصفية نوع الملف',
      filterVisibility: 'تصفية الوصول',
      searchLabel: 'البحث في العرض الحالي',
      toggleLanguage: 'تغيير اللغة',
      closeInspector: 'إغلاق التفاصيل',
      countHint: 'أعداد هذه التجربة محسوبة من البيانات التجريبية.',
      folder: 'مجلد',
      selection: 'التحديد',
      loadMore: 'عرض المزيد',
      hiddenReferences: 'مراجع محدودة الوصول',
      copyLink: 'نسخ الرابط',
      sampleSize: 'الحجم المعروض بيانات تجريبية توضيحية.',
      localSize: 'حجم الملف المحلي الأصلي؛ الخادم قد يحسّن الصور.',
    },
  };
  let locale = 'ar';
  let model = createModel();
  const state = {
    scope: 'folder',
    folderId: 'brand',
    selected: new Set(),
    anchor: null,
    focused: null,
    inspected: null,
    page: 1,
  };
  let queue = [],
    queueRunning = false,
    queueCancelled = false,
    queueGeneration = 0;
  let toastTimer;
  const objectURLs = new Set();
  const $ = (selector) => document.querySelector(selector);
  const t = (key) => copy[locale][key] || copy.en[key] || key;
  const number = (value) => new Intl.NumberFormat(locale).format(value);
  const bytes = (value) =>
    value >= 1_048_576
      ? `${number(Math.round((value / 1_048_576) * 10) / 10)} MiB`
      : `${number(Math.round(value / 1024))} KiB`;
  const icon = (name, size = 20) => {
    const paths = {
      folder: escapeHTML`<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>`,
      more: escapeHTML`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`,
      check: escapeHTML`<path d="m5 12 4 4L19 6"/>`,
      close: escapeHTML`<path d="m6 6 12 12M18 6 6 18"/>`,
      arrow: escapeHTML`<path d="m9 5 7 7-7 7"/>`,
      file: escapeHTML`<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>`,
      upload: escapeHTML`<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>`,
      image: escapeHTML`<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 4-3 4 5"/>`,
      lock: escapeHTML`<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>`,
      globe: escapeHTML`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c6 5 6 13 0 18-6-5-6-13 0-18Z"/>`,
      grid: escapeHTML`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
    };
    return escapeHTML`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  };
  const artSVG = (visual) => {
    const scenes = {
      dune: '<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#d9b6a0"/><stop offset="1" stop-color="#f9e4c8"/></linearGradient></defs><rect width="720" height="480" fill="url(#sky)"/><circle cx="527" cy="143" r="52" fill="#fff4d7"/><path d="M0 367Q250 225 520 353T850 420V480H0" fill="#c18b64"/><path d="M-50 460Q270 220 640 463L760 480H0" fill="#e0af85"/><path d="M240 480Q480 305 760 403V480" fill="#986346"/><text x="40" y="57" fill="#664b3b" font-size="16" letter-spacing="7" font-family="serif">STILL / 01</text>',
      forma:
        '<rect width="720" height="480" fill="#b9cace"/><rect x="54" y="40" width="612" height="400" rx="3" fill="#e5f0e7"/><path d="M247 371V172a113 113 0 0 1 226 0v199Z" fill="#ed733d"/><circle cx="360" cy="172" r="59" fill="#e5f0e7"/><text x="84" y="111" fill="#293d37" font-size="44" font-family="Georgia">forma.</text><text x="88" y="397" fill="#293d37" font-size="13" font-family="sans-serif" letter-spacing="4">MAKE ROOM FOR IDEAS</text>',
      olive:
        '<rect width="720" height="480" fill="#dce1c8"/><g fill="#758160"><ellipse cx="311" cy="195" rx="105" ry="190" transform="rotate(-42 311 195)"/><ellipse cx="480" cy="198" rx="90" ry="180" transform="rotate(25 480 198)"/></g><ellipse cx="409" cy="435" rx="120" ry="230" fill="#46583f" transform="rotate(55 409 435)"/><path d="m140 470 408-420" stroke="#cdd5b3" stroke-width="4"/><text x="39" y="55" fill="#3c4934" font-family="serif" font-size="23" letter-spacing="5">ORGANIC STUDIES</text>',
      arc: '<rect width="720" height="480" fill="#e5d9fc"/><circle cx="360" cy="243" r="162" fill="#6d54bd"/><circle cx="360" cy="243" r="109" fill="#e5d9fc"/><rect x="358" y="80" width="190" height="329" fill="#e5d9fc"/><path d="M378 407V80h106v327Z" fill="#322244"/><text x="43" y="61" fill="#322244" font-family="sans-serif" font-size="16" letter-spacing="5">A R C H I V E / VOL. 02</text>',
      coast:
        '<rect width="720" height="480" fill="#aecacb"/><rect y="236" width="720" height="244" fill="#4b787b"/><circle cx="532" cy="140" r="52" fill="#f1e6c8"/><path d="M0 329 150 187l112 100 112-63 176 190 170-55v121H0" fill="#a99b78"/><path d="M0 368 136 307l122 130 145-95 148 138H0" fill="#525c4b"/><path d="M388 480 487 380l141 100" fill="#d0bf9e"/><text x="37" y="55" fill="#2c4e54" font-family="serif" font-size="20" letter-spacing="5">THE QUIET COAST</text>',
      lookbook:
        '<rect width="720" height="480" fill="#e5bfb2"/><rect x="160" y="43" width="400" height="394" fill="#fff5e8"/><circle cx="360" cy="238" r="133" fill="#c9432e"/><path d="M227 238h266v139H227" fill="#d7845b"/><text x="189" y="111" fill="#343023" font-family="Georgia" font-size="39">A new perspective.</text><text x="190" y="412" fill="#343023" font-family="sans-serif" font-size="13" letter-spacing="6">AUTUMN — 2026</text>',
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480" viewBox="0 0 720 480">${scenes[visual] || scenes.arc}</svg>`;
  };
  const art = (item) =>
    item.kind === 'image'
      ? escapeHTML`<img src="${escapeHTML(item.localURL || `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artSVG(item.visual))}`)}" alt="" draggable="false" loading="lazy">`
      : escapeHTML`<div class="document-art"><span class="document-sheet">${icon('file', 46)}<b>${escapeHTML(item.displayName.split('.').at(-1).toUpperCase())}</b><i></i><i></i><i></i></span></div>`;

  document.body.insertAdjacentHTML(
    'beforeend',
    '<div id="concept-toast" role="status" aria-live="polite" hidden></div><div id="concept-menu" class="context-menu" hidden></div><dialog id="concept-dialog"></dialog><div id="drop-overlay" hidden></div><div id="selection-rectangle" hidden></div>'
  );
  $('#file-grid').insertAdjacentHTML(
    'beforebegin',
    '<p id="search-feedback" class="search-feedback" role="status" hidden></p>'
  );
  const dialog = $('#concept-dialog');
  const menu = $('#concept-menu');
  let previousFocus;

  function toast(message) {
    const element = $('#concept-toast');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      element.hidden = true;
    }, 4200);
  }
  function fail(error) {
    toast(t(error instanceof ConceptError ? error.code : 'unknownError'));
  }
  function closeDialog() {
    if (queueRunning) {
      queueCancelled = true;
      queueRunning = false;
      queueGeneration++;
    }
    dialog.close();
    previousFocus?.focus();
  }
  function showDialog(title, content, footer = '') {
    previousFocus = document.activeElement;
    if (dialog.open) dialog.close();
    dialog.innerHTML = unwrapSafeHTML(
      escapeHTML`<div class="dialog-heading"><h2>${escapeHTML(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="${t('close')}">${icon('close')}</button></div><div class="dialog-content">${content}</div>${footer ? escapeHTML`<div class="dialog-footer">${footer}</div>` : ''}`
    );
    dialog.showModal();
    dialog.querySelector('input, button, select')?.focus();
  }
  function confirmAction(title, description, run, danger = false) {
    showDialog(
      title,
      escapeHTML`<p class="dialog-description">${escapeHTML(description)}</p><p class="demo-note">${t('demoOnly')}</p>`,
      escapeHTML`<button data-action="close-dialog" class="secondary-button">${t('cancel')}</button><button id="confirm-operation" class="primary-button ${danger ? 'danger-button' : ''}">${escapeHTML(title)}</button>`
    );
    $('#confirm-operation').addEventListener('click', () => {
      try {
        run();
        closeDialog();
      } catch (error) {
        fail(error);
      }
    });
  }
  function visible() {
    const rawQuery = $('#search')
      .value.replace(/\p{Cc}/gu, '')
      .trim();
    const indexableQuery = [...rawQuery]
      .map((character) =>
        character.codePointAt(0) > 65_535 ? '\u{1}' : character
      )
      .join('');
    const query =
      [...rawQuery].length >= 3 &&
      [...rawQuery].length <= 200 &&
      /[\p{L}\p{Nl}\p{Nd}]{3}|[^\p{L}\p{Nl}\p{Nd}][\p{L}\p{Nl}\p{Nd}]|[\p{L}\p{Nl}\p{Nd}]{2}[^\p{L}\p{Nl}\p{Nd}]/u.test(
        indexableQuery
      )
        ? rawQuery.toLocaleLowerCase()
        : '';
    $('#search-feedback').hidden = !rawQuery || Boolean(query);
    $('#search-feedback').textContent = t('searchMinimum');
    const type = $('#type-filter').value,
      visibility = $('#visibility-filter').value;
    const matches = (item) =>
      !query || item.toLocaleLowerCase().includes(query);
    let files = model.data.files.filter(
      (item) =>
        (state.scope === 'all'
          ? item.folderId !== null
          : state.scope === 'unfiled'
            ? item.folderId === null &&
              item.usedBy.length === 0 &&
              !item.hiddenUsages
            : item.folderId === state.folderId) &&
        matches(item.displayName) &&
        (type === 'all' || item.kind === type) &&
        (visibility === 'all' || item.bucketType === visibility)
    );
    const sort = $('#sort').value;
    files.sort((a, b) =>
      sort === 'size'
        ? b.size - a.size
        : sort === 'newest'
          ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
          : a.displayName.localeCompare(b.displayName, locale)
    );
    let folders =
      state.scope === 'unfiled' || (!query && state.scope === 'all')
        ? []
        : model.data.folders.filter(
            (item) =>
              (state.scope === 'all' || item.parentId === state.folderId) &&
              matches(item.name)
          );
    folders.sort((a, b) => a.name.localeCompare(b.name, locale));
    const foldersTruncated = state.scope === 'all' && folders.length > 20;
    if (state.scope === 'all') folders = folders.slice(0, 20);
    return { files, folders, foldersTruncated };
  }
  function translate() {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.body.dataset.locale = locale;
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      if (element.tagName === 'INPUT')
        element.placeholder = t(element.dataset.i18n);
      else element.textContent = t(element.dataset.i18n);
    });
    $('#search').placeholder = t('search');
    $('#search').setAttribute('aria-label', t('searchLabel'));
    $('#type-filter').setAttribute('aria-label', t('filterType'));
    $('#visibility-filter').setAttribute('aria-label', t('filterVisibility'));
    $('#sort').setAttribute('aria-label', t('sortBy'));
    document.querySelectorAll('[data-action="locale"]').forEach((element) => {
      element.textContent = locale === 'ar' ? 'EN' : 'عربي';
      element.setAttribute('aria-label', t('toggleLanguage'));
    });
    document.dispatchEvent(
      new CustomEvent('media:locale', { detail: { locale } })
    );
  }
  function breadcrumb() {
    const crumbs = state.scope === 'folder' ? model.path(state.folderId) : [];
    $('#breadcrumb').innerHTML = unwrapSafeHTML(
      escapeHTML`<button data-scope="folder">${t('root')}</button>${state.scope === 'folder' ? escapeHTML`${crumbs.map((item) => escapeHTML`<span aria-hidden="true">/</span><button data-open-folder="${escapeHTML(item.id)}" dir="auto">${escapeHTML(item.name)}</button>`)}` : escapeHTML`<span aria-hidden="true">/</span><span>${t(state.scope === 'all' ? 'allFiles' : 'unfiled')}</span>`}`
    );
    $('#location-title').textContent =
      state.scope === 'all'
        ? t('allFiles')
        : state.scope === 'unfiled'
          ? t('unfiled')
          : model.folder(state.folderId)?.name || t('library');
  }
  function renderTree() {
    const tree = $('#folder-tree');
    if (!tree) return;
    const folders =
      document.body.dataset.design === 'harbor'
        ? model.data.folders.filter((item) => item.parentId === null)
        : model.data.folders;
    const ordered = [];
    function visit(parentId) {
      folders
        .filter((item) => item.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name, locale))
        .forEach((item) => {
          ordered.push(item);
          visit(item.id);
        });
    }
    visit(null);
    tree.innerHTML = unwrapSafeHTML(
      escapeHTML`${ordered.map(
        (item) =>
          escapeHTML`<button class="tree-folder ${state.folderId === item.id && state.scope === 'folder' ? 'is-active' : ''}" data-open-folder="${escapeHTML(item.id)}" data-drop-folder="${escapeHTML(item.id)}" style="--depth:${model.path(item.id).length - 1}" title="${escapeHTML(
            model
              .path(item.id)
              .map((crumb) => crumb.name)
              .join(' / ')
          )}">${icon('folder', 17)}<span dir="auto">${escapeHTML(item.name)}</span></button>`
      )}`
    );
  }
  function render() {
    breadcrumb();
    renderTree();
    const listing = visible();
    $('#folder-grid').innerHTML = unwrapSafeHTML(
      escapeHTML`${listing.folders.map(
        (item) =>
          escapeHTML`<div class="folder-card" data-drop-folder="${escapeHTML(item.id)}" data-folder-id="${escapeHTML(item.id)}" draggable="true"><button class="folder-open" data-open-folder="${escapeHTML(item.id)}" aria-label="${escapeHTML(t('openFolder') + ': ' + item.name)}"><span class="folder-art">${icon('folder', 34)}</span><span class="folder-info"><strong dir="auto">${escapeHTML(item.name)}</strong><small>${
            state.scope === 'all'
              ? escapeHTML(
                  model
                    .path(item.parentId)
                    .map((crumb) => crumb.name)
                    .join(' / ') || t('root')
                )
              : t('folder')
          }</small></span></button><button class="folder-menu icon-button" data-folder-menu="${escapeHTML(item.id)}" aria-label="${escapeHTML(t('menuLabel') + ': ' + item.name)}">${icon('more', 18)}</button></div>`
      )}`
    );
    const shown = listing.files.slice(0, state.page * 50);
    $('#file-grid').innerHTML = unwrapSafeHTML(
      shown.length > 0
        ? escapeHTML`${shown.map(
            (item) =>
              escapeHTML`<article class="file-card ${state.selected.has(item.id) ? 'is-selected' : ''}" data-file-id="${escapeHTML(item.id)}" data-visual="${escapeHTML(item.visual || item.kind)}" draggable="true" tabindex="0" role="option" aria-selected="${state.selected.has(item.id)}" aria-label="${escapeHTML(item.displayName)}"><button class="select-toggle" tabindex="-1" data-select-file="${escapeHTML(item.id)}" aria-label="${escapeHTML(t('selectLabel') + ': ' + item.displayName)}" aria-pressed="${state.selected.has(item.id)}">${icon('check', 14)}</button><div class="file-art">${art(item)}</div><div class="file-info"><strong dir="auto" title="${escapeHTML(item.displayName)}">${escapeHTML(item.displayName)}</strong><small>${escapeHTML(item.displayName.split('.').at(-1).toUpperCase())} <span>·</span> <span dir="ltr">${bytes(item.size)}</span></small></div><div class="file-meta"><span class="visibility ${item.bucketType}">${icon(item.bucketType === 'public' ? 'globe' : 'lock', 12)}${t(item.bucketType)}</span><button class="file-menu icon-button" tabindex="-1" data-file-menu="${escapeHTML(item.id)}" aria-label="${escapeHTML(t('menuLabel') + ': ' + item.displayName)}">${icon('more', 18)}</button></div></article>`
          )}`
        : escapeHTML`<div class="empty-state">${icon(state.scope === 'folder' && !state.folderId ? 'folder' : 'image', 48)}<h3>${t('empty')}</h3><p>${t(state.scope === 'unfiled' ? 'unfiledHint' : state.scope === 'folder' && !state.folderId ? 'rootHint' : $('#search').value || $('#type-filter').value !== 'all' || $('#visibility-filter').value !== 'all' ? 'noResults' : 'emptyHint')}</p>${state.scope === 'folder' ? escapeHTML`<button class="secondary-button" data-action="${state.folderId ? 'upload' : 'new-folder'}">${t(state.folderId ? 'upload' : 'newFolder')}</button>` : ''}</div>`
    );
    $('#file-grid').setAttribute('role', 'listbox');
    $('#file-grid').setAttribute('aria-multiselectable', 'true');
    $('#file-grid').setAttribute('aria-label', t('files'));
    $('#status-count').textContent =
      `${number(listing.folders.length)} ${t('folders')} · ${number(listing.files.length)} ${t('files')}${listing.foldersTruncated ? ' · ' + t('foldersTruncated') : ''}`;
    $('#status-count').title = t('countHint');
    $('#selection-bar').hidden = state.selected.size === 0;
    $('#selection-count').textContent =
      `${number(state.selected.size)} ${t('selected')}`;
    document.querySelectorAll('[data-action="upload"]').forEach((element) => {
      element.disabled = state.scope !== 'folder' || !state.folderId;
      element.title = element.disabled ? t('rootHint') : '';
    });
    document
      .querySelectorAll('[data-action="new-folder"]')
      .forEach((element) => {
        element.disabled = state.scope !== 'folder';
      });
    document.querySelectorAll('[data-scope]').forEach((element) => {
      const active = element.dataset.scope === state.scope;
      element.title = t(
        element.dataset.scope === 'folder'
          ? 'library'
          : element.dataset.scope === 'all'
            ? 'allFiles'
            : 'unfiled'
      );
      element.setAttribute('aria-label', element.title);
      element.classList.remove('active');
      element.classList.toggle('is-active', active);
      element.toggleAttribute('aria-current', active);
      if (active) element.setAttribute('aria-current', 'page');
    });
    document
      .querySelectorAll('[data-open-folder]')
      .forEach((element) =>
        element.classList.toggle(
          'is-active',
          element.dataset.openFolder === state.folderId &&
            state.scope === 'folder'
        )
      );
    let loadMore = $('#load-more-files');
    if (loadMore) loadMore.remove();
    if (listing.files.length > shown.length) {
      loadMore = document.createElement('button');
      loadMore.id = 'load-more-files';
      loadMore.dataset.action = 'load-more';
      loadMore.className = 'secondary-button';
      loadMore.textContent = t('loadMore');
      $('#file-grid').after(loadMore);
    }
    renderInspector();
  }
  function renderSelection() {
    document.querySelectorAll('[data-file-id]').forEach((element) => {
      const selected = state.selected.has(element.dataset.fileId);
      element.classList.toggle('is-selected', selected);
      element.setAttribute('aria-selected', String(selected));
      element
        .querySelector('.select-toggle')
        .setAttribute('aria-pressed', String(selected));
    });
    $('#selection-bar').hidden = state.selected.size === 0;
    $('#selection-count').textContent =
      `${number(state.selected.size)} ${t('selected')}`;
    renderInspector();
  }
  function renderInspector() {
    const inspector = $('#inspector'),
      item = model.file(state.inspected);
    if (!item) {
      inspector.hidden = true;
      inspector.innerHTML = unwrapSafeHTML(
        escapeHTML`<div class="inspector-empty">${icon('image', 36)}<h3>${t('nothingSelected')}</h3><p>${t('inspectorHint')}</p></div>`
      );
      return;
    }
    inspector.hidden = false;
    const date = (value) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeZone: 'Europe/Minsk',
      }).format(new Date(value));
    const detail = (label, value) =>
      escapeHTML`<dt>${t(label)}</dt><dd dir="auto">${escapeHTML(value)}</dd>`;
    inspector.innerHTML = unwrapSafeHTML(
      escapeHTML`<div class="inspector-content"><div class="inspector-top"><span>${t('details')}</span><button class="icon-button" data-action="close-inspector" aria-label="${t('closeInspector')}">${icon('close', 17)}</button></div><div class="inspector-art">${art(item)}</div><h2 dir="auto">${escapeHTML(item.displayName)}</h2><span class="visibility ${item.bucketType}">${icon(item.bucketType === 'public' ? 'globe' : 'lock', 12)}${t(item.bucketType)}</span><dl class="detail-list">${detail('type', item.mimeType)}${detail('size', bytes(item.size))}${detail(
        'location',
        model
          .path(item.folderId)
          .map((crumb) => crumb.name)
          .join(' / ') || t('unfiled')
      )}${detail('modified', date(item.updatedAt))}${detail('created', date(item.createdAt))}${item.width && item.height ? detail('dimensions', `${item.width} × ${item.height}`) : ''}${detail('uploader', item.uploadedBy || '—')}</dl><div class="usage-list"><h3>${t('references')}</h3>${item.usedBy.length > 0 ? escapeHTML`${item.usedBy.map((usage) => escapeHTML`<p dir="auto">${escapeHTML(usage.label)}</p>`)}` : escapeHTML`<p>${t('noReferences')}</p>`}${item.hiddenUsages ? escapeHTML`<p>${number(item.hiddenUsages)} ${t('hiddenReferences')}</p>` : ''}<small>${t('referencesHint')}</small></div><div class="detail-actions"><button class="primary-button" data-item-action="${item.kind === 'image' ? 'preview' : 'download'}" data-item-id="${escapeHTML(item.id)}">${t(item.kind === 'image' ? 'preview' : 'download')}</button><button class="secondary-button" data-item-action="rename" data-item-id="${escapeHTML(item.id)}">${t('rename')}</button><button class="secondary-button" data-item-action="move" data-item-id="${escapeHTML(item.id)}">${t('move')}</button><button class="secondary-button" data-item-action="visibility" data-item-id="${escapeHTML(item.id)}">${t(item.bucketType === 'public' ? 'unpublish' : 'publish')}</button></div><p class="inspector-note">${t(item.localFile ? 'localSize' : 'sampleSize')}<br>${t(item.kind === 'document' ? 'noDocPreview' : 'demoOnly')}</p></div>`
    );
  }
  function navigate(scope, folderId = null) {
    if (scope === 'folder' && folderId && !model.folder(folderId)) return;
    state.scope = scope;
    state.folderId = folderId;
    state.selected.clear();
    state.inspected = null;
    state.anchor = null;
    state.page = 1;
    $('#search').value = '';
    $('#type-filter').value = 'all';
    $('#visibility-filter').value = 'all';
    render();
  }
  function select(id, event, toggle = false) {
    const shown = visible()
      .files.slice(0, state.page * 50)
      .map((item) => item.id);
    if (event.shiftKey && state.anchor && shown.includes(state.anchor)) {
      const start = shown.indexOf(state.anchor),
        end = shown.indexOf(id);
      if (!event.ctrlKey && !event.metaKey) state.selected.clear();
      shown
        .slice(Math.min(start, end), Math.max(start, end) + 1)
        .forEach((value) => state.selected.add(value));
    } else if (toggle || event.ctrlKey || event.metaKey) {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      state.anchor = id;
    } else {
      state.selected = new Set([id]);
      state.anchor = id;
    }
    capSelection();
    state.inspected = id;
    state.focused = id;
    renderSelection();
  }
  function capSelection() {
    if (state.selected.size <= 50) return;
    state.selected = new Set([...state.selected].slice(0, 50));
    toast(t('batchLimit'));
  }
  function rename(kind, id) {
    const item = kind === 'folder' ? model.folder(id) : model.file(id);
    if (!item) return;
    showDialog(
      t('rename'),
      escapeHTML`<label class="field-label" for="rename-input">${t(kind === 'folder' ? 'folderName' : 'fileName')}</label><input id="rename-input" class="dialog-input" dir="auto" maxlength="${kind === 'folder' ? 100 : 150}" value="${escapeHTML(kind === 'folder' ? item.name : item.displayName)}"><p class="demo-note">${t('demoOnly')}</p>`,
      escapeHTML`<button class="secondary-button" data-action="close-dialog">${t('cancel')}</button><button class="primary-button" id="save-name">${t('save')}</button>`
    );
    const run = () => {
      try {
        model.rename(kind, id, $('#rename-input').value);
        closeDialog();
        render();
        toast(t('renamed'));
      } catch (error) {
        fail(error);
      }
    };
    $('#save-name').addEventListener('click', run);
    $('#rename-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') run();
    });
    $('#rename-input').focus();
    $('#rename-input').select();
  }
  function newFolder() {
    if (state.scope !== 'folder') return;
    showDialog(
      t('newFolder'),
      escapeHTML`<label class="field-label" for="new-folder-name">${t('folderName')}</label><input class="dialog-input" id="new-folder-name" maxlength="100" dir="auto" autofocus><p class="demo-note">${t('demoOnly')}</p>`,
      escapeHTML`<button class="secondary-button" data-action="close-dialog">${t('cancel')}</button><button id="create-folder" class="primary-button">${t('newFolder')}</button>`
    );
    const run = () => {
      try {
        model.createFolder($('#new-folder-name').value, state.folderId);
        closeDialog();
        render();
        toast(t('createdFolder'));
      } catch (error) {
        fail(error);
      }
    };
    $('#create-folder').addEventListener('click', run);
    $('#new-folder-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') run();
    });
    $('#new-folder-name').focus();
  }
  function moveDialog(ids, folderId) {
    const movingFolder = folderId !== undefined;
    if (!movingFolder && (ids.length === 0 || ids.length > 50)) {
      toast(t('batchLimit'));
      return;
    }
    const excluded = movingFolder ? model.descendants(folderId) : new Set();
    const options = escapeHTML`${movingFolder ? escapeHTML`<option value="">${t('root')}</option>` : ''}${escapeHTML`${model.data.folders
      .filter((item) => !excluded.has(item.id))
      .map(
        (item) =>
          escapeHTML`<option value="${escapeHTML(item.id)}">${escapeHTML(
            model
              .path(item.id)
              .map((crumb) => crumb.name)
              .join(' / ')
          )}</option>`
      )}`}`;
    showDialog(
      t('destination'),
      escapeHTML`<label class="field-label" for="move-destination">${t('folders')}</label><select class="dialog-input" id="move-destination">${options}</select><p class="demo-note">${t(movingFolder ? 'demoOnly' : 'filesNeedFolder')}</p>`,
      escapeHTML`<button class="secondary-button" data-action="close-dialog">${t('cancel')}</button><button id="execute-move" class="primary-button">${t('moveHere')}</button>`
    );
    $('#execute-move').addEventListener('click', () => {
      try {
        const destination = $('#move-destination').value || null;
        if (movingFolder) model.moveFolder(folderId, destination);
        else model.moveFiles(ids, destination);
        state.selected.clear();
        state.inspected = null;
        closeDialog();
        render();
        toast(t('moved'));
      } catch (error) {
        fail(error);
      }
    });
  }
  function deleteFiles(ids) {
    if (ids.length === 0 || ids.length > 50) {
      toast(t('batchLimit'));
      return;
    }
    confirmAction(
      `${t('deleteConfirm')} (${number(ids.length)})`,
      t('deleteWarning'),
      () => {
        model.deleteFiles(ids);
        state.selected.clear();
        state.inspected = null;
        render();
        toast(t('removed'));
      },
      true
    );
  }
  function deleteFolder(id) {
    confirmAction(
      t('deleteConfirm'),
      t('folderDeleteWarning'),
      () => {
        model.deleteFolder(id, true);
        if (model.folder(state.folderId)) {
          render();
        } else {
          navigate('folder');
        }
        toast(t('removed'));
      },
      true
    );
  }
  function preview(id) {
    const item = model.file(id);
    if (!item) return;
    if (item.kind === 'document') {
      showDialog(
        item.displayName,
        escapeHTML`<div class="document-preview">${art(item)}</div><p class="dialog-description">${t('noDocPreview')}</p>`,
        escapeHTML`<button class="secondary-button" data-action="close-dialog">${t('close')}</button><button class="primary-button" data-item-action="download" data-item-id="${escapeHTML(id)}">${t('download')}</button>`
      );
      return;
    }
    showDialog(
      item.displayName,
      escapeHTML`<div class="large-preview">${art(item)}</div><p class="demo-note">${t(item.localFile ? 'liveFile' : 'demoItem')} · ${t(item.bucketType)}</p>`,
      escapeHTML`<button class="secondary-button" data-action="close-dialog">${t('close')}</button><button class="primary-button" data-item-action="download" data-item-id="${escapeHTML(id)}">${t('download')}</button>`
    );
  }
  function samplePDF(name) {
    const text = [...name]
      .filter(
        (character) =>
          character.codePointAt(0) >= 32 &&
          character.codePointAt(0) <= 126 &&
          !'()\\'.includes(character)
      )
      .join('');
    const stream = `BT /F1 20 Tf 64 720 Td (${text}) Tj 0 -40 Td /F1 11 Tf (File manager prototype - illustrative sample document.) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let output = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(output.length);
      output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = output.length;
    output += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return output;
  }
  function download(id) {
    const item = model.file(id);
    if (!item) return;
    const blob =
      item.localFile ||
      new Blob(
        [
          item.kind === 'image'
            ? artSVG(item.visual)
            : samplePDF(item.displayName),
        ],
        { type: item.mimeType }
      );
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = item.displayName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (!item.localFile) toast(t('downloadSample'));
  }
  function itemAction(action, id) {
    if (action === 'preview') preview(id);
    else if (action === 'download') download(id);
    else if (action === 'rename') rename('file', id);
    else if (action === 'move') moveDialog([id]);
    else if (action === 'delete') deleteFiles([id]);
    else if (action === 'copy-link') toast(t('copiedUnsupported'));
    else if (action === 'visibility') {
      const item = model.file(id);
      if (!item) return;
      const publicNext = item.bucketType !== 'public';
      confirmAction(
        t(publicNext ? 'publish' : 'unpublish'),
        t(publicNext ? 'publishWarning' : 'privateWarning'),
        () => {
          model.setVisibility(id, publicNext ? 'public' : 'private');
          render();
          toast(t('visibilityChanged'));
        }
      );
    }
  }
  function showMenu(kind, id, x, y) {
    const item = kind === 'folder' ? model.folder(id) : model.file(id);
    if (!item) return;
    const selectionMenu =
      kind === 'file' && state.selected.size > 1 && state.selected.has(id);
    const actions =
      kind === 'folder'
        ? ['open', 'rename', 'move', 'delete']
        : selectionMenu
          ? ['move', 'delete']
          : [
              'preview',
              'download',
              'rename',
              'move',
              'copy-link',
              'visibility',
              'delete',
            ];
    menu.innerHTML = unwrapSafeHTML(
      escapeHTML`${actions.map(
        (action) =>
          escapeHTML`<button data-menu-action="${action}" data-menu-kind="${kind}" data-selection="${selectionMenu}" data-item-id="${escapeHTML(id)}" class="${action === 'delete' ? 'menu-danger' : ''}">${escapeHTML(t(action === 'open' ? 'openFolder' : action === 'copy-link' ? 'copyLink' : action === 'visibility' ? (item.bucketType === 'public' ? 'unpublish' : 'publish') : action))}${selectionMenu ? ` (${number(state.selected.size)})` : ''}</button>`
      )}`
    );
    menu.hidden = false;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button').focus();
  }
  function help() {
    showDialog(
      t('supportTitle'),
      escapeHTML`<div class="capability-block"><h3>${t('supported')}</h3><p>${t('supportText')}</p></div><div class="capability-block"><h3>${t('gaps')}</h3><p>${t('gapText')}</p></div><div class="capability-block"><h3>${t('reserved')}</h3><p>${t('reservedText')}</p></div><div class="capability-block"><h3>${t('keyboard')}</h3><p>${t('keyboardHint')}</p><p>${t('interactionText')}</p></div><a href="BACKEND-CAPABILITIES.md" target="_blank" rel="noopener">Backend capability audit ↗</a><p class="demo-note">${t('demoOnly')}</p>`,
      escapeHTML`<button class="primary-button" data-action="close-dialog">${t('close')}</button>`
    );
  }
  const accepted = new Map([
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['pdf', 'application/pdf'],
    [
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  ]);
  function validateUpload(file) {
    const extension = file.name.split('.').at(-1).toLowerCase(),
      mimeType = accepted.get(extension);
    if (!mimeType || (file.type && file.type !== mimeType))
      throw new ConceptError('unsupportedType');
    if (file.size === 0) throw new ConceptError('emptyFile');
    const kind = mimeType.startsWith('image/') ? 'image' : 'document';
    if (
      file.size >
      (mimeType === 'image/svg+xml' ? 0.4 : kind === 'image' ? 1 : 10) *
        1_048_576
    )
      throw new ConceptError(
        mimeType === 'image/svg+xml'
          ? 'svgSize'
          : kind === 'image'
            ? 'imageSize'
            : 'documentSize'
      );
    normalizeName(file.name);
    return { mimeType, kind };
  }
  function queueMarkup() {
    return escapeHTML`<div class="upload-dropzone" id="upload-dropzone">${icon('upload', 34)}<p>${t('dropHint')}</p><label class="primary-button" for="upload-input">${t('chooseFiles')}</label><input id="upload-input" type="file" multiple accept=".png,.webp,.svg,.pdf,.docx,.xlsx" class="visually-hidden"></div><p class="dialog-description">${t('uploadHint')}</p><ul id="upload-queue" class="upload-queue"></ul>`;
  }
  function drawQueue() {
    const list = $('#upload-queue');
    if (!list) return;
    list.innerHTML = unwrapSafeHTML(
      escapeHTML`${queue.map(
        (item) =>
          escapeHTML`<li class="queue-item ${item.status}"><span dir="auto">${escapeHTML(item.file.name)}<small dir="ltr">${bytes(item.file.size)}</small></span><span>${t(item.error || item.status)}</span></li>`
      )}`
    );
    const stop = $('#stop-upload');
    if (stop) stop.hidden = !queueRunning;
    const retry = $('#retry-upload');
    if (retry)
      retry.hidden =
        queueRunning ||
        !queue.some((item) => ['failed', 'cancelled'].includes(item.status));
    const input = $('#upload-input');
    if (input) input.disabled = queueRunning;
  }
  function openUpload() {
    if (state.scope !== 'folder' || !state.folderId) {
      toast(t('filesNeedFolder'));
      return;
    }
    queue = [];
    queueCancelled = false;
    showDialog(
      t('uploadTitle'),
      queueMarkup(),
      escapeHTML`<button class="secondary-button" data-action="close-dialog">${t('close')}</button><button id="stop-upload" class="secondary-button" data-action="stop-upload" hidden>${t('stop')}</button><button id="retry-upload" class="primary-button" data-action="retry-upload" hidden>${t('retry')}</button>`
    );
    $('#upload-input').addEventListener('change', (event) =>
      startQueue([...event.target.files])
    );
    $('#upload-dropzone').addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!queueRunning) startQueue([...event.dataTransfer.files]);
    });
  }
  async function startQueue(files, retry = false) {
    if (queueRunning || files.length === 0) return;
    const destination = state.folderId;
    if (!model.folder(destination)) {
      toast(t('filesNeedFolder'));
      return;
    }
    if (retry) {
      queue.forEach((item) => {
        if (['failed', 'cancelled', 'queued'].includes(item.status)) {
          item.status = 'queued';
          item.error = null;
        }
      });
    } else {
      queue.push(
        ...files.map((file) => ({ file, status: 'queued', error: null }))
      );
    }
    queueRunning = true;
    queueCancelled = false;
    const generation = ++queueGeneration;
    let done = 0;
    const pending = queue.filter((entry) => entry.status === 'queued');
    for (const item of pending) {
      if (generation !== queueGeneration) return;
      if (queueCancelled) {
        item.status = 'cancelled';
        continue;
      }
      item.status = 'uploading';
      drawQueue();
      await new Promise((resolve) => setTimeout(resolve, 220));
      if (generation !== queueGeneration) return;
      if (queueCancelled) {
        item.status = 'cancelled';
        continue;
      }
      let localURL;
      try {
        const specification = validateUpload(item.file);
        localURL = URL.createObjectURL(item.file);
        let width = null,
          height = null;
        if (specification.kind === 'image') {
          const image = new Image();
          image.src = localURL;
          await image.decode();
          if (specification.mimeType !== 'image/svg+xml') {
            width = image.naturalWidth;
            height = image.naturalHeight;
            if (width * height > 25e6 || width > 16_383 || height > 16_383)
              throw new ConceptError('imageDimensions');
          }
        }
        if (generation !== queueGeneration || queueCancelled) {
          URL.revokeObjectURL(localURL);
          item.status = 'cancelled';
          continue;
        }
        model.addFile({
          id: crypto.randomUUID(),
          displayName: item.file.name,
          folderId: destination,
          ...specification,
          size: item.file.size,
          width,
          height,
          blurhash: null,
          uploadedBy: 'demo-user',
          localURL,
          localFile: item.file,
        });
        objectURLs.add(localURL);
        item.status = 'complete';
        done++;
        render();
      } catch (error) {
        if (localURL) URL.revokeObjectURL(localURL);
        item.status = 'failed';
        item.error =
          error instanceof ConceptError ? error.code : 'unknownError';
      }
      drawQueue();
    }
    if (generation !== queueGeneration) return;
    queueRunning = false;
    drawQueue();
    if (done) toast(t('uploadDone'));
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, a, [data-file-id]');
    if (!event.target.closest('#concept-menu')) menu.hidden = true;
    if (!target) return;
    if (target.dataset.openFolder !== undefined) {
      navigate('folder', target.dataset.openFolder);
      return;
    }
    if (target.dataset.scope) {
      navigate(target.dataset.scope);
      return;
    }
    if (target.dataset.selectFile) {
      select(target.dataset.selectFile, event, true);
      return;
    }
    if (target.dataset.fileMenu || target.dataset.folderMenu) {
      const rect = target.getBoundingClientRect();
      showMenu(
        target.dataset.folderMenu ? 'folder' : 'file',
        target.dataset.folderMenu || target.dataset.fileMenu,
        rect.left,
        rect.bottom + 4
      );
      return;
    }
    if (target.dataset.menuAction) {
      menu.hidden = true;
      const action = target.dataset.menuAction,
        id = target.dataset.itemId;
      if (target.dataset.menuKind === 'folder') {
        if (action === 'open') navigate('folder', id);
        else if (action === 'rename') rename('folder', id);
        else if (action === 'move') moveDialog([], id);
        else if (action === 'delete') deleteFolder(id);
      } else if (target.dataset.selection === 'true') {
        if (action === 'move') moveDialog([...state.selected]);
        else if (action === 'delete') deleteFiles([...state.selected]);
      } else itemAction(action, id);
      return;
    }
    if (target.dataset.itemAction) {
      itemAction(target.dataset.itemAction, target.dataset.itemId);
      return;
    }
    const action = target.dataset.action;
    if (action) {
      if (action === 'locale') {
        locale = locale === 'ar' ? 'en' : 'ar';
        translate();
        render();
      } else if (action === 'new-folder') newFolder();
      else if (action === 'upload') openUpload();
      else if (action === 'help') help();
      else if (action === 'reset') {
        queueGeneration++;
        queueCancelled = true;
        queueRunning = false;
        objectURLs.forEach((url) => URL.revokeObjectURL(url));
        objectURLs.clear();
        model = createModel();
        navigate('folder', 'brand');
      } else if (action === 'select-all') {
        state.selected = new Set(
          visible()
            .files.slice(0, state.page * 50)
            .map((item) => item.id)
        );
        capSelection();
        state.inspected = [...state.selected][0] || null;
        renderSelection();
      } else if (action === 'clear-selection') {
        state.selected.clear();
        state.inspected = null;
        renderSelection();
      } else if (action === 'move') moveDialog([...state.selected]);
      else if (action === 'delete') deleteFiles([...state.selected]);
      else if (action === 'close-inspector') {
        state.inspected = null;
        renderInspector();
      } else if (action === 'close-dialog') closeDialog();
      else if (action === 'stop-upload') {
        queueCancelled = true;
      } else if (action === 'retry-upload')
        startQueue(
          queue
            .filter((item) =>
              ['failed', 'cancelled', 'queued'].includes(item.status)
            )
            .map((item) => item.file),
          true
        );
      else if (action === 'load-more') {
        state.page++;
        render();
      }
      return;
    }
    const card = target.closest('[data-file-id]');
    if (card) select(card.dataset.fileId, event);
  });
  document.addEventListener('dblclick', (event) => {
    const card = event.target.closest('[data-file-id]');
    if (card && !event.target.closest('button')) preview(card.dataset.fileId);
  });
  document.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('[data-file-id], [data-folder-id]');
    if (!card) return;
    event.preventDefault();
    if (card.dataset.fileId && !state.selected.has(card.dataset.fileId))
      select(card.dataset.fileId, event);
    showMenu(
      card.dataset.folderId ? 'folder' : 'file',
      card.dataset.folderId || card.dataset.fileId,
      event.clientX,
      event.clientY
    );
  });
  ['search', 'type-filter', 'visibility-filter', 'sort'].forEach((id) =>
    $('#' + id).addEventListener(id === 'search' ? 'input' : 'change', () => {
      state.page = 1;
      state.selected.clear();
      state.inspected = null;
      render();
    })
  );
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select') || dialog.open) return;
    if (!menu.hidden) {
      if (event.key === 'Escape') {
        menu.hidden = true;
        return;
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const buttons = [...menu.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        event.preventDefault();
        buttons[
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length
        ].focus();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#search').focus();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      state.selected = new Set(
        visible()
          .files.slice(0, state.page * 50)
          .map((item) => item.id)
      );
      capSelection();
      renderSelection();
    }
    if (event.key === 'Escape') {
      state.selected.clear();
      state.inspected = null;
      renderSelection();
      menu.hidden = true;
    }
    if (event.key === 'Delete' && state.selected.size > 0) {
      event.preventDefault();
      deleteFiles([...state.selected]);
    }
    if (event.key === 'F2' && state.selected.size === 1) {
      event.preventDefault();
      rename('file', [...state.selected][0]);
    }
    const card = event.target.closest('[data-file-id]');
    if (
      card &&
      [
        ' ',
        'Enter',
        'ArrowRight',
        'ArrowLeft',
        'ArrowDown',
        'ArrowUp',
      ].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === ' ') select(card.dataset.fileId, event, true);
      else if (event.key === 'Enter') preview(card.dataset.fileId);
      else {
        const cards = [...document.querySelectorAll('[data-file-id]')];
        const index = cards.indexOf(card);
        const firstRow = cards[0].getBoundingClientRect().top;
        const columns = cards.filter(
          (item) => Math.abs(item.getBoundingClientRect().top - firstRow) < 1
        ).length;
        const horizontalDirection = event.key === 'ArrowRight' ? 1 : -1;
        const direction =
          event.key === 'ArrowDown'
            ? columns
            : event.key === 'ArrowUp'
              ? -columns
              : horizontalDirection * (locale === 'ar' ? -1 : 1);
        const next =
          cards[Math.max(0, Math.min(cards.length - 1, index + direction))];
        next.focus();
        if (event.shiftKey) select(next.dataset.fileId, event);
      }
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        closeDialog();
    }
  });

  let dragged = null;
  document.addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-file-id], [data-folder-id]');
    if (!card) return;
    if (card.dataset.fileId) {
      if (!state.selected.has(card.dataset.fileId))
        select(card.dataset.fileId, event);
      dragged = { kind: 'files', ids: [...state.selected] };
    } else dragged = { kind: 'folder', id: card.dataset.folderId };
    event.dataTransfer.setData(
      'application/x-media-concept',
      JSON.stringify(dragged)
    );
    event.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', (event) => {
    const destination = event.target.closest('[data-drop-folder]');
    if (dragged && destination) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      document
        .querySelectorAll('.is-drop-target')
        .forEach((element) => element.classList.remove('is-drop-target'));
      destination.classList.add('is-drop-target');
    } else if ([...event.dataTransfer.types].includes('Files')) {
      event.preventDefault();
      $('#drop-overlay').textContent = t(
        state.scope === 'folder' && state.folderId
          ? 'dropHint'
          : 'filesNeedFolder'
      );
      $('#drop-overlay').hidden = Boolean(dialog.open);
    }
  });
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) $('#drop-overlay').hidden = true;
  });
  document.addEventListener('dragend', () => {
    dragged = null;
    document
      .querySelectorAll('.is-drop-target')
      .forEach((element) => element.classList.remove('is-drop-target'));
    $('#drop-overlay').hidden = true;
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    $('#drop-overlay').hidden = true;
    document
      .querySelectorAll('.is-drop-target')
      .forEach((element) => element.classList.remove('is-drop-target'));
    const destination = event.target.closest('[data-drop-folder]');
    if (dragged && destination) {
      try {
        if (dragged.kind === 'files')
          model.moveFiles(dragged.ids, destination.dataset.dropFolder);
        else model.moveFolder(dragged.id, destination.dataset.dropFolder);
        state.selected.clear();
        state.inspected = null;
        render();
        toast(t('moved'));
      } catch (error) {
        fail(error);
      }
      dragged = null;
      return;
    }
    if (event.dataTransfer.files.length > 0) {
      if (
        [...event.dataTransfer.items].some(
          (item) => item.webkitGetAsEntry?.()?.isDirectory
        )
      ) {
        toast(t('folderDrop'));
        return;
      }
      if (dialog.open && $('#upload-input')) {
        if (!queueRunning) startQueue([...event.dataTransfer.files]);
        return;
      }
      if (state.scope !== 'folder' || !state.folderId) {
        toast(t('filesNeedFolder'));
        return;
      }
      openUpload();
      startQueue([...event.dataTransfer.files]);
    }
    dragged = null;
  });

  let lasso = null;
  const fileGrid = $('#file-grid');
  fileGrid.addEventListener('pointerdown', (event) => {
    if (
      event.button !== 0 ||
      event.pointerType === 'touch' ||
      event.target.closest('[data-file-id], button, a')
    )
      return;
    lasso = {
      x: event.clientX,
      y: event.clientY,
      base:
        event.ctrlKey || event.metaKey || event.shiftKey
          ? new Set(state.selected)
          : new Set(),
      moved: false,
    };
    fileGrid.setPointerCapture(event.pointerId);
  });
  fileGrid.addEventListener('pointermove', (event) => {
    if (!lasso) return;
    const width = Math.abs(event.clientX - lasso.x),
      height = Math.abs(event.clientY - lasso.y);
    if (width + height < 5) return;
    lasso.moved = true;
    const x = Math.min(lasso.x, event.clientX),
      y = Math.min(lasso.y, event.clientY);
    const rectangle = $('#selection-rectangle');
    rectangle.hidden = false;
    Object.assign(rectangle.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    state.selected = new Set(lasso.base);
    fileGrid.querySelectorAll('[data-file-id]').forEach((element) => {
      const bounds = element.getBoundingClientRect();
      if (
        bounds.left < x + width &&
        bounds.right > x &&
        bounds.top < y + height &&
        bounds.bottom > y
      )
        state.selected.add(element.dataset.fileId);
    });
    capSelection();
    renderSelection();
  });
  function finishLasso() {
    if (!lasso) return;
    if (!lasso.moved) {
      state.selected = new Set(lasso.base);
      state.inspected = null;
      renderSelection();
    }
    lasso = null;
    $('#selection-rectangle').hidden = true;
  }
  fileGrid.addEventListener('pointerup', finishLasso);
  fileGrid.addEventListener('pointercancel', finishLasso);
  window.addEventListener('beforeunload', () => {
    objectURLs.forEach((url) => URL.revokeObjectURL(url));
  });
  window.addEventListener('resize', () => {
    menu.hidden = true;
  });
  translate();
  render();
})();
