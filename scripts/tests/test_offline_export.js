/*
 * Verification harness for the browser-side exporters.
 *
 *   node scripts/tests/test_offline_export.js [wiki]
 *
 * frontend/js/offline-export.js builds the .pyz and the single-file .html from
 * Cache Storage. Every bug it has had so far - wrong CRCs, images resolved to
 * paths that match nothing, the same image written once per page, a root that
 * 404s - looked fine from the outside and only showed up when something opened
 * the result. So this runs the real exporter against a cache built from real
 * build output, and checks the bytes it produces.
 *
 * The browser APIs it needs are shimmed rather than mocked away: a real
 * CacheStorage-alike over the filesystem, and the exporter is given a sink so
 * output lands in a file instead of a download.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const ARGS = process.argv.slice(2);
const FULL = ARGS.includes('--full');
// --full loads every wiki with no page cap, to measure a real export rather
// than a sample. Slow and memory-hungry; the default stays small.
const WIKIS_ARG = ARGS.filter((a) => !a.startsWith('--'));
const WIKI = WIKIS_ARG[0] || 'rover';
const ALL_WIKIS = ['copter', 'plane', 'rover', 'sub', 'blimp', 'dev',
                   'antennatracker', 'planner', 'planner2', 'ardupilot', 'mavproxy'];
const OUT = '/tmp/ap-export-test';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) { failures++; }
}

/* ---------------------------------------------------------- cache shim ---- */

class FakeResponse {
  constructor(buf) { this._buf = buf; }
  arrayBuffer() { return Promise.resolve(this._buf.buffer.slice(
    this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength)); }
  text() { return Promise.resolve(this._buf.toString('utf8')); }
}

class FakeCache {
  constructor() { this.map = new Map(); }
  put(url, res) { this.map.set(String(url), res); return Promise.resolve(); }
  keys() {
    return Promise.resolve([...this.map.keys()].map((u) => ({ url: 'https://x' + u })));
  }
  match(req) {
    const url = typeof req === 'string' ? req : req.url.replace('https://x', '');
    return Promise.resolve(this.map.get(url));
  }
}

const caches = {
  _all: new Map(),
  keys() { return Promise.resolve([...this._all.keys()]); },
  open(name) {
    if (!this._all.has(name)) { this._all.set(name, new FakeCache()); }
    return Promise.resolve(this._all.get(name));
  }
};

/** Populate the cache the way a real download would: wiki pages + shared images. */
function loadWiki(wiki, limit) {
  const root = path.join(REPO, wiki, 'build', 'html');
  if (!fs.existsSync(root)) {
    console.error('No build output for ' + wiki + ' - run update.py --site ' + wiki);
    process.exit(2);
  }
  const wikiCache = new FakeCache();
  const commonCache = caches._all.get('ardupilot-offline-common') || new FakeCache();
  let pages = 0, images = 0, css = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = '/' + wiki + '/' + path.relative(root, full).split(path.sep).join('/');
      const buf = fs.readFileSync(full);

      if (rel.endsWith('.html')) {
        var isIndex = /\/index\.html$/.test(rel);
        if (pages >= limit && !isIndex) { continue; }
        pages++;
        wikiCache.put(rel, new FakeResponse(buf));
      } else if (/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot)$/i.test(rel)) {
        // Mirror production: shared images live once under /_common/.
        if (rel.includes('/_images/')) {
          if (images >= limit * 3) { continue; }
          images++;
          commonCache.put(rel.replace(/^\/[^/]+\/_images\//, '/_common/_images/'),
                          new FakeResponse(buf));
        } else {
          wikiCache.put(rel, new FakeResponse(buf));
        }
      } else if (rel.endsWith('.css') || rel.endsWith('.js')) {
        css++;
        wikiCache.put(rel, new FakeResponse(buf));
      }
    }
  };
  walk(root);

  wikiCache.put('/__ap_complete__',
    new FakeResponse(Buffer.from(JSON.stringify({ build: 'test', id: wiki }))));
  commonCache.put('/__ap_complete__',
    new FakeResponse(Buffer.from(JSON.stringify({ build: 'test', id: 'common' }))));

  caches._all.set('ardupilot-offline-' + wiki, wikiCache);
  caches._all.set('ardupilot-offline-common', commonCache);
  return { pages, images, css };
}

/* --------------------------------------------------------- module load ---- */

