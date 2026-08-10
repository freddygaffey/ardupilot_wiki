/*
 * Harness for common/source/_static/offline-page.js, the offline manager panel.
 *
 *   npm install --no-save jsdom
 *   node scripts/tests/test_offline_page.js
 *
 * The exporter has had a harness since early on; the panel had only ever been
 * checked by a person clicking it. This drives it against a real DOM and a
 * CacheStorage-alike, so the states that are tedious to reach by hand - a wiki
 * saved from an older build, a download interrupted halfway, a manifest that
 * fails to load, a completion marker that cannot be read - are asserted rather
 * than eyeballed.
 *
 * The markup comes out of common-offline.rst rather than being copied here, so
 * the script and the page it drives cannot drift apart without this noticing.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('\nSKIPPED: this harness needs jsdom, which is not installed.\n' +
              '  npm install --no-save jsdom\n' +
              'The panel is a DOM application; testing it without one would mean\n' +
              'hand-rolling a DOM, and a shim with its own bugs is worse than none.\n');
  process.exit(0);
}

const REPO = path.resolve(__dirname, '..', '..');
const PAGE = path.join(REPO, 'common/source/_static/offline-page.js');
const RST = path.join(REPO, 'common/source/docs/common-offline.rst');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* ---------------------------------------------------------- cache shim ---- */

class FakeResponse {
  constructor(body) { this._b = typeof body === 'string' ? body : JSON.stringify(body); }
  text() { return Promise.resolve(this._b); }
  json() { return Promise.resolve(JSON.parse(this._b)); }
}
class FakeCache {
  constructor() { this.map = new Map(); }
  put(k, v) { this.map.set(String(k && k.url ? k.url : k), v); return Promise.resolve(); }
  match(k) { return Promise.resolve(this.map.get(String(k && k.url ? k.url : k))); }
  keys() { return Promise.resolve([...this.map.keys()].map(u => ({ url: 'https://x' + u }))); }
}
function makeCaches() {
  const all = new Map();
  return {
    _all: all,
    keys: () => Promise.resolve([...all.keys()]),
    open: (n) => { if (!all.has(n)) all.set(n, new FakeCache()); return Promise.resolve(all.get(n)); },
    delete: (n) => Promise.resolve(all.delete(n))
  };
}

/**
 * A real tar, NOT gzipped: the archive is served as a content coding now,
 * so the browser decompresses before the client sees a byte. Feeding gzip
 * here would test a pipeline that no longer exists. The download path runs
 * to completion rather than
 * stopping at the fetch. Without this the completion marker is never written
 * and the freshness contract - download, record the build, compare it on the
 * next check - cannot be tested at all.
 */
function tarBytes(files) {
  const zlib = require('zlib');
  const blocks = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const head = Buffer.alloc(512);
    head.write(name, 0, 100);
    head.write('000644 \0', 100, 8);
    head.write('000000 \0', 108, 8);
    head.write('000000 \0', 116, 8);
    head.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    head.write('00000000000\0', 136, 12);
    head.write('        ', 148, 8);            // checksum field, spaces first
    head.write('0', 156, 1);                   // regular file
    let sum = 0;
    for (const b of head) { sum += b; }
    head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(head, data,
                Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));             // end of archive
  return Buffer.concat(blocks);
}

function streamOf(buf) {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(buf)); c.close(); }
  });
}

/* -------------------------------------------------------- page under test - */

/**
 * Build the panel's real markup out of the .rst, so the test breaks if the
 * markup and the script drift apart rather than testing a copy that cannot.
 */
function panelMarkup() {
  const rst = fs.readFileSync(RST, 'utf8');
  // Start at whichever of the panel's blocks comes first: the warning sits
  // above the panel, and slicing from the panel alone would silently drop it.
  const panel = rst.indexOf('<div class="apo">');
  const warn = rst.indexOf('<div id="storage-warning">');
  const start = warn !== -1 && warn < panel ? warn : panel;
  // Search forward from the panel, not from the top of the file: the
  // stylesheet is inlined above the markup now and mentions the install
  // button by name, so an absolute search matched inside the CSS and cut
  // the slice to nothing.
  const end = rst.indexOf('Install as an app', start);
  let html = rst.slice(start, end);
  html = html.replace(/^\s{0,3}/gm, '');            // rST indentation
  html = html.split('\n').filter(l => !l.trim().startsWith('.. ')).join('\n');
  return html + '<div id="ap-install-app"></div><span id="install-state"></span>';
}

