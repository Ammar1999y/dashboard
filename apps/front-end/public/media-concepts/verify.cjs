'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createModel,
  normalizeName,
  seed,
  ConceptError,
  escapeHTML,
  unwrapSafeHTML,
} = require('./shared.js');

let passed = 0;
let failed = 0;
let skipped = 0;
const requireAll = process.argv.includes('--require-all');
const compareText = (left, right) => left.localeCompare(right);

function localPath(filename) {
  const resolved = path.resolve(__dirname, filename);
  const relative = path.relative(__dirname, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      'Verification files must stay inside the concept directory.'
    );
  return resolved;
}

function readLocal(filename) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- localPath confines reads to the concept directory.
  return fs.readFileSync(localPath(filename), 'utf8');
}

function hasLocalFile(filename) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- localPath confines checks to the concept directory.
  return fs.existsSync(localPath(filename));
}

function isRemote(value) {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('//') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://')
  );
}

function check(name, run) {
  try {
    run();
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed++;
    process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
  }
}

function rejects(model, code, run) {
  const before = structuredClone(model.data);
  assert.throws(
    run,
    (error) => error instanceof ConceptError && error.code === code
  );
  assert.deepEqual(
    model.data,
    before,
    'Rejected operations must preserve all files and folders.'
  );
}

check(
  'HTML templates escape data, compose fragments and refuse raw markup',
  () => {
    const name = '<img src=x onerror="alert(1)"> & \'quoted\'';
    const escaped =
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;';
    assert.equal(
      unwrapSafeHTML(escapeHTML`<p>${name}</p>`),
      `<p>${escaped}</p>`
    );
    assert.equal(
      unwrapSafeHTML(escapeHTML`<input value="${name}">`),
      `<input value="${escaped}">`
    );
    const nested = [
      escapeHTML`<li>${name}</li>`,
      escapeHTML`<li>${'second'}</li>`,
    ];
    assert.equal(
      unwrapSafeHTML(escapeHTML`<ul>${nested}</ul>`),
      `<ul><li>${escaped}</li><li>second</li></ul>`
    );
    assert.equal(
      unwrapSafeHTML(escapeHTML`<p>${escapeHTML(name)}</p>`),
      `<p>${escaped}</p>`
    );
    assert.throws(() => unwrapSafeHTML(name), TypeError);
    assert.throws(() => unwrapSafeHTML({}), TypeError);
    assert.throws(() => localPath('../outside.html'));
  }
);

const sample = seed();
const folderRecord = (id, parentId = null, name = id) => ({
  ...sample.folders[0],
  id,
  parentId,
  name,
});
const fileRecord = (id, folderId = 'origin', overrides = {}) => ({
  ...sample.files[0],
  id,
  folderId,
  displayName: `${id}.svg`,
  usedBy: [],
  hiddenUsages: 0,
  bucketType: 'private',
  ...overrides,
});
const fixture = (files = [fileRecord('one'), fileRecord('two')]) => ({
  folders: [folderRecord('origin'), folderRecord('destination')],
  files,
});
const chain = (length) =>
  Array.from({ length }, (_, index) =>
    folderRecord(`level-${index + 1}`, index ? `level-${index}` : null)
  );

check('Exports expose typed failures and independent valid sample data', () => {
  assert.equal(typeof createModel, 'function');
  assert.equal(typeof normalizeName, 'function');
  assert.equal(new ConceptError('missing').code, 'missing');
  const one = seed();
  const two = seed();
  one.folders[0].name = 'Changed';
  assert.notEqual(one.folders[0].name, two.folders[0].name);
  const folderIds = new Set(two.folders.map((item) => item.id));
  assert.equal(folderIds.size, two.folders.length);
  assert.equal(
    new Set(two.files.map((item) => item.id)).size,
    two.files.length
  );
  two.folders.forEach((item) =>
    assert(item.parentId === null || folderIds.has(item.parentId))
  );
  two.files.forEach((item) => {
    assert(
      folderIds.has(item.folderId),
      'Sample library files must live inside folders.'
    );
    if (item.kind === 'document') assert.equal(item.bucketType, 'private');
  });
});

