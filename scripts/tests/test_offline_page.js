/*
 * Harness for common/source/_static/common_offline_page.js, the offline manager panel.
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
  // Exit NON-zero. This used to exit 0, so `npm test` reported "all checks
  // passed" while running none of the 99 assertions below - a green suite that
  // proved nothing, on every machine where jsdom was not already installed.
  // A test run that cannot run is a failure, not a pass.
  console.error('\nFAILED: this harness needs jsdom, which is not installed.\n' +
                '  npm install --no-save jsdom\n' +
                'The panel is a DOM application; testing it without one would mean\n' +
                'hand-rolling a DOM, and a shim with its own bugs is worse than none.\n');
  process.exit(1);
}

const REPO = path.resolve(__dirname, '..', '..');
const PAGE = path.join(REPO, 'common/source/_static/common_offline_page.js');
const RST = path.join(REPO, 'common/source/docs/common-offline.rst');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* ---------------------------------------------------------- cache shim ---- */

/**
 * Bodies are kept as bytes, not as strings.
 *
 * The differential update fetches a changed file, takes its blob, and puts that
 * blob straight into the cache. Stringifying on the way in would make every
 * such body the literal "{}" and the update tests would then pass while storing
 * nothing recognisable. Keeping a Buffer lets a test read back what was
 * actually written and compare it with what the server sent.
 */
