:orphan:

.. Reached from the top menu rather than a toctree, so mark it orphan and keep
.. the build warning-free.

.. _common-offline:

==============
Offline Copies
==============

.. raw:: html

   <!-- Everything below is one raw block on purpose.
        Sphinx supplies the page title and the surrounding wiki chrome; the tool
        itself is plain HTML, CSS and JavaScript, so it can be worked on without
        touching reStructuredText and without docutils deciding how it is laid
        out. It is also the only arrangement that is structurally safe: a <div>
        opened in one raw block and closed in another lands inside different
        section wrappers, which corrupts the nesting and pushes the page footer
        out of the content column.

        Styling:   /css/offline.css
        Behaviour: /js/offline-page.js  (the panel)
                   /js/offline-export.js (building .pyz and .html files)

        The panel follows ArduPilot's other tool front-end,
        custom.ardupilot.org: dark header strip, status badges, progress bars.
   -->
   <link rel="stylesheet" href="/css/offline.css">

   <div class="apo-intro">
     <p>Keep the documentation readable with no connection &mdash; in a hangar, in
        a field, or anywhere the signal runs out.</p>
     <p>Two separate things live on this page, and they are easily confused.
        <strong>Saving pages</strong> makes the wiki readable offline and works in
        an ordinary browser tab. <strong>Installing</strong> the app downloads
        nothing at all &mdash; it only gives the wiki its own window, and makes
        your browser far less likely to delete what you have saved.</p>
   </div>

   <div class="apo">

     <div class="apo-head">
       <p class="apo-title">Offline storage</p>
       <span class="apo-spacer"></span>
       <button id="download-cache-btn" class="apo-btn apo-btn-primary">Save selected</button>
       <button id="check-btn" class="apo-btn apo-btn-ghost">Check for updates</button>
       <button id="persist-btn" class="apo-btn apo-btn-ghost" hidden>Make permanent</button>
       <button id="clear-btn" class="apo-btn apo-btn-ghost">Remove all</button>
     </div>

     <div id="storage-warning"></div>

     <table class="apo-table">
       <thead>
         <tr>
           <th>Wiki</th>
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
       <span class="apo-spacer"></span>
       <span class="apo-status" id="selection-total"></span>
       <span class="apo-status" id="storage-status"></span>
       <span class="apo-status" id="cache-progress" hidden></span>
       <span class="apo-status" id="check-result" hidden></span>
       <span class="apo-status" id="build-date"></span>
     </div>

     <div class="apo-files">
       <h3>Save a copy as a file</h3>
       <p class="apo-hint" style="margin-top:0">Both are built here from the pages
         you have saved, so nothing extra is downloaded and each file holds exactly
         the wikis you kept, shared images included.</p>

       <div class="apo-file">
         <button id="dl-pyz" class="apo-btn apo-btn-outline">Save as .pyz</button>
         <div class="apo-hint">One file that serves itself:
           <code>python3 &lt;file&gt;.pyz</code> opens the wiki in your browser. Pages
           load instantly, search works, and nothing is extracted to disk.</div>
       </div>

       <div class="apo-file">
         <button id="dl-single" class="apo-btn apo-btn-outline">Save as .html</button>
         <div class="apo-hint">A single self-contained page. Double-click it, nothing
           to install &mdash; it works from a USB stick, though it is large and takes
           a moment to open.</div>
       </div>
     </div>

     <div class="apo-install">
       <h3>Install as an app</h3>
       <div class="apo-note apo-note-info" style="border-bottom:0">
         <strong>Installing downloads nothing</strong>, and is not needed to read
         offline &mdash; saving pages works in an ordinary browser tab. It gives the
         wiki its own window and a launcher icon, and makes your browser far less
         likely to delete your saved pages when the device runs low on space.
       </div>
       <div class="apo-file" style="margin-top:12px">
         <button id="ap-install-app" class="apo-btn apo-btn-outline" hidden>Install app</button>
         <span id="install-state" class="apo-hint"></span>
       </div>
     </div>

   </div>

   <script src="/js/offline-export.js" defer></script>
   <script src="/js/offline-page.js" defer></script>

[copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
