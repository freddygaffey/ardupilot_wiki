/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * Marker required: without one a .js copies to only four of the eleven wikis,
 * leaving the panel scriptless on the other seven.
 *
 * Logic for /offline/. State is measured from Cache Storage and the Storage
 * API, not remembered, so an evicted copy shows as gone. Download fetches one
 * pre-built archive per wiki and unpacks it locally rather than crawling.
 */
(function (global) {
  'use strict';

  // Bumped when this file changes in a way worth telling apart at runtime.
  // window.ArduPilotOfflineVersion answers "is the page running the code I just
  // deployed?" without inferring it from behaviour.
  var VERSION = 'verified-bytes-1';
  global.ArduPilotOfflineVersion = VERSION;


  // What the table shows for the fraction of a second before the manifest
  // arrives, and all it has to show if the manifest cannot be fetched. Copied
  // from a real build's offline-manifest.json, so refresh them when the figures
  // move: these last read 110 MB for Copter, which stopped being true the day
  // the historical parameter pages moved out of the archives.
  //
  // "About" has no row: at 3 MB and 28 pages it was the smallest entry by an
  // order of magnitude, and whether to include it was a question with only one
  // sensible answer. It travels inside common now, which is why common has a
  // page count at all. See FOLD_INTO_COMMON in build_offline_artifacts.py.
  var COMMON = { id: 'common', name: 'Common (required)', mb: 442, pages: 28, required: true };
  var WIKIS = [
    { id: 'copter', name: 'Copter', mb: 74, pages: 860 },
    { id: 'dev', name: 'Developer', mb: 52, pages: 313 },
    { id: 'plane', name: 'Plane', mb: 42, pages: 829 },
    { id: 'rover', name: 'Rover', mb: 32, pages: 761 },
    { id: 'sub', name: 'Sub', mb: 15, pages: 653 },
    { id: 'blimp', name: 'Blimp', mb: 12, pages: 292 },
    { id: 'planner', name: 'Mission Planner', mb: 12, pages: 76 },
    { id: 'mavproxy', name: 'MAVProxy', mb: 7, pages: 115 },
    { id: 'planner2', name: 'APM Planner 2', mb: 5, pages: 43 },
    { id: 'antennatracker', name: 'Antenna Tracker', mb: 4, pages: 55 }
  ];

  // The archives are ordinary static files in the built tree, written to
  // <destdir>/offline/ by update.py --offline and served by nginx like any
  // other file: same origin as the pages, so no CORS and no separate host. The
  // manifest's "artifact_base" overrides this when they are hosted elsewhere.
  var ARTIFACT_BASE = '/offline';

  var PAGE_CACHE_PREFIX = 'ardupilot-pages-';
  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';
  // Wikis that used to have an archive and a cache of their own and now travel
  // inside common. Kept in step with FOLD_INTO_COMMON in
  // scripts/build_offline_artifacts.py and FOLDED_INTO_COMMON in sw.js.
  var FOLDED_INTO_COMMON = ['ardupilot'];
  var AUTOUPDATE_KEY = 'ap-autoupdate';
  // Quota estimates are deliberately fuzzed by browsers, and unpacking needs
  // room to work, so require noticeably more headroom than the raw payload.
  var HEADROOM = 1.5;

  // Build id of the manifest currently published, filled in on load.
  var CURRENT_BUILD = null;

  function el(id) { return document.getElementById(id); }

  // The worker memoises which offline caches exist and carry a completion
  // marker, and only refreshes that on CACHES_CHANGED. Send it after every
  // change to what is stored, or a wiki saved mid-session stays invisible to
  // the worker until it restarts.
  function notifyWorkerCachesChanged() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CACHES_CHANGED' });
      }
    } catch (err) { /* no controller yet; nothing is memoised to invalidate */ }
  }

  function fmt(bytes) {
    var m = bytes / 1048576;
    return m >= 1024 ? (m / 1024).toFixed(1) + ' GB' : Math.round(m) + ' MB';
  }

  // Update toast: a card shown while a saved wiki checks for or applies an
  // update. The bar sweeps for unknown-length steps, fills as files are
  // applied, turns green when done, then fades out. Styled in common_offline.css.
  var toastEl = null, toastHideTimer = null;

  function toast(opts) {
    if (typeof document === 'undefined' || !document.body) { return; }
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ap-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      toastEl.innerHTML =
        '<div class="ap-toast-title"></div>' +
        '<div class="ap-toast-msg"></div>' +
        '<div class="ap-toast-track"><div class="ap-toast-bar"></div></div>';
      document.body.appendChild(toastEl);
    }
    if (opts.mode === 'hide') {
      toastEl.classList.remove('ap-toast-show');
      return;
    }
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }

    toastEl.querySelector('.ap-toast-title').textContent = opts.title || '';
    toastEl.querySelector('.ap-toast-msg').textContent = opts.msg || '';
    var track = toastEl.querySelector('.ap-toast-track');
    var bar = toastEl.querySelector('.ap-toast-bar');
    toastEl.classList.remove('ap-toast-done');
    track.classList.remove('ap-toast-sweep');

    if (opts.mode === 'sweep') {
      track.classList.add('ap-toast-sweep');
    } else if (opts.mode === 'progress') {
      var pct = Math.max(3, Math.min(100, opts.pct || 0));
      bar.style.width = pct + '%';
    } else if (opts.mode === 'done') {
      toastEl.classList.add('ap-toast-done');
      toastHideTimer = setTimeout(function () { toast({ mode: 'hide' }); }, 3500);
    }
    // Force a reflow so the slide-in transition runs even on the first show.
    void toastEl.offsetWidth;
    toastEl.classList.add('ap-toast-show');
  }

  /* ---------- measured state ---------- */

  function storedWikis() {
    return caches.keys().then(function (names) {
      var stored = {};
      var offline = names.filter(function (n) { return n.indexOf(OFFLINE_CACHE_PREFIX) === 0; });
      return Promise.all(offline.map(function (name) {
        return caches.open(name).then(function (cache) {
          // Only a cache carrying the completion marker counts. An interrupted
          // download leaves entries behind, and treating those as a usable copy
          // is how somebody ends up offline with half a wiki.
          return cache.match(COMPLETE_MARKER).then(function (marker) {
            if (!marker) { return; }
            stored[name.slice(OFFLINE_CACHE_PREFIX.length).split('-')[0]] = true;
          });
        });
      })).then(function () { return stored; });
    });
  }

  function countCachedPages() {
    return caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (n) { return n.indexOf(PAGE_CACHE_PREFIX) === 0; })
        .map(function (n) {
          return caches.open(n).then(function (c) {
            return c.keys().then(function (k) { return k.length; });
          });
        })).then(function (counts) {
          return counts.reduce(function (a, b) { return a + b; }, 0);
        });
    });
  }

  function storage() {
    var est = navigator.storage && navigator.storage.estimate
      ? navigator.storage.estimate() : Promise.resolve({});
    var per = navigator.storage && navigator.storage.persisted
      ? navigator.storage.persisted() : Promise.resolve(false);
    return Promise.all([est, per]).then(function (r) {
      return { estimate: r[0] || {}, persisted: r[1] };
    });
  }

  /* ---------- rendering ---------- */

  function renderStorage() {
    return Promise.all([storage(), countCachedPages()]).then(function (r) {
      var est = r[0].estimate, persisted = r[0].persisted, pages = r[1];
      var used = est.usage || 0;

      // Two different things get called "saved" and they contradict each other:
      // wikis you deliberately downloaded, and pages cached simply because you
      // read them. The table shows the first, so the footer reporting the
      // second as "saved" made "Remove all" look enabled with nothing to
      // remove. Name them separately.
      var savedWikis = Object.keys(storedIds).filter(function (id) {
        return id !== 'common';
      }).length;
      var parts = [];
      parts.push(savedWikis
        ? savedWikis + ' wiki' + (savedWikis === 1 ? '' : 's') + ' saved'
        : 'no wikis saved');
      if (pages) {
        parts.push(pages + ' page' + (pages === 1 ? '' : 's') + ' cached while reading');
      }
      // Chrome's quota accounting lags a deletion by seconds, so immediately
      // after Remove all this said "no wikis saved · 542 MB used", which reads
      // as a failure to delete anything. Measured: still pinned at 568 MB
      // twenty-five seconds after the caches were verifiably gone, and correct
      // on the next load. Say what is happening instead of quoting a number
      // that contradicts the line beside it, and look again shortly.
      var nothingHeld = !savedWikis && !pages && !storedIds.common;
      if (nothingHeld && used > 5 * 1048576) {
        parts.push('freeing space');
        if (!reclaimTimer) {
          reclaimTimer = setTimeout(function () {
            reclaimTimer = null;
            renderStorage();
          }, 3000);
        }
      } else {
        parts.push(fmt(used) + ' used');
      }
      // Free space is not shown: the browser's quota is a fuzzed figure it can
      // revise, not disk space, so it invites a meaningless comparison.
      // checkRoom still consults it before a download.
      parts.push('storage ' + (persisted ? 'permanent' : 'temporary'));
      el('storage-status').textContent = parts.join(' · ');

      // No button: browsers routinely decline a bare persist() request, so it
      // appeared to do nothing. Installing is the signal they do act on.
      var evicted = evictedIds();
      var evictNote = evicted.length
        ? '<div class="apo-note apo-note-warn">&#9888; ' +
          (evicted.length === 1 ? 'A wiki you saved is' : evicted.length + ' wikis you saved are') +
          ' no longer here. Your browser reclaimed the space. Save ' +
          (evicted.length === 1 ? 'it' : 'them') + ' again, and install the ' +
          'wiki as an app to make that less likely.</div>'
        : '';
      el('storage-warning').innerHTML = evictNote + (persisted
        ? ''
        : '<div class="apo-note apo-note-warn">&#9888; Storage is ' +
          '<strong>temporary</strong>. Your browser can delete these saved pages ' +
          'without warning if this device runs low on space. Installing the wiki ' +
          'as an app makes that less likely. ' +
          '<a href="#install-as-an-app" data-ap-install>Install it now</a>, ' +
          'or read what that means below.</div>');

      // Nothing cached means nothing to remove, so the button should not invite
      // a press. Disarm it too, in case it was armed when the last of it went.
      var clear = el('clear-btn');
      if (clear) {
        var anything = pages > 0 || Object.keys(storedIds).length > 0;
        clear.disabled = !anything;
        clear.title = anything ? 'Removes saved wikis and pages cached while reading'
                               : 'Nothing is stored on this device';
        if (!anything && clearArmed) { disarmClear(clear); }
      }

      updateExportState();
      updateSaveState();
      updateTotal();
    });
  }

  function wikiById(id) {
    for (var i = 0; i < WIKIS.length; i++) {
      if (WIKIS[i].id === id) { return WIKIS[i]; }
    }
    return null;
  }

  function selectionBytes() {
    var selectedTotal = 0, toDownload = 0;

    selected().forEach(function (c) {
      var b = parseInt(c.dataset.mb, 10) * 1048576;
      // Chosen parameter versions are fetched alongside the archive, so they
      // are part of what this selection costs even though they travel
      // separately. Raw bytes: the figures quoted everywhere else are what
      // crosses the wire, and these compress on the way in like anything else.
      var w = wikiById(c.value);
      if (w) { b += paramBytes(w); }
      selectedTotal += b;
      if (!storedIds[c.value]) { toDownload += b; }
    });

    var commonBytes = (COMMON.mb || 0) * 1048576;
    selectedTotal += commonBytes;
    if (!storedIds.common) { toDownload += commonBytes; }

    return { total: selectedTotal, toDownload: toDownload };
  }

  var storedIds = {};

  // Eviction detection. Temporary storage can be reclaimed without warning and
  // a saved wiki just vanishes; reading Cache Storage alone shows it as not
  // saved, silently. So saved ids are mirrored to localStorage - a record with
  // no matching cache is one the browser reclaimed, and the panel says so.
  var SAVED_IDS_KEY = 'ap-saved-ids';

  function savedRecord() {
    try {
      var raw = window.localStorage.getItem(SAVED_IDS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (err) { return []; }
  }

  function rememberSaved(id) {
    try {
      var rec = savedRecord();
      if (rec.indexOf(id) === -1) {
        rec.push(id);
        window.localStorage.setItem(SAVED_IDS_KEY, JSON.stringify(rec));
      }
    } catch (err) { /* private browsing: eviction notices are a nicety */ }
  }

  function forgetSaved(id) {
    try {
      var rec = savedRecord().filter(function (x) { return x !== id; });
      window.localStorage.setItem(SAVED_IDS_KEY, JSON.stringify(rec));
    } catch (err) { /* ignore */ }
  }

  // Ids we recorded as saved but that are no longer in Cache Storage: the
  // browser reclaimed them. 'common' is excluded because it is not a wiki a
  // reader thinks of themselves as having saved.
  function evictedIds() {
    return savedRecord().filter(function (id) {
      return id !== 'common' && !storedIds[id];
    });
  }
  // Set while waiting for the browser to finish reclaiming deleted space.
  var reclaimTimer = null;


  /*
   * Which historical parameter versions a reader wants.
   *
   * These are not in the wiki archives. update.py --paramversioning builds one
   * page per firmware version - 14 for Copter at 4 to 6 MB each - and baking
   * them in would put a third of a wiki's download behind something most
   * people never open. The manifest lists what exists; the pages are already
   * served at their real URLs, so a chosen one is fetched directly and stored
   * through the same compressing path as the archive's own entries.
   *
   * Keyed by wiki id, holding a map of file -> true. Seeded from the
   * manifest's default (the newest stable) the first time a wiki is seen.
   */
  var paramPicks = {};

  function paramsOf(w) {
    return (w && w.param_versions) || [];
  }

  /*
   * Seeded from the manifest's default, and NOT before the manifest is here.
   *
   * The panel renders immediately from the built-in wiki list so it is not
   * blank while the manifest loads, and at that point no wiki has any versions
   * at all. Memoising then cached an empty selection for every wiki, so when
   * the real list arrived and the rows were drawn again this returned that
   * empty object and the default was never ticked. Nothing looked broken: the
   * versions were listed correctly, just all unchecked.
   */
  function picksFor(w) {
    var versions = paramsOf(w);
    if (!versions.length) { return paramPicks[w.id] || {}; }
    if (!paramPicks[w.id]) {
      var seed = {};
      versions.forEach(function (v) {
        if (v['default']) { seed[v.file] = true; }
      });
      paramPicks[w.id] = seed;
    }
    return paramPicks[w.id];
  }

  /*
   * Tick what is actually saved, not what is newest.
   *
   * The seed above comes from the manifest's `default` flag, which marks the
   * newest stable. That is the right guess for someone who has saved nothing.
   * It is the wrong answer for everyone else, and it goes wrong the moment a
   * release lands: a reader holding 4.7.0 would open the panel to find 4.7.1
   * ticked and 4.7.0 clear, which is the exact opposite of the truth, and
   * pressing Save would then fetch the version they did not ask for while
   * leaving the one they have looking unselected.
   *
   * So for any wiki with a completed download, the cache decides. Wikis with
   * nothing saved keep the default. Runs once per render pass, one cache open
   * and one match per offered version, all against caches that are already
   * open.
   */
  function syncPicksWithCache(stored) {
    var wikis = WIKIS.filter(function (w) {
      return paramsOf(w).length && stored[w.id];
    });
    if (!wikis.length) { return Promise.resolve(false); }
    return Promise.all(wikis.map(function (w) {
      return caches.open(OFFLINE_CACHE_PREFIX + w.id).then(function (cache) {
        return Promise.all(paramsOf(w).map(function (v) {
          return cache.match(paramCacheKey(w, v)).then(function (hit) {
            return hit ? v.file : null;
          });
        }));
      }).then(function (files) {
        var found = files.filter(Boolean);
        // A saved wiki whose parameter pages are all absent means the reader
        // deliberately took none. Honour that rather than re-ticking a default
        // they already declined.
        var next = {};
        found.forEach(function (f) { next[f] = true; });
        var before = JSON.stringify(paramPicks[w.id] || {});
        paramPicks[w.id] = next;
        return before !== JSON.stringify(next);
      });
    })).then(function (changed) {
      return changed.some(Boolean);
    }).catch(function () { return false; });
  }

  function pickedFiles(w) {
    var picks = picksFor(w);
    return paramsOf(w).filter(function (v) { return picks[v.file]; });
  }

  /** Bytes the chosen versions add to this wiki, before compression. */
  function paramBytes(w) {
    return pickedFiles(w).reduce(function (n, v) { return n + (v.bytes || 0); }, 0);
  }

  // Versions promoted out of the dropdown and into the tick list. Held per
  // wiki for the life of the page. A promoted version that gets saved is
  // recognised by syncPicksWithCache on the next load and shortlists itself,
  // so this only has to survive until then.
  var paramPromoted = {};

  /** "4.7.0" -> "4.7". The release series a version belongs to. */
  function seriesOf(v) {
    var m = /^(\d+\.\d+)/.exec(v.version || '');
    return m ? m[1] : (v.version || v.file);
  }

  /** Newest first, so "the newest of this series" is a comparison not a guess. */
  function compareVersions(a, b) {
    var pa = String(a.version || '').split('.');
    var pb = String(b.version || '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) { return nb - na; }
    }
    // A stable release outranks a beta carrying the same number.
    if (a.channel !== b.channel) { return a.channel === 'stable' ? -1 : 1; }
    return 0;
  }

  /*
   * Which versions get a tick box of their own.
   *
   * Copter builds fourteen. Showing all fourteen as ticks was the reason the
   * whole block had to be hidden behind a disclosure button in the first place,
   * and it still asked the reader to read fourteen near-identical lines to find
   * the two they cared about. Nine of the fourteen are point releases within a
   * series that differ from their neighbours by about 8%.
   *
   * So the ticks are the ones worth a glance:
   *   - the newest stable of each release series (4.7.0, 4.6.3, 4.5.7)
   *   - anything already saved, so what you have is never hidden from you
   *   - anything promoted from the dropdown, so a choice you made stays made
   *
   * Everything else goes in the dropdown, and picking it from there promotes it
   * here. The user asked for exactly this: "both tick and dropdown ... like the
   * dropdown is custom then it will appear as a tickbox".
   */
  function shortlistFor(w) {
    var versions = paramsOf(w);
    var picks = picksFor(w);
    var promoted = paramPromoted[w.id] || {};
    var newestOfSeries = {};
    versions.forEach(function (v) {
      if (v.channel !== 'stable') { return; }
      var key = seriesOf(v);
      if (!newestOfSeries[key] || compareVersions(v, newestOfSeries[key]) < 0) {
        newestOfSeries[key] = v;
      }
    });
    var keep = {};
    Object.keys(newestOfSeries).forEach(function (k) {
      keep[newestOfSeries[k].file] = true;
    });
    versions.forEach(function (v) {
      if (picks[v.file] || promoted[v.file]) { keep[v.file] = true; }
    });
    return versions.filter(function (v) { return keep[v.file]; })
                   .sort(compareVersions);
  }

  /** The rest: reachable through the dropdown, one press away from a tick. */
  function paramRestFor(w) {
    var shown = {};
    shortlistFor(w).forEach(function (v) { shown[v.file] = true; });
    return paramsOf(w).filter(function (v) { return !shown[v.file]; })
                      .sort(compareVersions);
  }

  function paramCacheKey(w, v) {
    return '/' + w.id + '/' + v.file;
  }

  /*
   * The disclosure row under a wiki, listing every version it built.
   *
   * Hidden until asked for: five vehicles carry these and an always-open list
   * of fourteen checkboxes each would bury the ten rows that matter.
   */
  function paramRowFor(w) {
    var versions = paramsOf(w);
    if (!versions.length) { return ''; }
    var picks = picksFor(w);
    var mb = function (v) { return Math.round((v.bytes || 0) / 1048576); };

    // The current list ships inside the wiki archive and cannot be deselected.
    // Shown rather than merely stated, because "the current list is always
    // included" in prose above a grid of unticked boxes reads as though the
    // current list were one of the unticked boxes.
    var fixed = '<label class="apo-param apo-param-fixed" ' +
                  'title="Part of the wiki download; cannot be deselected">' +
                  '<input type="checkbox" checked disabled>' +
                  '<span>Latest (master)</span>' +
                  '<small>always included</small>' +
                '</label>';

    var boxes = shortlistFor(w).map(function (v) {
      return '<label class="apo-param">' +
               '<input type="checkbox" class="param-check" data-wiki="' + w.id +
                 '" value="' + v.file + '"' + (picks[v.file] ? ' checked' : '') + '>' +
               '<span>' + v.label + '</span>' +
               '<small>' + mb(v) + ' MB</small>' +
             '</label>';
    }).join('');

    var rest = paramRestFor(w);
    var more = rest.length
      ? '<label class="apo-param-more">' +
          '<span>Another version</span>' +
          '<select class="param-more" data-wiki="' + w.id + '" ' +
            'aria-label="Add another parameter version for ' + w.name + '">' +
            '<option value="">' + rest.length + ' more\u2026</option>' +
            rest.map(function (v) {
              return '<option value="' + v.file + '">' + v.label +
                     ' \u00b7 ' + mb(v) + ' MB</option>';
            }).join('') +
          '</select>' +
        '</label>'
      : '';

    return '<tr class="apo-param-row" data-params-for="' + w.id + '" hidden>' +
             '<td colspan="5">' +
               '<p class="apo-param-note">Parameter lists for older firmware. ' +
                 'The newest of each release series is offered here; pick any ' +
                 'other from the dropdown and it joins the list.</p>' +
               '<div class="apo-param-grid">' + fixed + boxes + more + '</div>' +
             '</td>' +
           '</tr>';
  }

  /** Fetch and store the versions chosen for one wiki. */
  function storeParams(w, cache, report) {
    var wanted = pickedFiles(w);
    if (!wanted.length) { return Promise.resolve(0); }
    var stored = 0;
    return wanted.reduce(function (chain, v) {
      return chain.then(function () {
        var url = paramCacheKey(w, v);
        return fetch(url, { cache: 'no-cache' }).then(function (r) {
          if (!r.ok) { throw new Error(url + ' (' + r.status + ')'); }
          return r.arrayBuffer();
        }).then(function (buf) {
          var body = new Uint8Array(buf);
          stored += body.length;
          if (report) { report(w.name + ' · parameters ' + v.label); }
          return ApUnpack.storeEntry(cache, url, v.file, body);
        }).catch(function (err) {
          // One missing version must not fail a whole wiki: the pages are
          // republished on every build and a reader who asked for a version
          // that has just been retired should still get their wiki.
          console.warn('[offline] parameter version skipped', err && err.message);
        });
      });
    }, Promise.resolve()).then(function () { return stored; });
  }

  function renderWikis(afterSync) {
    return storedWikis().then(function (stored) {
      storedIds = stored;
      // What is stored decides which parameter versions are ticked. Done here,
      // before the rows are built, so the boxes are right on first paint
      // rather than correcting themselves a moment later. `afterSync` stops
      // the recursion: the second pass paints with the synced picks.
      if (!afterSync) {
        return syncPicksWithCache(stored).then(function () {
          return renderWikis(true);
        });
      }
      var rows = [COMMON].concat(WIKIS).map(function (w) {
        var isStored = !!stored[w.id];
        var box = w.required
          ? '<input type="checkbox" checked disabled title="Required">'
          : '<input type="checkbox" class="wiki-check" value="' + w.id +
            '" data-mb="' + w.mb + '"' + (isStored ? ' checked' : '') + '>';
        var badge = isStored
          ? '<span class="apo-badge apo-badge-stored">Saved</span>'
          : '<span class="apo-badge apo-badge-none">Not saved</span>';
        return '<tr data-wiki="' + w.id + '">' +
                 '<td class="apo-name"><label class="apo-pick">' + box +
                   '<span>' + w.name + '</span></label>' +
                   (paramsOf(w).length
                     ? ' <button type="button" class="apo-param-toggle" ' +
                         'data-toggle-params="' + w.id + '" aria-expanded="false">' +
                         paramsOf(w).length + ' parameter versions</button>'
                     : '') +
                 '</td>' +
                 '<td class="apo-num">' + w.mb + ' MB</td>' +
                 '<td class="apo-num apo-pages">' + (w.pages || '') + '</td>' +
                 // Rendered from state, not painted on afterwards: renderWikis
                 // rebuilds this tbody when a download finishes, which used to
                 // wipe the bar the moment it reached 100%.
                 '<td class="apo-num"><div class="apo-progress"' +
                   (isStored ? '' : ' hidden') + '>' +
                   '<div class="apo-progress-bar" style="width:' +
                     (isStored ? '100%' : '0') + '"></div>' +
                   '<span>' + (isStored ? '100%' : '') + '</span></div></td>' +
                 '<td class="apo-num">' + badge + '</td>' +
               '</tr>' + paramRowFor(w);
      });
      el('wiki-rows').innerHTML = rows.join('');

      var clear = el('clear-btn');
      if (clear) {
        var anySaved = Object.keys(stored).length > 0;
        if (anySaved) { clear.disabled = false; clear.title = ''; }
      }

      syncSelectAll();
      updateExportState();
      updateSaveState();
      updateTotal();
    });
  }

  /** Show progress on one wiki's own row, the way the build tool does. */
  function rowProgress(wikiId, percent, label) {
    var row = document.querySelector('tr[data-wiki="' + wikiId + '"]');
    if (!row) { return; }
    var wrap = row.querySelector('.apo-progress');
    var bar = row.querySelector('.apo-progress-bar');
    var text = row.querySelector('.apo-progress span');
    var badge = row.querySelector('.apo-badge');
    if (!wrap) { return; }

    if (percent === null) {
      wrap.hidden = true;
      return;
    }
    if (percent >= 100) {
      wrap.hidden = false;
      bar.style.width = '100%';
      text.textContent = label || '100%';
      if (badge) {
        badge.className = 'apo-badge apo-badge-stored';
        badge.textContent = 'Saved';
      }
      return;
    }
    wrap.hidden = false;
    bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    text.textContent = label || Math.round(percent) + '%';
    if (badge) {
      badge.className = 'apo-badge apo-badge-busy';
      badge.textContent = 'Saving';
    }
  }

  function selected() {
    return Array.prototype.slice.call(document.querySelectorAll('.wiki-check:checked'));
  }

  function selectable() {
    return Array.prototype.slice.call(document.querySelectorAll('.wiki-check'));
  }

  /**
   * Mirror the rows: ticked when every wiki is, indeterminate when only some
   * are. Common is excluded, its box being required and disabled.
   */
  function syncSelectAll() {
    var box = el('select-all');
    if (!box) { return; }
    var all = selectable().length;
    var on = selected().length;
    box.checked = all > 0 && on === all;
    box.indeterminate = on > 0 && on < all;
    box.disabled = all === 0;
  }

  function toggleAll(on) {
    selectable().forEach(function (c) { c.checked = on; });
    syncSelectAll();
    updateTotal();
    updateExportState();
    updateSaveState();
  }

  function updateTotal() {
    var b = selectionBytes();
    var total = el('selection-total');
    if (!total) { return; }

    // Kept short: this sits in a right-aligned column barely wider than the
    // checkbox beside it, and a sentence long enough to wrap reads badly there.
    if (!b.total) {
      total.textContent = 'Nothing selected';
    } else if (!b.toDownload) {
      total.innerHTML = '<strong>' + fmt(b.total) + '</strong> selected, ' +
                        'all already saved';
    } else {
      total.innerHTML = '<strong>' + fmt(b.toDownload) + '</strong> to download' +
                        (b.toDownload === b.total ? '' :
                          ' &middot; ' + fmt(b.total - b.toDownload) + ' of ' +
                          fmt(b.total) + ' already saved');
    }
    warnIfOverQuota(b);
  }

  /*
   * Say so BEFORE the download, not after it has failed.
   *
   * checkRoom() already refuses a download that cannot fit, but it runs when
   * Save is pressed, by which point the reader has made every choice and is
   * told no. This warns while they are still choosing.
   *
   * Quota, not a browser check. WebKit is the one that reports about 1.0 GB
   * against Chromium's 6.5 and Firefox's 10.7 on the same machine, so it is
   * where this will fire - but a Chrome profile that is already full hits the
   * identical wall, and asking the browser what it will give us is both more
   * honest and one less thing to keep up to date than a list of user agents.
   *
   * Why it matters here rather than being a nicety: WebKit does not refuse a
   * write that would exceed the quota, it discards the origin. Measured on a
   * full uncompressed download - storage climbed to 953 MB, Sub finished, and
   * it dropped to 52 MB, with every archive still reporting success. A reader
   * who ignores this warning does not get an error, they get nothing, having
   * waited for the whole download.
   */
  var QUOTA_MARGIN = 1.15;

  function warnIfOverQuota(b) {
    var line = el('quota-warning');
    if (!line) { return; }
    if (!b.toDownload) { line.hidden = true; return; }
    storage().then(function (r) {
      var est = (r && r.estimate) || {};
      if (est.quota === undefined) { line.hidden = true; return; }
      var free = (est.quota || 0) - (est.usage || 0);
      if (free >= b.toDownload * QUOTA_MARGIN) { line.hidden = true; return; }
      line.hidden = false;
      line.textContent = '\u26A0 This needs about ' + fmt(b.toDownload) +
        ' and your browser is offering ' + fmt(free) + '. Downloading anyway ' +
        'can lose everything already saved for this site, without an error. ' +
        'Deselect a wiki, or free up space first.';
    }).catch(function () { line.hidden = true; });
  }

  /* ---------- actions ---------- */

  // Removing is destructive and slow to undo, so it asks first in place, says
  // how much is at stake, and disarms itself if left alone.
  var CONFIRM_MS = 6000;
  // A double click should never delete anything. The second press is ignored
  // until this has passed, so confirming has to be a deliberate, separate act.
  var CONFIRM_DEAD_MS = 700;

  var clearArmed = null;
  var clearArmedAt = 0;

  function disarmClear(btn) {
    if (clearArmed) { clearTimeout(clearArmed); }
    clearArmed = null;
    btn.textContent = 'Remove all';
    // Stays red: it is destructive whether or not it is armed. Arming is
    // signalled by the label, the darker shade and the draining bar.
    btn.classList.remove('apo-btn-armed');
    var bar = btn.querySelector('.apo-arm');
    if (bar) { bar.remove(); }
  }

  function confirmClear() {
    var btn = el('clear-btn');
    if (!btn) { return; }

    if (clearArmed) {
      if (Date.now() - clearArmedAt < CONFIRM_DEAD_MS) { return; }
      disarmClear(btn);
      return clearAll();
    }

    return storage().then(function (r) {
      var used = (r.estimate || {}).usage || 0;
      btn.textContent = used ? 'Delete ' + fmt(used) + '? Press again'
                             : 'Press again to confirm';
      btn.classList.add('apo-btn-armed');

      var bar = document.createElement('span');
      bar.className = 'apo-arm';
      btn.appendChild(bar);
      // Force a layout so the transition starts from full width rather than
      // being collapsed into the same frame.
      void bar.offsetWidth;
      bar.style.transitionDuration = CONFIRM_MS + 'ms';
      bar.classList.add('apo-arm-run');

      clearArmedAt = Date.now();
      clearArmed = setTimeout(function () { disarmClear(btn); }, CONFIRM_MS);
    });
  }

  function clearAll() {
    return caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (n) { return n.indexOf('ardupilot-') === 0; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () {
      // Deliberately removed, so it is not an eviction.
      try { window.localStorage.removeItem(SAVED_IDS_KEY); } catch (err) { /* ignore */ }
      notifyWorkerCachesChanged();
      return renderWikis().then(renderStorage);
    });
  }

  /*
   * Retire the cache of a wiki that has since been folded into common.
   *
   * Anyone who saved About before the fold has an ardupilot-offline-ardupilot
   * cache that nothing lists any more: no row owns it, so no button removes it,
   * and it sits there counting against the quota while the service worker finds
   * its pages only by searching every cache.
   *
   * Deleting saved pages is not something to do lightly, so this runs at
   * exactly one moment: a common download has just finished, meaning the same
   * pages are now in the common cache under the same paths. Before that instant
   * the old cache is the reader's only copy and is left alone. Failure is
   * ignored - the worst case is the cache we meant to tidy up staying put.
   */
  function dropFoldedCaches(entry) {
    if (!entry || entry.id !== 'common') { return Promise.resolve(); }
    return Promise.all(FOLDED_INTO_COMMON.map(function (id) {
      return caches.delete(OFFLINE_CACHE_PREFIX + id).then(function (gone) {
        if (gone) {
          delete storedIds[id];
          forgetSaved(id);
        }
      });
    })).then(function () { notifyWorkerCachesChanged(); })
      .catch(function () { /* tidying, not a step of the download */ });
  }

  /*
   * Check there is room before starting. A download that dies partway leaves a
   * cache with holes in it, and at these sizes that is a long wait for nothing.
   */
  function checkRoom(neededBytes) {
    return storage().then(function (r) {
      var est = r.estimate;
      if (est.quota === undefined) { return true; }
      var available = (est.quota || 0) - (est.usage || 0);
      if (available < neededBytes * HEADROOM) {
        throw new Error('Not enough room: this needs about ' + fmt(neededBytes) +
          ' plus working space, and only ' + fmt(available) + ' is available. ' +
          'Deselect a wiki or free up space.');
      }
      return true;
    });
  }

  /* ---------- download and unpack ---------- */
  //
  // The tar reader and the archive fetch live in common_offline_unpack.js
  // (window.ApUnpack), so this file stays about the panel rather than about
  // byte formats. mimeFor is used by the differential update below too.

  var mimeFor = ApUnpack.mimeFor;

  // Differential updates live in common_offline_update.js (window.ApUpdate).
  // The panel hands it the live config at each call: where the artifacts are,
  // the current build, the wiki list. updateStored resolves {changed, removed}
  // or null (fall back to the archive); tableUrl and storeTable are shared with
  // the download path below.

  // The config ApUpdate needs, read fresh each call so a manifest reload is
  // always reflected.
  function updateCfg() {
    return {
      base: ARTIFACT_BASE, build: CURRENT_BUILD, wikis: WIKIS,
      here: location.pathname.split('/')[1],
      offlinePrefix: OFFLINE_CACHE_PREFIX, completeMarker: COMPLETE_MARKER,
      mimeFor: mimeFor,
      getSignal: function () { return activeDownload ? activeDownload.signal : undefined; }
    };
  }

  var activeDownload = null;

  function cancelDownload() {
    if (activeDownload) { activeDownload.abort(); }
  }

  /**
   * Download what is selected and not already held.
   *
   * `refreshIds` re-fetches something already stored; only the update check
   * passes it. Without that filter a second press re-fetched every selected
   * wiki, several hundred megabytes, to end up where it started.
   */
  function saveSelectedReal(refreshIds) {
    // A several-hundred-megabyte download has to be stoppable. The same button
    // becomes Cancel rather than adding a second one that is dead most of the
    // time.
    if (activeDownload) { return cancelDownload(); }

    var refresh = refreshIds || [];
    var chosen = selected().map(function (c) { return c.value; });
    // The chosen wikis first, the shared-image archive (common) LAST.
    //
    // A wiki's own archive holds every one of its pages plus the images unique
    // to it, so the wiki is fully navigable the moment it lands - tens of MB,
    // downloaded in seconds. common is 440 MB of images shared across wikis;
    // putting it first meant nothing was readable for the minutes it took. Now
    // it backfills afterwards, and until it finishes a shared image is served
    // from the network when online and is simply absent offline, which is a far
    // better failure than a blank half-hour. Refreshing an already-saved wiki
    // (the update fallback) still re-fetches common if it was asked for.
    var queue = WIKIS.filter(function (w) {
      return chosen.indexOf(w.id) !== -1;
    }).concat([COMMON]).filter(function (w) {
      return !storedIds[w.id] || refresh.indexOf(w.id) !== -1;
    });

    if (!queue.length) {
      el('cache-progress').hidden = false;
      el('cache-progress').textContent =
        'Everything selected is already saved. Use Check for updates to refresh it.';
      return Promise.resolve();
    }

    var totalBytes = queue.reduce(function (a, w) {
      return a + (w.mb || 0) * 1048576;
    }, 0);

    var progress = el('cache-progress');
    var button = el('download-cache-btn');
    var received = 0;

    progress.hidden = false;
    activeDownload = new AbortController();
    button.classList.add('busy');
    setLabel('Cancel');

    function setLabel(text) {
      var lbl = button.querySelector('.lbl');
      if (lbl) { lbl.textContent = text; } else { button.textContent = text; }
    }
    function report(text) { progress.textContent = text; }
    report('Checking space…');

    // Ask for persistence before storing rather than after, so the data is
    // protected from the moment it lands.
    var persistFirst = navigator.storage && navigator.storage.persist
      ? navigator.storage.persist() : Promise.resolve(false);

    return persistFirst
      .then(function () { return checkRoom(totalBytes); })
      .then(function () {
        // Staged under a build-scoped name and only marked complete at the very
        // end, so an interrupted download can never look like a usable copy.
        return queue.reduce(function (chain, entry) {
          return chain.then(function () {
            var cacheName = OFFLINE_CACHE_PREFIX + entry.id;
            return caches.open(cacheName).then(function (cache) {
              // raw_bytes, not mb: the browser decompresses before we count,
              // so the stream is larger than the download.
              var entryBytes = entry.raw_bytes || (entry.mb || 0) * 1048576;
              var entryGot = 0;
              return ApUnpack.fetchArchive(entry, cache, function (n) {
                received += n;
                entryGot += n;
                var pct = Math.min(99, Math.round(received / totalBytes * 100));
                rowProgress(entry.id,
                  entryBytes ? Math.min(99, (entryGot / entryBytes) * 100) : pct);
                report(entry.name + ' · ' + pct + '%');
              }, {
                base: ARTIFACT_BASE,
                build: CURRENT_BUILD,
                signal: activeDownload ? activeDownload.signal : undefined
              }).then(function () {
                // After the archive, before the completion marker: the chosen
                // parameter versions are part of this download, so a copy that
                // is marked complete without them would be a copy the panel
                // says is saved and that is missing what the reader asked for.
                return storeParams(entry, cache, report);
              }).then(function () {
                rowProgress(entry.id, 100, 'done');
                // Store the file table beside the files it describes, so a
                // later update can compare against exactly what was written
                // here. A failure to fetch it is not fatal: the wiki is
                // complete and usable, and the next update falls back to
                // re-fetching the archive, which is what happened before
                // tables existed.
                return fetch(ApUpdate.tableUrl(entry, ARTIFACT_BASE, CURRENT_BUILD), { cache: 'no-cache' })
                  .then(function (r) { return r.ok ? r.json() : null; })
                  .then(function (table) {
                    return table ? ApUpdate.storeTable(cache, table) : null;
                  })
                  .catch(function () { return null; });
              }).then(function () {
                // The marker records the build, not just the time: an update
                // check is only meaningful against what was actually stored.
                return cache.put(COMPLETE_MARKER,
                  new Response(JSON.stringify({
                    build: CURRENT_BUILD, saved: Date.now(), id: entry.id
                  }), { headers: { 'Content-Type': 'application/json' } }));
              }).then(function () {
                // One source of truth, updated the moment it becomes true.
                //
                // The rows were painted live as each archive landed while the
                // footer was computed from a snapshot taken at page load and
                // refreshed only when the whole queue finished. Mid-download
                // the panel said every row was Saved and, on the same screen,
                // that no wikis were saved and the full 696 MB was still to
                // download. Both readings came from the same run.
                storedIds[entry.id] = true;
                rememberSaved(entry.id);
                notifyWorkerCachesChanged();
                return dropFoldedCaches(entry).then(renderStorage);
              });
            });
          });
        }, Promise.resolve());
      })
      .then(function () { report('Saved'); })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          report('Cancelled. Anything already saved is kept.');
        } else if (err && err.name === 'QuotaExceededError') {
          report('Ran out of space. Your existing copy is untouched.');
        } else {
          report((err && err.message) || 'Download failed');
        }
      })
      .then(function () {
        activeDownload = null;
        button.classList.remove('busy');
        setLabel('Save selected');
        // Bars for anything that completed stay at 100%; only unfinished ones
        // are cleared, so a cancelled run does not look like a successful one.
        queue.forEach(function (w) {
          if (!storedIds[w.id]) { rowProgress(w.id, null); }
        });
        return renderWikis().then(renderStorage);
      });
  }

  /**
   * Ask the server what the current build is and compare it against what each
   * stored copy recorded when it was saved. Anything behind is re-fetched.
   *
   * This is a real request, not a reassuring message: a reader checking before
   * heading out needs to know whether what they are carrying is current.
   */
  function checkForUpdates(quiet) {
    var out = el('check-result');

    // An automatic run says nothing until it has something worth saying.
    // Printing "Checking…" over the panel every half minute would be noise,
    // and worse, it would look like the page was acting on an instruction the
    // reader had not given. News - that an update is being applied, or that it
    // was - is announced either way.
    function announce(text) { out.hidden = false; out.textContent = text; }
    var report = quiet ? function () {} : announce;

    report('Checking…');
    if (!quiet) { toast({ title: 'Checking for updates', msg: '', mode: 'sweep' }); }

    return fetch('/offline/offline-manifest.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('could not reach the server'); }
        return r.json();
      })
      .then(function (manifest) {
        CURRENT_BUILD = manifest.generated || CURRENT_BUILD;
        if (manifest.common && manifest.wikis) {
          COMMON = manifest.common;
          WIKIS = manifest.wikis;
        }
        return caches.keys().then(function (names) {
          var offline = names.filter(function (n) {
            return n.indexOf(OFFLINE_CACHE_PREFIX) === 0;
          });
          return Promise.all(offline.map(function (name) {
            // The cache is named for the wiki it holds, so the id is known
            // without reading anything. The marker names it too, but a marker
            // that is unreadable or from an older format would otherwise leave
            // that wiki permanently stuck: it reports itself up to date, and
            // no update ever selects it.
            var id = name.slice(OFFLINE_CACHE_PREFIX.length).split('-')[0];
            return caches.open(name).then(function (c) {
              return c.match(COMPLETE_MARKER).then(function (m) {
                if (!m) { return null; }
                return m.json().then(function (info) {
                  return (info.build && info.build !== CURRENT_BUILD)
                    ? (info.id || id) : null;
                }).catch(function () { return null; });
              });
            });
          }));
        });
      })
      .then(function (results) {
        var stale = results.filter(Boolean);
        if (!stale.length) {
          report('Up to date.');
          if (!quiet) {
            toast({ title: 'Up to date', msg: 'Your saved wikis are current.',
                    mode: 'done' });
          }
          return;
        }
        // Real news: something moved, and pages the reader is holding are
        // about to change under them. Said out loud even on an automatic run.
        announce('Updating ' + stale.length + ' item' +
                 (stale.length === 1 ? '' : 's') + '…');
        toast({ title: 'Updating saved wikis',
                msg: 'Checking what changed…', mode: 'sweep' });

        // Try the differential path first: compare the stored file table with
        // the published one and fetch only what moved. Anything saved before
        // tables existed has nothing to compare against and resolves null, and
        // those fall back to re-fetching the whole archive.
        var byId = {};
        [COMMON].concat(WIKIS).forEach(function (w) { byId[w.id] = w; });

        var moved = 0, full = [];
        return stale.reduce(function (chain, id) {
          return chain.then(function () {
            var entry = byId[id];
            if (!entry) { full.push(id); return; }
            return ApUpdate.updateStored(entry, updateCfg(), function (done, total) {
              announce('Updating ' + entry.name + ' · ' +
                       done + ' of ' + total + ' files…');
              toast({ title: 'Updating ' + entry.name,
                      msg: done + ' of ' + total + ' files',
                      mode: 'progress', pct: total ? (done / total) * 100 : 0 });
            }).then(function (result) {
              if (!result) { full.push(id); return; }
              moved += result.changed + result.removed;
            }, function () {
              full.push(id);
            });
          });
        }, Promise.resolve()).then(function () {
          if (!full.length) {
            if (moved) {
              announce('Updated ' + moved + ' file' + (moved === 1 ? '' : 's') + '.');
              toast({ title: 'Update complete',
                      msg: 'Updated ' + moved + ' file' + (moved === 1 ? '' : 's') + '.',
                      mode: 'done' });
              notifyWorkerCachesChanged();
            } else {
              report('Already up to date.');
              if (!quiet) {
                toast({ title: 'Up to date', msg: 'Nothing had changed.',
                        mode: 'done' });
              }
            }
            return renderWikis();
          }
          /*
           * The cheap path could not cover these, so what remains is a full
           * archive download, hundreds of megabytes for common alone.
           *
           * On a quiet, timer-driven run that MUST NOT start by itself. It was
           * observed doing exactly that: a background tick, no click anywhere,
           * and the button flipped to Cancel with 439 MB on its way, which on
           * mobile data is an expensive surprise nobody consented to. A
           * download that size is a decision, and decisions belong to the
           * reader: announce that a full refresh is waiting and leave the
           * button armed.
           *
           * A manual press of Check for updates is that consent, and proceeds
           * as before.
           */
          if (quiet) {
            var names = full.map(function (id) {
              return (byId[id] && byId[id].name) || id;
            });
            announce('A full download is needed to update ' +
                     names.join(', ') +
                     '. Press Check for updates to start it.');
            toast({ title: 'Update available',
                    msg: 'A full download is needed. Open the Offline panel to update.',
                    mode: 'done' });
            return renderWikis();
          }

          // Re-select what could not be updated differentially and reuse the
          // download path, so there is one implementation of fetching and
          // unpacking.
          selectable().forEach(function (c) {
            c.checked = full.indexOf(c.value) !== -1;
          });
          syncSelectAll();
          updateTotal();
          updateExportState();
          updateSaveState();
          // The one caller allowed to re-fetch what is already stored.
          return saveSelectedReal(full);
        });
      })
      .catch(function (err) {
        // A failed automatic check is ordinary: it means the reader is offline,
        // which is the situation this whole feature exists for. Only a check
        // somebody asked for reports that it could not be done.
        report((err && err.message) || 'Check failed');
      });
  }

  /** Save is offered only when it has something to fetch. */
  function updateSaveState() {
    var button = el('download-cache-btn');
    if (!button || activeDownload) { return; }
    var b = selectionBytes();
    // Common alone is images with no pages to view them in.
    var anyWiki = selected().length > 0;
    button.disabled = !anyWiki || !b.toDownload;
    button.title = !anyWiki
      ? 'Select a wiki first'
      : (b.toDownload
          ? 'Downloads ' + fmt(b.toDownload)
          : 'Everything selected is already saved. Check for updates refreshes it.');
  }

  function updateExportState() {
    var chosen = selected().length;
    var b = el('dl-single');
    if (!b) { return; }
    b.disabled = !chosen;
    b.title = chosen ? '' : 'Select at least one wiki first';
  }

  // What an export contains: the selection, limited to what is actually saved.
  // Reading the stored set alone ignored the selection, so ticking every wiki
  // and getting one back looked like corruption rather than a missing download.
  function exportSelection() {
    var chosen = selected().map(function (c) { return c.value; });
    var have = chosen.filter(function (id) { return storedIds[id]; });
    var missing = chosen.filter(function (id) { return !storedIds[id]; });
    return { ids: have, missing: missing, chosen: chosen };
  }

  /**
   * Name an export after its contents plus the build date - the only thing
   * telling someone months later which vehicles the file holds.
   *   one wiki    copter-2026-08-08.html
   *   several     blimp-copter-rover-2026-08-08.html
   *   everything  ardupilot-all-2026-08-08.html
   */
  function exportName(ids, extension) {
    var stamp = (CURRENT_BUILD || new Date().toISOString()).slice(0, 10);
    var base;
    if (!ids.length) {
      base = 'ardupilot';
    } else if (ids.length >= WIKIS.length) {
      base = 'ardupilot-all';
    } else {
      base = ids.slice().sort().join('-');
    }
    return base + '-' + stamp + extension;
  }

  // Build a file from the selection: anything selected but not yet saved is
  // downloaded first, then the file is built from the cache - one press, not two.
  function buildExport(buttonId) {
    var link = el(buttonId);
    if (!link || !global.ArduPilotExport || !selected().length) { return; }

    var original = link.dataset.label || link.textContent;
    link.dataset.label = original;
    link.disabled = true;

    var done = function (text, keep) {
      link.textContent = text;
      link.disabled = false;
      if (!keep) { setTimeout(function () { link.textContent = original; }, 8000); }
    };

    var sel = exportSelection();
    link.textContent = sel.missing.length
      ? 'Saving ' + sel.missing.join(', ') + '…'
      : 'Preparing…';

    var first = sel.missing.length ? saveSelectedReal() : Promise.resolve();

    return first.then(function () {
      var ready = exportSelection();
      if (!ready.ids.length) {
        throw new Error('Nothing was saved - check your connection');
      }
      var name = exportName(ready.ids, '.html');
      return global.ArduPilotExport.exportHtml(ready.ids, name,
        function (n, total) {
          link.textContent = 'Writing ' + n + ' / ' + total + ' pages…';
        }).then(function (r) {
          done('Saved ' + name + ' (' + r.pages + ' pages)');
        });
    }).catch(function (err) {
      done((err && err.message) || 'Export failed');
    });
  }

  /*
   * Automatic updates. A check that finds nothing costs one manifest request, a
   * few hundred bytes: file tables are fetched only for wikis whose recorded
   * build id actually moved, which is what makes a timer reasonable rather than
   * only-on-demand.
   */

  // Thirty minutes, jittered +/-50% by the scheduler. The wiki rebuilds a few
  // times a day, so anything tighter buys nothing and multiplies manifest
  // traffic by every open tab. NB the 30s value used in development must not
  // ship: across eleven panels that is a manifest request every few seconds.
  var AUTOUPDATE_MS = 30 * 60 * 1000;

  var autoTimer = null;
  var autoBusy = false;

  function autoUpdateOn() {
    var box = el('autoupdate');
    return !!(box && box.checked);
  }

  function autoUpdateTick() {
    if (!autoUpdateOn()) { return; }
    // A check already running, or a download in progress, owns the panel and
    // the network until it is done. Overlapping runs would fight over the same
    // caches and report over each other.
    if (autoBusy || activeDownload) { return; }
    // Nothing saved means nothing to update and no reason to touch the network.
    if (!Object.keys(storedIds).length) { return; }
    // Deliberately NOT skipped while the tab is hidden. Browsers already
    // throttle background timers, so a guard buys nothing and costs the common
    // case: a wiki left open for hours in a background tab is the copy most
    // likely to be behind. (Measured: with the guard, a mid-session rebuild was
    // never picked up.)

    autoBusy = true;
    return checkForUpdates(true).then(function () { autoBusy = false; },
                                      function () { autoBusy = false; });
  }

  /*
   * Spread readers out so a new build is not a stampede. On a fixed interval
   * every reader polls in lockstep, finds the same new build, and starts
   * fetching at the same moment - a self-inflicted DoS whenever a layout edit
   * rewrites every page. So each tick is scheduled independently with +/-50%
   * jitter, the first one included, smearing the herd across the interval
   * without changing the average rate.
   */
  function scheduleNextTick() {
    if (autoTimer) { window.clearTimeout(autoTimer); }
    var jittered = AUTOUPDATE_MS * (0.5 + Math.random());
    autoTimer = window.setTimeout(function () {
      var done = autoUpdateTick();
      if (done && typeof done.then === 'function') {
        done.then(scheduleNextTick, scheduleNextTick);
      } else {
        scheduleNextTick();
      }
    }, jittered);
  }

  function startAutoUpdate() {
    scheduleNextTick();
  }

  function exportHtmlFile() { return buildExport('dl-single'); }

  /* ---------- wiring ---------- */

  /*
   * The disclosure button, and the versions inside it.
   *
   * Delegated like everything else here, because renderWikis() replaces the
   * whole tbody whenever a download finishes and any handler bound to a row
   * would go with it.
   */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.apo-param-toggle');
    if (!btn) { return; }
    var id = btn.getAttribute('data-toggle-params');
    var row = document.querySelector('[data-params-for="' + id + '"]');
    if (!row) { return; }
    var open = row.hasAttribute('hidden');
    if (open) { row.removeAttribute('hidden'); } else { row.setAttribute('hidden', ''); }
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /*
   * A version chosen from the dropdown becomes a ticked box and stays one.
   *
   * Re-rendering only this row, not the table: renderWikis() rebuilds the whole
   * tbody, which would collapse the disclosure the reader just opened and lose
   * their place mid-choice.
   */
  document.addEventListener('change', function (e) {
    if (!e.target.classList.contains('param-more')) { return; }
    var id = e.target.getAttribute('data-wiki');
    var file = e.target.value;
    var w = wikiById(id);
    if (!w || !file) { return; }

    if (!paramPromoted[id]) { paramPromoted[id] = {}; }
    paramPromoted[id][file] = true;
    picksFor(w)[file] = true;

    var row = document.querySelector('[data-params-for="' + id + '"]');
    if (row) {
      var fresh = document.createElement('tbody');
      fresh.innerHTML = paramRowFor(w);
      var next = fresh.firstChild;
      if (next) {
        // The disclosure is open, or the reader could not have reached the
        // dropdown. Keep it open.
        next.removeAttribute('hidden');
        row.parentNode.replaceChild(next, row);
      }
    }
    // Choosing a version implies wanting the wiki, same as ticking one.
    var box = document.querySelector('.wiki-check[value="' + id + '"]');
    if (box && !box.checked) {
      box.checked = true;
      syncSelectAll();
      updateExportState();
    }
    updateTotal();
    updateSaveState();
  });

  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('param-check')) {
      var id = e.target.getAttribute('data-wiki');
      var w = wikiById(id);
      if (w) {
        picksFor(w)[e.target.value] = e.target.checked;
        if (!e.target.checked) { delete picksFor(w)[e.target.value]; }
      }
      // Picking a version implies wanting the wiki it belongs to; without this
      // a reader ticks four versions, presses Save, and nothing happens.
      var box = document.querySelector('.wiki-check[value="' + id + '"]');
      if (box && e.target.checked && !box.checked) {
        box.checked = true;
        syncSelectAll();
        updateExportState();
        updateSaveState();
      }
      updateTotal();
      updateSaveState();
    }
    if (e.target.classList.contains('wiki-check')) {
      syncSelectAll();
      updateTotal();
      // Clearing the last tick otherwise left the export buttons enabled
      // until the next render.
      updateExportState();
      updateSaveState();
    }
    if (e.target.id === 'select-all') { toggleAll(e.target.checked); }
    if (e.target.id === 'autoupdate') {
      try {
        window.localStorage.setItem(AUTOUPDATE_KEY, e.target.checked ? '1' : '0');
      } catch (err) { /* private browsing */ }
      // Turning it on should mean something now rather than at the next tick.
      if (e.target.checked) { autoUpdateTick(); }
    }
  });

  document.addEventListener('click', function (e) {
    // closest(), not e.target, because these buttons have children. Once armed,
    // Remove all contains its own countdown bar, three pixels tall across the
    // bottom of the button. A click landing on those three pixels reported the
    // bar as the target, matched no id, and was swallowed: the reader pressed
    // the confirm button, in the button, and nothing happened.
    var hit = e.target && e.target.closest &&
              e.target.closest('#clear-btn, #download-cache-btn, #check-btn, #dl-single');
    if (!hit) { return; }
    if (hit.id === 'clear-btn') { confirmClear(); }
    if (hit.id === 'download-cache-btn') { saveSelectedReal(); }
    if (hit.id === 'check-btn') { checkForUpdates(); }
    if (hit.id === 'dl-single') { e.preventDefault(); exportHtmlFile(); }
  });

  function init() {
    try {
      var pref = window.localStorage.getItem(AUTOUPDATE_KEY);
      if (pref === '0') { el('autoupdate').checked = false; }
    } catch (err) { /* private browsing */ }

    startAutoUpdate();
    // A tab left open for hours does nothing while it is hidden, so coming
    // back to it is the moment its copy is most likely to be behind.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { autoUpdateTick(); }
    });

    var standalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;
    el('install-state').textContent = standalone
      ? 'Already running as an installed app.'
      : '';

    if (!('caches' in window)) {
      el('storage-status').textContent =
        'This browser does not support offline storage.';
      return;
    }

    // Draw from the built-in list at once; waiting for the manifest left the
    // table empty for the length of the request. The numbers are corrected when
    // it lands. renderStorage's footer reads storedIds, which renderWikis fills,
    // so it must follow or it briefly says "no wikis saved" on a device with some.
    renderWikis().then(renderStorage);

    // Sizes and page counts change with every build, so they come from
    // offline-manifest.json; the constants above are only a fallback for a
    // deployment that has not published one yet.
    fetch('/offline/offline-manifest.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (manifest) {
        if (manifest && manifest.common && manifest.wikis) {
          COMMON = manifest.common;
          WIKIS = manifest.wikis;
          if (manifest.artifact_base) {
            ARTIFACT_BASE = manifest.artifact_base.replace(/\/$/, '');
          }
          CURRENT_BUILD = manifest.generated || null;
          if (manifest.generated) {
            el('build-date').textContent =
              'Build ' + manifest.generated.slice(0, 10);
          }
        }
        renderStorage();
        renderWikis();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
