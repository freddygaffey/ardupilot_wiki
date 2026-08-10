.. _wiki-offline-copies:

==========================
How Offline Copies Work
==========================

The wiki can be read with no connection. This page explains how that is built,
for developers maintaining it or reviewing changes to it. If you only want to
*use* the feature, see :ref:`common-offline` instead.

No web experience is assumed. Where a browser mechanism is unfamiliar, it is
explained in terms of what it actually does rather than by name alone.

Overview
========

Three separate things are provided, and they are easy to confuse:

#. **Pages are kept as you read them.** Anything you visit is stored, so losing
   your connection leaves whatever you have already seen still readable. No
   action is required and nothing is downloaded in advance.

#. **A whole wiki can be downloaded.** One file per wiki, unpacked by the
   browser into its own storage. This is the only part that costs bandwidth,
   and it is always a deliberate choice.

#. **A single self-contained file can be exported.** One ``.html`` holding the
   pages, the images and a search index, built in the browser from what has
   already been stored. It opens by double-clicking, needs nothing installed
   and runs from a USB stick.

The service worker
==================

A **service worker** is a small script the browser keeps running in the
background, separate from any page. Once installed it sits between the browser
and the network: every request a page makes is handed to it first, and it
decides whether to answer from storage or let it go to the network.

The closest analogy in embedded terms is a cache controller sitting in front of
slow memory. Nothing above it knows the difference; it either has the line or
it fetches it.

This matters because it is what makes offline reading work *without changing
the wiki*. The pages are ordinary static HTML built by Sphinx exactly as they
always were. Nothing is rewritten, no framework is introduced, and if the
worker is removed the site behaves exactly as it did before.

The worker lives in ``frontend/sw.js`` and is registered by
``frontend/js/pwa.js``, which is injected into every page by
``common/_templates/layout.html``.

.. note::

   A service worker only runs on ``https://`` (or ``http://localhost``). This
   is a browser rule and cannot be worked around. A wiki served over plain
   HTTP has no offline support at all.

Where things are stored
-----------------------

The browser provides **Cache Storage**: a set of named stores, each holding
responses keyed by URL. It is not the browser's ordinary cache and is not
cleared by "clear history".

The worker uses several, and the distinction matters:

``ardupilot-pages-v3``, ``-images-v3``, ``-static-v3``
   Filled as you browse. Disposable: bumping the version number discards them.

``ardupilot-offline-<wiki>``
   A wiki you deliberately downloaded. **Never discarded on version bumps**,
   because it is hundreds of megabytes somebody chose to store.

``ardupilot-thirdparty-v3``
   A few assets from other domains, so pages do not wait on them every visit.

The lookup
----------

One function answers "do we already have this?" for every kind of resource:
``heldOffline()`` in ``sw.js``. It tries, in order, the shapes a URL can have
been stored under.

This is deliberately one function rather than several. When pages and images
had separate lookups they drifted apart, and the result was that every image
belonging to a single wiki was missing offline while shared images resolved
normally. That failure looked like scattered broken pictures rather than a
missing code path, and took far longer to find than it should have.

.. note::

   The URL a reader is on must match the URL that was stored. ArduPilot serves
   ``/copter/docs/foo.html`` directly, so this holds. A host that rewrites URLs
   (for instance stripping ``.html``) breaks offline reading completely, and
   silently: pages still load online, and only cold opens fail.

Downloading a whole wiki
========================

The naive approach, fetching every page in turn, would mean roughly 3,400
requests per reader for Copter alone. Instead each wiki is packed at build time
into a single compressed archive, and the browser unpacks it locally.

What the build produces
-----------------------

``scripts/build_offline_artifacts.py`` runs as part of an ordinary build when
``--offline`` is passed, and writes into ``<destdir>/offline/``:

``offline-manifest.json``
   Sizes, page counts and a build id. The download page renders itself from
   this, so the numbers track the wiki instead of being hardcoded.

``common-offline.tar.gz``
   Images used by two or more wikis, stored once. This is most of the payload,
   because nearly every wiki references most of the shared images.

