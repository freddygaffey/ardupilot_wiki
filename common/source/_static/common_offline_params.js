/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * Marker required, or this .js reaches only four of the eleven wikis.
 *
 * Tell the truth in the firmware version dropdown on a parameters page.
 *
 * THE PROBLEM. That dropdown is upstream's. parameters.html carries an inline
 * script that fetches _static/parameters-<Vehicle>.json - a map of label to URL,
 * fifteen entries for Copter - and fills the <select> from it. The JSON is 971
 * bytes so it travels inside the wiki archive. The pages it points at are 4 to
 * 6 MB each, so when historical parameters became opt-in they left the archive:
 * Copter went 80 MB to 74 MB, and all fourteen versions became 17.5 MB chosen
 * rather than 242.7 MB imposed.
 *
 * The pages moved. The index pointing at them did not. Offline, with a default
 * save, fourteen of the fifteen entries lead to "This page has not been saved
 * for offline use". Measured: six followed, five dead ends. The dropdown
 * promises fifteen doors and one opens.
 *
 * That is ours, not upstream's. Online the JSON is exactly right; every page it
 * names is on the server. It only becomes a lie once the archive is a subset.
 *
 * WHY THIS CANNOT BE FIXED AT BUILD TIME. Which versions a reader has depends
 * on which they ticked. No file written by the build can know, so the answer
 * has to be computed here, per reader, per entry.
 *
 * WHAT IT DOES. Nothing at all unless this wiki has a completed offline
 * download; a reader who has never used the feature sees the dropdown exactly
 * as it has always been. Otherwise every entry is checked against Cache
 * Storage, and the ones that are not there are labelled, and disabled while
 * offline.
 *
 * ON navigator.onLine, AND A CORRECTION. I first wrote that it is unreliable
 * saying true and reliable saying false, and built the disabling on that.
 * Measured, it is not: on a document navigated while genuinely offline it
 * reported TRUE. That may be an artefact of the test browser's offline
 * emulation rather than real behaviour, and I cannot tell the two apart from
 * here, which is the whole reason not to depend on it.
 *
 * So the fix does not. The LABEL is the fix, and it needs no network knowledge
 * at all: a version either is in Cache Storage or is not, and that answer is
 * correct in every state. Disabling is opportunistic on top - taken when
 * onLine says false and when an 'offline' event fires, which is reliable
 * because events report a transition rather than an initial value.
 *
 * Worst case the entry stays clickable and the reader lands on the offline
 * fallback, which is a designed page, having already been told by its label
 * that they did not save it. That is strictly better than today, where the
 * dropdown says nothing and fourteen of fifteen entries dead-end in silence.
 */
(function () {
  'use strict';

  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';
  var MISSING_SUFFIX = ' — not saved';

  if (!window.caches || !document.getElementById) { return; }

  var wiki = window.location.pathname.split('/')[1];
  if (!wiki) { return; }

  /** Every option's target, as an absolute path, in DOM order. */
  function targets(select) {
    return Array.prototype.map.call(select.options, function (opt) {
      if (!opt.value) { return null; }
      try {
        return new URL(opt.value, window.location.href).pathname;
      } catch (err) { return null; }
    });
  }

  function annotate(select, missing, offline) {
    Array.prototype.forEach.call(select.options, function (opt, i) {
      var absent = missing[i];
      // The label is rebuilt from a remembered original rather than appended
      // to, or repeated passes would stack suffixes: "4.6.2 - not saved - not
      // saved". Recomputed on every online/offline event, so this runs often.
      if (opt.dataset.apLabel === undefined) { opt.dataset.apLabel = opt.text; }
      opt.text = opt.dataset.apLabel + (absent ? MISSING_SUFFIX : '');
      opt.disabled = !!(absent && offline);
    });
  }

  function refresh(select, missing) {
    annotate(select, missing, navigator.onLine === false);
  }

  function considered(select) {
    // Only speak up for a reader who actually has this wiki saved. Without
    // this guard the live site would grow "not saved" labels for people who
    // have never touched the offline feature, which would be noise at best and
    // alarming at worst.
    return caches.open(OFFLINE_CACHE_PREFIX + wiki).then(function (cache) {
      return cache.match(COMPLETE_MARKER).then(function (marker) {
        if (!marker) { return null; }
        var paths = targets(select);
        return Promise.all(paths.map(function (p) {
          // The placeholder option, and anything unparseable, are left alone.
          if (!p) { return false; }
          // caches.match with no name searches every cache, which is the right
          // question here: a version could have been stored by a download or
          // simply by being read once while online.
          return caches.match(p).then(function (hit) { return !hit; });
        }));
      });
    }).catch(function () { return null; });
  }

  function attach(select) {
    considered(select).then(function (missing) {
      if (!missing) { return; }
      refresh(select, missing);
      window.addEventListener('online', function () { refresh(select, missing); });
      window.addEventListener('offline', function () { refresh(select, missing); });
    });
  }

  function start() {
    var select = document.getElementById('selectPicker');
    if (!select) { return; }
    if (select.options.length) { attach(select); return; }
    // The inline script fills it after its own fetch resolves, so wait for the
    // options rather than racing them. Disconnects on the first batch: the
    // list is built once and never rebuilt.
    var seen = new MutationObserver(function () {
      if (!select.options.length) { return; }
      seen.disconnect();
      attach(select);
    });
    seen.observe(select, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
