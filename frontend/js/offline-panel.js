/*
 * Offline status panel for the wiki sidebar.
 *
 * Every figure shown here is read back from Cache Storage and the Storage API,
 * never from a stored flag. If the browser evicts the cached copy the panel
 * says so, because it counts what is actually on disk rather than remembering
 * what was once put there.
 *
 * This is the status half of the offline feature. Selecting and downloading
 * whole wikis is a separate, larger piece; what is here works today and needs
 * no build artefacts.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    return;
  }

  var PAGE_CACHE_PREFIX = 'ardupilot-pages-';

  function el(id) {
    return document.getElementById(id);
  }

  function formatBytes(bytes) {
    if (!bytes) {
      return '0 MB';
    }
    var mb = bytes / 1048576;
    if (mb >= 1024) {
      return (mb / 1024).toFixed(1) + ' GB';
    }
    return Math.round(mb) + ' MB';
  }

  /** Count cached pages by enumerating the cache, not by trusting a counter. */
  function countCachedPages() {
    return caches.keys().then(function (names) {
      var pageCaches = names.filter(function (name) {
        return name.indexOf(PAGE_CACHE_PREFIX) === 0;
      });
      return Promise.all(pageCaches.map(function (name) {
        return caches.open(name).then(function (cache) {
          return cache.keys().then(function (keys) {
            return keys.length;
          });
        });
      })).then(function (counts) {
        return counts.reduce(function (a, b) {
          return a + b;
        }, 0);
      });
    });
  }

  function storageState() {
    var estimate = navigator.storage && navigator.storage.estimate
      ? navigator.storage.estimate()
      : Promise.resolve({});
    var persisted = navigator.storage && navigator.storage.persisted
      ? navigator.storage.persisted()
      : Promise.resolve(false);
    return Promise.all([estimate, persisted]).then(function (results) {
      return { estimate: results[0] || {}, persisted: results[1] };
    });
  }

  /*
   * Installing and saving pages are separate things and the panel says so.
   * Installing gives an app window, a launcher icon and better odds of a
   * persistent storage grant, but downloads no content. Saved pages work in an
   * ordinary tab with nothing installed.
   */
  function renderAppState() {
    var status = el('ap-app-status');
    if (!status) {
      return;
    }
    var standalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;
    if (standalone) {
      status.innerHTML = 'Running as an installed app.';
    } else {
      status.innerHTML = 'Running in the browser.';
    }

    // Readers assume "Install" downloads the wiki. It does not, and offline
    // reading does not require it - a service worker caches pages perfectly
    // well in an ordinary tab. What installing actually changes is how likely
    // the browser is to keep that cache, so say exactly that.
    var note = el('ap-app-note');
    if (note && !standalone) {
      note.innerHTML =
        '<strong>You do not need to install to read offline.</strong> ' +
        'Pages are saved as you read them either way, and installing ' +
        'downloads nothing by itself. Installing gives the wiki its own ' +
        'window and launcher icon, and makes your browser far less likely ' +
        'to delete the saved pages when space runs short.';
      note.hidden = false;
    } else if (note) {
      note.hidden = true;
    }
  }

  function render() {
    renderAppState();
    return Promise.all([countCachedPages(), storageState()]).then(function (results) {
      var pages = results[0];
      var estimate = results[1].estimate;
      var persisted = results[1].persisted;

      var status = el('ap-offline-status');
      if (!status) {
        return;
      }

      var lines = [];
      if (pages === 0) {
        lines.push('No pages saved yet. Pages are saved as you read them.');
      } else {
        lines.push('<strong>' + pages + '</strong> page' + (pages === 1 ? '' : 's') +
                   ' saved on this device.');
      }

      if (estimate.usage !== undefined) {
        var available = (estimate.quota || 0) - (estimate.usage || 0);
        lines.push(formatBytes(estimate.usage) + ' used &middot; ' +
                   formatBytes(available) + ' available.');
      }

      status.innerHTML = lines.join('<br>');

      // Readers need to know this before they rely on an offline copy in the
      // field. Browsers evict "best effort" storage silently and without
      // warning when the device runs low on space, and even a persistence
      // grant does not survive the user clearing site data.
      var warning;
      if (persisted) {
        warning = 'Storage: <strong>permanent</strong>. This copy will not be ' +
                  'evicted automatically, but clearing your browser data still ' +
                  'removes it.';
      } else {
        warning = '&#9888; Storage: <strong>temporary</strong>. Your browser can ' +
                  'delete these saved pages without warning if this device runs ' +
                  'low on space. Do not rely on this copy in the field until you ' +
                  'make it permanent.';
      }
      status.innerHTML += '<div style="margin-top:8px; padding:6px 8px; font-size:11px;' +
                          'line-height:1.45; border-left:3px solid ' +
                          (persisted ? '#5a9e5a' : '#d9822b') + ';' +
                          'background:rgba(0,0,0,0.15)">' + warning + '</div>';

      var persistButton = el('ap-offline-persist');
      if (persistButton) {
        persistButton.hidden = persisted || !(navigator.storage && navigator.storage.persist);
      }

      var panel = el('ap-offline-panel');
      if (panel) {
        panel.hidden = false;
      }
    });
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || target.id !== 'ap-offline-persist') {
      return;
    }
    target.disabled = true;
    navigator.storage.persist().then(function (granted) {
      if (!granted) {
        // Chrome decides from engagement signals; installing the app is the
        // strongest one available to us, so point at that rather than leaving
        // a button that silently does nothing.
        var status = el('ap-offline-status');
        if (status) {
          status.innerHTML += '<br>Request declined. Installing the app makes ' +
                              'permanent storage more likely.';
        }
      }
      target.disabled = false;
      return render();
    });
  });

  window.addEventListener('load', function () {
    render();
    // Pages are cached as they are read, so the counts move while you browse.
    setInterval(render, 10000);
  });
})();