check('Model mutations leave the supplied fixture untouched', () => {
  const initial = fixture();
  const before = structuredClone(initial);
  const model = createModel(initial);
  model.moveFiles(['one'], 'destination');
  model.rename('folder', 'origin', 'Originals');
  assert.deepEqual(initial, before);
});

check(
  'Names normalize Unicode and whitespace while enforcing file and folder limits',
  () => {
    assert.equal(
      normalizeName('  Cafe\u{301}   collection  ', true),
      'Café collection'
    );
    assert.equal(normalizeName('  final   asset.svg  '), 'final asset.svg');
    assert.equal(normalizeName('f'.repeat(100), true).length, 100);
    assert.equal(normalizeName('f'.repeat(150)).length, 150);
    for (const [name, folder] of [
      ['', false],
      [' '.repeat(3), true],
      ['x/y', false],
      [String.raw`x\y`, true],
      ['a\u{0}b', false],
      ['a\u{200B}b', true],
      ['.', true],
      ['..', true],
      ['f'.repeat(101), true],
      ['f'.repeat(151), false],
    ])
      assert.throws(
        () => normalizeName(name, folder),
        (error) => error instanceof ConceptError && error.code === 'invalidName'
      );
  }
);

check(
  'Normalized sibling folder names reject duplicate create and rename without changes',
  () => {
    const model = createModel(fixture([]));
    model.createFolder('Cafe\u{301}   assets', 'origin');
    rejects(model, 'duplicateFolder', () =>
      model.createFolder('  CAFÉ assets  ', 'origin')
    );
    const other = model.createFolder('Other', 'origin');
    rejects(model, 'duplicateFolder', () =>
      model.rename('folder', other.id, 'café assets')
    );
    model.createFolder('Café assets', 'destination');
  }
);

check('Moving a folder rejects sibling name collisions atomically', () => {
  const initial = fixture([]);
  initial.folders.push(
    folderRecord('a', 'origin', 'Campaign'),
    folderRecord('b', 'destination', 'CAMPAIGN')
  );
  const model = createModel(initial);
  rejects(model, 'duplicateFolder', () => model.moveFolder('a', 'destination'));
});

check('Files cannot be moved or uploaded to the library root', () => {
  const model = createModel(fixture());
  rejects(model, 'filesNeedFolder', () =>
    model.moveFiles(['one', 'two'], null)
  );
  rejects(model, 'filesNeedFolder', () =>
    model.addFile(fileRecord('new', null))
  );
  rejects(model, 'filesNeedFolder', () =>
    model.moveFiles(['one'], 'missing-folder')
  );
});

check(
  'Folder moves reject self and descendant cycles with the subtree preserved',
  () => {
    const initial = fixture([]);
    initial.folders.push(
      folderRecord('child', 'origin'),
      folderRecord('grandchild', 'child')
    );
    const model = createModel(initial);
    rejects(model, 'cycle', () => model.moveFolder('origin', 'origin'));
    rejects(model, 'cycle', () => model.moveFolder('origin', 'grandchild'));
    model.moveFolder('child', 'destination');
    assert.equal(model.folder('child').parentId, 'destination');
    assert.equal(model.folder('grandchild').parentId, 'child');
  }
);

check('Empty bulk moves and deletions fail without changing data', () => {
  const model = createModel(fixture());
  rejects(model, 'batchLimit', () => model.moveFiles([], 'destination'));
  rejects(model, 'batchLimit', () => model.deleteFiles([]));
});

check('The 50-file bulk ceiling rejects 51 files before any mutation', () => {
  const files = Array.from({ length: 51 }, (_, index) =>
    fileRecord(`file-${index}`)
  );
  const model = createModel(fixture(files));
  const ids = files.map((item) => item.id);
  rejects(model, 'batchLimit', () => model.moveFiles(ids, 'destination'));
  rejects(model, 'batchLimit', () => model.deleteFiles(ids));
});

check('Exactly 50 files can move together and delete together', () => {
  const files = Array.from({ length: 50 }, (_, index) =>
    fileRecord(`file-${index}`)
  );
  const model = createModel(fixture(files));
  const ids = files.map((item) => item.id);
  model.moveFiles(ids, 'destination');
  assert(model.data.files.every((item) => item.folderId === 'destination'));
  model.deleteFiles(ids);
  assert.equal(model.data.files.length, 0);
  assert.equal(model.data.folders.length, 2);
});

