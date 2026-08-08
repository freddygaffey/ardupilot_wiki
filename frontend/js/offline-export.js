/*
 * Builds downloadable copies from what is already in Cache Storage.
 *
 * The alternative was for the build server to produce and host a ~480MB .pyz
 * and a ~700MB single-file HTML for every wiki, duplicating content the reader
 * has already downloaded. Generating them here means the server hosts only the
 * archives, and the export costs nothing extra to fetch.
 *
 * Everything streams. A few hundred megabytes cannot be assembled in a Blob or
 * a string, so the page writes chunks into a stream that the service worker
 * answers as a download response, and the browser writes it to disk as it goes.
 * Peak memory is one file, not one archive.
 */
(function (global) {
  'use strict';

  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';

  /* ---------------------------------------------------------------- crc32 */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    // The final inversion is part of the algorithm, not an optimisation.
    // Without it the archive still has a valid structure - correct names,
    // sizes and offsets - so it looks fine until something actually verifies
    // a checksum, at which point every entry fails.
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ------------------------------------------------------------ zip writer */

  function bytes(n) { return new Uint8Array(n); }

  function u16(view, offset, value) { view.setUint16(offset, value, true); }
  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  /**
   * Minimal zip writer. Entries are STORED, never deflated: the payload is
   * mostly PNG and JPEG that gain nothing from a second pass, and storing lets
   * Python read any entry from the archive without decompressing it.
   */
  function ZipWriter(write) {
    this.write = write;       // (Uint8Array) -> Promise
    this.offset = 0;
    this.entries = [];
  }

  ZipWriter.prototype._push = function (chunk) {
    this.offset += chunk.length;
    return this.write(chunk);
  };

  ZipWriter.prototype.add = function (name, data) {
    var self = this;
    var nameBytes = new TextEncoder().encode(name);
    var crc = crc32(data);
    var header = bytes(30);
    var view = new DataView(header.buffer);

    u32(view, 0, 0x04034b50);       // local file header
    u16(view, 4, 20);               // version needed
    u16(view, 6, 0);                // flags
    u16(view, 8, 0);                // method: stored
    u16(view, 10, 0);               // mod time
    u16(view, 12, 0x21);            // mod date (1980-01-01)
    u32(view, 14, crc);
    u32(view, 18, data.length);     // compressed size
    u32(view, 22, data.length);     // uncompressed size
    u16(view, 26, nameBytes.length);
    u16(view, 28, 0);               // extra length

    this.entries.push({
      name: nameBytes, crc: crc, size: data.length, offset: this.offset
    });

    return this._push(header)
      .then(function () { return self._push(nameBytes); })
      .then(function () { return self._push(data); });
  };

  ZipWriter.prototype.finish = function () {
    var self = this;
    var start = this.offset;
    var chain = Promise.resolve();

    this.entries.forEach(function (e) {
      chain = chain.then(function () {
        var rec = bytes(46);
        var view = new DataView(rec.buffer);
        u32(view, 0, 0x02014b50);   // central directory header
        u16(view, 4, 20);           // version made by
        u16(view, 6, 20);           // version needed
        u16(view, 8, 0);
        u16(view, 10, 0);           // stored
        u16(view, 12, 0);
        u16(view, 14, 0x21);
        u32(view, 16, e.crc);
        u32(view, 20, e.size);
        u32(view, 24, e.size);
        u16(view, 28, e.name.length);
        u16(view, 30, 0);
        u16(view, 32, 0);
        u16(view, 34, 0);
        u16(view, 36, 0);
        u32(view, 38, 0);           // external attrs
        u32(view, 42, e.offset);
        return self._push(rec).then(function () { return self._push(e.name); });
      });
    });

    return chain.then(function () {
      var size = self.offset - start;
      var end = bytes(22);
      var view = new DataView(end.buffer);
      u32(view, 0, 0x06054b50);     // end of central directory
      u16(view, 4, 0);
      u16(view, 6, 0);
      u16(view, 8, self.entries.length);
      u16(view, 10, self.entries.length);
      u32(view, 12, size);
      u32(view, 16, start);
      u16(view, 20, 0);
      return self._push(end);
    });
  };

  /* --------------------------------------------------------- cache reading */

  /** Every cached entry belonging to a stored wiki, as [path, Response]. */
  function storedEntries(wikiIds) {
    return caches.keys().then(function (names) {
      var wanted = names.filter(function (n) {
        if (n.indexOf(OFFLINE_CACHE_PREFIX) !== 0) { return false; }
        var id = n.slice(OFFLINE_CACHE_PREFIX.length);
        return wikiIds.indexOf(id) !== -1 || id === 'common';
      });
      return Promise.all(wanted.map(function (name) {
        return caches.open(name).then(function (cache) {
          return cache.keys().then(function (reqs) {
            return { cache: cache, reqs: reqs };
          });
        });
      }));
    });
  }

  /* ------------------------------------------------------ download plumbing */

  /**
   * Open a download the page can write into.
   *
   * Prefers the service worker: it can answer with a ReadableStream, so the
   * browser writes to disk while we are still generating, and this works
   * outside Chromium. Falls back to the File System Access API, and finally to
   * a Blob for browsers with neither - which is memory-bound, so it is only a
   * last resort.
   */
  function openDownload(filename) {
    // Order matters, and none of these may be assumed available. A page can be
    // uncontrolled for perfectly ordinary reasons - a hard reload, a first
    // visit before the worker activates, a worker that failed to install - so
    // the export has to work regardless rather than depend on one path.
    if (navigator.serviceWorker && navigator.serviceWorker.controller &&
        typeof TransformStream !== 'undefined') {
      var ts = new TransformStream();
      var writer = ts.writable.getWriter();
      var id = String(Date.now()) + Math.random().toString(36).slice(2);

      navigator.serviceWorker.controller.postMessage(
        { type: 'EXPORT_START', id: id, filename: filename, stream: ts.readable },
        [ts.readable]
      );

      // An iframe rather than location: navigating away would tear down the
      // page that is generating the stream.
      var frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = '/__export__/' + id;
      document.body.appendChild(frame);

      return Promise.resolve({
        write: function (chunk) { return writer.write(chunk); },
        close: function () {
          return writer.close().then(function () {
            setTimeout(function () { frame.remove(); }, 2000);
          });
        }
      });
    }

    // Needs a user gesture, which the click that got us here provides.
    if (global.showSaveFilePicker) {
      return global.showSaveFilePicker({ suggestedName: filename })
        .then(function (handle) { return handle.createWritable(); })
        .then(function (w) {
          return {
            write: function (chunk) { return w.write(chunk); },
            close: function () { return w.close(); }
          };
        });
    }

    var parts = [];
    return Promise.resolve({
      write: function (chunk) { parts.push(chunk); return Promise.resolve(); },
      close: function () {
        var url = URL.createObjectURL(new Blob(parts));
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        return Promise.resolve();
      }
    });
  }

  /* ---------------------------------------------------------- exports: pyz */

  // Kept in step with scripts/wiki_pyz_main.py. Embedded rather than fetched
  // so an export works with no connection.
  var PYZ_MAIN = [
    '"""ArduPilot wiki, offline. Run: python3 <this file>"""',
    'import http.server, mimetypes, socketserver, sys, threading, zipfile, webbrowser',
    'PORT, STRIDE, TRIES, PREFIX = 8790, 10, 12, "site/"',
    '_p, _local = sys.path[0], threading.local()',
    'def _zip():',
    '    z = getattr(_local, "z", None)',
    '    if z is None: z = _local.z = zipfile.ZipFile(_p)',
    '    return z',
    'import re as _re',
    'def _candidates(name):',
    '    yield name',
    '    yield name.rstrip("/") + "/index.html"',
    '    # Shared images are stored once at site/_images/, but pages ask',
    '    # for them under their own wiki: site/rover/_images/x.png.',
    '    alias = _re.sub(r"^site/[^/]+/_images/", "site/_images/", name)',
    '    if alias != name: yield alias',
    '    # A single-wiki archive has no page at the root, so send / to it.',
    '    if name in ("site/", "site/index.html"):',
    '        for n in _zip().namelist():',
    '            if n.count("/") == 2 and n.endswith("/index.html"): yield n; return',

    'class H(http.server.BaseHTTPRequestHandler):',
    '    protocol_version = "HTTP/1.1"',
    '    def log_message(self, *a): pass',
    '    def do_GET(self):',
    '        path = self.path.split("?")[0].split("#")[0]',
    '        if path.endswith("/"): path += "index.html"',
    '        name = PREFIX + path.lstrip("/")',
    '        body = None',
    '        for cand in _candidates(name):',
    '            try:',
    '                body = _zip().read(cand); break',
    '            except KeyError: pass',
    '        if body is None: self.send_error(404, "Not in archive: " + name); return',
    '        try:',
    '            self.send_response(200)',
    '            self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "application/octet-stream")',
    '            self.send_header("Content-Length", str(len(body)))',
    '            self.end_headers()',
    '            self.wfile.write(body)',
    '        except (BrokenPipeError, ConnectionResetError): self.close_connection = True',
    '    def do_HEAD(self): self.do_GET()',
    'class S(socketserver.ThreadingTCPServer):',
    '    daemon_threads = allow_reuse_address = True',
    '    def handle_error(self, *a):',
    '        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):',
    '            super().handle_error(*a)',
    'for i in range(TRIES):',
    '    try:',
    '        httpd = S(("127.0.0.1", PORT + i * STRIDE), H); port = PORT + i * STRIDE; break',
    '    except OSError as e:',
    '        if e.errno not in (48, 98): raise',
    'else: sys.exit("no free port")',
    'url = "http://127.0.0.1:%d/" % port',
    'print("ArduPilot wiki, offline.\\n  %s\\n\\nPress Ctrl+C to stop." % url)',
    'try: webbrowser.open(url)',
    'except Exception: pass',
    'try: httpd.serve_forever()',
    'except KeyboardInterrupt: print("\\nStopped.")'
  ].join('\n') + '\n';

  /**
   * Write a runnable .pyz containing every cached page for the chosen wikis.
   * `onProgress(done, total)` is called as entries are written.
   */
  function exportPyz(wikiIds, filename, onProgress) {
    return storedEntries(wikiIds).then(function (groups) {
      var total = groups.reduce(function (a, g) { return a + g.reqs.length; }, 0);
      if (!total) {
        throw new Error('Nothing is saved yet - download a wiki first.');
      }

      return openDownload(filename).then(function (sink) {
        var zip = new ZipWriter(sink.write);
        var done = 0;

        return zip.add('__main__.py', new TextEncoder().encode(PYZ_MAIN))
          .then(function () {
            var chain = Promise.resolve();
            groups.forEach(function (g) {
              g.reqs.forEach(function (req) {
                chain = chain.then(function () {
                  var path = new URL(req.url).pathname;
                  if (path === COMPLETE_MARKER) { return; }
                  return g.cache.match(req)
                    .then(function (res) { return res.arrayBuffer(); })
                    .then(function (buf) {
                      // /_common/_images/x -> site/_images/x so the pages,
                      // which ask for their own wiki's path, still resolve.
                      var name = 'site' + path.replace('/_common/', '/');
                      return zip.add(name, new Uint8Array(buf));
                    })
                    .then(function () {
                      done++;
                      if (onProgress && done % 25 === 0) { onProgress(done, total); }
                    });
                });
              });
            });
            return chain;
          })
          .then(function () { return zip.finish(); })
          .then(function () { return sink.close(); })
          .then(function () { return { files: done }; });
      });
    });
  }


  /* --------------------------------------------------- exports: single HTML */

  var BINARY = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i;

  function mimeFor(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
              ttf: 'font/ttf' })[ext] || 'application/octet-stream';
  }

  function base64(bytes) {
    // Chunked: String.fromCharCode.apply blows the argument limit on anything
    // more than a few tens of kilobytes, and these are photographs.
    var out = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  function anchorFor(path) {
    return 'ap-' + path.replace(/^\//, '').replace(/\.[^.]*$/, '')
                       .replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  }

  // The shell: a single-page app, not a concatenation.
  //
  // Pages are written as inert <script type="text/plain"> blocks. The browser
  // parses them as text but never renders them or decodes the data URIs inside,
  // so opening the file costs one parse rather than laying out hundreds of
  // pages and decoding several hundred megabytes of images at once. A page is
  // materialised only when you navigate to it.
  // Only what the app itself needs. Everything else - type, headings,
  // admonitions, code blocks, tables - comes from the theme's own stylesheet,
  // embedded at export time, so this looks like the site rather than like an
  // approximation of it.
  var SHELL_CSS =
    'html,body{height:100%}' +
    '.wy-nav-side{overflow-y:auto}' +
    '#ap-search{margin:12px;padding:8px 10px;border:0;border-radius:3px;' +
    'font:inherit;width:calc(100% - 24px)}' +
    '#ap-nav a.on{background:#2e2b2b;border-left:3px solid #2980b9;color:#fff;' +
    'font-weight:700}' +
    '#ap-miss{display:none;padding:10px 16px;color:#a8620f;background:#ffedcc;' +
    'font-size:13px}' +
    '#ap-bar{background:#2980b9;color:#fff;padding:8px 16px;font-size:13px}' +
    '#ap-brand{background:#2980b9;color:#fff;padding:14px 16px;font-weight:700}' +
    '#ap-brand small{display:block;font-weight:400;opacity:.85;font-size:12px}';

  var SHELL_JS = [
    '(function(){',
    'var D=JSON.parse(document.getElementById("ap-index").textContent);',
    'var doc=document.getElementById("ap-doc");',
    'var nav=document.getElementById("ap-nav");',
    'var crumb=document.getElementById("ap-crumb");',
    'var miss=document.getElementById("ap-miss");',
    'var search=document.getElementById("ap-search");',
    // Anchors are page paths, not ordinals. An ordinal shifts whenever the set
    // of exported pages changes, so a bookmark into last month's file would
    // land somewhere else in this month's.
    'var byPath={};D.pages.forEach(function(p,i){byPath[p.p]=i;});',
    'nav.innerHTML=D.nav;',
    'var links=[].slice.call(nav.querySelectorAll("a[href^=\\"#\\"]"));',
    'function current(){return (location.hash||"").replace(/^#/,"")||D.pages[0].p;}',
    'function show(path){',
    'var i=byPath[path];',
    'if(i===undefined){miss.style.display="block";',
    'miss.textContent="That page is not in this file: "+path;return;}',
    'miss.style.display="none";',
    'var el=document.getElementById("p"+i);if(!el)return;',
    'doc.innerHTML=el.textContent;',
// Images are stored once and referenced by id; attach them only
// for the page being shown, so nothing else decodes.
'[].forEach.call(doc.querySelectorAll("[data-ap-img]"),function(im){',
'var b=document.getElementById("i"+im.getAttribute("data-ap-img"));',
'if(b)im.src=b.textContent;});',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;',
    'crumb.textContent=D.pages[i].t;',
    'document.title=D.pages[i].t+" - ArduPilot (offline)";',
    'links.forEach(function(a){',
    'var on=a.getAttribute("href")==="#"+path;',
    'a.className=on?"on":"";',
    'if(on&&a.scrollIntoView)a.scrollIntoView({block:"nearest"});});}',
    'function route(){show(current());}',
    'window.addEventListener("hashchange",route);',
    // Links inside page content still point at the original files
    // (docs/x.html, ../index.html). Resolve them against the current page and
    // route internally; without this every cross-reference dead-ends.
    'function resolve(base,href){',
    'var parts=base.split("/");parts.pop();',
    'href.split("/").forEach(function(seg){',
    'if(seg===".."){parts.pop();}else if(seg!=="."&&seg!==""){parts.push(seg);}});',
    'return parts.join("/").replace(/\\.html?$/,"");}',
    'doc.addEventListener("click",function(e){',
    'var a=e.target.closest?e.target.closest("a[href]"):null;if(!a)return;',
    'var href=a.getAttribute("href");',
    'if(!href||/^(https?:|mailto:|#)/.test(href))return;',
    'var frag="";var h=href;var hi=h.indexOf("#");',
    'if(hi>=0){frag=h.slice(hi);h=h.slice(0,hi);}',
    'var target=resolve(current(),h);',
    'if(byPath[target]!==undefined){e.preventDefault();location.hash="#"+target;',
    'if(frag){var t=doc.querySelector(frag);if(t&&t.scrollIntoView)t.scrollIntoView();}}',
    '});',
    // Filter the real navigation tree rather than a flat list.
    'search.addEventListener("input",function(){',
    'var q=search.value.toLowerCase();',
    'links.forEach(function(a){',
    'var li=a.parentNode;',
    'li.style.display=a.textContent.toLowerCase().indexOf(q)===-1?"none":"";});});',
    'document.addEventListener("keydown",function(e){',
    'if(e.key==="/"&&document.activeElement!==search){e.preventDefault();search.focus();}});',
    'route();})();'
  ].join('');

  /** Lift the theme's navigation tree out of a wiki's index page. */
  function extractNav(html, wiki) {
    var m = html.match(/<div class="wy-menu wy-menu-vertical"[^>]*>([\s\S]*?)<\/div>/i);
    if (!m) { return ''; }
    // Hrefs in the root index are relative to the wiki root, so they map
    // straight onto our anchors once the extension is dropped.
    return m[1].replace(/href="([^"#]+)(#[^"]*)?"/g, function (all, href) {
      if (/^(https?:|mailto:)/.test(href)) { return all; }
      return 'href="#/' + wiki + '/' + href.replace(/\.html?$/, '') + '"';
    });
  }

  /**
   * Assemble one self-contained HTML file from the cached pages.
   *
   * Images are inlined as data URIs, the shared common set included: a single
   * file cannot reference an archive beside it. Written straight to the stream
   * page by page, because the finished file runs to hundreds of megabytes and
   * cannot be built as a string first.
   */
  function exportHtml(wikiIds, filename, onProgress) {
    var enc = new TextEncoder();

    return storedEntries(wikiIds).then(function (groups) {
      var pages = [], assets = {}, styles = {}, roots = {};

      groups.forEach(function (g) {
        g.reqs.forEach(function (req) {
          var path = new URL(req.url).pathname;
          if (path === COMPLETE_MARKER) { return; }
          if (BINARY.test(path)) { assets[path] = g.cache; }
          else if (/\.css$/.test(path)) { styles[path] = g.cache; assets[path] = g.cache; }
          else if (/\.html?$/.test(path)) {
            pages.push({ path: path, cache: g.cache });
            if (/^\/[^/]+\/index\.html$/.test(path)) {
              roots[path.split('/')[1]] = { cache: g.cache, path: path };
            }
          }
        });
      });

      if (!pages.length) {
        throw new Error('Nothing is saved yet - download a wiki first.');
      }
      pages.sort(function (a, b) { return a.path < b.path ? -1 : 1; });

      // Build the navigation from each wiki's own toctree, so the structure is
      // the wiki's rather than an alphabetical list of every file.
      var wikis = Object.keys(roots).sort();
      return Promise.all(wikis.map(function (w) {
        return roots[w].cache.match(roots[w].path)
          .then(function (r) { return r.text(); })
          .then(function (html) {
            return '<p class="caption">' + w + '</p>' + extractNav(html, w);
          })
          .catch(function () { return ''; });
      })).then(function (navParts) {
        var navHtml = navParts.join('');
        return buildThemeCss(styles, assets).then(function (themeCss) {
        return openDownload(filename).then(function (sink) {
          var done = 0, index = [];
          // Shared across pages so each image is emitted once.
          var imgIds = { __next: 0 };
          var write = function (text) { return sink.write(enc.encode(text)); };

          return write(
            '<!DOCTYPE html><html lang="en" class="writer-html5"><head>' +
            '<meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>ArduPilot wiki (offline)</title>' +
            '<style>' + themeCss + '</style><style>' + SHELL_CSS + '</style>' +
            '</head><body class="wy-body-for-nav">' +
            '<div class="wy-grid-for-nav">' +
            '<nav data-toggle="wy-nav-shift" class="wy-nav-side">' +
            '<div id="ap-brand">ArduPilot<small>offline copy &middot; ' +
            wikis.join(', ') + '</small></div>' +
            '<input id="ap-search" placeholder="Filter pages  ( / )" autocomplete="off">' +
            '<div class="wy-menu wy-menu-vertical" id="ap-nav"></div></nav>' +
            '<section data-toggle="wy-nav-shift" class="wy-nav-content-wrap">' +
            '<div class="wy-nav-content"><div class="rst-content">' +
            '<div id="ap-bar">Offline copy built from pages saved on your device. ' +
            'It does not update itself.</div>' +
            '<div id="ap-miss"></div><div id="ap-crumb"></div>' +
            '<div itemprop="articleBody" id="ap-doc"></div>' +
            '</div></div></section></div>'
          ).then(function () {
            var chain = Promise.resolve();
            pages.forEach(function (p, i) {
              chain = chain.then(function () {
                return p.cache.match(p.path)
                  .then(function (res) { return res.text(); })
                  .then(function (html) {
                    var title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] ||
                                p.path.replace(/^\//, '');
                    title = title.split('&mdash;')[0].split(' — ')[0].trim();
                    index.push({ t: title, p: p.path.replace(/\.html?$/, '') });

                    var m = html.match(/<div[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>\s*<footer/i);
                    return referenceImages(m ? m[1] : html, assets, p.path, imgIds);
                  })
                  .then(function (r) {
                    done++;
                    if (onProgress && done % 10 === 0) { onProgress(done, pages.length); }
                    var body = r.html.split('</script>').join('<\\/script>');
                    // Images seen for the first time are written now, once.
                    var blocks = r.fresh.map(function (f) {
                      return '<script type="text/plain" id="i' + f.id + '">' +
                             f.uri + '<\/script>';
                    }).join('');
                    return write(blocks + '<script type="text/plain" id="p' + i + '">' +
                                 body + '<\/script>');
                  });
              });
            });
            return chain;
          }).then(function () {
            var payload = { pages: index, nav: navHtml, wikis: wikis };
            return write('<script type="application/json" id="ap-index">' +
                         JSON.stringify(payload).split('</').join('<\\/') +
                         '<\/script><script>' + SHELL_JS + '<\/script></body></html>');
          }).then(function () { return sink.close(); })
            .then(function () { return { pages: done }; });
        });
        });
      });
    });
  }

  /**
   * Rebuild the theme's stylesheet with its fonts inlined.
   *
   * Without this the export approximates the theme: admonitions, code blocks,
   * tables and inline literals all render plain, and the type falls back to
   * Helvetica because Lato and Roboto Slab are loaded by @font-face. All of it
   * is already in the cache, so using it is a few hundred kilobytes on a file
   * that is already hundreds of megabytes.
   */
  function buildThemeCss(styles, assets) {
    var wanted = Object.keys(styles).filter(function (p) {
      return /_static\/css\/(theme|badge_only)\.css$/.test(p) ||
             /_static\/(ardupilot|custom)\.css$/.test(p);
    }).sort();
    if (!wanted.length) { return Promise.resolve(''); }

    // One wiki's copy is enough - they are identical across wikis.
    var seen = {};
    wanted = wanted.filter(function (p) {
      var base = p.replace(/^\/[^/]+\//, '');
      if (seen[base]) { return false; }
      seen[base] = 1;
      return true;
    });

    var chain = Promise.resolve('');
    wanted.forEach(function (path) {
      chain = chain.then(function (acc) {
        return styles[path].match(path)
          .then(function (r) { return r.text(); })
          .then(function (css) { return inlineCssUrls(css, path, assets); })
          .then(function (css) { return acc + '\n' + css; })
          .catch(function () { return acc; });
      });
    });
    return chain;
  }

  /** Replace url(...) in a stylesheet with data URIs from the cache. */
  function inlineCssUrls(css, cssPath, assets) {
    var refs = [];
    css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, function (all, ref) {
      if (!/^(data:|https?:|\/\/)/.test(ref) && refs.indexOf(ref) === -1) {
        refs.push(ref);
      }
      return all;
    });
    if (!refs.length) { return Promise.resolve(css); }

    var chain = Promise.resolve(css);
    refs.forEach(function (ref) {
      chain = chain.then(function (current) {
        var clean = ref.split('?')[0].split('#')[0];
        var resolved = clean.charAt(0) === '/' ? clean : resolvePath(cssPath, clean);
        if (!assets[resolved]) { return current; }
        return assets[resolved].match(resolved)
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            var uri = 'data:' + mimeFor(resolved) + ';base64,' +
                      base64(new Uint8Array(buf));
            return current.split(ref).join(uri);
          })
          .catch(function () { return current; });
      });
    });
    return chain;
  }

  /** Resolve a relative href against a page path, as a browser would. */
  function resolvePath(basePath, href) {
    var parts = basePath.split('/');
    parts.pop();                       // drop the page's own filename
    href.split('/').forEach(function (seg) {
      if (seg === '..') { parts.pop(); }
      else if (seg && seg !== '.') { parts.push(seg); }
    });
    return parts.join('/');
  }

  /**
   * Point each <img> at a shared image block instead of inlining it.
   *
   * Inlining per page encodes the same picture once for every page that shows
   * it - a diagram used on forty pages was written forty times, which is what
   * made a full export enormous. Each image is now emitted once as its own
   * inert block and referenced by id, so the file holds one copy of each
   * regardless of how many pages use it.
   *
   * Returns the rewritten html plus any images seen for the first time, which
   * the caller writes out as it streams.
   */
  function referenceImages(html, assets, pagePath, imgIds) {
    var srcs = [];
    html.replace(/<img[^>]+src="([^"]+)"/gi, function (all, src) {
      if (srcs.indexOf(src) === -1) { srcs.push(src); }
      return all;
    });
    if (!srcs.length) { return Promise.resolve({ html: html, fresh: [] }); }

    var fresh = [];
    var chain = Promise.resolve(html);

    srcs.forEach(function (src) {
      chain = chain.then(function (current) {
        if (/^(data:|https?:|\/\/)/.test(src)) { return current; }

        var clean = src.split('?')[0].split('#')[0];
        var resolved = clean.charAt(0) === '/' ? clean : resolvePath(pagePath, clean);
        var candidates = [
          resolved,
          resolved.replace(/^\/[^/]+\/_images\//, '/_common/_images/')
        ];

        var hit = null;
        candidates.forEach(function (c) { if (!hit && assets[c]) { hit = c; } });
        if (!hit) { return current; }

        // Already emitted for an earlier page: just point at it.
        if (imgIds[hit] !== undefined) {
          return current.split('src="' + src + '"')
                        .join('data-ap-img="' + imgIds[hit] + '"');
        }

        var id = imgIds[hit] = imgIds.__next++;
        return assets[hit].match(hit)
          .then(function (res) { return res.arrayBuffer(); })
          .then(function (buf) {
            fresh.push({
              id: id,
              uri: 'data:' + mimeFor(hit) + ';base64,' + base64(new Uint8Array(buf))
            });
            return current.split('src="' + src + '"')
                          .join('data-ap-img="' + id + '"');
          })
          .catch(function () { return current; });
      });
    });

    return chain.then(function (out) { return { html: out, fresh: fresh }; });
  }

  global.ArduPilotExport = {
    exportPyz: exportPyz,
    exportHtml: exportHtml,
    openDownload: openDownload
  };
})(window);
