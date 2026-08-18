/*
 * Serve the locally built wiki the way a deployed mirror does, without copying
 * ten gigabytes into a staging directory first.
 *
 * deploy_mirror.sh lays out `frontend/*` at the web root, each wiki's
 * `build/html` under its own name, and `offline/` alongside. This maps those
 * three sources onto one origin at request time instead:
 *
 *   /offline/<f>        -> offline/<f>
 *   /<wiki>/<rest>      -> <wiki>/build/html/<rest>
 *   everything else     -> frontend/<path>
 *
 * localhost is a secure context, so service workers register over plain HTTP
 * and no certificate is needed.
 *
 * Used by test_offline_browsers.js, which stops the server mid-test: killing a
 * local origin is the only way to take *every* engine offline, since
 * Playwright's setOffline does not reach service worker fetches outside
 * Chromium.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WIKIS = new Set(['copter', 'plane', 'rover', 'sub', 'blimp', 'dev',
  'antennatracker', 'planner', 'planner2', 'ardupilot', 'mavproxy']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.gz': 'application/gzip',
  '.inv': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/** Map a request path onto a file in the source tree. */
function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (rel.endsWith('/')) {
    rel += 'index.html';
  }
  rel = rel.replace(/^\/+/, '');

  // No traversal out of the tree, whatever the path claims to be.
  const parts = rel.split('/').filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) {
    return path.join(ROOT, 'frontend', 'index.html');
  }

  if (parts[0] === 'offline') {
    return path.join(ROOT, 'offline', ...parts.slice(1));
  }
  if (WIKIS.has(parts[0])) {
    return path.join(ROOT, parts[0], 'build', 'html', ...parts.slice(1));
  }
  return path.join(ROOT, 'frontend', ...parts);
}

/*
 * The header rules that the offline feature actually depends on, copied from
 * frontend/_headers. A test that serves sw.js cacheable would pass while the
 * real recovery path is broken.
 */
function extraHeaders(urlPath) {
  if (urlPath === '/sw.js') {
    return { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' };
  }
  if (urlPath === '/manifest.json' || urlPath.startsWith('/offline/')) {
    return { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
  }
  return {};
}

/*
 * Deploying a new service worker is the one routine event that takes control
 * away from every tab already on the site, so a test has to be able to cause
 * one. Bumping this appends a changed comment to sw.js, which is all the
 * browser compares - the worker then installs, skipWaiting()s and activates,
 * exactly as a real deploy does.
 */
let workerBuild = 0;
function bumpWorker() {
  workerBuild += 1;
  return workerBuild;
}

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const file = resolveFile(req.url || '/');

    /*
     * nginx gzip_static, which the mirror relies on and this has to match.
     *
     * The manifest deliberately names `<wiki>-offline.tar`, with no .gz: nginx
     * finds the .gz beside it and serves that with Content-Encoding: gzip, so
     * the browser inflates the archive natively and the unpacker gets a plain
     * tar stream. Without this the archives 404 here while working in
     * production, which is the wrong way round for a test server whose whole
     * job is to behave like the real one. Verified against the mirror:
     * requesting the .tar returns 200, Content-Encoding: gzip.
     */
    if (urlPath.endsWith('.tar') && fs.existsSync(file + '.gz')) {
      const gz = file + '.gz';
      res.writeHead(200, Object.assign({
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(gz).size,
        'Content-Encoding': 'gzip',
      }, extraHeaders(urlPath)));
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(gz).pipe(res);
      return;
    }

    if (urlPath === '/sw.js' && workerBuild) {
      fs.readFile(file, 'utf8', (err, body) => {
        if (err) {
          res.writeHead(404); res.end(); return;
        }
        const stamped = body + '\n// test build ' + workerBuild + '\n';
        res.writeHead(200, Object.assign({
          'Content-Type': TYPES['.js'],
          'Content-Length': Buffer.byteLength(stamped),
        }, extraHeaders(urlPath)));
        res.end(stamped);
      });
      return;
    }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        if (!err && stat.isDirectory()) {
          res.writeHead(301, { Location: urlPath + '/' });
          res.end();
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404</h1>');
        return;
      }
      const type = TYPES[path.extname(file).toLowerCase()] ||
        'application/octet-stream';
      res.writeHead(200, Object.assign({
        'Content-Type': type,
        'Content-Length': stat.size,
      }, extraHeaders(urlPath)));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file).pipe(res);
    });
  });
}

/** Listen on an ephemeral port; resolves with { server, port, close }. */
function start(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // Kept short so that stopping the server does not wait on the keep-alive
    // sockets the browser is holding open. Without this, close() hangs.
    server.keepAliveTimeout = 1;
    const sockets = new Set();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.on('error', reject);
    server.listen(port || 0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => {
          sockets.forEach((s) => s.destroy());
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { start, createServer, resolveFile, bumpWorker, WIKIS };

if (require.main === module) {
  const port = Number(process.argv[2] || 8000);
  start(port).then(({ port: p }) => {
    console.log(`serving the built wiki on http://localhost:${p}/`);
  });
}
