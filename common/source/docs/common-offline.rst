:orphan:

.. Reached from the top menu rather than a toctree, so mark it orphan and keep
.. the build warning-free.

.. _common-offline:

==============
Offline Copies
==============

Keep the documentation readable with no connection: in a hangar, in a field, or
anywhere the signal runs out.

Two separate things live on this page, and they are easily confused. *Saving
pages* makes the wiki readable offline and works in an ordinary browser tab.
*Installing* the app downloads nothing at all. It only gives the wiki its own
window, and makes your browser far less likely to delete what you have saved.

.. raw:: html

   <!-- The tool. Markup only:

          styling    /css/offline.css
          behaviour  /js/offline-page.js    (the panel)
                     /js/offline-export.js  (building .pyz and .html files)

        Self-contained - every tag opened here is closed here. A <div> opened in
        one raw block and closed in another lands inside different section
        wrappers, which corrupts the nesting and pushes the page footer out of
        the content column.

        Follows ArduPilot's other tool front-end, custom.ardupilot.org: dark
        header strip, status badges, progress bars. -->
   <link rel="stylesheet" href="/css/offline.css">

   <div class="apo">

     <div class="apo-head">
       <p class="apo-title">Offline storage</p>
       <span class="apo-spacer"></span>
       <button id="download-cache-btn" class="apo-btn apo-btn-primary">Save selected</button>
       <button id="check-btn" class="apo-btn apo-btn-ghost">Check for updates</button>
       <button id="clear-btn" class="apo-btn apo-btn-danger">Remove all</button>
     </div>

     <div id="storage-warning"></div>

     <table class="apo-table">
       <thead>
         <tr>
           <th class="apo-name"><span class="apo-pick"><input type="checkbox"
                 id="select-all" title="Select every wiki"
                 aria-label="Select every wiki"><span>Wiki</span></span></th>
           <th class="apo-num">Size</th>
           <th class="apo-num apo-pages-h">Pages</th>
           <th class="apo-num">Progress</th>
           <th class="apo-num">Status</th>
         </tr>
       </thead>
       <tbody id="wiki-rows"></tbody>
     </table>

     <div class="apo-foot">
       <label><input type="checkbox" id="autoupdate" checked>
         <span>Update saved pages automatically</span></label>
       <div class="apo-status apo-foot-status">
         <span id="selection-total"></span>
         <span id="cache-progress" hidden></span>
         <span id="check-result" hidden></span>
       </div>
       <div class="apo-status apo-foot-status">
         <span id="storage-status"></span>
         <span id="build-date"></span>
       </div>
     </div>

     <div class="apo-files">
       <h3>Save a copy as a file</h3>
       <p class="apo-hint" style="margin-top:0">Built on this device from the
         wikis ticked above. Anything not saved yet is downloaded first, so
         one press is enough. Each file contains exactly the wikis you chose,
         shared images included.</p>

       <div class="apo-file">
         <button id="dl-pyz" class="apo-btn apo-btn-outline">Save as .pyz</button>
         <div class="apo-hint">One file that serves itself:
           <code>python3 &lt;file&gt;.pyz</code> opens the wiki in your browser. Pages
           load instantly, search works, and nothing is extracted to disk.</div>
       </div>

       <div class="apo-file">
         <button id="dl-single" class="apo-btn apo-btn-outline">Save as .html</button>
         <div class="apo-hint">A single self-contained page. Double-click it, nothing
           to install. It works from a USB stick, though it is large and takes
           a moment to open.</div>
       </div>
     </div>

   </div>

Install as an app
=================

.. note::

   Installing downloads nothing, and is not needed to read offline. Saving pages
   works in an ordinary browser tab. It gives the wiki its own window and a
   launcher icon, and makes your browser far less likely to delete your saved
   pages when the device runs low on space.

.. raw:: html

   <div class="apo-install-row">
     <button id="ap-install-app" class="apo-btn apo-btn-outline" hidden>Install app</button>
     <span id="install-state" class="apo-hint"></span>
   </div>

   <script src="/js/offline-export.js" defer></script>
   <script src="/js/offline-page.js" defer></script>

[copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