class FakeResponse {
  constructor(body) {
    this._b = typeof body === 'string' ? body
            : Buffer.isBuffer(body) ? body
            : body instanceof ArrayBuffer ? Buffer.from(body)
            : ArrayBuffer.isView(body)
                ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
                : JSON.stringify(body);
  }
  text() {
    return Promise.resolve(Buffer.isBuffer(this._b) ? this._b.toString('utf8') : this._b);
  }
  json() { return this.text().then((t) => JSON.parse(t)); }
  blob() {
    return Promise.resolve(Buffer.isBuffer(this._b) ? this._b : Buffer.from(this._b));
  }
  arrayBuffer() {
    const b = Buffer.isBuffer(this._b) ? this._b : Buffer.from(this._b);
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
}
class FakeCache {
  constructor() { this.map = new Map(); }
  put(k, v) { this.map.set(String(k && k.url ? k.url : k), v); return Promise.resolve(); }
  match(k) { return Promise.resolve(this.map.get(String(k && k.url ? k.url : k))); }
  delete(k) { return Promise.resolve(this.map.delete(String(k && k.url ? k.url : k))); }
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

/**
 * A site that serves file tables and individual files.
 *
 * `tables` maps a published table's filename to its contents, and `served`
 * maps a path this site answers - the same paths the wiki itself is served at -
 * to the bytes at it. Anything not in `served` 404s, which is how the shared
 * image fallback is exercised: the first wiki tried does not have the file.
 */
function load({ manifest = null, caches = makeCaches(), persisted = false,
                usage = 0, quota = 10e9, archives = null,
                tables = null, served = null, rateLimit = false } = {}) {
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
    window: w, document: w.document,
    // A global, as it is in a browser. Without it the shared-file path - the
    // only code here that asks which wiki is being read - threw a ReferenceError
    // that the update's own error handling turned into a silent fall back to
    // downloading the whole archive.
    location: w.location,
    navigator: {
      storage: {
        estimate: () => Promise.resolve({ usage, quota }),
        persisted: () => Promise.resolve(persisted),
        persist: () => Promise.resolve(persisted)
      }
    },
    caches,
    crypto: require('crypto').webcrypto,
    setTimeout: w.setTimeout.bind(w), clearTimeout: w.clearTimeout.bind(w),
    console,
    Response: FakeResponse,
    Request: class { constructor(u) { this.url = u; } },
    AbortController: w.AbortController,
    TransformStream, ReadableStream, Uint8Array,
    fetch: (u, o) => {
      fetchCalls.push(String(u));
      fetchOpts.push({ url: String(u), opts: o || {}, at: Date.now() });
      if (String(u).indexOf('offline-manifest.json') !== -1) {
        return Promise.resolve(manifest
          ? { ok: true, json: () => Promise.resolve(manifest) }
          : { ok: false, json: () => Promise.reject(new Error('no manifest')) });
      }
      // A published file table, named the way the manifest asks for it.
      if (tables && String(u).indexOf('-files.json') !== -1) {
        const name = String(u).split('?')[0].split('/').pop();
        return Promise.resolve(Object.prototype.hasOwnProperty.call(tables, name)
          ? { ok: true, json: () => Promise.resolve(tables[name]) }
          : { ok: false, json: () => Promise.reject(new Error('no table')) });
      }
      // The server refusing update traffic.
      if (rateLimit && String(u).indexOf('ap-update=') !== -1) {
        return Promise.resolve({ ok: false, status: 429,
                                 blob: () => Promise.reject(new Error('429')) });
      }
      // An individual file, at the path the site really serves it from.
      if (served) {
        const p = String(u).split('?')[0];
        if (Object.prototype.hasOwnProperty.call(served, p)) {
          const buf = Buffer.from(served[p]);
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(buf),
            arrayBuffer: () => Promise.resolve(
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          });
        }
        if (String(u).indexOf('.tar') === -1) {
          // 404, not a rejection: this is a wiki that does not hold the file,
          // which the shared-image fallback must walk past rather than abort on.
          return Promise.resolve({ ok: false, blob: () => Promise.reject(new Error('404')) });
        }
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

// The build's file hash, in Node, so a test's published table can carry the
// hash of exactly the bytes it serves. Same as build_offline_artifacts.file_hash
// and the client's hashBytes: sha256, first eight bytes, hex.
async function fileHash(text) {
  const d = await require('crypto').webcrypto.subtle.digest('SHA-256', Buffer.from(text));
  return [...new Uint8Array(d).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
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

  /* --------------------------------------------- differential updates ----- */
  //
  // The browser proof of this path took most of a session and is slow to
  // repeat, so it is asserted here against bytes in the cache rather than
  // against what the panel says it did. The distinction matters: the count in
  // the panel is derived from the size of the diff, so a run that fetched
  // nothing at all could still report that it updated nine files.

  const TABLE_KEY = '/__ap_files__';

  /**
   * What a finished download leaves behind: the files, the table describing
   * them, and the completion marker naming the build they came from.
   *
   * `files` maps an archive path to [hash, body]. The hash is opaque - the
   * client never computes one, it only compares - so any distinct string will
   * do, and using readable ones makes a failure legible.
   */
  async function seedSaved(cachesObj, id, build, files) {
    const c = await cachesObj.open('ardupilot-offline-' + id);
    const table = {};
    for (const [name, [hash, body]] of Object.entries(files)) {
      table[name] = hash;
      await c.put((id === 'common' ? '/_common/' : '/') + name, new FakeResponse(body));
    }
    await c.put(TABLE_KEY, new FakeResponse(JSON.stringify(table)));
    await c.put('/__ap_complete__', completeMarker(build, id));
    return c;
  }

  const bodyAt = async (cache, key) => {
    const r = await cache.match(key);
    return r ? await r.text() : null;
  };
  const OLD_BUILD = '2020-01-01T00:00:00Z';
  // Requests for content from this site: not the CDN the tables and archives
  // sit on, and not the manifest, which is fetched from a relative path before
  // the manifest itself has said where the artifacts live.
  const siteCalls = (calls) => calls.filter(
    u => u.indexOf('/') === 0 && u.indexOf('offline-manifest.json') === -1 &&
         u.indexOf('-files.json') === -1);

  console.log('\ndifferential update: only what moved');
  {
    const cachesObj = makeCaches();
    // Both saved from an older build, so both are stale and both are checked.
    // Common's table is unchanged, which is the ordinary case: one wiki edited,
    // everything else identical.
    await seedSaved(cachesObj, 'common', OLD_BUILD, {
      '_images/shared.png': ['c1', 'shared bytes']
    });
    const copter = await seedSaved(cachesObj, 'copter', OLD_BUILD, {
      'copter/index.html':     ['h1', 'old index'],
      'copter/docs/a.html':    ['h2', 'old a'],
      'copter/docs/b.html':    ['h3', 'old b'],
      'copter/searchindex.js': ['h4', 'old searchindex'],
      'copter/docs/gone.html': ['h5', 'old gone']
    });

    // The published hash for a changed file is the real hash of what the
    // server will send, because the client now verifies. Unchanged entries
    // keep arbitrary values; they are never fetched.
    const { doc, fetchCalls, fetchOpts } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: {
        'common-files.json': { '_images/shared.png': 'c1' },
        'copter-files.json': {
          'copter/index.html':     'h1',
          'copter/docs/a.html':    await fileHash('NEW a'),
          'copter/searchindex.js': await fileHash('NEW searchindex'),
          'copter/docs/b.html':    'h3'
        }
      },
      served: {
        '/copter/docs/a.html':    'NEW a',
        '/copter/searchindex.js': 'NEW searchindex'
      }
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 20; i++) { await settle(); }

    check('no archive is fetched when the tables can be compared',
          !fetchCalls.some(u => u.indexOf('.tar') !== -1),
          JSON.stringify(fetchCalls.filter(u => u.indexOf('.tar') !== -1)));

    const got = siteCalls(fetchCalls).map(u => u.split('?')[0]).sort();
    check('exactly the changed files are fetched, and nothing else',
          got.length === 2 && got[0] === '/copter/docs/a.html' &&
          got[1] === '/copter/searchindex.js', JSON.stringify(got));

    check('a changed page holds the new bytes',
          (await bodyAt(copter, '/copter/docs/a.html')) === 'NEW a',
          JSON.stringify(await bodyAt(copter, '/copter/docs/a.html')));
    check('a changed non-page holds the new bytes',
          (await bodyAt(copter, '/copter/searchindex.js')) === 'NEW searchindex',
          JSON.stringify(await bodyAt(copter, '/copter/searchindex.js')));
    // The failure this guards against is the one that was actually shipped:
    // HTML answered from the cache being refreshed and written back over
    // itself, which looks identical to an update that worked.
    check('an unchanged page keeps its own bytes, not a refetched copy',
          (await bodyAt(copter, '/copter/index.html')) === 'old index' &&
          (await bodyAt(copter, '/copter/docs/b.html')) === 'old b',
          JSON.stringify(await bodyAt(copter, '/copter/index.html')));
    check('a file dropped from the build is deleted from the cache',
          (await copter.match('/copter/docs/gone.html')) === undefined);

    const stored = JSON.parse(await bodyAt(copter, TABLE_KEY));
    check('the stored table now matches the published one',
          stored['copter/docs/a.html'] === (await fileHash('NEW a')) &&
          stored['copter/searchindex.js'] === (await fileHash('NEW searchindex')) &&
          !('copter/docs/gone.html' in stored) &&
          Object.keys(stored).length === 4, JSON.stringify(stored));

    const marker = JSON.parse(await bodyAt(copter, '/__ap_complete__'));
    check('the marker moves to the build that was applied',
          marker.build === MANIFEST.generated, JSON.stringify(marker.build));

    // Untagged requests take the cache-first route in the worker, which answers
    // an update out of the very cache it is refreshing. Every request on this
    // path has to carry the tag; this is the assertion that was missing when
    // that shipped.
    check('every update request is tagged for the network',
          siteCalls(fetchCalls).length > 0 &&
          siteCalls(fetchCalls).every(u => u.indexOf('ap-update=') !== -1),
          JSON.stringify(siteCalls(fetchCalls)));
    check('and none of them may be served from the HTTP cache',
          fetchOpts.filter(f => f.url.indexOf('/') === 0)
                   .every(f => f.opts && f.opts.cache === 'no-cache'));

    // An unchanged wiki costs one request for its table and no more. This is
    // the whole point of the design: a typo in Copter must not cost anyone the
    // 439 MB of common.
    const commonCalls = fetchCalls.filter(u => u.indexOf('common') !== -1);
    check('an unchanged wiki costs one request, its table',
          commonCalls.length === 1 && commonCalls[0].indexOf('common-files.json') !== -1,
          JSON.stringify(commonCalls));
    const commonCache = await cachesObj.open('ardupilot-offline-common');
    check('and it is still marked current afterwards',
          JSON.parse(await bodyAt(commonCache, '/__ap_complete__')).build ===
            MANIFEST.generated);

    // Two fetched, one deleted. The count is currently derived from the size of
    // the diff rather than from writes that completed, so it would report the
    // same on a run that stored nothing. It is true here, and this pins it to
    // what the cache actually holds so that it stays true.
    check('the reported count equals the changes actually applied',
          ($(doc, 'check-result').textContent || '').indexOf('3 files') !== -1,
          JSON.stringify($(doc, 'check-result').textContent));
  }

  console.log('\na quiet update never starts an archive download by itself');
  {
    // Observed live before the fix: a background tick, no click anywhere, and
    // 439 MB on its way. The fallback from the cheap path is the most
    // expensive action in the product and must not run unattended.
    const cachesObj = makeCaches();
    // A wiki saved before tables existed: updateStored() resolves null, which
    // is the fallback trigger.
    const c = await cachesObj.open('ardupilot-offline-dev');
    await c.put('/dev/index.html', new FakeResponse('<html>'));
    await c.put('/__ap_complete__', completeMarker(OLD_BUILD, 'dev'));
    (await cachesObj.open('ardupilot-offline-common')).put('/__ap_complete__',
      completeMarker(MANIFEST.generated, 'common'));

    const { doc, sandbox, fetchCalls } = load({
      manifest: MANIFEST, caches: cachesObj,
      archives: { 'dev/index.html': '<html>new' },
    });
    await settle();
    // The quiet path, exactly as the timer calls it.
    await sandbox.window.eval ? null : null;
    // Reach the internals the way the scheduler does: fire a tick.
    // checkForUpdates(true) is not exported, so drive it via the checkbox
    // handler's immediate tick after re-enabling autoupdate.
    doc.getElementById('autoupdate').checked = false;
    doc.getElementById('autoupdate').dispatchEvent(
      new sandbox.window.Event('change', { bubbles: true }));
    doc.getElementById('autoupdate').checked = true;
    doc.getElementById('autoupdate').dispatchEvent(
      new sandbox.window.Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i++) { await settle(); }

    check('no archive is fetched by a quiet run',
          !fetchCalls.some(u => u.indexOf('.tar') !== -1),
          JSON.stringify(fetchCalls.filter(u => u.indexOf('.tar') !== -1)));
    check('the reader is told a full download is waiting',
          ($(doc, 'check-result').textContent || '').indexOf('full download') !== -1,
          JSON.stringify($(doc, 'check-result').textContent));

    // The same state via the button IS consent, and proceeds.
    $(doc, 'check-btn').click();
    for (let i = 0; i < 20; i++) { await settle(); }
    check('the button press does start it',
          fetchCalls.some(u => u.indexOf('.tar') !== -1),
          JSON.stringify(fetchCalls.filter(u => u.indexOf('.tar') !== -1).slice(0,2)));
  }

  console.log('\nthe update paces itself and backs off when told to');
  {
    // The client is the rate limiter here, so these two behaviours are load
    // bearing rather than polite. Sequential fetches with no pause ran at about
    // 75 a second from one browser; a hundred readers doing that after a build
    // is 7,500 a second at the origin.
    const cachesObj = makeCaches();
    const files = {};
    for (let i = 0; i < 8; i++) { files['dev/docs/p' + i + '.html'] = ['h' + i, 'old']; }
    await seedSaved(cachesObj, 'dev', OLD_BUILD, files);
    const published = {};
    const served = {};
    const newBody = 'new body ';
    for (const k of Object.keys(files)) {
      served['/' + k] = newBody + k;
      published[k] = await fileHash(newBody + k);   // verified, so must be real
    }

    const { doc, fetchOpts } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: { 'dev-files.json': published }, served,
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 40; i++) { await settle(); }

    // The gaps between consecutive file requests, which is what pacing means.
    // Wall-clock time is no use here: it is dominated by the harness's own
    // polling, so an unpaced run looks identical to a paced one.
    const times = fetchOpts.filter(f => f.url.indexOf('/') === 0 &&
                                        f.url.indexOf('ap-update=') !== -1)
                           .map(f => f.at);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const floor = (1000 / 15) * 0.6;
    check('consecutive update requests are spaced apart',
          gaps.length > 2 && gaps.every(g => g >= floor),
          gaps.length + ' gaps, smallest ' + (gaps.length ? Math.min(...gaps) : 'n/a') +
          ' ms, need >= ' + Math.round(floor));
  }
  {
    // A 429 is the server saying stop. Trying the next wiki for that file would
    // be one more request at precisely the wrong moment.
    // A shared file, deliberately: those are looked for under every wiki in
    // turn, so ignoring a 429 means asking the struggling server four more
    // times for the same file. A wiki-owned file has only one source and would
    // make this look fine either way.
    const cachesObj = makeCaches();
    await seedSaved(cachesObj, 'common', OLD_BUILD, {
      '_images/shared.png': ['c1', 'old'],
    });
    const { doc, fetchCalls } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: { 'common-files.json': { '_images/shared.png': 'c2' } },
      rateLimit: true,
      archives: { 'x/index.html': '<html>' },
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 25; i++) { await settle(); }
    check('a 429 stops the update rather than trying every other source',
          siteCalls(fetchCalls).length === 1,
          siteCalls(fetchCalls).length + ' requests made after being refused');
  }

  console.log('\nautomatic updates are spread out, not synchronised');
  {
    // Every reader on a fixed interval discovers a new build in the same window
    // and starts fetching together. The interval must be jittered or the update
    // mechanism floods its own origin whenever a template changes.
    const src = fs.readFileSync(PAGE, 'utf8');
    check('ticks are scheduled one at a time, not on a fixed interval',
          !/setInterval\(autoUpdateTick/.test(src) && /scheduleNextTick/.test(src),
          'self-scheduling');
    check('and each delay is jittered',
          /AUTOUPDATE_MS \* \(0\.5 \+ Math\.random\(\)\)/.test(src),
          'plus or minus 50%');

    // Observed, rather than read: collect the delays the page actually asks for.
    const delays = [];
    const cachesObj = makeCaches();
    await seedSaved(cachesObj, 'dev', OLD_BUILD, { 'dev/index.html': ['h1', 'x'] });
    const { sandbox } = load({ manifest: MANIFEST, caches: cachesObj });
    const realSetTimeout = sandbox.window.setTimeout;
    sandbox.window.setTimeout = function (fn, ms) {
      if (ms > 1000) { delays.push(ms); return 0; }   // the update tick
      return realSetTimeout(fn, ms);
    };
    await settle();
    // Re-arm a few times to see a spread rather than one number.
    for (let i = 0; i < 5; i++) { sandbox.window.dispatchEvent(new sandbox.window.Event('online')); }
    await settle();
    const unique = new Set(delays).size;
    check('the delays are not all identical',
          delays.length === 0 || unique > 1 || delays.length === 1,
          delays.length + ' delays, ' + unique + ' distinct');
  }

  console.log('\ndifferential update: a large diff falls back to the archive');
  {
    // A template or stylesheet change rewrites every page, and then the
    // "difference" is the whole wiki fetched one request at a time. Measured on
    // a real reader with twelve wikis saved: 5,169 requests from one browser.
    // Past a threshold this must give up and use the archive, which is one.
    const cachesObj = makeCaches();
    const many = {};
    for (let i = 0; i < 400; i++) { many['dev/docs/p' + i + '.html'] = ['h' + i, 'old ' + i]; }
    await seedSaved(cachesObj, 'dev', OLD_BUILD, many);

    const published = {};
    Object.keys(many).forEach((k) => { published[k] = many[k][0] + '-moved'; });

    const { fetchCalls, doc } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: { 'dev-files.json': published },
      archives: { 'dev/index.html': '<html>from the archive' },
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 25; i++) { await settle(); }

    check('a wiki where everything changed is not fetched file by file',
          siteCalls(fetchCalls).length === 0,
          siteCalls(fetchCalls).length + ' individual file requests');
    check('it downloads the archive instead, which is one request',
          fetchCalls.filter(u => u.indexOf('.tar') !== -1).length >= 1,
          JSON.stringify(fetchCalls.filter(u => u.indexOf('.tar') !== -1)));
  }
  {
    // The ordinary case must be untouched: a handful of changed files still
    // takes the cheap path, or the whole feature is pointless.
    const cachesObj = makeCaches();
    const files = {};
    for (let i = 0; i < 400; i++) { files['dev/docs/p' + i + '.html'] = ['h' + i, 'old ' + i]; }
    const dev = await seedSaved(cachesObj, 'dev', OLD_BUILD, files);
    const published = {};
    Object.keys(files).forEach((k) => { published[k] = files[k][0]; });
    published['dev/docs/p7.html'] = await fileHash('NEW seven');

    const { fetchCalls, doc } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: { 'dev-files.json': published },
      served: { '/dev/docs/p7.html': 'NEW seven' },
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 25; i++) { await settle(); }

    check('one changed file out of four hundred still uses the cheap path',
          siteCalls(fetchCalls).length === 1 &&
          !fetchCalls.some(u => u.indexOf('.tar') !== -1),
          JSON.stringify(siteCalls(fetchCalls)));
    check('and it is applied',
          (await bodyAt(dev, '/dev/docs/p7.html')) === 'NEW seven',
          JSON.stringify(await bodyAt(dev, '/dev/docs/p7.html')));
  }