function load({ manifest = null, caches = makeCaches(), persisted = false,
                usage = 0, quota = 10e9, archives = null } = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { console.log('    [page error] ' + e.message);
                               if (e.stack) console.log('    ' + e.stack.split('\n')[1]); });
  const dom = new JSDOM('<!doctype html><body>' + panelMarkup() + '</body>',
                        { url: 'https://example.test/x/docs/common-offline.html',
                          virtualConsole: vc });
  const w = dom.window;
  // jsdom has no matchMedia and init() calls it to detect standalone mode.
  if (!w.matchMedia) { w.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){} }); }
  const fetchCalls = [];
  const fetchOpts = [];
  const sandbox = {
    window: w, document: w.document, navigator: {
      storage: {
        estimate: () => Promise.resolve({ usage, quota }),
        persisted: () => Promise.resolve(persisted),
        persist: () => Promise.resolve(persisted)
      }
    },
    caches,
    setTimeout: w.setTimeout.bind(w), clearTimeout: w.clearTimeout.bind(w),
    console,
    Response: FakeResponse,
    Request: class { constructor(u) { this.url = u; } },
    AbortController: w.AbortController,
    TransformStream, ReadableStream, Uint8Array,
    fetch: (u, o) => {
      fetchCalls.push(String(u));
      fetchOpts.push({ url: String(u), opts: o || {} });
      if (String(u).indexOf('offline-manifest.json') !== -1) {
        return Promise.resolve(manifest
          ? { ok: true, json: () => Promise.resolve(manifest) }
          : { ok: false, json: () => Promise.reject(new Error('no manifest')) });
      }
      if (archives) {
        // A real archive, so the unpack runs and the marker gets written.
        return Promise.resolve({ ok: true, body: streamOf(tarBytes(archives)) });
      }
      return Promise.reject(new Error('archive fetch blocked by harness'));
    }
  };
  // The page guards on `'caches' in window`, so the shim has to be on the
  // window object and not only on the sandbox global.
  sandbox.window.caches = caches;
  sandbox.window.fetch = sandbox.fetch;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PAGE, 'utf8'), sandbox);
  return { dom, w, doc: w.document, sandbox, fetchCalls, fetchOpts };
}

const settle = () => new Promise(r => setTimeout(r, 60));
const $ = (doc, id) => doc.getElementById(id);
const rows = (doc) => [...doc.querySelectorAll('.wiki-check')];

function completeMarker(build, id) {
  // The real download writes id alongside build; the update check reads it.
  return new FakeResponse(JSON.stringify({ build, saved: Date.now(), id }));
}

const MANIFEST = {
  generated: '2026-08-09T00:00:00Z',
  artifact_base: 'https://cdn.example.test',
  common: { id: 'common', name: 'Common (required)', mb: 400, pages: 0, required: true,
            archive: 'common-offline.tar' },
  wikis: [
    { id: 'copter', name: 'Copter', mb: 74, pages: 846, archive: 'copter-offline.tar' },
    { id: 'rover', name: 'Rover', mb: 32, pages: 747, archive: 'rover-offline.tar' },
    { id: 'dev', name: 'Developer', mb: 52, pages: 312, archive: 'dev-offline.tar' }
  ]
};

/* ------------------------------------------------------------- the run ---- */

