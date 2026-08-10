/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * The same destinations as docs/common-offline.rst, deliberately: an asset
 * belongs wherever its page does. Without a marker a .js takes
 * DEFAULT_COPY_WIKIS, which is four of the eleven, so the panel would have
 * been scriptless on seven wikis while looking correct on the four anyone
 * would think to check. (.css is copied to every wiki unconditionally, which
 * is why the stylesheet needs no marker and this does.)
 */
/*
 * Builds downloadable copies from what is already in Cache Storage.
 *
 * This half reads the cache and moves bytes. What the finished file says -
 * its shell, its stylesheet, its sidebar tree and its reading order - is in
 * common_offline_document.js, which must be loaded first.
 *
 * The alternative was for the build server to produce and host a ~970MB file
 * for every combination of wikis, duplicating content the reader has already
 * downloaded. Generating it here means the server hosts only the archives,
 * and the export costs nothing extra to fetch.
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

  /* --------------------------------------------------- exports: single HTML */

  var BINARY = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i;

  function mimeFor(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
              ttf: 'font/ttf' })[ext] || 'application/octet-stream';
  }

  /**
   * Relative reference -> path from the site root, as a browser would read it.
   *
   * The rule lives in common_offline_document.js because the sidebar applies
   * it to every href in every toctree it reads. Images and stylesheets need
   * exactly the same rule, and a second copy is how the two would come to
   * disagree about where a file is. Looked up per call so the two scripts may
   * load in either order.
   */
  function resolvePath(basePath, href) {
    return global.ArduPilotOfflineDocument.resolvePath(basePath, href);
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

  /**
   * Sphinx's own search index, trimmed to what searching needs.
   *
   * The file is `Search.setIndex({...})`, so the JSON sits between the outer
   * brackets. Dropping objects, indexentries, alltitles and filenames halves
   * it: 11 MB across eleven wikis becomes 5 MB, against a 970 MB export.
   */
  function readSearchIndex(entry) {
    return entry.cache.match(entry.path)
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

  /**
   * Assemble one self-contained HTML file from the cached pages.
   *
   * Images are inlined as data URIs, the shared common set included: a single
   * file cannot reference an archive beside it. Written straight to the stream
   * page by page, because the finished file runs to hundreds of megabytes and
   * cannot be built as a string first.
   */
  function exportHtml(wikiIds, filename, onProgress, sink) {
    var enc = new TextEncoder();
    // What the file says, as opposed to where its bytes come from. Read here
    // rather than at load time so the two scripts may arrive in either order.
    var DOC = global.ArduPilotOfflineDocument;
    if (!DOC) {
      throw new Error('common_offline_document.js is not loaded.');
    }

    return storedEntries(wikiIds).then(function (groups) {
      var pages = [], assets = {}, styles = {};
      // Sphinx already built a stemmed full-text index per wiki, and the
      // stemmer that built it. Both are sitting in the cache.
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

      // The parameter list is published once per release, back to 3.x, and one
      // of those pages is 5.8 MB. Decide which to carry before anything is
      // written, so the ones left out cost nothing rather than being written
      // and then ignored.
      var params = DOC.parameterVersions(pages.map(function (p) {
        return p.path.replace(/\.html?$/, '');
      }));
      pages = pages.filter(function (p) {
        return !params.drop[p.path.replace(/\.html?$/, '')];
      });

      // Group by wiki from the pages themselves, so a wiki still appears even
      // if its index page was not part of the export.
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
          // Shared across pages so each image is emitted once.
          var imgIds = { __next: 0 };
          // Image path as pages spell it -> the id of the block holding it,
          // so a link to an image can be answered from what is already here.
          var imgPaths = {};
          // The navigation is collected as the pages stream past rather than
          // read from each wiki's index page. The index page is the one page
          // whose sidebar expands nothing, so reading only that produced the
          // flat list the export used to show; every other page expands the
          // branch it sits in, and the union of them is the whole tree.
          var navState = DOC.newNav();
          var write = function (text) { return sink.write(enc.encode(text)); };

          return write(DOC.head(wikis, themeCss)).then(function () {
            var chain = Promise.resolve();
            pages.forEach(function (p, i) {
              chain = chain.then(function () {
                return p.cache.match(p.path)
                  .then(function (res) { return res.text(); })
                  .then(function (html) {
                    var title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] ||
                                p.path.replace(/^\//, '');
                    // Strip the theme's " <dash> Project documentation" suffix.
                    // The dashes are what Sphinx emits, so the split spells them.
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
            // With one wiki there is nothing to choose, so open it directly.
            // With several, opening on one of them is a guess: show the list.
            var homes = DOC.wikiHomes(index, wikis);
            // Sidebar and reading order out of the same call, because a
            // separately derived order disagrees with the tree on screen.
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
                ? stemmerSrc.cache.match(stemmerSrc.path)
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
          // Leaving the relative src in place points at nothing once the page
          // is inside a single file, and shows as a silently blank space.
          // Drop the src so the alt text renders and the gap is legible.
          return current.split('src="' + src + '"')
                        .join('data-ap-missing="' + src + '"');
        }

        // Record the path as the page spells it, so a link to this image can
        // be answered from the copy already in the file.
        // Already emitted for an earlier page: just point at it.
        if (imgIds[hit] !== undefined) {
          if (imgPaths) { imgPaths[resolved] = imgIds[hit]; }
          return current.split('src="' + src + '"')
                        .join('data-ap-img="' + imgIds[hit] + '"');
        }

        var id = imgIds[hit] = imgIds.__next++;
        if (imgPaths) { imgPaths[resolved] = id; }
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
    exportHtml: exportHtml,
    openDownload: openDownload
  };
})(window);