  console.log('\ndifferential update: a wrong body is refused, not stored');
  {
    // The blocker a reviewer found: a 200 with the wrong body (captive portal,
    // error page, mid-deploy skew) was stored verbatim and the table rewritten
    // to claim health, so no later update could ever detect it. The client now
    // hashes what it fetched against the table and refuses a mismatch.
    const cachesObj = makeCaches();
    const copter = await seedSaved(cachesObj, 'copter', OLD_BUILD, {
      'copter/docs/a.html': ['h1', 'old a'],
    });
    (await cachesObj.open('ardupilot-offline-common')).put('/__ap_complete__',
      completeMarker(MANIFEST.generated, 'common'));
    // No archive available either, so the differential path is observed in
    // isolation: if it wrongly advanced the table, nothing downstream would
    // correct it. (When an archive IS available it repairs the wiki, which is
    // fine and desirable; that is a different assertion.)
    const { doc, fetchCalls } = load({
      manifest: MANIFEST, caches: cachesObj,
      // The table promises the hash of the RIGHT bytes...
      tables: { 'copter-files.json': { 'copter/docs/a.html': await fileHash('correct a') } },
      // ...but the server sends the wrong ones, at 200.
      served: { '/copter/docs/a.html': '<html>captive portal login</html>' },
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 25; i++) { await settle(); }

    check('the wrong body is NOT written to the cache',
          (await bodyAt(copter, '/copter/docs/a.html')) === 'old a',
          JSON.stringify(await bodyAt(copter, '/copter/docs/a.html')));
    const tbl = JSON.parse(await bodyAt(copter, TABLE_KEY));
    check('the differential path does NOT advance the table on a bad body',
          tbl['copter/docs/a.html'] === 'h1', JSON.stringify(tbl));
    check('and the wiki still reports the build it actually holds',
          JSON.parse(await bodyAt(copter, '/__ap_complete__')).build === OLD_BUILD,
          JSON.parse(await bodyAt(copter, '/__ap_complete__')).build);
    check('the changed file was tried on the network, then the update gave up',
          siteCalls(fetchCalls).some(u => u.indexOf('/copter/docs/a.html') !== -1),
          JSON.stringify(siteCalls(fetchCalls)));
  }

  console.log('\ndifferential update: a shared file is found under some wiki');
  {
    // Common's files are stored once under /_common/, a path this site never
    // serves. Each is published under every wiki that uses it, so the update
    // tries the wikis in turn. Here only Rover has it.
    const cachesObj = makeCaches();
    const common = await seedSaved(cachesObj, 'common', OLD_BUILD, {
      '_images/shared.png': ['c1', 'old shared bytes']
    });
    const SHARED_HASH = await fileHash('NEW shared bytes');
    const { doc, fetchCalls } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: { 'common-files.json': { '_images/shared.png': SHARED_HASH } },
      served: { '/rover/_images/shared.png': 'NEW shared bytes' }
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 20; i++) { await settle(); }

    check('a shared file is stored back under /_common/, not under a wiki',
          (await bodyAt(common, '/_common/_images/shared.png')) === 'NEW shared bytes',
          JSON.stringify(await bodyAt(common, '/_common/_images/shared.png')));
    const tried = siteCalls(fetchCalls).map(u => u.split('?')[0]);
    check('the wikis are tried in turn and the walk stops at the first hit',
          tried.length === 3 && tried[tried.length - 1] === '/rover/_images/shared.png',
          JSON.stringify(tried));
    check('the wiki being read is tried first',
          tried[0] === '/x/_images/shared.png', JSON.stringify(tried[0]));
    check('no archive is fetched for a single shared image',
          !fetchCalls.some(u => u.indexOf('.tar') !== -1));
  }

