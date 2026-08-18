/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * Differential updates: refresh a saved wiki by fetching only what changed.
 *
 * The build writes one table per archive mapping every path to a hash of its
 * contents. Saving stores the table alongside the files; an update compares the
 * stored table with the freshly published one and fetches only what moved. This
 * library holds that machinery. The panel (common_offline_page.js) drives it and
 * hands in what it needs - where the artifacts live, the current build id, the
 * list of wikis - rather than this file reaching into the panel.
 *
 * Nothing is hashed to find the difference: the stored table is already an exact
 * record of what was written, so the comparison is table against table. But
 * every fetched body IS hashed against the table before it is stored, so a wrong
 * body (a captive-portal page, an error dressed as 200, a mid-deploy mismatch)
 * is refused rather than written over a healthy file.
 *
 * Exposes window.ApUpdate:
 *   updateStored(entry, cfg, onProgress) -> {changed, removed} | null
 *   tableUrl(entry, base, build)         -> URL of a wiki's published table
 *   storeTable(cache, table)             -> persist a table beside its files
 *   hashBytes(arrayBuffer)               -> the build's file hash (sha256/8 hex)
 *
 * cfg carries the live panel config at call time:
 *   { base, build, wikis, here, offlinePrefix, completeMarker, mimeFor, getSignal }
 */