check('A missing member rejects the entire bulk move or deletion', () => {
  const model = createModel(fixture());
  rejects(model, 'missing', () =>
    model.moveFiles(['one', 'missing', 'two'], 'destination')
  );
  rejects(model, 'missing', () => model.deleteFiles(['one', 'missing', 'two']));
});

check('A transitioning member rejects the entire bulk move or deletion', () => {
  const model = createModel(
    fixture([
      fileRecord('one'),
      fileRecord('busy', 'origin', { transition: 'to_public' }),
    ])
  );
  rejects(model, 'busy', () => model.moveFiles(['one', 'busy'], 'destination'));
  rejects(model, 'busy', () => model.deleteFiles(['one', 'busy']));
});

check(
  'Visible and restricted references prevent any deletion in a batch',
  () => {
    for (const usage of [
      {
        usedBy: [{ label: 'Home page', resource: 'page', recordId: 'page-1' }],
      },
      { hiddenUsages: 1 },
    ]) {
      const model = createModel(
        fixture([
          fileRecord('one'),
          fileRecord('referenced', 'origin', usage),
          fileRecord('two'),
        ])
      );
      rejects(model, 'inUse', () =>
        model.deleteFiles(['one', 'referenced', 'two'])
      );
    }
  }
);

check(
  'A successful bulk deletion preserves unselected files and folders',
  () => {
    const model = createModel(
      fixture([
        fileRecord('one'),
        fileRecord('two'),
        fileRecord('keep', 'destination'),
      ])
    );
    model.deleteFiles(['one', 'two']);
    assert.deepEqual(
      model.data.files.map((item) => item.id),
      ['keep']
    );
    assert.deepEqual(
      model.data.folders.map((item) => item.id),
      ['origin', 'destination']
    );
  }
);

check(
  'Recursive deletion leaves the entire subtree intact when a descendant file is referenced',
  () => {
    const initial = fixture([
      fileRecord('one'),
      fileRecord('referenced', 'nested', { hiddenUsages: 1 }),
      fileRecord('keep', 'destination'),
    ]);
    initial.folders.push(
      folderRecord('nested', 'origin'),
      folderRecord('empty-descendant', 'nested')
    );
    const model = createModel(initial);
    rejects(model, 'inUse', () => model.deleteFolder('origin', true));
  }
);

check(
  'Recursive deletion rejects a busy descendant before removing other items',
  () => {
    const initial = fixture([
      fileRecord('one'),
      fileRecord('busy', 'nested', { transition: 'cleanup' }),
    ]);
    initial.folders.push(folderRecord('nested', 'origin'));
    const model = createModel(initial);
    rejects(model, 'busy', () => model.deleteFolder('origin', true));
  }
);

check(
  'Nonempty folders require recursive deletion and successful recursion preserves other branches',
  () => {
    const initial = fixture([
      fileRecord('one'),
      fileRecord('child-file', 'nested'),
      fileRecord('keep', 'destination'),
    ]);
    initial.folders.push(folderRecord('nested', 'origin'));
    const model = createModel(initial);
    rejects(model, 'folderNotEmpty', () => model.deleteFolder('origin', false));
    model.deleteFolder('origin', true);
    assert.deepEqual(
      model.data.folders.map((item) => item.id),
      ['destination']
    );
    assert.deepEqual(
      model.data.files.map((item) => item.id),
      ['keep']
    );
  }
);

check(
  'Recursive deletion caps descendants plus files at 200, excluding the selected folder',
  () => {
    for (const count of [199, 200]) {
      const files = Array.from({ length: count }, (_, index) =>
        fileRecord(`file-${index}`, 'nested')
      );
      const initial = fixture(files);
      initial.folders.push(folderRecord('nested', 'origin'));
      const model = createModel(initial);
      if (count === 200)
        rejects(model, 'recursiveLimit', () =>
          model.deleteFolder('origin', true)
        );
      else {
        model.deleteFolder('origin', true);
        assert.deepEqual(
          model.data.folders.map((item) => item.id),
          ['destination']
        );
        assert.equal(model.data.files.length, 0);
      }
    }
  }
);