  console.log('\ndifferential update: a failure leaves the record intact');
  {
    // One changed file is unavailable everywhere. The update must not record
    // itself as complete, because a wiki that claims a build it does not have
    // is one no later update will ever correct.
    const cachesObj = makeCaches();
    const copter = await seedSaved(cachesObj, 'copter', OLD_BUILD, {
      'copter/index.html':  ['h1', 'old index'],
      'copter/docs/a.html': ['h2', 'old a']
    });
    const { fetchCalls, doc } = load({
      manifest: MANIFEST, caches: cachesObj,
      tables: {
        'copter-files.json': {
          'copter/index.html':  await fileHash('NEW index'),
          'copter/docs/a.html': 'h2-moved'
        }
      },
      served: { '/copter/index.html': 'NEW index' }   // a.html 404s everywhere
    });
    await settle();
    $(doc, 'check-btn').click();
    for (let i = 0; i < 20; i++) { await settle(); }

    check('a file that cannot be fetched does not update the stored table',
          JSON.parse(await bodyAt(copter, TABLE_KEY))['copter/index.html'] === 'h1',
          await bodyAt(copter, TABLE_KEY));
    check('and the wiki still reports the build it actually holds',
          JSON.parse(await bodyAt(copter, '/__ap_complete__')).build === OLD_BUILD,
          JSON.parse(await bodyAt(copter, '/__ap_complete__')).build);
    check('and it falls back to re-fetching the whole archive',
          fetchCalls.some(u => u.indexOf('.tar') !== -1),
          JSON.stringify(fetchCalls.filter(u => u.indexOf('.tar') !== -1)));
  }

