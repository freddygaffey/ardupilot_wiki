.. _wiki-offline-copies:

=======================
How Offline Copies Work
=======================

The wiki can be read with no connection. This page describes how that is
implemented, and what a server must provide to support it.

For using the feature, see :ref:`common-offline`.

Overview
========

Three things are provided:

#. **Pages are kept as they are read**, and served from storage on subsequent
   visits. Pages the reader appears to be about to open are also fetched
   slightly ahead of the click, within the limits described under
   `Prefetching`_.

#. **A whole wiki can be downloaded**: that wiki's archive together with the
   shared image archive, which is required whichever wiki is chosen and is the
   larger of the two. Both are unpacked in the browser into local storage.

#. **A single self-contained file can be exported.** One ``.html`` containing
   pages, images and a search index, assembled in the browser from stored
   content.

The service worker
==================

A service worker is a script the browser runs in the background, independently
of any page and persisting after the page that registered it has closed. Once
active it is placed between the pages in its scope and the network: every
request those pages make is passed to the worker, which returns a response
either from local storage or by forwarding the request to the network.

That interception is what provides offline reading. The pages themselves are
unmodified static HTML as built by Sphinx.

.. image:: ../images/wiki-offline-request-flow.svg
    :target: ../_images/wiki-offline-request-flow.svg
    :width: 100%

Timings are measured: a page held locally is returned in 13 to 19 ms, against
about 1,000 ms for the same page over the network.

Implementation is in ``frontend/sw.js``, registered by
``frontend/js/pwa.js``, which ``common/_templates/layout.html`` includes on
every page.

.. note::

   Service workers require a secure context: ``https://``, or
   ``http://localhost`` during development. A wiki served over plain HTTP has
   no offline support.

Storage
-------

Cache Storage holds complete HTTP responses keyed by request URL, in named
stores. It is separate from the browser's HTTP cache, is not cleared with
browsing history, and is scoped to the origin.

Four stores are used:

``ardupilot-pages-v3``, ``-images-v3``, ``-static-v3``
   Populated while browsing. Discarded when ``CACHE_VERSION`` changes.

``ardupilot-offline-<wiki>``
   A downloaded wiki. Excluded from version-bump deletion, as it holds content
   the reader explicitly chose to store.

``ardupilot-thirdparty-v3``
   Cross-origin assets, cached to avoid re-fetching them on every page.

Lookup
------

``heldOffline()`` in ``sw.js`` determines whether a URL is held locally. It is
used for all resource types, and tries each form a URL may have been stored
under, including the ``/_common/`` path used for images shared between wikis.

.. note::

   Stored keys are the URLs the site serves. ArduPilot serves
   ``/copter/docs/foo.html`` directly. A host that canonicalises URLs, for
   example by stripping ``.html``, will break offline reading without
   affecting online browsing.

Performance
===========

The same interception makes ordinary browsing faster, whether or not the reader
has downloaded anything and whether or not they are offline. Once a page or
asset is held locally it is served from storage, so navigation does not wait on
the network.

Measured on the reference deployment, pages not previously visited in that
session and served from a downloaded wiki:

===================================  ==============
Page HTML                            13 to 19 ms
Theme assets (jQuery, CSS, fonts)    1 to 2 ms
Network requests per navigation      0
===================================  ==============

Four things produce that:

**Local content is preferred over the network.** A page held locally is
returned immediately and revalidated in the background; if the fetched copy
differs, the page is notified and offers a reload. Previously the network was
tried first and local content used only on failure, so a reader holding the
entire wiki still waited on the network for every page.

**Lookups are directed rather than exhaustive.** ``caches.match()`` without a
store name searches every store in turn, and a reader with all wikis
downloaded has fourteen. The URL identifies the store that can hold it, so that
one is consulted first: 692 ms against 89 ms for the same request. The
exhaustive search remains as a fallback.

**Content found in a downloaded wiki is promoted** into the runtime store, so
subsequent requests resolve directly. Without this, shared assets are
re-resolved through the wiki archive on every request: 84 ms against 1 ms.

**Static assets are cache-first.** Sphinx fingerprints them
(``theme.css?v=5d32c60e``), so a stored copy can only be the copy that
fingerprint refers to and revalidation cannot find anything new. nginx marks
them ``immutable``.