check('The tenth folder level is allowed and an eleventh is rejected', () => {
  const model = createModel({ folders: chain(9), files: [] });
  const tenth = model.createFolder('Tenth level', 'level-9');
  assert.equal(model.path(tenth.id).length, 10);
  rejects(model, 'depthLimit', () => model.createFolder('Too deep', tenth.id));
});

check('Folder moves account for the depth of the entire subtree', () => {
  const initial = {
    folders: [
      ...chain(9),
      folderRecord('branch'),
      folderRecord('leaf', 'branch'),
    ],
    files: [],
  };
  const model = createModel(initial);
  rejects(model, 'depthLimit', () => model.moveFolder('branch', 'level-9'));
  model.moveFolder('branch', 'level-8');
  assert.equal(model.path('leaf').length, 10);
  model.moveFolder('branch', null);
  assert.equal(model.path('leaf').length, 2);
});

check(
  'Parents stop accepting child folders at 500 without rejecting a rename in place',
  () => {
    const initial = fixture([]);
    initial.folders.push(
      ...Array.from({ length: 500 }, (_, index) =>
        folderRecord(`child-${index}`, 'origin')
      )
    );
    const model = createModel(initial);
    rejects(model, 'childrenLimit', () =>
      model.createFolder('One too many', 'origin')
    );
    rejects(model, 'childrenLimit', () =>
      model.moveFolder('destination', 'origin')
    );
    model.rename('folder', 'child-0', 'Renamed child');
    assert.equal(model.folder('child-0').name, 'Renamed child');
  }
);

check(
  'Images and documents can publish and unpublish while invalid visibility is rejected',
  () => {
    const initial = fixture([
      fileRecord('image'),
      fileRecord('document', 'origin', {
        kind: 'document',
        mimeType: 'application/pdf',
        displayName: 'brief.pdf',
      }),
    ]);
    const model = createModel(initial);
    rejects(model, 'invalidVisibility', () =>
      model.setVisibility('image', 'shared')
    );
    for (const id of ['image', 'document']) {
      model.setVisibility(id, 'public');
      assert.equal(model.file(id).bucketType, 'public');
      model.setVisibility(id, 'private');
      assert.equal(model.file(id).bucketType, 'private');
    }
  }
);

check(
  'Public references block unpublishing without affecting an already-private no-op',
  () => {
    const model = createModel(
      fixture([
        fileRecord('public-file', 'origin', {
          bucketType: 'public',
          hasPublicUsage: true,
        }),
        fileRecord('private-file', 'origin', {
          bucketType: 'private',
          hasPublicUsage: true,
        }),
      ])
    );
    rejects(model, 'publicInUse', () =>
      model.setVisibility('public-file', 'private')
    );
    model.setVisibility('private-file', 'private');
    assert.equal(model.file('private-file').bucketType, 'private');
  }
);

check(
  'Record-held files cannot be renamed, adopted or published through the library',
  () => {
    const model = createModel(
      fixture([
        fileRecord('one'),
        fileRecord('record-held', null, {
          usedBy: [
            { label: 'Content record', resource: 'page', recordId: 'page-1' },
          ],
        }),
      ])
    );
    rejects(model, 'missing', () =>
      model.moveFiles(['one', 'record-held'], 'destination')
    );
    rejects(model, 'missing', () =>
      model.rename('file', 'record-held', 'New name.svg')
    );
    rejects(model, 'missing', () =>
      model.setVisibility('record-held', 'public')
    );
  }
);

check('Newly added files always start private', () => {
  const model = createModel(fixture([]));
  model.addFile(fileRecord('new', 'origin', { bucketType: 'public' }));
  assert.equal(model.file('new').bucketType, 'private');
  rejects(model, 'duplicateId', () =>
    model.addFile(fileRecord('new', 'destination'))
  );
});

check(
  'Adopting a dormant unfiled fixture clears its retention clock and preserves file identity',
  () => {
    for (const stamp of ['2026-10-01T08:00:00Z', null]) {
      const orphan = fileRecord('orphan', null, { unfiledAt: stamp });
      const model = createModel(fixture([orphan]));
      model.moveFiles(['orphan'], 'destination');
      const adopted = model.file('orphan');
      assert.equal(adopted.folderId, 'destination');
      assert.equal(adopted.unfiledAt, null);
      for (const key of [
        'id',
        'displayName',
        'createdAt',
        'mimeType',
        'size',
        'bucketType',
        'uploadedBy',
      ])
        assert.equal(adopted[key], orphan[key]);
      assert(!Number.isNaN(Date.parse(adopted.updatedAt)));
    }
  }
);

