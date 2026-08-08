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
const WIKI = process.argv[2] || 'rover';
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
  const commonCache = new FakeCache();
  let pages = 0, images = 0, css = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = '/' + wiki + '/' + path.relative(root, full).split(path.sep).join('/');
      const buf = fs.readFileSync(full);

      if (rel.endsWith('.html')) {
        if (pages >= limit) { continue; }
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
      } else if (rel.endsWith('.css')) {
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

/* ------------------------------------------------------------- the run ---- */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const loaded = loadWiki(WIKI, 40);
  console.log('\ncache: ' + loaded.pages + ' pages, ' + loaded.images +
              ' shared images, ' + loaded.css + ' stylesheets\n');

  const api = loadExporter();

  console.log('single-file HTML');
  const htmlPath = path.join(OUT, 'test.html');
  const htmlRes = await api.exportHtml([WIKI], 'test.html', null, fileSink(htmlPath));
  const html = fs.readFileSync(htmlPath, 'utf8');

  const imgBlocks = (html.match(/id="i\d+"/g) || []).length;
  const imgRefs = (html.match(/data-ap-img=/g) || []).length;
  const inlineDataUris = (html.match(/data:image\//g) || []).length;

  check('pages written', htmlRes.pages === loaded.pages,
        htmlRes.pages + ' of ' + loaded.pages);
  check('theme stylesheet embedded', html.includes('.wy-nav-content'));
  check('theme markup emitted', html.includes('wy-body-for-nav'));
  check('fonts inlined', (html.match(/@font-face/g) || []).length > 0,
        (html.match(/@font-face/g) || []).length + ' rules');
  check('images stored once (no per-page duplication)',
        inlineDataUris <= imgBlocks + 2,
        imgBlocks + ' blocks, ' + imgRefs + ' refs, ' + inlineDataUris + ' data URIs');
  check('images actually resolved', imgBlocks > 0);
  check('navigation from toctree', html.includes('toctree-l1'));
  check('path anchors', html.includes('#/' + WIKI + '/'));
  check('no unresolved relative image srcs',
        !/<img[^>]+src="\.\.\//.test(html));

  console.log('\nrunnable .pyz');
  const pyzPath = path.join(OUT, 'test.pyz');
  const pyzRes = await api.exportPyz([WIKI], 'test.pyz', null, fileSink(pyzPath));
  check('entries written', pyzRes.files > 0, pyzRes.files + ' files');

  const stat = fs.statSync(pyzPath);
  check('archive non-empty', stat.size > 1000, (stat.size / 1048576).toFixed(1) + ' MB');

  console.log('\nwrote ' + OUT + '/test.html and ' + OUT + '/test.pyz');
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n' : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