function loadExporter() {
  const src = fs.readFileSync(
    path.join(REPO, 'frontend', 'js', 'offline-export.js'), 'utf8');
  const sandbox = {
    caches,
    TextEncoder, TextDecoder, URL, btoa, console,
    setTimeout, clearTimeout,
    navigator: {},                 // no service worker: forces the sink we pass
    document: { createElement: () => ({ style: {}, click() {}, remove() {} }),
                body: { appendChild() {} } },
    Blob: class { constructor(p) { this.parts = p; } },
    window: {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.ArduPilotExport;
}

/** A sink that writes straight to a file, standing in for the download. */
function fileSink(target) {
  const fd = fs.openSync(target, 'w');
  return {
    write(chunk) { fs.writeSync(fd, Buffer.from(chunk)); return Promise.resolve(); },
    close() { fs.closeSync(fd); return Promise.resolve(); }
  };
}

/**
 * Count patterns and look for literals in a file too large to hold as a string.
 *
 * Chunks overlap so a match spanning a boundary is not missed.
 */
function scanFile(file, patterns, literals) {
  const counts = patterns.map(() => 0);
  const found = {};
  literals.forEach((l) => { found[l] = false; });

  const SIZE = 8 * 1024 * 1024;
  const OVERLAP = 4096;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(SIZE);
  let carry = '';
  let bytes;
  while ((bytes = fs.readSync(fd, buf, 0, SIZE, null)) > 0) {
    const text = carry + buf.slice(0, bytes).toString('latin1');
    patterns.forEach((re, i) => {
      re.lastIndex = 0;
      const m = text.match(re);
      counts[i] += m ? m.length : 0;
    });
    literals.forEach((l) => { if (!found[l] && text.includes(l)) { found[l] = true; } });
    carry = text.slice(-OVERLAP);
  }
  fs.closeSync(fd);
  return { counts, found };
}

/* ------------------------------------------------------------- the run ---- */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const wikis = FULL ? ALL_WIKIS.filter((w) =>
    fs.existsSync(path.join(REPO, w, 'build', 'html'))) : [WIKI];
  const cap = FULL ? Infinity : 40;

  let totals = { pages: 0, images: 0, css: 0 };
  for (const w of wikis) {
    const r = loadWiki(w, cap);
    totals.pages += r.pages; totals.images += r.images; totals.css += r.css;
  }
  const loaded = totals;
  console.log('\ncache: ' + loaded.pages + ' pages, ' + loaded.images +
              ' shared images, ' + loaded.css + ' stylesheets' +
              (FULL ? '  (' + wikis.length + ' wikis, no cap)' : '') + '\n');

  const api = loadExporter();

  console.log('single-file HTML');
  const htmlPath = path.join(OUT, 'test.html');
  const t0 = Date.now();
  const htmlRes = await api.exportHtml(wikis, 'test.html', null, fileSink(htmlPath));
  console.log('  generated in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  // A full export exceeds V8's maximum string length, so scan it in chunks
  // rather than reading it into one string.
  const scan = scanFile(htmlPath, [
    /id="i\d+"/g, /data-ap-img=/g, /data:image\//g, /@font-face/g,
    /<img[^>]{0,200}src="\.\.\//g
  ], ['.wy-nav-content', 'wy-body-for-nav', 'toctree-l1', '#/' + wikis[0] + '/']);

  const html = { includes: (s) => scan.found[s] };
  const imgBlocks = scan.counts[0];
  const imgRefs = scan.counts[1];
  const inlineDataUris = scan.counts[2];

  check('pages written', htmlRes.pages === loaded.pages,
        htmlRes.pages + ' of ' + loaded.pages);
  check('theme stylesheet embedded', html.includes('.wy-nav-content'));
  check('theme markup emitted', html.includes('wy-body-for-nav'));
  check('fonts inlined', scan.counts[3] > 0, scan.counts[3] + ' rules');
  check('images stored once (no per-page duplication)',
        inlineDataUris <= imgBlocks + 2,
        imgBlocks + ' blocks, ' + imgRefs + ' refs, ' + inlineDataUris + ' data URIs');
  check('images actually resolved', imgBlocks > 0);
  check('navigation from toctree', html.includes('toctree-l1'));
  check('path anchors', html.includes('#/' + wikis[0] + '/'));
  check('no unresolved relative image srcs', scan.counts[4] === 0,
        scan.counts[4] + ' left');

  console.log('\nrunnable .pyz');
  const pyzPath = path.join(OUT, 'test.pyz');
  const pyzRes = await api.exportPyz(wikis, 'test.pyz', null, fileSink(pyzPath));
  check('entries written', pyzRes.files > 0, pyzRes.files + ' files');

  const stat = fs.statSync(pyzPath);
  check('archive non-empty', stat.size > 1000, (stat.size / 1048576).toFixed(1) + ' MB');
  console.log('\nsizes: html ' + (fs.statSync(htmlPath).size / 1048576).toFixed(0) +
              ' MB, pyz ' + (stat.size / 1048576).toFixed(0) + ' MB');

  // The archive must answer at its root: opening it to a 404 makes a working
  // file look broken, and that was a real bug. Checked by inspecting the
  // embedded server rather than executing it, so the test cannot hang.
  // __main__.py is stored first, so only the head needs inspecting - and the
  // whole archive is far too large to hold as a string.
  const head = Buffer.alloc(64 * 1024);
  const zfd = fs.openSync(pyzPath, 'r');
  fs.readSync(zfd, head, 0, head.length, 0);
  fs.closeSync(zfd);
  const headText = head.toString('latin1');
  check('root page generator embedded', headText.includes('def _root_page'));
  check('shared-image alias embedded', headText.includes('_candidates'));

  console.log('\nwrote ' + OUT + '/test.html and ' + OUT + '/test.pyz');
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n' : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