``<wiki>-offline.tar.gz``
   Everything unique to one wiki.

Splitting shared from per-wiki matters at this scale: bundling the shared
images into every wiki would multiply several hundred megabytes by eleven.

.. note::

   Archives are reproducible. Timestamps, ownership and permissions are
   normalised, so a wiki whose content has not changed produces a
   byte-identical archive and can be skipped on upload.

What the browser does with it
-----------------------------

``common_offline_page.js`` requests the archive, and unpacks it as it arrives
rather than downloading it first. Each file inside is written into Cache
Storage under the URL the wiki serves it at, so an unpacked page is
indistinguishable from one that was fetched normally. The ordinary page-serving
path then finds it with no special cases.

Two details are load-bearing:

* **Decompression is the browser's job.** The archive is served as a content
  coding, so the browser has already decompressed it before the script sees a
  byte. This avoids requiring ``DecompressionStream``, which older Safari and
  Firefox lack.
* **A completion marker is written last.** A copy only counts as usable once
  that marker exists, so an interrupted download is never mistaken for a
  complete one.

Serving requirements
====================

The archives are ordinary static files. There is no endpoint, no application
server and no database. Anything that can serve a directory can serve this.

Three properties are required:

**Serve pages at the URLs they were built as.** ``/copter/docs/foo.html`` must
return that page. Do not canonicalise to ``/copter/docs/foo``: the archives
store the built paths, and a mismatch breaks offline reading while leaving the
online site looking fine.

**Do not cache the worker.** ``/sw.js`` must be served ``Cache-Control:
no-cache``. A stale worker paired with a fresh site is difficult to recover
from.

**Pair the archives with their compressed form.** With nginx, ``gzip_static on``
in the ``/offline/`` location serves ``<name>.tar.gz`` when ``<name>.tar`` is
requested, setting the header that makes the browser decompress.

A worked nginx configuration is in ``deploy/nginx-wiki.conf``.

.. note::

   The frontend must be served at the **web root**, not from a subdirectory. A
   service worker can only control pages at or below its own location, so a
   worker at ``/frontend/sw.js`` would register cleanly, report no error, and
   control no wiki page at all.

Recovering from a bad worker
============================

A service worker persists across visits, so a broken one is not fixed by
reloading. ``frontend/sw-kill.js`` exists for this: deploy it in place of
``sw.js`` and it unregisters itself and deletes its caches everywhere.

This depends on ``/sw.js`` being served ``no-cache``, which is why that rule is
not optional.

Testing changes
===============

.. code-block:: bash

    npm install --no-save jsdom
    npm test

The suite runs the shipped code rather than a copy of it, which is deliberate:
an earlier version of the search test reimplemented the ranking logic, the copy
carried the same bug as the original, and the two agreed with each other while
readers got no results.

``scripts/tests/test_offline_worker.js``
   Builds a cache from real archives, asks for the URLs the site actually
   serves, and answers with the worker's own code.

``scripts/tests/test_offline_page.js``
   Drives the download panel in jsdom, including the freshness round trip.

``scripts/tests/test_offline_export.js``
   Runs the real exporter against real build output and checks the bytes.

``scripts/tests/test_offline_archives.py``
   Reads the finished archives. Needs ``update.py --offline`` to have run.

Two rules apply to anything added here. A test must be shown to fail when its
fix is removed, or it is not testing anything. And no test may reimplement the
logic it tests.

Known limitations
=================

* The shared image archive is several hundred megabytes and is required
  whichever wiki is chosen, so the first download is large before anything is
  readable.
* The generated reference pages (parameter lists, board feature tables) reach
  several megabytes and hundreds of thousands of DOM elements. They are slow in
  any browser, offline or not, and no caching affects that.
* EPUB and PDF generation are not part of this. Both build, but need work on
  contents generation and image handling first.

Other faults found while building this, which belong to the wiki rather than to
the offline feature, are recorded in ``scripts/tests/KNOWN_UPSTREAM_ISSUES.md``.
