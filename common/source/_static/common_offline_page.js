/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * The Offline page: saves wikis from the pre-built archives, checks for
 * updates, exports. State is measured from Cache Storage each time, not
 * remembered, so an evicted copy shows as gone.
 */
(function (global) {
  'use strict';

  // Answers "is the page running the code just deployed" at runtime.
  var VERSION = 'verified-bytes-1';
  global.ArduPilotOfflineVersion = VERSION;


  // Fallback rows until the manifest arrives; refresh from a real build when
  // the figures move. About travels inside common (FOLD_INTO_COMMON).
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

  // Static files in the built tree, same origin; the manifest's artifact_base
  // overrides this.
  var ARTIFACT_BASE = '/offline';

  var PAGE_CACHE_PREFIX = 'ardupilot-pages-';
  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';
  // Kept in step with FOLD_INTO_COMMON (build) and FOLDED_INTO_COMMON (sw.js).
  var FOLDED_INTO_COMMON = ['ardupilot'];
  var AUTOUPDATE_KEY = 'ap-autoupdate';
  // Quota estimates are fuzzed, and unpacking needs working room.
  var HEADROOM = 1.5;

  // Build id of the manifest currently published, filled in on load.
  var CURRENT_BUILD = null;

  function el(id) { return document.getElementById(id); }

  // The worker memoises which caches exist; tell it after every change.
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

  // Progress card for update checks. Styled in common_offline.css.
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
        '<button type="button" class="ap-toast-action apo-btn apo-btn-primary" hidden></button>' +
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

    var action = toastEl.querySelector('.ap-toast-action');
    if (action) {
      if (opts.action && opts.onAction) {
        action.textContent = opts.action;
        action.hidden = false;
        action.onclick = function () {
          action.disabled = true;
          opts.onAction();
        };
      } else {
        action.hidden = true;
        action.onclick = null;
      }
    }
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
          // Only a cache with the completion marker counts; the rest is an
          // aborted download.
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

      // Saved wikis and pages cached while reading are different things.
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
      // Chrome's quota figure lags a deletion by seconds; say so and look again.
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
      // Free space is not shown: the quota is a fuzzed figure, not disk space.
      parts.push('storage ' + (persisted ? 'permanent' : 'temporary'));
      el('storage-status').textContent = parts.join(' · ');

      // No persist button: browsers routinely decline it; installing is what
      // they act on.
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

      // Nothing stored, nothing to remove.
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
      // Chosen parameter versions travel separately but count toward the selection.
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

  // Saved ids are mirrored to localStorage, so an evicted wiki can be reported
  // rather than silently read as unsaved.
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

  // Recorded as saved but no longer in Cache Storage: the browser reclaimed it.
  function evictedIds() {
    return savedRecord().filter(function (id) {
      return id !== 'common' && !storedIds[id];
    });
  }
  // Set while waiting for the browser to finish reclaiming deleted space.
  var reclaimTimer = null;


  // Historical parameter versions a reader wants, keyed by wiki id, file ->
  // true. They are not in the archives (14 for Copter at 4 to 6 MB each);
  // chosen ones are fetched from their live URLs.
  var paramPicks = {};

  function paramsOf(w) {
    return (w && w.param_versions) || [];
  }

  // Seeded from the manifest's default, and not before the manifest is here:
  // memoising an empty selection first left the default unticked.
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

  // Tick what is saved, not what is newest: a reader holding 4.7.0 must not
  // find 4.7.1 ticked. Wikis with nothing saved keep the default.
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
        // All absent means the reader took none; honour that.
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

  // Promoted from the dropdown; once saved, syncPicksWithCache keeps it.
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

  // Ticks: the newest stable of each series, anything saved, anything
  // promoted. The rest is in the dropdown.
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

  // The disclosure row under a wiki. Hidden until asked for: fourteen boxes
  // each would bury the ten rows that matter.
  function paramRowFor(w) {
    var versions = paramsOf(w);
    if (!versions.length) { return ''; }
    var picks = picksFor(w);
    var mb = function (v) { return Math.round((v.bytes || 0) / 1048576); };

    // The current list is in the archive; shown as a ticked, disabled box.
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
          // One retired version must not fail the whole wiki.
          console.warn('[offline] parameter version skipped', err && err.message);
        });
      });
    }, Promise.resolve()).then(function () { return stored; });
  }

  function renderWikis(afterSync) {
    return storedWikis().then(function (stored) {
      storedIds = stored;
      // Sync picks with the cache before painting; `afterSync` stops the recursion.
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
                 // From state: this tbody is rebuilt when a download finishes.
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

  /** Ticked when every wiki is, indeterminate when some are. */
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

    // Short: the column is barely wider than the checkbox.
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

  // Warn while choosing, not after Save fails. WebKit reports about 1 GB and
  // does not refuse a write over quota: it discards the origin, with every
  // archive still reporting success.
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

  // Destructive, so it asks in place and disarms itself if left alone.
  var CONFIRM_MS = 6000;
  // A double click must never delete anything.
  var CONFIRM_DEAD_MS = 700;

  var clearArmed = null;
  var clearArmedAt = 0;

  function disarmClear(btn) {
    if (clearArmed) { clearTimeout(clearArmed); }
    clearArmed = null;
    btn.textContent = 'Remove all';
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

    return Promise.resolve().then(function () {
      // What this button removes, from the table's sizes: storage.estimate()
      // counts space freed but not yet reclaimed.
      var used = [COMMON].concat(WIKIS).reduce(function (n, w) {
        return storedIds[w.id] ? n + (w.mb || 0) * 1048576 : n;
      }, 0);
      btn.textContent = used ? 'Delete ' + fmt(used) + '? Press again'
                             : 'Press again to confirm';
      btn.classList.add('apo-btn-armed');

      var bar = document.createElement('span');
      bar.className = 'apo-arm';
      btn.appendChild(bar);
      // Force a layout so the transition starts from full width.
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

  // Retire a folded wiki's old cache, only once a common download has just
  // finished: until then it is the reader's only copy.
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

  // A download that dies partway leaves a cache with holes.
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
  // Tar reading and the archive fetch: common_offline_unpack.js. Differential
  // updates: common_offline_update.js, handed the live config on each call.

  var mimeFor = ApUnpack.mimeFor;

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

  /** Download what is selected and not already held; `refreshIds` re-fetches
   *  stored wikis (only the update check passes it). */
  function saveSelectedReal(refreshIds) {
    // The same button becomes Cancel.
    if (activeDownload) { return cancelDownload(); }

    var refresh = refreshIds || [];
    var chosen = selected().map(function (c) { return c.value; });
    // Chosen wikis first, common (440 MB of shared images) last, so a wiki is
    // readable in seconds while the images backfill.
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

    // Persistence before storing, so the data is protected from the start.
    var persistFirst = navigator.storage && navigator.storage.persist
      ? navigator.storage.persist() : Promise.resolve(false);

    return persistFirst
      .then(function () { return checkRoom(totalBytes); })
      .then(function () {
        // Marked complete only at the end, so an interrupted download never
        // looks usable.
        return queue.reduce(function (chain, entry) {
          return chain.then(function () {
            var cacheName = OFFLINE_CACHE_PREFIX + entry.id;
            return caches.open(cacheName).then(function (cache) {
              // raw_bytes: the browser decompresses before we count.
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
                // Before the completion marker: the chosen versions are part of
                // this download.
                return storeParams(entry, cache, report);
              }).then(function () {
                rowProgress(entry.id, 100, 'done');
                // The file table beside the files, for a later differential
                // update. Not fatal if missing: the next update re-fetches.
                return fetch(ApUpdate.tableUrl(entry, ARTIFACT_BASE, CURRENT_BUILD), { cache: 'no-cache' })
                  .then(function (r) { return r.ok ? r.json() : null; })
                  .then(function (table) {
                    return table ? ApUpdate.storeTable(cache, table) : null;
                  })
                  .catch(function () { return null; });
              }).then(function () {
                // The marker records the build an update check compares against.
                return cache.put(COMPLETE_MARKER,
                  new Response(JSON.stringify({
                    build: CURRENT_BUILD, saved: Date.now(), id: entry.id
                  }), { headers: { 'Content-Type': 'application/json' } }));
              }).then(function () {
                // One source of truth, updated the moment it is true.
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
        // Only unfinished bars are cleared, so a cancelled run does not look
        // successful.
        queue.forEach(function (w) {
          if (!storedIds[w.id]) { rowProgress(w.id, null); }
        });
        return renderWikis().then(renderStorage);
      });
  }

  /** Compare the server's build with each stored copy and re-fetch what is
   *  behind. */
  function checkForUpdates(quiet) {
    var out = el('check-result');

    // An automatic run says nothing until it has news.
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
            // The cache name gives the id even when the marker is unreadable.
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
        // Real news, announced even on an automatic run.
        announce('Updating ' + stale.length + ' item' +
                 (stale.length === 1 ? '' : 's') + '…');
        toast({ title: 'Updating saved wikis',
                msg: 'Checking what changed…', mode: 'sweep' });

        // Differential first; anything without a stored table falls back to
        // the archive.
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
          // A full archive download must never start from a timer: it is
          // hundreds of megabytes and the reader's decision. A manual press is
          // consent.
          if (quiet) {
            var names = full.map(function (id) {
              return (byId[id] && byId[id].name) || id;
            });
            announce('A full download is needed to update ' +
                     names.join(', ') +
                     '. Press Check for updates to start it.');
            // Say these need re-downloading, not that a lot changed: a missing
            // or unfetchable table is the usual reason.
            toast({ title: 'Update available',
                    msg: 'These cannot be updated in place, so they need '
                       + 'downloading again: ' + names.join(', ') + '.',
                    mode: 'done',
                    action: 'Redownload',
                    onAction: function () {
                      toast({ mode: 'hide' });
                      var btn = el('check-btn');
                      if (btn) { btn.click(); }
                    } });
            return renderWikis();
          }

          // Re-select what needs a full fetch and reuse the one download path.
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
        // A failed automatic check means offline, which is ordinary.
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

  // The selection, limited to what is saved.
  function exportSelection() {
    var chosen = selected().map(function (c) { return c.value; });
    var have = chosen.filter(function (id) { return storedIds[id]; });
    var missing = chosen.filter(function (id) { return !storedIds[id]; });
    return { ids: have, missing: missing, chosen: chosen };
  }

  /** Name an export after its contents and the build date, e.g.
   *  blimp-copter-rover-2026-08-08.html. */
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

  // Anything selected but unsaved is downloaded first: one press, not two.
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

  // Automatic updates: a check that finds nothing costs one small manifest
  // request. Thirty minutes, jittered; the wiki rebuilds a few times a day.
  // A development value of 30 s must not ship.
  var AUTOUPDATE_MS = 30 * 60 * 1000;

  var autoTimer = null;
  var autoBusy = false;

  function autoUpdateOn() {
    var box = el('autoupdate');
    return !!(box && box.checked);
  }

  function autoUpdateTick() {
    if (!autoUpdateOn()) { return; }
    // A running check or download owns the panel and the network.
    if (autoBusy || activeDownload) { return; }
    // Nothing saved means nothing to update and no reason to touch the network.
    if (!Object.keys(storedIds).length) { return; }
    // Not skipped while hidden: browsers throttle background timers already,
    // and a background tab is the copy most likely to be behind.

    autoBusy = true;
    return checkForUpdates(true).then(function () { autoBusy = false; },
                                      function () { autoBusy = false; });
  }

  // Jittered +/-50% so a new build is not a stampede.
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

  // Delegated: renderWikis() replaces the tbody, taking row handlers with it.
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

  // A dropdown choice becomes a ticked box. Only this row is re-rendered, so
  // the disclosure stays open.
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
      // Picking a version implies wanting its wiki.
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
    // closest(): the armed Remove all contains its own countdown bar.
    var hit = e.target && e.target.closest &&
              e.target.closest('#clear-btn, #download-cache-btn, #check-btn, #dl-single');
    if (!hit) { return; }
    if (hit.id === 'clear-btn') { confirmClear(); }
    if (hit.id === 'download-cache-btn') {
      // Saving opts in to offline mode (pwa.js); without a worker saved pages
      // are never served.
      if (window.ApOffline) { window.ApOffline.enable(); }
      saveSelectedReal();
    }
    if (hit.id === 'check-btn') { checkForUpdates(); }
    if (hit.id === 'dl-single') { e.preventDefault(); exportHtmlFile(); }
  });

  function init() {
    try {
      var pref = window.localStorage.getItem(AUTOUPDATE_KEY);
      if (pref === '0') { el('autoupdate').checked = false; }
    } catch (err) { /* private browsing */ }

    startAutoUpdate();
    // Returning to a long-hidden tab is when its copy is most likely behind.
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

    // Draw from the built-in list at once; renderStorage reads storedIds, so
    // it follows renderWikis.
    renderWikis().then(renderStorage);

    // Sizes and counts come from the manifest; the constants are a fallback.
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