Prefetching
-----------

``pwa.js`` fetches a page shortly before it is likely to be requested, using
pointer position, velocity projected forward, and whether the pointer is
decelerating as it approaches a link. A pointer crossing a link at speed does
not trigger it.

Speculative requests are bounded: at most eight per page view, at least 400 ms
apart, one in flight at a time, each URL once, anything over 2 MB abandoned,
and in-flight requests cancelled on navigation. Pages already held locally
bypass the budget, as they generate no traffic. Nothing is fetched when the
reader has requested reduced data usage, or on pages carrying more than 250
links, where the links are an index rather than an indication of intent.

Downloading a wiki
==================

Retrieving pages individually would require approximately 3,400 requests per
reader for Copter. Each wiki is instead packed at build time and unpacked by
the browser.

Build output
------------

``scripts/build_offline_artifacts.py`` runs during a build when ``--offline``
is passed, writing to ``<destdir>/offline/``:

``offline-manifest.json``
   Sizes, page counts and build id. The download page renders from this.

``common-offline.tar.gz``
   Images used by two or more wikis. The majority of the total size.

``<wiki>-offline.tar.gz``
   Content unique to a single wiki.

Shared images are separated because including them per wiki would multiply
several hundred megabytes across eleven wikis.

Archives are reproducible: tar metadata is normalised, so unchanged content
produces byte-identical output and unchanged archives can be skipped on upload.

Client side
-----------

``common_offline_page.js`` streams the archive and unpacks entries as they
arrive rather than buffering the whole file. Each entry is written to Cache
Storage under the URL the site serves it at, so unpacked content is retrieved
by the same path as content cached while browsing.

Two constraints apply:

* Archives are served with a content coding, so the browser decompresses them
  before the script receives the body. This avoids requiring
  ``DecompressionStream``, which is unavailable in Safari before 16.4 and
  Firefox before 113.
* A completion marker is written last, and a stored wiki is treated as usable
  only when it is present, so an interrupted download is not mistaken for a
  complete one.

Serving requirements
====================

The archives are static files; no application server or database is involved.

**Serve pages at their built URLs.** ``/copter/docs/foo.html`` must return that
page. Canonicalising to ``/copter/docs/foo`` breaks offline reading while
leaving online browsing unaffected.

**Do not cache the worker.** ``/sw.js`` must be served with
``Cache-Control: no-cache``.

**Pair archives with their compressed form.** Under nginx, ``gzip_static on``
in the ``/offline/`` location serves ``<name>.tar.gz`` in response to
``<name>.tar`` and sets the content coding.

**Serve the frontend at the web root.** A worker's scope is its own path and
below, so a worker at ``/frontend/sw.js`` registers successfully but controls
no wiki page.

``deploy/nginx-wiki.conf`` contains a working configuration.

Recovery
========

A service worker persists after the page that registered it closes, so a faulty
worker is not resolved by reloading. ``frontend/sw-kill.js`` is deployed in
place of ``sw.js`` to unregister the worker and delete its caches. This depends
on ``/sw.js`` being served ``no-cache``.

Testing
=======

.. code-block:: bash

    npm install --no-save jsdom
    npm test

``scripts/tests/test_offline_worker.js``
   Builds a cache from real archives, requests the URLs the site serves, and
   resolves them using the worker's own code.

``scripts/tests/test_offline_page.js``
   Drives the download panel under jsdom, including the update check.

``scripts/tests/test_offline_export.js``
   Runs the exporter against build output and inspects the result.

``scripts/tests/test_offline_archives.py``
   Inspects the finished archives. Requires ``update.py --offline`` to have run.

Tests must exercise the shipped code rather than a reimplementation of it, and
each must be shown to fail when the behaviour it covers is removed.

Limitations
===========

* The shared image archive is required regardless of which wiki is chosen, so
  the first download is large before any content is readable.
* Generated reference pages, such as the full parameter lists and board feature
  tables, reach several megabytes and hundreds of thousands of DOM nodes. Their
  rendering cost is unaffected by caching.
* EPUB and PDF output are not covered here.

Faults belonging to the wiki rather than to this feature are recorded in
``scripts/tests/KNOWN_UPSTREAM_ISSUES.md``.