(function (global) {
  'use strict';

  var TABLE_KEY = '/__ap_files__';

  // When more than this has changed, re-download the archive instead of
  // fetching files one by one. A layout or stylesheet edit rewrites every page,
  // and then the "difference" is the whole wiki, one HTTP request at a time -
  // measured at 5,169 requests from one browser after such a change. Above the
  // cap, updateStored returns null and the caller re-fetches one archive.
  // How closely together an update may ask the server for files. 250 ms is
  // four a second: brisk enough that a large update finishes while the reader
  // is still on the page, slow enough that it reads as a browser rather than a
  // crawler. See the pacing note in updateStored.
  var MIN_REQUEST_GAP_MS = 250;

  var MAX_DIFF_FILES = 300;
  var MAX_DIFF_FRACTION = 0.2;
  // Below this, a proportion says nothing: two files out of four is half the
  // wiki and also two requests. Only the absolute cap applies to small ones.
  var DIFF_FRACTION_MIN_FILES = 50;

  // Requests per second one reader makes while updating. Sequential fetches
  // with no pause ran at ~75 a second from one browser; a hundred readers doing
  // that after a build is a flood the differential path exists partly to avoid.
  var UPDATE_RATE_PER_SEC = 15;
  var lastFetchAt = 0;

  function pace() {
    var gap = 1000 / UPDATE_RATE_PER_SEC;
    var wait = Math.max(0, lastFetchAt + gap - Date.now());
    lastFetchAt = Date.now() + wait;
    return wait ? new Promise(function (r) { setTimeout(r, wait); })
                : Promise.resolve();
  }

  /*
   * Hash of a body, exactly as the build computes it: sha256, first eight
   * bytes, hex (scripts/build_offline_artifacts.py, file_hash). The two must
   * agree byte for byte or every update rejects everything.
   */
  function hashBytes(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      var v = new Uint8Array(d);
      var out = '';
      for (var i = 0; i < 8; i++) {
        out += (v[i] < 16 ? '0' : '') + v[i].toString(16);
      }
      return out;
    });
  }

  function tableUrl(entry, base, build) {
    return base + '/' + (entry.files || entry.id + '-files.json') +
           (build ? '?v=' + encodeURIComponent(build) : '');
  }

  function storeTable(cache, table) {
    return cache.put(TABLE_KEY, new Response(JSON.stringify(table), {
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  function readTable(cache) {
    return cache.match(TABLE_KEY).then(function (r) {
      return r ? r.json().catch(function () { return null; }) : null;
    });
  }

  // A table key becomes a cache key by exactly the rule the unpacker used to
  // store it, so the rule is imported rather than restated. Restating it meant
  // a wiki folded into common (About) got its updates written to
  // /_common/ardupilot/..., beside the copy actually being read.
  var cacheKeyFor = ApUnpack.cachePathFor;

  /*
   * Where to fetch a changed file from, best source first.
   *
   * The build publishes rewritten HTML and generated stills at <base>/files/,
   * the exact bytes the table hashes, so an update must prefer them: fetching
   * the ORIGINAL page from the live path mismatches the table and drops the
   * whole wiki into a full re-download. Files identical to the live path are not
   * published there, so their loose URL 404s and the fall-throughs serve them.
   *
   * After the loose copy: a wiki entry is served at its own path; a shared image
   * is stored once under /_common/, a path the site never serves, and published
   * under each wiki that uses it, so those wikis are tried in turn.
   */
  function sourcesFor(id, name, cfg) {
    var out = [cfg.base + '/files/' + name];
    // A shared image is the only entry with no URL of its own. Everything else
    // - a wiki archive's pages, and the pages of a wiki folded into common -
    // is served at its own path, so ask for it there.
    if (id !== 'common' || name.indexOf('_images/') !== 0) {
      out.push('/' + name);
      return out;
    }
    var ids = [cfg.here].concat((cfg.wikis || []).map(function (w) { return w.id; }));
    var seen = {};
    ids.forEach(function (w) {
      if (w && !seen[w]) { seen[w] = 1; out.push('/' + w + '/' + name); }
    });
    return out;
  }

  function fetchInto(cache, id, name, expected, cfg) {
    // Tagged so the service worker sends it to the network. Without this the
    // worker answers from the cache being refreshed, and the update stores what
    // it already had while reporting that it updated.
    var tag = 'ap-update=' + encodeURIComponent(cfg.build || '1');
    var urls = sourcesFor(id, name, cfg).map(function (u) {
      return u + (u.indexOf('?') === -1 ? '?' : '&') + tag;
    });
    var key = cacheKeyFor(id, name);
    function attempt(i) {
      if (i >= urls.length) {
        throw new Error('could not fetch ' + name);
      }
      return pace().then(function () {
        return fetch(urls[i], {
          cache: 'no-cache',
          signal: cfg.getSignal ? cfg.getSignal() : undefined
        });
      }).then(function (r) {
        // The server asking us to slow down is not a missing file, and trying
        // the next wiki for it would be one more request at exactly the wrong
        // moment. Stop, and let the caller fall back to the archive.
        if (r.status === 429 || r.status === 503) {
          var e = new Error('server is rate limiting updates');
          e.name = 'RateLimited';
          throw e;
        }
        if (!r.ok) { return attempt(i + 1); }
        return r.arrayBuffer().then(function (body) {
          // Verify against the table's hash before storing. A 200 with the
          // wrong body was otherwise written verbatim and the table rewritten
          // to claim health, so no later update could ever detect it. A
          // mismatch is treated like a failed fetch: try the next source, and
          // if none is right the update rejects and the archive takes over.
          if (!expected) {
            return cache.put(new Request(key), new Response(body, {
              headers: { 'Content-Type': cfg.mimeFor(name) }
            }));
          }
          return hashBytes(body).then(function (got) {
            if (got !== expected) { return attempt(i + 1); }
            return cache.put(new Request(key), new Response(body, {
              headers: { 'Content-Type': cfg.mimeFor(name) }
            }));
          });
        });
      }, function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'RateLimited')) {
          throw err;
        }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  /*
   * Compare stored against published and apply the difference.
   *
   * Resolves with a summary, or null when this wiki was saved before tables
   * existed, or when too much has changed to be worth fetching file by file, in
   * which case the caller falls back to re-fetching the whole archive.
   */
  function updateStored(entry, cfg, onProgress) {
    var cacheName = cfg.offlinePrefix + entry.id;
    return caches.open(cacheName).then(function (cache) {
      return Promise.all([
        readTable(cache),
        fetch(tableUrl(entry, cfg.base, cfg.build), { cache: 'no-cache' })
          .then(function (r) {
            if (!r.ok) { throw new Error('could not fetch the file list'); }
            return r.json();
          })
      ]).then(function (both) {
        var stored = both[0], published = both[1];
        if (!stored) { return null; }

        var changed = [], removed = [];
        Object.keys(published).forEach(function (k) {
          if (stored[k] !== published[k]) { changed.push(k); }
        });
        Object.keys(stored).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(published, k)) {
            removed.push(k);
          }
        });

        var total = Object.keys(published).length || 1;
        if (changed.length > MAX_DIFF_FILES ||
            (total >= DIFF_FRACTION_MIN_FILES &&
             changed.length / total > MAX_DIFF_FRACTION)) {
          return null;
        }

        /*
         * Paced, not just sequential.
         *
         * This already fetched one file at a time, but with no gap: on a fast
         * connection a 300-file update is 300 requests as quickly as the
         * server will answer them, from every reader whose browser decides to
         * check at the same time. ardupilot.org is a documentation site behind
         * one nginx, and an update that is indistinguishable from a scraper is
         * a good way to have the feature blocked rather than adopted.
         *
         * The gap is measured from the START of each request, so a slow
         * network costs nothing extra - only a fast one is held back to this
         * rate. Nothing here is urgent: an update is a background refresh of
         * pages the reader already has, and taking a minute over it is
         * invisible.
         */
        var done = 0;
        function next(i) {
          if (i >= changed.length) { return Promise.resolve(); }
          var startedAt = Date.now();
          return fetchInto(cache, entry.id, changed[i],
                           published[changed[i]], cfg).then(function () {
            done += 1;
            if (onProgress) { onProgress(done, changed.length); }
            if (i + 1 >= changed.length) { return next(i + 1); }
            var wait = MIN_REQUEST_GAP_MS - (Date.now() - startedAt);
            if (wait <= 0) { return next(i + 1); }
            return new Promise(function (go) { setTimeout(go, wait); })
              .then(function () { return next(i + 1); });
          });
        }

        return next(0).then(function () {
          return Promise.all(removed.map(function (k) {
            return cache.delete(new Request(cacheKeyFor(entry.id, k)));
          }));
        }).then(function () {
          // Written only once every file is in place. An interrupted update
          // therefore leaves the previous table and the previous build id, so
          // the wiki still reports itself as the older build rather than as a
          // mixture of two.
          return storeTable(cache, published);
        }).then(function () {
          return cache.put(cfg.completeMarker, new Response(JSON.stringify({
            build: cfg.build, saved: Date.now(), id: entry.id
          }), { headers: { 'Content-Type': 'application/json' } }));
        }).then(function () {
          return { id: entry.id, changed: changed.length, removed: removed.length };
        });
      });
    });
  }

  global.ApUpdate = {
    updateStored: updateStored,
    tableUrl: tableUrl,
    storeTable: storeTable,
    hashBytes: hashBytes
  };
})(typeof self !== 'undefined' ? self : this);