function tags(html) {
  return [...html.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi)].map((match) => {
    const attributes = Object.create(null);
    const entries = (match[2] || '').matchAll(
      // eslint-disable-next-line security/detect-unsafe-regex -- This parser inspects repository-owned HTML only.
      /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    );
    for (const entry of entries) {
      attributes[entry[1].toLowerCase()] =
        entry[2] ?? entry[3] ?? entry[4] ?? '';
    }
    return { tag: match[1].toLowerCase(), attributes };
  });
}

let translations;
check('Both locales define the same translation keys', () => {
  const source = readLocal(path.join(__dirname, 'shared.js'));
  const dictionary = source.match(
    /\bconst copy\s*=\s*(\{[\s\S]*?\n\s*\});\s*\n\s*let locale/
  );
  assert(
    dictionary,
    'Expected the shared locale dictionary to be a standalone object literal.'
  );
  translations = vm.runInNewContext(`(${dictionary[1]})`, Object.create(null), {
    timeout: 1000,
  });
  assert.deepEqual(
    Object.keys(translations.en).sort(compareText),
    Object.keys(translations.ar).sort(compareText)
  );
  for (const locale of ['en', 'ar']) {
    const values = Object.values(translations[locale]);
    for (const value of values) assert.equal(typeof value, 'string');
  }
});

for (const design of ['harbor', 'studio', 'vault']) {
  const filename = `${design}.html`;
  const filepath = path.join(__dirname, filename);
  if (!requireAll && !hasLocalFile(filepath)) {
    skipped++;
    process.stdout.write(
      `SKIP ${filename}: not created yet; use --require-all for the final check.\n`
    );
    continue;
  }
  check(`${filename} satisfies the interactive HTML contract`, () => {
    assert(hasLocalFile(filepath), `${filename} must exist.`);
    const html = readLocal(filepath);
    const elements = tags(html);
    const ids = elements
      .filter((item) => 'id' in item.attributes)
      .map((item) => item.attributes.id);
    assert.equal(new Set(ids).size, ids.length, 'IDs must be unique.');
    const byId = (id) => elements.find((item) => item.attributes.id === id);
    for (const id of [
      'breadcrumb',
      'location-title',
      'folder-grid',
      'file-grid',
      'status-count',
      'selection-bar',
      'selection-count',
      'search',
      'type-filter',
      'visibility-filter',
      'sort',
      'inspector',
    ])
      assert(byId(id), `Missing #${id}.`);
    assert.equal(byId('search').tag, 'input');
    assert.equal(byId('inspector').tag, 'aside');
    assert(
      'hidden' in byId('selection-bar').attributes,
      'The selection toolbar starts hidden.'
    );
    assert(
      'hidden' in byId('inspector').attributes,
      'The detail inspector starts hidden.'
    );
    assert(
      !elements.some((item) => item.tag === 'table'),
      'Concepts must present a file manager rather than a table.'
    );
    assert(
      elements.some(
        (item) =>
          item.tag === 'body' && item.attributes['data-design'] === design
      )
    );
    assert(
      elements.some(
        (item) =>
          item.tag === 'html' &&
          item.attributes.dir === 'rtl' &&
          item.attributes.lang === 'ar'
      )
    );
    const actions = new Set(
      elements.map((item) => item.attributes['data-action']).filter(Boolean)
    );
    for (const action of [
      'upload',
      'new-folder',
      'locale',
      'help',
      'reset',
      'move',
      'delete',
      'select-all',
      'clear-selection',
    ])
      assert(actions.has(action), `Missing ${action} action.`);
    const scopes = new Set(
      elements.map((item) => item.attributes['data-scope']).filter(Boolean)
    );
    for (const scope of ['folder', 'all', 'unfiled'])
      assert(scopes.has(scope), `Missing ${scope} scope.`);
    for (const [id, values] of [
      ['type-filter', ['all', 'image', 'document']],
      ['visibility-filter', ['all', 'private', 'public']],
      ['sort', ['name', 'newest', 'size']],
    ]) {
      assert.equal(byId(id).tag, 'select');
      const selectors = [
        ...html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select\s*>/gi),
      ];
      const selector = selectors.find(
        (match) => tags(match[0])[0].attributes.id === id
      );
      assert(selector, `Cannot inspect #${id}.`);
      const options = tags(selector[1])
        .filter((item) => item.tag === 'option')
        .map((item) => item.attributes.value);
      assert.deepEqual(
        options.sort(compareText),
        values.sort(compareText),
        `Unexpected option contract for #${id}.`
      );
    }
    const scripts = elements.filter((item) => item.tag === 'script');
    assert.equal(
      scripts.length,
      1,
      'Each concept shares a single behavior engine.'
    );
    assert.equal(scripts[0].attributes.src, 'shared.js');
    assert('defer' in scripts[0].attributes);
    const css = elements
      .filter(
        (item) => item.tag === 'link' && item.attributes.rel === 'stylesheet'
      )
      .map((item) => item.attributes.href);
    assert.deepEqual(css, ['shared.css', `${design}.css`]);
    for (const item of elements) {
      const dependency = ['script', 'img', 'source', 'link'].includes(item.tag)
        ? item.attributes.src || item.attributes.href
        : null;
      if (dependency) {
        assert(!isRemote(dependency), `Remote dependency: ${dependency}`);
        if (!dependency.startsWith('data:'))
          assert(
            hasLocalFile(path.resolve(__dirname, dependency)),
            `Missing local dependency: ${dependency}`
          );
      }
      for (const attribute of ['data-i18n', 'data-i18n-placeholder']) {
        const key = item.attributes[attribute];
        if (key)
          for (const locale of ['en', 'ar'])
            assert(
              translations && Object.hasOwn(translations[locale], key),
              `Unknown ${locale} translation: ${key}`
            );
      }
    }
    const links = elements
      .filter((item) => item.tag === 'a')
      .map((item) => item.attributes.href);
    assert(
      links.includes('index.html'),
      'Each concept must link back to the comparison page.'
    );
  });
}

