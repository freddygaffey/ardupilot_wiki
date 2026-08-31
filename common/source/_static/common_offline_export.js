/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * Build a single self-contained HTML file from what is in Cache Storage,
 * streamed to disk through the service worker so peak memory is one file, not
 * one archive. What the file says is in common_offline_document_builder.js.
 * The destinations match docs/common-offline.rst; without a marker a .js
 * reaches only DEFAULT_COPY_WIKIS.
 */
(function (global) {
  'use strict';

  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';

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

  /** Open a download the page can write into: streamed through the service
   *  worker, else the File System Access API, else a memory-bound Blob. */
  function openDownload(filename) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller &&
        typeof TransformStream !== 'undefined') {
      var ts = new TransformStream();
      var writer = ts.writable.getWriter();
      var id = String(Date.now()) + Math.random().toString(36).slice(2);

      navigator.serviceWorker.controller.postMessage(
        { type: 'EXPORT_START', id: id, filename: filename, stream: ts.readable },
        [ts.readable]
      );

      // An iframe: navigating away would tear down the generating page.
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

  /* --------------------------------------------------- exports: single HTML */

  var BINARY = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i;

  function mimeFor(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
              ttf: 'font/ttf' })[ext] || 'application/octet-stream';
  }

  // One resolution rule, shared with the document builder; looked up per call
  // so the scripts may load in either order.
  function resolvePath(basePath, href) {
    return global.ArduPilotOfflineDocument.resolvePath(basePath, href);
  }

  function base64(bytes) {
    // Chunked: fromCharCode.apply blows the argument limit on large images.
    var out = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  /** Sphinx's search index, trimmed to what searching needs (11 MB -> 5 MB). */
  function readSearchIndex(entry) {
    return ApUnpack.readFrom(entry.cache, entry.path)
      .then(function (r) { return r.text(); })
      .then(function (src) {
        var open = src.indexOf('('), close = src.lastIndexOf(')');
        if (open === -1 || close <= open) { return null; }
        var d = JSON.parse(src.slice(open + 1, close));
        if (!d.terms || !d.docnames) { return null; }
        return { docnames: d.docnames, titles: d.titles || [],
                 terms: d.terms, titleterms: d.titleterms || {} };
      })
      .catch(function () { return null; });
  }

  /** Assemble one self-contained HTML file from the cached pages, images
   *  inlined once each, written page by page to the stream. */
  function exportHtml(wikiIds, filename, onProgress, sink) {
    var enc = new TextEncoder();
    var DOC = global.ArduPilotOfflineDocument;
    if (!DOC) {
      throw new Error('common_offline_document_builder.js is not loaded.');
    }

    return storedEntries(wikiIds).then(function (groups) {
      var pages = [], assets = {}, styles = {};
      // Sphinx's stemmed index and its stemmer are both in the cache.
      var indexes = {}, stemmerSrc = null;

      groups.forEach(function (g) {
        g.reqs.forEach(function (req) {
          var path = new URL(req.url).pathname;
          if (path === COMPLETE_MARKER) { return; }
          var si = path.match(/^\/([^/]+)\/searchindex\.js$/);
          if (si) { indexes[si[1]] = { cache: g.cache, path: path }; return; }
          if (/\/_static\/language_data\.js$/.test(path)) {
            if (!stemmerSrc) { stemmerSrc = { cache: g.cache, path: path }; }
            return;
          }
          if (BINARY.test(path)) { assets[path] = g.cache; }
          else if (/\.css$/.test(path)) { styles[path] = g.cache; assets[path] = g.cache; }
          else if (/\.html?$/.test(path)) {
            pages.push({ path: path, cache: g.cache });
          }
        });
      });

      if (!pages.length) {
        throw new Error('Nothing is saved yet - download a wiki first.');
      }
      pages.sort(function (a, b) { return a.path < b.path ? -1 : 1; });

      // Decide which parameter-list versions to carry before anything is written.
      var params = DOC.parameterVersions(pages.map(function (p) {
        return p.path.replace(/\.html?$/, '');
      }));
      pages = pages.filter(function (p) {
        return !params.drop[p.path.replace(/\.html?$/, '')];
      });

      // From the pages themselves, so a wiki appears even without its index page.
      var wikis = [];
      pages.forEach(function (pg) {
        var w = pg.path.split('/')[1];
        if (w && wikis.indexOf(w) === -1) { wikis.push(w); }
      });
      wikis.sort();

      return buildThemeCss(styles, assets).then(function (themeCss) {
        return (sink ? Promise.resolve(sink) : openDownload(filename))
        .then(function (sink) {
          var done = 0, index = [];
          // Each image is emitted once and referenced by id.
          var imgIds = { __next: 0 };
          var imgPaths = {};
          // The navigation is the union of every page's expanded sidebar; the
          // index page alone expands nothing.
          var navState = DOC.newNav();
          var write = function (text) { return sink.write(enc.encode(text)); };

          return write(DOC.head(wikis, themeCss)).then(function () {
            var chain = Promise.resolve();
            pages.forEach(function (p, i) {
              chain = chain.then(function () {
                return ApUnpack.readFrom(p.cache, p.path)
                  .then(function (res) { return res.text(); })
                  .then(function (html) {
                    var title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] ||
                                p.path.replace(/^\//, '');
                    // Strip the theme's " <dash> Project documentation" suffix.
                    title = title.split('&mdash;')[0].split(' — ')[0].trim();
                    index.push({ t: title, p: p.path.replace(/\.html?$/, '') });

                    DOC.addNav(navState, html, p.path);

                    var m = html.match(/<div[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>\s*<footer/i);
                    return referenceImages(m ? m[1] : html, assets, p.path,
                                           imgIds, imgPaths);
                  })
                  .then(function (r) {
                    done++;
                    if (onProgress && done % 10 === 0) { onProgress(done, pages.length); }
                    return write(DOC.pageBlock(i, r.html, r.fresh));
                  });
              });
            });
            return chain;
          }).then(function () {
            // One wiki opens directly; several show the list.
            var homes = DOC.wikiHomes(index, wikis);
            // Sidebar and reading order from one call, so they agree.
            var nav = DOC.buildNav(navState, wikis, pages);
            var payload = { pages: index, nav: nav.html, order: nav.order,
                            wikis: wikis, imgs: imgPaths, homes: homes,
                            params: params.byWiki,
                            home: homes.length === 1 ? homes[0].path : '' };

            var wantIndex = wikis.filter(function (w) { return indexes[w]; });
            return Promise.all(wantIndex.map(function (w) {
              return readSearchIndex(indexes[w]).then(function (d) {
                return d ? [w, d] : null;
              });
            })).then(function (loaded) {
              var byWiki = {};
              loaded.forEach(function (e) { if (e) { byWiki[e[0]] = e[1]; } });
              var stem = stemmerSrc
                ? ApUnpack.readFrom(stemmerSrc.cache, stemmerSrc.path)
                    .then(function (r) { return r.text(); })
                    .catch(function () { return ''; })
                : Promise.resolve('');
              return stem.then(function (stemSrc) {
                return write(DOC.searchBlock(byWiki, stemSrc));
              });
            }).then(function () {
              return write(DOC.tail(payload));
            });
          }).then(function () { return sink.close(); })
            .then(function () { return { pages: done }; });
        });
      });
    });
  }

  /** The theme's stylesheets with their fonts inlined, so the export renders
   *  as the site does. */
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
        return ApUnpack.readFrom(styles[path], path)
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
        return ApUnpack.readFrom(assets[resolved], resolved)
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

  /** Point each <img> at a shared image block, so a diagram on forty pages is
   *  written once. Returns the html and any images seen for the first time. */
  function referenceImages(html, assets, pagePath, imgIds, imgPaths) {
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
        if (!hit) {
          // Drop the src so the alt text renders instead of a blank space.
          return current.split('src="' + src + '"')
                        .join('data-ap-missing="' + src + '"');
        }

        // Already emitted: point at it.
        if (imgIds[hit] !== undefined) {
          if (imgPaths) { imgPaths[resolved] = imgIds[hit]; }
          return current.split('src="' + src + '"')
                        .join('data-ap-img="' + imgIds[hit] + '"');
        }

        var id = imgIds[hit] = imgIds.__next++;
        if (imgPaths) { imgPaths[resolved] = id; }
        return ApUnpack.readFrom(assets[hit], hit)
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
    exportHtml: exportHtml,
    openDownload: openDownload
  };
})(window);