async function main() {
  console.log('\nnothing saved yet');
  {
    const { doc } = load({ manifest: MANIFEST });
    await settle();
    check('renders a row per wiki plus common',
          doc.querySelectorAll('tr[data-wiki]').length === 4,
          doc.querySelectorAll('tr[data-wiki]').length + ' rows');
    check('manifest names are used, not directory names',
          [...doc.querySelectorAll('.apo-name')].some(e => e.textContent.includes('Developer')));
    check('save is disabled with nothing selected', $(doc, 'download-cache-btn').disabled);
    check('export is disabled with nothing selected', $(doc, 'dl-single').disabled);
    check('select-all is clear', !$(doc, 'select-all').checked &&
                                  !$(doc, 'select-all').indeterminate);
    check('build date shown', ($(doc, 'build-date').textContent || '').includes('2026-08-09'));
    check('remove all disabled when nothing is stored', $(doc, 'clear-btn').disabled);
  }

  console.log('\nselecting');
  {
    const { doc, w } = load({ manifest: MANIFEST });
    await settle();
    $(doc, 'select-all').click();
    await settle();
    check('select-all ticks every wiki', rows(doc).every(c => c.checked));
    check('save enabled once something is selected', !$(doc, 'download-cache-btn').disabled);
    check('export enabled once something is selected', !$(doc, 'dl-single').disabled);
    const total = $(doc, 'selection-total').textContent;
    check('total counts common plus every wiki', total.includes('558'),
          JSON.stringify(total));
    rows(doc)[0].click();
    await settle();
    check('unticking one makes select-all indeterminate',
          $(doc, 'select-all').indeterminate && !$(doc, 'select-all').checked);
    rows(doc).forEach(c => { if (c.checked) c.click(); });
    await settle();
    check('unticking all disables save again', $(doc, 'download-cache-btn').disabled);
    check('unticking all disables export again', $(doc, 'dl-single').disabled);
  }

  console.log('\nalready saved');
  {
    const caches = makeCaches();
    for (const id of ['common', 'copter']) {
      const c = await caches.open('ardupilot-offline-' + id);
      await c.put('/__ap_complete__', completeMarker('2026-08-09T00:00:00Z', id));
    }
    const { doc } = load({ manifest: MANIFEST, caches, usage: 500e6 });
    await settle();
    const copter = doc.querySelector('tr[data-wiki="copter"]');
    check('a stored wiki shows as saved',
          copter.querySelector('.apo-badge').textContent.toLowerCase().includes('saved'));
    check('a stored wiki is auto-ticked',
          doc.querySelector('.wiki-check[value="copter"]').checked);
    check('save is disabled when the selection is all stored',
          $(doc, 'download-cache-btn').disabled, $(doc, 'download-cache-btn').title);
    check('remove all is enabled when something is stored', !$(doc, 'clear-btn').disabled);
    doc.querySelector('.wiki-check[value="rover"]').click();
    await settle();
    check('adding an unsaved wiki re-enables save', !$(doc, 'download-cache-btn').disabled);
    check('total counts only what is missing',
          $(doc, 'selection-total').textContent.includes('32'),
          JSON.stringify($(doc, 'selection-total').textContent));
  }

  console.log('\ninterrupted download');
  {
    const caches = makeCaches();
    // Entries present but no completion marker: this is what an aborted
    // download leaves behind and it must not count as a usable copy.
    const c = await caches.open('ardupilot-offline-copter');
    await c.put('/copter/index.html', new FakeResponse('<html>'));
    const { doc } = load({ manifest: MANIFEST, caches });
    await settle();
    check('a partial download is not reported as saved',
          doc.querySelector('tr[data-wiki="copter"] .apo-badge')
             .textContent.toLowerCase().includes('not saved'));
    check('a partial download is not auto-ticked',
          !doc.querySelector('.wiki-check[value="copter"]').checked);
  }

  console.log('\nno manifest published');
  {
    const { doc } = load({ manifest: null });
    await settle();
    check('falls back to built-in wiki list rather than an empty table',
          doc.querySelectorAll('tr[data-wiki]').length > 1,
          doc.querySelectorAll('tr[data-wiki]').length + ' rows');
    check('page still usable with no manifest', !!$(doc, 'select-all'));
  }

  console.log('\nstorage warning');
  {
    const a = load({ manifest: MANIFEST, persisted: false });
    await settle();
    check('warns when storage is temporary',
          (a.doc.getElementById('storage-warning').textContent || '').includes('temporary'));
    const b = load({ manifest: MANIFEST, persisted: true });
    await settle();
    check('no warning when storage is permanent',
          (b.doc.getElementById('storage-warning').textContent || '').trim() === '');
  }

  console.log('\ncache busting');
  {
    const { sandbox } = load({ manifest: MANIFEST });
    await settle();
    check('exposes a version marker for debugging',
          typeof sandbox.window.ArduPilotOfflineVersion === 'string',
          sandbox.window.ArduPilotOfflineVersion);
  }

  console.log('\nupdate check');
  {
    const caches = makeCaches();
    // copter saved from an older build, rover current.
    (await caches.open('ardupilot-offline-common')).put('/__ap_complete__', completeMarker(MANIFEST.generated, 'common'));
    (await caches.open('ardupilot-offline-copter')).put('/__ap_complete__', completeMarker('2020-01-01T00:00:00Z', 'copter'));
    (await caches.open('ardupilot-offline-rover')).put('/__ap_complete__', completeMarker(MANIFEST.generated, 'rover'));
    const { doc, fetchCalls } = load({ manifest: MANIFEST, caches });
    await settle();
    $(doc, 'check-btn').click();
    await settle(); await settle();
    const archive = fetchCalls.filter(u => u.indexOf('.tar') !== -1);
    check('update check re-fetches the stale wiki', archive.some(u => u.indexOf('copter') !== -1),
          JSON.stringify(archive));
    check('update check does not re-fetch a current wiki',
          !archive.some(u => u.indexOf('rover') !== -1), JSON.stringify(archive));
    check('archive URL is tagged with the build',
          archive.every(u => u.indexOf('?v=') !== -1), JSON.stringify(archive.slice(0,1)));
    check('archive URL uses the manifest host',
          archive.every(u => u.indexOf('https://cdn.example.test/') === 0), JSON.stringify(archive.slice(0,1)));
  }

  console.log('\nnothing stale');
  {
    const caches = makeCaches();
    for (const id of ['common', 'copter']) {
      (await caches.open('ardupilot-offline-' + id)).put('/__ap_complete__', completeMarker(MANIFEST.generated, id));
    }
    const { doc, fetchCalls } = load({ manifest: MANIFEST, caches });
    await settle();
    $(doc, 'check-btn').click();
    await settle(); await settle();
    check('reports up to date when nothing is stale',
          ($(doc, 'check-result').textContent || '').toLowerCase().includes('up to date'),
          JSON.stringify($(doc, 'check-result').textContent));
    check('up to date downloads nothing',
          !fetchCalls.some(u => u.indexOf('.tar') !== -1));
  }

  console.log('\nremove all');
  {
    const caches = makeCaches();
    (await caches.open('ardupilot-offline-copter')).put('/__ap_complete__', completeMarker(MANIFEST.generated, 'copter'));
    (await caches.open('ardupilot-pages-v1')).put('/copter/docs/x.html', new FakeResponse('<html>'));
    const { doc } = load({ manifest: MANIFEST, caches, usage: 100e6 });
    await settle();
    const btn = $(doc, 'clear-btn');
    btn.click();
    await settle();
    check('first press arms rather than deletes',
          btn.textContent.toLowerCase().includes('again'), JSON.stringify(btn.textContent));
    check('arming does not delete anything yet',
          (await caches.keys()).length === 2, (await caches.keys()).join(','));
    btn.click();
    await settle();
    check('an immediate second press is ignored (double-click guard)',
          (await caches.keys()).length === 2, (await caches.keys()).join(','));
    await new Promise(r => setTimeout(r, 800));
    btn.click();
    await settle(); await settle();
    check('a deliberate second press clears everything',
          (await caches.keys()).length === 0, (await caches.keys()).join(','));
  }

  console.log('\nodd manifests');
  {
    const odd = JSON.parse(JSON.stringify(MANIFEST));
    delete odd.wikis[0].archive;                       // no filename given
    const caches = makeCaches();
    (await caches.open('ardupilot-offline-common')).put('/__ap_complete__', completeMarker(odd.generated, 'common'));
    const { doc, fetchCalls } = load({ manifest: odd, caches });
    await settle();
    doc.querySelector('.wiki-check[value="copter"]').click();
    await settle();
    $(doc, 'download-cache-btn').click();
    await settle(); await settle();
    check('falls back to <id>-offline.tar.gz when the manifest omits a filename',
          fetchCalls.some(u => u.indexOf('copter-offline.tar') !== -1),
          JSON.stringify(fetchCalls.filter(u => u.indexOf('tar.gz') !== -1)));
  }
  {
    // A wiki cached from an older build that the manifest no longer lists.
    const caches = makeCaches();
    (await caches.open('ardupilot-offline-retired')).put('/__ap_complete__', completeMarker(MANIFEST.generated, 'retired'));
    (await caches.open('ardupilot-offline-common')).put('/__ap_complete__', completeMarker(MANIFEST.generated, 'common'));
    const { doc } = load({ manifest: MANIFEST, caches, usage: 10e6 });
    await settle();
    check('a cached wiki the manifest no longer lists does not break the table',
          doc.querySelectorAll('tr[data-wiki]').length === 4,
          doc.querySelectorAll('tr[data-wiki]').length + ' rows');
    check('and it is still counted as stored somewhere the reader can act on',
          !$(doc, 'clear-btn').disabled);
  }

  console.log('\nmarker without an id');
  {
    const caches = makeCaches();
    (await caches.open('ardupilot-offline-common')).put('/__ap_complete__', completeMarker(MANIFEST.generated, 'common'));
    // A marker naming no wiki: the cache name still says which it is, and a
    // wiki that cannot be named can never be updated.
    (await caches.open('ardupilot-offline-copter')).put('/__ap_complete__',
      new FakeResponse(JSON.stringify({ build: '2020-01-01T00:00:00Z', saved: 1 })));
    const { doc, fetchCalls } = load({ manifest: MANIFEST, caches });
    await settle();
    $(doc, 'check-btn').click();
    await settle(); await settle();
    check('a marker with no id is still updated, using the cache name',
          fetchCalls.some(u => u.indexOf('copter-offline.tar') !== -1),
          JSON.stringify(fetchCalls.filter(u => u.indexOf('tar.gz') !== -1)));
    check('and it is not reported as up to date',
          !($(doc, 'check-result').textContent || '').toLowerCase().includes('up to date'),
          JSON.stringify($(doc, 'check-result').textContent));
  }

  console.log('\nfreshness: the manifest');
  {
    const { fetchOpts } = load({ manifest: MANIFEST });
    await settle();
    const m = fetchOpts.filter(f => f.url.indexOf('offline-manifest.json') !== -1);
    check('the manifest is requested', m.length > 0);
    // Everything downstream is derived from the manifest, so a cached manifest
    // means a frozen build id, a frozen tag, and archives that never refresh.
    check('the manifest is never served from cache',
          m.every(f => f.opts && f.opts.cache === 'no-cache'),
          JSON.stringify(m.map(f => f.opts && f.opts.cache)));
  }

  console.log('\nfreshness: the archive tag');
  {
    const caches = makeCaches();
    const { doc, fetchCalls } = load({ manifest: MANIFEST, caches,
                                       archives: { 'x/index.html': '<html>' } });
    await settle();
    $(doc, 'select-all').click();
    await settle();
    $(doc, 'download-cache-btn').click();
    for (let i = 0; i < 12; i++) { await settle(); }
    const arch = fetchCalls.filter(u => u.indexOf('.tar') !== -1);
    check('every archive in the queue is tagged, not just the first',
          arch.length > 1 && arch.every(u => u.indexOf('?v=') !== -1),
          arch.length + ' archives');
    check('the tag is exactly the manifest build id',
          arch.every(u => u.endsWith('?v=' + encodeURIComponent(MANIFEST.generated))),
          JSON.stringify(arch[0]));
    check('common and the wikis are all fetched',
          arch.some(u => u.indexOf('common-') !== -1) &&
          arch.some(u => u.indexOf('copter-') !== -1), JSON.stringify(arch));
  }

  console.log('\nfreshness: a new build changes the tag');
  {
    const older = JSON.parse(JSON.stringify(MANIFEST));
    older.generated = '2020-01-01T00:00:00Z';
    const a = load({ manifest: older, archives: { 'x/index.html': '<html>' } });
    await settle();
    $(a.doc, 'select-all').click(); await settle();
    $(a.doc, 'download-cache-btn').click();
    for (let i = 0; i < 12; i++) { await settle(); }
    const oldTags = a.fetchCalls.filter(u => u.indexOf('.tar') !== -1);

    const b = load({ manifest: MANIFEST, archives: { 'x/index.html': '<html>' } });
    await settle();
    $(b.doc, 'select-all').click(); await settle();
    $(b.doc, 'download-cache-btn').click();
    for (let i = 0; i < 12; i++) { await settle(); }
    const newTags = b.fetchCalls.filter(u => u.indexOf('.tar') !== -1);

    check('a different build produces a different URL',
          oldTags.length && newTags.length && oldTags[0] !== newTags[0],
          JSON.stringify([oldTags[0], newTags[0]]));
    check('the old build tag is not reused',
          !newTags.some(u => u.indexOf('2020-01-01') !== -1));
  }

  console.log('\nfreshness: no build id means no bogus tag');
  {
    const noBuild = JSON.parse(JSON.stringify(MANIFEST));
    delete noBuild.generated;
    const { doc, fetchCalls } = load({ manifest: noBuild,
                                       archives: { 'x/index.html': '<html>' } });
    await settle();
    doc.querySelector('.wiki-check[value="copter"]').click();
    await settle();
    $(doc, 'download-cache-btn').click();
    for (let i = 0; i < 12; i++) { await settle(); }
    const arch = fetchCalls.filter(u => u.indexOf('.tar') !== -1);
    check('no build id means an untagged URL, never ?v=undefined',
          arch.length && arch.every(u => u.indexOf('undefined') === -1 &&
                                          u.indexOf('?v=') === -1),
          JSON.stringify(arch[0]));
  }

  console.log('\nfreshness: the whole round trip');
  {
    const caches = makeCaches();
    const first = load({ manifest: MANIFEST, caches,
                         archives: { 'copter/index.html': '<html>ok' } });
    await settle();
    first.doc.querySelector('.wiki-check[value="copter"]').click();
    await settle();
    $(first.doc, 'download-cache-btn').click();
    for (let i = 0; i < 15; i++) { await settle(); }

    const c = await caches.open('ardupilot-offline-copter');
    const marker = await c.match('/__ap_complete__');
    check('a completed download writes a marker', !!marker);
    const info = marker ? JSON.parse(await marker.text()) : {};
    check('the marker records the build that was downloaded',
          info.build === MANIFEST.generated, JSON.stringify(info.build));
    check('the archive contents were unpacked into the cache',
          !!(await c.match('/copter/index.html')));

    // Same build again: nothing to do.
    const same = load({ manifest: MANIFEST, caches,
                        archives: { 'copter/index.html': '<html>ok' } });
    await settle();
    $(same.doc, 'check-btn').click();
    for (let i = 0; i < 8; i++) { await settle(); }
    check('checking against the same build reports up to date',
          ($(same.doc, 'check-result').textContent || '').toLowerCase().includes('up to date'),
          JSON.stringify($(same.doc, 'check-result').textContent));
    check('and downloads nothing',
          !same.fetchCalls.some(u => u.indexOf('.tar') !== -1));

    // A newer build: the wiki is stale and must be re-fetched with the new tag.
    const newer = JSON.parse(JSON.stringify(MANIFEST));
    newer.generated = '2027-01-01T00:00:00Z';
    const next = load({ manifest: newer, caches,
                        archives: { 'copter/index.html': '<html>new' } });
    await settle();
    $(next.doc, 'check-btn').click();
    for (let i = 0; i < 15; i++) { await settle(); }
    const arch = next.fetchCalls.filter(u => u.indexOf('.tar') !== -1);
    check('a newer build makes the stored copy stale',
          arch.length > 0, JSON.stringify(arch));
    check('the refetch carries the new build tag, not the stored one',
          arch.every(u => u.indexOf(encodeURIComponent('2027-01-01T00:00:00Z')) !== -1),
          JSON.stringify(arch[0]));
    const after = await (await caches.open('ardupilot-offline-copter')).match('/__ap_complete__');
    const info2 = after ? JSON.parse(await after.text()) : {};
    check('and the marker is updated to the new build',
          info2.build === '2027-01-01T00:00:00Z', JSON.stringify(info2.build));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('failed: ' + failures.join('; ')); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