check(
  'Comparison page has unique IDs, local dependencies, all concepts and the audit report',
  () => {
    const filepath = path.join(__dirname, 'index.html');
    assert(hasLocalFile(filepath), 'The comparison page must exist.');
    const elements = tags(readLocal(filepath));
    const ids = elements
      .filter((item) => 'id' in item.attributes)
      .map((item) => item.attributes.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      'Comparison page IDs must be unique.'
    );
    const toggle = elements.find(
      (item) => item.attributes.id === 'locale-toggle'
    );
    assert(
      toggle && toggle.tag === 'button',
      'The language toggle must be a button.'
    );
    assert(
      elements.some(
        (item) =>
          item.tag === 'html' &&
          item.attributes.lang === 'ar' &&
          item.attributes.dir === 'rtl'
      )
    );
    const links = new Set(
      elements
        .filter((item) => item.tag === 'a')
        .map((item) => item.attributes.href)
    );
    for (const destination of [
      'harbor.html',
      'studio.html',
      'vault.html',
      'BACKEND-CAPABILITIES.md',
    ])
      assert(links.has(destination), `Missing comparison link: ${destination}`);
    const scripts = elements.filter((item) => item.tag === 'script');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].attributes.src, 'compare.js');
    assert('defer' in scripts[0].attributes);
    const stylesheets = elements.filter(
      (item) => item.tag === 'link' && item.attributes.rel === 'stylesheet'
    );
    assert.deepEqual(
      stylesheets.map((item) => item.attributes.href),
      ['compare.css']
    );
    for (const item of elements) {
      const destinations = ['src', 'href']
        .map((attribute) => item.attributes[attribute])
        .filter(Boolean);
      for (const destination of destinations) {
        assert(
          !isRemote(destination),
          `Remote comparison dependency: ${destination}`
        );
        if (!destination.startsWith('data:') && !destination.startsWith('#'))
          assert(
            hasLocalFile(path.resolve(__dirname, destination)),
            `Missing local comparison file: ${destination}`
          );
      }
    }
  }
);