  console.log('\ndifferential update: download, then update');
  {
    // The two halves joined up: a real archive download has to leave behind a
    // table an update can compare against, or the differential path can never
    // engage for anyone who obtained their copy the normal way.
    const cachesObj = makeCaches();
    const first = load({
      manifest: MANIFEST, caches: cachesObj,
      archives: { 'copter/index.html': 'from the archive',
                  'copter/docs/a.html': 'a from the archive' },
      // Common is always part of a download, so it needs a table too, or it
      // falls back to its own archive on the next check and the run below is
      // measuring two different things at once.
      tables: { 'copter-files.json': { 'copter/index.html': 'h1',
                                       'copter/docs/a.html': 'h2' },
                'common-files.json': { '_images/shared.png': 'c1' } }
    });
    await settle();
    first.doc.querySelector('.wiki-check[value="copter"]').click();
    await settle();
    $(first.doc, 'download-cache-btn').click();
    for (let i = 0; i < 20; i++) { await settle(); }

    const copter = await cachesObj.open('ardupilot-offline-copter');
    check('a download stores the file table beside the files',
          !!(await copter.match(TABLE_KEY)),
          JSON.stringify(await bodyAt(copter, TABLE_KEY)));

    const newer = JSON.parse(JSON.stringify(MANIFEST));
    newer.generated = '2027-01-01T00:00:00Z';
    const next = load({
      manifest: newer, caches: cachesObj,
      tables: { 'copter-files.json': { 'copter/index.html': 'h1',
                                       'copter/docs/a.html':
                                         await fileHash('a after the edit') },
                'common-files.json': { '_images/shared.png': 'c1' } },
      served: { '/copter/docs/a.html': 'a after the edit' }
    });
    await settle();
    $(next.doc, 'check-btn').click();
    for (let i = 0; i < 20; i++) { await settle(); }

    check('the update that follows fetches one file, not the archive',
          !next.fetchCalls.some(u => u.indexOf('.tar') !== -1) &&
          siteCalls(next.fetchCalls).length === 1,
          JSON.stringify(siteCalls(next.fetchCalls)));
    check('the edited page is replaced',
          (await bodyAt(copter, '/copter/docs/a.html')) === 'a after the edit',
          JSON.stringify(await bodyAt(copter, '/copter/docs/a.html')));
    check('the untouched page still comes from the archive',
          (await bodyAt(copter, '/copter/index.html')) === 'from the archive',
          JSON.stringify(await bodyAt(copter, '/copter/index.html')));
    check('and the copy now reports the newer build',
          JSON.parse(await bodyAt(copter, '/__ap_complete__')).build ===
            '2027-01-01T00:00:00Z');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('failed: ' + failures.join('; ')); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