let comparisonLabels;
let comparisonEnglish;
check(
  'Comparison English keys match the Arabic labels extracted from HTML',
  () => {
    const html = readLocal(path.join(__dirname, 'index.html'));
    comparisonLabels = [
      ...html.matchAll(
        /<([a-z][\w:-]*)\b[^>]*\bdata-copy\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1\s*>/gi
      ),
    ].map((match) => ({
      dataset: { copy: match[2] },
      textContent: match[3]
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    }));
    const source = readLocal(path.join(__dirname, 'compare.js'));
    const dictionary = source.match(
      /\bconst english\s*=\s*(\{[\s\S]*?\n\s*\});\s*\n\s*const arabic/
    );
    assert(
      dictionary,
      'Expected the comparison English dictionary to be a standalone object literal.'
    );
    comparisonEnglish = vm.runInNewContext(
      `(${dictionary[1]})`,
      Object.create(null),
      { timeout: 1000 }
    );
    const arabic = Object.fromEntries(
      comparisonLabels.map((element) => [
        element.dataset.copy,
        element.textContent,
      ])
    );
    assert.deepEqual(
      Object.keys(comparisonEnglish).sort(compareText),
      Object.keys(arabic).sort(compareText),
      'Every comparison label needs both languages.'
    );
    for (const [key, value] of Object.entries(arabic)) {
      assert(value.length > 0, `Empty Arabic label: ${key}`);
      assert.equal(typeof comparisonEnglish[key], 'string');
      assert(comparisonEnglish[key].length > 0, `Empty English label: ${key}`);
    }
  }
);

check(
  'Comparison language toggle updates direction and restores every Arabic label',
  () => {
    assert(
      comparisonLabels && comparisonEnglish,
      'The comparison dictionaries must be valid.'
    );
    const elements = structuredClone(comparisonLabels);
    const originalLabels = elements.map((element) => element.textContent);
    let onClick;
    const toggle = {
      textContent: 'EN',
      addEventListener(event, listener) {
        assert.equal(event, 'click');
        onClick = listener;
      },
    };
    const document = {
      documentElement: { lang: 'ar', dir: 'rtl' },
      querySelectorAll(selector) {
        assert.equal(selector, '[data-copy]');
        return elements;
      },
      querySelector(selector) {
        assert.equal(selector, '#locale-toggle');
        return toggle;
      },
    };
    vm.runInNewContext(
      readLocal(path.join(__dirname, 'compare.js')),
      { document },
      { timeout: 1000 }
    );
    assert.equal(typeof onClick, 'function');
    onClick();
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(document.documentElement.dir, 'ltr');
    elements.forEach((element) =>
      assert.equal(element.textContent, comparisonEnglish[element.dataset.copy])
    );
    assert.equal(toggle.textContent, 'عربي');
    onClick();
    assert.equal(document.documentElement.lang, 'ar');
    assert.equal(document.documentElement.dir, 'rtl');
    assert.deepEqual(
      elements.map((element) => element.textContent),
      originalLabels
    );
    assert.equal(toggle.textContent, 'EN');
  }
);

check(
  'All five local stylesheets have balanced CSS blocks, strings and comments',
  () => {
    for (const filename of [
      'shared.css',
      'compare.css',
      'harbor.css',
      'studio.css',
      'vault.css',
    ]) {
      const source = readLocal(path.join(__dirname, filename));
      let depth = 0;
      let quote = null;
      let comment = false;
      for (let index = 0; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1];
        if (comment) {
          if (character === '*' && next === '/') {
            comment = false;
            index++;
          }
        } else if (quote) {
          if (character === '\\') index++;
          else if (character === quote) quote = null;
        } else if (character === '/' && next === '*') {
          comment = true;
          index++;
        } else if (character === '"' || character === "'") quote = character;
        else if (character === '{') depth++;
        else if (character === '}') {
          depth--;
          assert(depth >= 0, `Unexpected closing block in ${filename}.`);
        }
      }
      assert.equal(depth, 0, `Unclosed CSS block in ${filename}.`);
      assert.equal(quote, null, `Unclosed string in ${filename}.`);
      assert.equal(comment, false, `Unclosed comment in ${filename}.`);
    }
  }
);

process.stdout.write(
  `\n${passed} passed, ${failed} failed, ${skipped} skipped. No UI or backend requests were made.\n`
);
if (failed) process.exitCode = 1;
