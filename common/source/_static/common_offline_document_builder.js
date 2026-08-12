/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * Marker required, or this .js reaches only four of the eleven wikis and the
 * exporter builds a file with no shell.
 *
 * The exported-document builder: everything that decides what the .html file
 * *is* (common_offline_export.js reads Cache Storage and streams the bytes).
 * Two landmines:
 *   - buildNav builds the sidebar tree AND the next/previous order from one
 *     merged toctree; built separately they drift and "next" skips pages.
 *   - SHELL_JS is the script embedded in the exported file, assembled from
 *     single-quoted literals, so every backslash here must be DOUBLED or it
 *     vanishes from the built file (one written singly once shipped stripped and
 *     silently corrupted search). Code outside SHELL_JS is ordinary source.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ the shell */

  // Only what the app itself needs. Everything else - type, headings,
  // admonitions, code blocks, tables, the collapsible sidebar, the footer
  // buttons - comes from the theme's own stylesheet, embedded at export time,
  // so this looks like the site rather than like an approximation of it.
  var SHELL_CSS =
    'html,body{height:100%}' +
    '.wy-nav-side{overflow-y:auto}' +
    '#ap-search{margin:12px;padding:8px 10px;border:0;border-radius:3px;' +
    'font:inherit;width:calc(100% - 24px)}' +
    '#ap-miss{display:none;padding:10px 16px;color:#a8620f;background:#ffedcc;' +
    'font-size:13px}' +
    '#ap-bar{background:#2980b9;color:#fff;padding:8px 16px;font-size:13px}' +
    '#ap-brand{background:#2980b9;color:#fff;padding:14px 16px;font-weight:700}' +
    '#ap-brand small{display:block;font-weight:400;opacity:.85;font-size:12px}' +
    '#ap-crumb{padding:6px 0;color:#666;font-size:13px;text-transform:uppercase;' +
    'letter-spacing:.05em}' +
    // The gap the theme leaves between the last paragraph and the buttons. On
    // the site it comes from the <hr> and copyright block underneath, which an
    // offline copy has nothing to put in.
    '#ap-foot{margin-top:24px}' +
    '#ap-lightbox{position:fixed;top:0;right:0;bottom:0;left:0;z-index:9999;' +
    'display:none;align-items:center;justify-content:center;cursor:zoom-out;' +
    'background:rgba(0,0,0,.85)}' +
    '#ap-lightbox img{max-width:94vw;max-height:94vh}' +
    '#ap-pick{list-style:none;margin:1em 0 0;padding:0}' +
    '#ap-pick li{border-bottom:1px solid #e1e4e5}' +
    '#ap-pick a{display:flex;align-items:baseline;justify-content:space-between;' +
    'gap:1em;padding:12px 2px;text-decoration:none}' +
    '#ap-pick small{color:#666;text-transform:none;font-size:.85em}' +
    '.ap-results li{padding:10px 0}' +
    '.ap-results a{padding:0;border:0}' +
    '.ap-snip{margin:.25em 0 0;color:#4a4a4a;font-size:.9em;line-height:1.5}' +
    '.ap-snip mark{background:#fff3b0;color:inherit;padding:0 2px}' +
    '.ap-actions{display:flex;flex-wrap:wrap;gap:0 1.5em}' +
    '#ap-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
    'z-index:10000;display:none;align-items:center;gap:1em;' +
    'max-width:min(680px,92vw);padding:12px 16px;border-radius:4px;' +
    'background:#1f2d3a;color:#fff;font-size:14px;line-height:1.4;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.3)}' +
    '#ap-toast.on{display:flex}' +
    '#ap-toast a{color:#8ecbff;text-decoration:underline;white-space:nowrap}' +
    '#ap-toast button{background:none;border:0;color:#c3ccd5;font:inherit;' +
    'cursor:pointer;padding:0;white-space:nowrap}';

  var SHELL_JS = [
    '(function(){',
    'var D=JSON.parse(document.getElementById("ap-index").textContent);',
    'var doc=document.getElementById("ap-doc");',
    'var nav=document.getElementById("ap-nav");',
    'var foot=document.getElementById("ap-foot");',
    'var crumb=document.getElementById("ap-crumb");',
    'var miss=document.getElementById("ap-miss");',
    'var search=document.getElementById("ap-search");',
    // Anchors are page paths, not ordinals. An ordinal shifts whenever the set
    // of exported pages changes, so a bookmark into last month's file would
    // land somewhere else in this month's.
    'var byPath={};D.pages.forEach(function(p,i){byPath[p.p]=i;});',
    // Position in the toctree, for the footer buttons. Built from D.order,
    // which buildNav produced from the same tree it rendered the sidebar from.
    'var orderAt={};(D.order||[]).forEach(function(p,n){',
    'if(orderAt[p]===undefined)orderAt[p]=n;});',
    'nav.innerHTML=D.nav;',
    'var links=[].slice.call(nav.querySelectorAll("a[href^=\\"#\\"]"));',
    'function current(){return (location.hash||"").replace(/^#/,"");}',
    // Accept the shorthand people actually type. #/rover should land on the
    // Rover wiki, not on a "page not found" - as should a trailing slash, a
    // leftover .html, or a missing leading slash.
    'function lookup(raw){',
    'if(!raw)return undefined;',
    'var cands=[],p=raw;',
    'if(p.charAt(0)!=="/")p="/"+p;',
    'p=p.replace(/\\.html?$/,"");',
    'cands.push(p);',
    'if(p.slice(-1)==="/")cands.push(p.slice(0,-1));',
    'var base=p.replace(/\\/$/,"");',
    'cands.push(base+"/index");',
    'cands.push(base+"/docs/index");',
    'for(var i=0;i<cands.length;i++){',
    'if(byPath[cands[i]]!==undefined)return cands[i];}',
    // Last resort: the first page under that prefix, so #/rover/docs works.
    'for(var j=0;j<D.pages.length;j++){',
    'if(D.pages[j].p.indexOf(base+"/")===0)return D.pages[j].p;}',
    'return undefined;}',

    /* ----------------------------------------- the sidebar, as the theme has it */
    // sphinx_rtd_theme drives the whole tree off one class. A branch is open
    // when its <li> carries "current"; theme.css hides every other <ul>. So
    // expanding, collapsing and highlighting are all the same operation, and
    // the styling arrives for free from the stylesheet already embedded here.
    'function ancestors(el){var out=[];',
    'while(el&&el!==nav){if(el.tagName==="LI")out.push(el);el=el.parentNode;}',
    'return out;}',
    'function clearCurrent(){',
    '[].forEach.call(nav.querySelectorAll(".current"),function(el){',
    'el.classList.remove("current");',
    'if(el.tagName==="LI")el.setAttribute("aria-expanded","false");});}',
    // What the theme does on every hashchange: open the path down to the page
    // being read and close everything else, so the sidebar always shows where
    // you are without showing all several thousand entries at once.
    'function setCurrent(path){',
    'clearCurrent();',
    'var hit=null;',
    'links.forEach(function(a){',
    'if(!hit&&a.getAttribute("href")==="#"+path)hit=a;});',
    'if(!hit)return;',
    'hit.classList.add("current");',
    'ancestors(hit).forEach(function(li){li.classList.add("current");',
    'li.setAttribute("aria-expanded","true");});',
    'if(hit.scrollIntoView)hit.scrollIntoView({block:"nearest"});}',
    // The theme's toggleCurrent. Siblings close when one opens, and so does
    // anything left open inside them, rather than the tree accumulating every
    // branch anybody has ever clicked.
    'function toggleBranch(btn){',
    'var li=btn.closest?btn.closest("li"):null;',
    'if(!li||!li.parentNode)return;',
    '[].forEach.call(li.parentNode.children,function(s){',
    'if(s===li)return;',
    's.classList.remove("current");s.setAttribute("aria-expanded","false");',
    '[].forEach.call(s.querySelectorAll("li.current"),function(x){',
    'x.classList.remove("current");x.setAttribute("aria-expanded","false");});});',
    'var kids=li.querySelectorAll("ul li");',
    'if(!kids.length)return;',
    '[].forEach.call(kids,function(x){x.classList.remove("current");',
    'x.setAttribute("aria-expanded","false");});',
    'var open=li.classList.toggle("current");',
    'li.setAttribute("aria-expanded",open?"true":"false");}',

    /* ------------------------------------------------ next / previous buttons */
    // Same markup and classes the theme emits, so the buttons are the theme's
    // buttons rather than a lookalike.
    'function clearFooter(){if(foot)foot.innerHTML="";}',
    // A page the reader did not download has no business being offered as
    // "next": it would land on "not in this offline copy". Step past it to the
    // next page that is actually here, and stop at the wiki boundary, which is
    // where the live wiki stops too.
    'function nearby(i,dir,w){',
    'for(var j=i+dir;j>=0&&j<D.order.length;j+=dir){',
    'var p=D.order[j];',
    'if(p.split("/")[1]!==w)return null;',
    'if(byPath[p]!==undefined)return p;}',
    'return null;}',
    'function navButton(p,dir){',
    'var t=byPath[p]!==undefined?D.pages[byPath[p]].t:p;',
    'if(dir<0)return \'<a href="#\'+p+\'" class="btn btn-neutral float-left" title="\'',
    '+esc(t)+\'" accesskey="p" rel="prev">\'',
    '+\'<span class="fa fa-arrow-circle-left" aria-hidden="true"></span> Previous</a>\';',
    'return \'<a href="#\'+p+\'" class="btn btn-neutral float-right" title="\'',
    '+esc(t)+\'" accesskey="n" rel="next">Next \'',
    '+\'<span class="fa fa-arrow-circle-right" aria-hidden="true"></span></a>\';}',
    'function showFooter(path){',
    'if(!foot)return;',
    'var i=orderAt[path];',
    'if(i===undefined){clearFooter();return;}',
    'var w=path.split("/")[1];',
    'var pv=nearby(i,-1,w),nx=nearby(i,1,w);',
    'foot.innerHTML=(pv||nx)?\'<div class="rst-footer-buttons" role="navigation"\'',
    '+\' aria-label="Footer">\'+(pv?navButton(pv,-1):"")+(nx?navButton(nx,1):"")',
    '+\'</div>\':"";}',

    /* ---------------------------------------- the parameter version switcher */
    // The wiki's own switcher cannot work inside a single file: its script
    // fetches ../_static/parameters-<Vehicle>.json over the network and then
    // navigates by URL, and offline there is neither. The <select> is the
    // theme's own element, sitting in the page where it always was, so fill it
    // from the versions this file actually holds and route through the hash.
    //
    // Only what is here is offered. A switcher listing every release the site
    // publishes would be a list of forty ways to reach "not in this offline
    // copy".
    'function fillVersions(path){',
    'var sel=doc.querySelector("#selectPicker");if(!sel)return;',
    'var box=sel.parentNode;',
    'var list=(D.params||{})[path.split("/")[1]]||[];',
    // The sentence beside it promises a choice. With nothing to choose, the
    // promise is the only thing left, so take that away too.
    'if(!list.length){if(box)box.style.display="none";return;}',
    'sel.innerHTML="";',
    'list.forEach(function(v){',
    'var o=document.createElement("option");',
    'o.value=v.p;o.textContent=v.n;',
    'if(v.p===path)o.selected=true;',
    'sel.appendChild(o);});',
    'sel.addEventListener("change",function(){go(sel.value);});}',

    // Landing page when the file holds more than one wiki. Picking one of them
    // to open on is a guess, and the reader is the only one who knows.
    'function showPicker(){',
    'miss.style.display="none";',
    'var rows=D.homes.map(function(h){',
    'return \'<li><a href="#\'+h.path+\'"><span>\'+(h.name||h.id)+\'</span>\'',
    '+\'<small>\'+h.pages+\' pages</small></a></li>\';}).join("");',
    'doc.innerHTML="<h1>Offline copy</h1><p>This file contains "+D.homes.length',
    '+" wikis. Choose one to start reading.</p><ul id=\\"ap-pick\\">"+rows+"</ul>";',
    'crumb.textContent="";',
    'document.title="ArduPilot (offline)";',
    'clearCurrent();clearFooter();',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;}',

    // A page rather than a banner that vanishes. Landing somewhere that says
    // what happened, and offers a way on, beats a message the reader may not
    // have been looking at when it appeared.
    'function showMissing(raw){',
    'miss.style.display="none";',
    'var held=D.homes.map(function(h){return h.name||h.id;}).join(", ");',
    'var live="https://ardupilot.org"+(raw==="/"?"":raw+".html");',
    'doc.innerHTML="<h1>Not in this offline copy</h1>"',
    '+"<p><code>"+raw+"</code> is not included in this download.</p>"',
    '+"<p>This file contains: "+held+".</p>"',
    '+"<p class=\\"ap-actions\\">"',
    // data-ap-external keeps the click handler off it. Without that the link
    // is an ardupilot.org URL like any other and gets routed straight back
    // here, which is a loop rather than a way out.
    '+"<a href=\\""+live+"\\" data-ap-external=\\"1\\">Open it on ardupilot.org</a>"',
    '+"<a href=\\"#\\" id=\\"ap-back\\">Go back</a>"',
    '+(D.homes.length>1?"<a href=\\"#/\\">Choose a wiki</a>":"")+"</p>"',
    '+"<p><small>Opening the live wiki needs a connection. '
      + 'With none it will simply fail to load, and this file is still here.'
      + '</small></p>";',
    'var b=document.getElementById("ap-back");',
    'if(b)b.addEventListener("click",function(ev){ev.preventDefault();history.back();});',
    'crumb.textContent="";',
    'document.title="Not in this offline copy - ArduPilot";',
    'clearFooter();',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;}',

    // A page is stored inside an inert <script> block, so any <script> of its
    // own had to be escaped on the way in or the block would have ended at the
    // first one. Undo that on the way out. Left escaped, the browser reads
    // <\/script> as ordinary text, which never closes the script element it
    // opened, and the whole rest of the page is swallowed into it. The
    // parameter list is the page this bites: the version switcher's script
    // sits a few lines below the heading, so everything under it disappeared.
    'function unblock(s){return s.split("<\\\\/script>").join("<\\/script>");}',

    'function show(raw){',
    'var path=lookup(raw);',
    'if(path===undefined){return showMissing(raw);}',
    'var i=byPath[path];',
    'miss.style.display="none";',
    'var el=document.getElementById("p"+i);if(!el)return;',
    'doc.innerHTML=unblock(el.textContent);',
    // Images are stored once and referenced by id; attach them only
    // for the page being shown, so nothing else decodes.
    '[].forEach.call(doc.querySelectorAll("[data-ap-img]"),function(im){',
    'var b=document.getElementById("i"+im.getAttribute("data-ap-img"));',
    'if(b)im.src=b.textContent;});',
    'fillVersions(path);',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;',
    // The page's own <h1> follows, so name the wiki rather than repeat it.
    'var wid=D.pages[i].p.split("/")[1]||"";',
    'var wh=null;D.homes.forEach(function(h){if(h.id===wid)wh=h;});',
    'crumb.textContent=wh?wh.name:wid.replace(/^./,function(c){return c.toUpperCase();});',
    'document.title=D.pages[i].t+" - ArduPilot (offline)";',
    'setCurrent(path);',
    'showFooter(path);}',
    'function route(){',
    'var raw=current();',
    'if(!raw||raw==="/"){',
    'return D.home?show(D.home):showPicker();}',
    'show(raw);}',
    'window.addEventListener("hashchange",route);',
    // Built once and reused. A browser will not navigate to a data: URL, so
    // linked images are shown here rather than opened.
    'function lightbox(uri){',
    'var lb=document.getElementById("ap-lightbox");',
    'if(!lb){lb=document.createElement("div");lb.id="ap-lightbox";',
    'lb.addEventListener("click",function(){lb.style.display="none";});',
    'document.body.appendChild(lb);}',
    'lb.innerHTML="";',
    'var im=document.createElement("img");im.src=uri;lb.appendChild(im);',
    'lb.style.display="flex";}',
    // An anchor parses the host for us, which beats a regular expression in a
    // file assembled from single-quoted literals: a backslash written here is
    // one the built page never sees.
    'function hostOf(u){var a=document.createElement("a");a.href=u;',
    'return a.hostname||u;}',
    // A link to another host is not in this file and never can be. Following
    // it silently costs the reader the whole document and, with no connection,
    // gives them a browser error in exchange. So say what is about to happen
    // and let them choose. This has to replace the navigation rather than
    // accompany it: a message shown on the way out is one nobody reads, and
    // the page carrying it is already gone.
    'var toastTimer=null;',
    'function toast(href){',
    'var t=document.getElementById("ap-toast");',
    'if(!t){t=document.createElement("div");t.id="ap-toast";',
    'document.body.appendChild(t);}',
    'clearTimeout(toastTimer);',
    't.innerHTML="";',
    'var msg=document.createElement("span");',
    'msg.textContent=hostOf(href)+" is not part of this offline copy. "',
    '+"Opening it leaves this file and needs a connection.";',
    'var go=document.createElement("a");',
    'go.href=href;go.target="_blank";go.rel="noopener";',
    'go.textContent="Open anyway";',
    // Opening in a new tab keeps the offline copy where it was, so choosing to
    // look does not mean losing the document.
    'go.addEventListener("click",function(){t.className="";});',
    'var hide=document.createElement("button");',
    'hide.type="button";hide.textContent="Dismiss";',
    'hide.addEventListener("click",function(){t.className="";});',
    't.appendChild(msg);t.appendChild(go);t.appendChild(hide);',
    't.className="on";',
    'toastTimer=setTimeout(function(){t.className="";},9000);}',
    // Links inside page content still point at the original files
    // (docs/x.html, ../index.html). Resolve them against the current page and
    // route internally; without this every cross-reference dead-ends.
    'function resolve(base,href){',
    'var parts=base.split("/");parts.pop();',
    'href.split("/").forEach(function(seg){',
    'if(seg===".."){parts.pop();}else if(seg!=="."&&seg!==""){parts.push(seg);}});',
    'return parts.join("/").replace(/\\.html?$/,"");}',
    // The About wiki links to every other wiki by absolute ardupilot.org URL,
    // as does cross-wiki body text, so offline those lead out of the document.
    // Map them back in when the target is here; leave the rest external.
    'function siteHref(href){',
    'var m=/^https?:\\/\\/(?:www\\.)?ardupilot\\.org(\\/.*)?$/i.exec(href);',
    'if(!m)return null;',
    'var rest=(m[1]||"").replace(/[?#].*$/,"");',
    'if(!rest||rest==="/")return "/";',
    'return rest.replace(/\\.html?$/,"");}',
    // Assigning an unchanged hash fires no hashchange, so a link back to the
    // page you are already on would do nothing without this.
    'function go(p){var h="#"+p;if(location.hash===h){route();}else{location.hash=h;}}',
    'function onLinkClick(e){',
    // The expand arrows live inside the anchor, exactly as the theme puts
    // them, so this has to run before the link handling or opening a branch
    // would navigate to it instead.
    'var xb=e.target.closest?e.target.closest("button.toctree-expand"):null;',
    'if(xb){e.preventDefault();e.stopPropagation();toggleBranch(xb);return;}',
    'var a=e.target.closest?e.target.closest("a[href]"):null;if(!a)return;',
    'var href=a.getAttribute("href");',
    'if(a.getAttribute("data-ap-external")!==null)return;',
    'if(!href||/^(mailto:|#)/.test(href))return;',
    'if(/^https?:/i.test(href)){',
    'var mapped=siteHref(href);',
    // Another host: the forum, the firmware server, cloud.ardupilot.org from
    // the sidebar. These are separate services rather than wiki content, so
    // there is no offline copy to route to and the link stays what it is. What
    // changes is that it no longer happens silently.
    'if(mapped===null){e.preventDefault();toast(a.href);return;}',
    // An ardupilot.org URL is wiki content, so it never leaves the file, for
    // the same reason a relative link does not: offline there is nothing at
    // the other end, and following it costs the reader the whole document.
    // Say the wiki is missing instead.
    'e.preventDefault();',
    'if(mapped==="/"){go("/");return;}',
    'var hit=lookup(mapped);',
    'go(hit!==undefined?hit:mapped);',
    'return;}',
    'var frag="";var h=href;var hi=h.indexOf("#");',
    'if(hi>=0){frag=h.slice(hi);h=h.slice(0,hi);}',
    'var target=resolve(current(),h);',
    // Never let a relative link leave the file. Outside it there is nothing to
    // resolve against, so following one lands on a broken URL and the reader
    // loses the document entirely - Sphinx links thumbnails to full-size
    // images, so this is easy to hit by accident.
    'e.preventDefault();',
    'var found=lookup(target);',
    'if(found!==undefined){go(target);',
    'if(frag){setTimeout(function(){var t=doc.querySelector(frag);',
    'if(t&&t.scrollIntoView)t.scrollIntoView();},50);}return;}',
    // Sphinx links every thumbnail to its full-size file, so these outnumber
    // the page links. Answer them from the index.
    'var iid=D.imgs?D.imgs[target]:undefined;',
    'if(iid!==undefined&&iid!==null){',
    'var blk=document.getElementById("i"+iid);',
    'if(blk){lightbox(blk.textContent);return;}}',
    // Scaled images link an original that no page displays, so it is not in
    // the file. The wrapped thumbnail is the same picture.
    'var inner=a.querySelector?a.querySelector("[data-ap-img]"):null;',
    'if(inner){',
    'var ib=document.getElementById("i"+inner.getAttribute("data-ap-img"));',
    'if(ib){lightbox(ib.textContent);return;}}',
    'showMissing(target);',
    '}',
    // The sidebar carries the absolute links, so it needs this too.
    'doc.addEventListener("click",onLinkClick);',
    'nav.addEventListener("click",onLinkClick);',
    'if(foot)foot.addEventListener("click",onLinkClick);',
    // Search every page, not the sidebar.
    //
    // This used to hide non-matching entries in the navigation tree, which
    // only ever covered what the toctree lists: about a hundred headings out
    // of several thousand pages. Anything reached from within a page could not
    // be found at all. Titles and paths for the whole file are already in the
    // index, so matching against those costs nothing and covers all of it.
    'function esc(s){return String(s).replace(/[&<>"]/g,function(c){',
    'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
    'function wikiName(p){var id=p.split("/")[1]||"";var out=id;',
    'D.homes.forEach(function(h){if(h.id===id)out=h.name||h.id;});return out;}',
    // Sphinx's index, parsed the first time somebody searches rather than on
    // load, so opening the file does not pay for it.
    'var SI=null;',
    'function searchIndex(){',
    'if(SI!==null)return SI;',
    'var el=document.getElementById("ap-fts");',
    'try{SI=el?JSON.parse(el.textContent):{};}catch(e){SI={};}',
    'return SI;}',
    // The index is stemmed, so the query has to be stemmed the same way or
    // "tuning" never matches the "tune" that is actually stored. This is
    // Sphinx's own stemmer, carried along with the index that it built.
    'var stemmer=(typeof Stemmer!=="undefined")?new Stemmer():null;',
    'function stem(w){return stemmer?stemmer.stemWord(w):w;}',
    // Sphinx leaves stopwords out of the index entirely, so requiring every
    // query word to match meant one "the" reduced the whole result set to
    // nothing. Anybody pasting a sentence got no results at all.
    'var STOP=(typeof stopwords!=="undefined")?stopwords:[];',
    // Edit distance with a budget, abandoning a row as soon as every cell in
    // it already exceeds what we will accept. Most candidates are rejected on
    // the length check without any work at all.
    'function within(a,b,max){',
    'if(Math.abs(a.length-b.length)>max)return false;',
    'var prev=[],i,j;for(j=0;j<=b.length;j++)prev[j]=j;',
    'for(i=1;i<=a.length;i++){',
    'var best=i,diag=prev[0];prev[0]=i;',
    'for(j=1;j<=b.length;j++){',
    'var cur=Math.min(prev[j]+1,prev[j-1]+1,diag+(a.charAt(i-1)===b.charAt(j-1)?0:1));',
    'diag=prev[j];prev[j]=cur;if(cur<best)best=cur;}',
    'if(best>max)return false;}',
    'return prev[b.length]<=max;}',
    'function fullText(ql){',
    'var idx=searchIndex();var out={};',
    'var words=ql.split(/[^a-z0-9_]+/).filter(function(w){',
    'return w.length>1&&STOP.indexOf(w)===-1;});',
    'if(!words.length)return out;',
    'var all=[],best=0;',
    'Object.keys(idx).forEach(function(w){',
    'var d=idx[w];var score={},cover={};',
    'words.forEach(function(word){',
    'var s=stem(word);var hit={};',
    'function mark(list,weight){',
    'if(list===undefined)return;',
    'if(typeof list==="number")list=[list];',
    'list.forEach(function(n){hit[n]=(hit[n]||0)+weight;});}',
    'mark(d.terms[s],1);mark(d.titleterms[s],5);',
    // A word still being typed should match by prefix, or results only appear
    // once the word is finished.
    'var keys=Object.keys(d.terms),k;',
    'if(word.length>=3){',
    'for(k=0;k<keys.length;k++){',
    'if(keys[k]!==s&&keys[k].indexOf(s)===0)mark(d.terms[keys[k]],0.5);}}',
    // Only when a word matched nothing at all is it worth treating as a typo.
    // A correctly spelled query never pays for this, and one edit is as far as
    // it goes: two starts matching words with no relation to what was typed.
    'if(word.length>=4&&!Object.keys(hit).length){',
    'for(k=0;k<keys.length;k++){',
    'if(within(s,keys[k],1))mark(d.terms[keys[k]],0.25);}}',
    // Count how many query words reached each document, alongside the score.
    'Object.keys(hit).forEach(function(n){',
    'score[n]=(score[n]||0)+hit[n];cover[n]=(cover[n]||0)+1;});});',
    'Object.keys(cover).forEach(function(n){',
    'if(cover[n]>best)best=cover[n];',
    'all.push({p:"/"+w+"/"+d.docnames[n],c:cover[n],s:score[n]});});});',
    // Requiring every word to match is fatal for a pasted sentence. A reader
    // dragging a selection clips the first and last words, so "industrial-
    // grade" arrives as "rial-grade": that matches other pages by one edit,
    // never the intended one, and intersecting emptied the whole result set.
    // Twenty-three further words all pointed at a single page - two of them,
    // "india" and "indigenous", appear on no other page in the wiki - and the
    // search still answered nothing found.
    //
    // Take the best-covered tier instead. When some page really does contain
    // every word this is exactly the old behaviour, because that page covers
    // all of them and nothing else can do better. When no page covers them
    // all, the closest pages surface rather than nothing.
    'all.forEach(function(r){',
    'if(r.c<best)return;',
    'out[r.p]=Math.max(out[r.p]||0,r.s);});',
    'return out;}',
    // One matcher, two views: the sidebar list and the full page both rank the
    // same way, so pressing Enter never reorders what was just on screen.
    'function matches(q){',
    'var ql=q.toLowerCase();var hits=[];var seen={};',
    'for(var i=0;i<D.pages.length;i++){',
    'var pg=D.pages[i];var at=pg.t.toLowerCase().indexOf(ql);',
    'var ap=at===-1?pg.p.toLowerCase().indexOf(ql):-1;',
    // Half-remembered page names are the common case for a title search, so a
    // single wrong letter should still find it. Titles are few and short, so
    // this costs nothing worth measuring.
    'if(at===-1&&ap===-1&&ql.length>=4){',
    'var tw=pg.t.toLowerCase().split(/[^a-z0-9]+/);',
    'for(var w=0;w<tw.length;w++){',
    'if(tw[w].length>=4&&within(ql,tw[w],1)){at=1;break;}}}',
    'if(at===-1&&ap===-1)continue;',
    // Title matches first, and a title that starts with the query above one
    // that merely contains it. Path-only matches last.
    'hits.push({pg:pg,i:i,rank:at===0?0:(at>0?1:2)});seen[pg.p]=1;}',
    // Then whatever the body text turns up, below the title matches.
    'var ft=fullText(ql);',
    'var byPathPage={},byPathIdx={};',
    'D.pages.forEach(function(p,n){byPathPage[p.p]=p;byPathIdx[p.p]=n;});',
    'Object.keys(ft).sort(function(a,b){return ft[b]-ft[a];}).forEach(function(p){',
    'if(seen[p]||!byPathPage[p])return;',
    'hits.push({pg:byPathPage[p],i:byPathIdx[p],rank:3});});',
    'hits.sort(function(a,b){return a.rank-b.rank||(a.pg.t<b.pg.t?-1:1);});',
    'return hits;}',

    'function renderSearch(q){',
    'var hits=matches(q);',
    'var words=q.toLowerCase().split(/[^a-z0-9_]+/).filter(function(w){',
    'return w.length>1&&STOP.indexOf(w)===-1;});',
    'var shown=hits.slice(0,60);',
    'var rows=shown.map(function(h){',
    'return \'<li><a href="#\'+h.pg.p+\'"><span>\'+esc(h.pg.t)+\'</span>\'',
    '+\'<small>\'+esc(wikiName(h.pg.p))+\'</small></a>\'',
    '+\'<p class="ap-snip">\'+snippet(h.i,words)+\'</p></li>\';}).join("");',
    'doc.innerHTML="<h1>Search</h1><p>"+hits.length+" page"',
    '+(hits.length===1?"":"s")+" matching <strong>"+esc(q)+"</strong>"',
    '+(hits.length>shown.length?", showing the first "+shown.length:"")+"</p>"',
    '+(hits.length?"<ul id=\\"ap-pick\\" class=\\"ap-results\\">"+rows+"</ul>":"");',
    'crumb.textContent="";',
    'clearFooter();',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;}',
    // A few hundred characters of the page around the first match, so a result
    // can be judged without opening it. Pulled from the inert page block and
    // stripped of markup; only done for the handful of results on screen.
    'function snippet(i,words){',
    'var el=document.getElementById("p"+i);if(!el)return "";',
    'var text=el.textContent.replace(/<[^>]*>/g," ").replace(/\\s+/g," ");',
    'var low=text.toLowerCase(),at=-1,hit="";',
    'for(var w=0;w<words.length;w++){',
    'var p=low.indexOf(words[w]);',
    'if(p!==-1&&(at===-1||p<at)){at=p;hit=words[w];}}',
    'if(at===-1)return text.slice(0,160)+"\u2026";',
    'var from=Math.max(0,at-70),to=Math.min(text.length,at+hit.length+130);',
    'return (from?"\u2026":"")+esc(text.slice(from,at))+"<mark>"',
    '+esc(text.slice(at,at+hit.length))+"</mark>"+esc(text.slice(at+hit.length,to))',
    '+(to<text.length?"\u2026":"");}',

    // Typing filters the sidebar and leaves the document alone: someone
    // searching has not asked to leave the page they are reading. Enter is
    // what commits to the full result list.
    'var navHtml=null;',
    'function restoreNav(){if(navHtml!==null){nav.innerHTML=navHtml;navHtml=null;',
    'links=[].slice.call(nav.querySelectorAll(\'a[href^="#"]\'));',
    // The restored tree is a fresh set of elements, so the branch that was
    // open before the search has to be opened again or the sidebar comes back
    // fully collapsed with nothing marked.
    'setCurrent(current());}}',
    'function sidebarResults(q,hits){',
    'if(navHtml===null)navHtml=nav.innerHTML;',
    'var rows=hits.slice(0,40).map(function(h){',
    'return \'<li class="toctree-l1"><a href="#\'+h.pg.p+\'">\'+esc(h.pg.t)+\'</a></li>\';',
    '}).join("");',
    'nav.innerHTML=\'<p class="caption">\'+hits.length+\' result\'+(hits.length===1?"":"s")',
    '+\'</p><ul>\'+(rows||\'<li class="toctree-l1"><a href="#">nothing found</a></li>\')+\'</ul>\';}',

    'var searchTimer=null,beforeSearch=null;',
    'search.addEventListener("input",function(){',
    'clearTimeout(searchTimer);',
    'searchTimer=setTimeout(function(){',
    'var q=search.value.trim();',
    'if(q.length<2){restoreNav();',
    'if(beforeSearch!==null){var b=beforeSearch;beforeSearch=null;go(b);}return;}',
    'sidebarResults(q,matches(q));},120);});',
    // Enter opens the full list, with context, without having disturbed
    // anything up to that point.
    'search.addEventListener("keydown",function(e){',
    'if(e.key!=="Enter")return;e.preventDefault();',
    'var q=search.value.trim();if(q.length<2)return;',
    'if(beforeSearch===null)beforeSearch=current()||"/";',
    'renderSearch(q);});',
    'window.addEventListener("hashchange",function(){beforeSearch=null;restoreNav();});',
    'document.addEventListener("keydown",function(e){',
    'if(e.key==="Escape"){var lb=document.getElementById("ap-lightbox");',
    'if(lb)lb.style.display="none";',
    'if(document.activeElement===search&&search.value){',
    'search.value="";search.dispatchEvent(new Event("input"));}}',
    'if(e.key==="/"&&document.activeElement!==search){e.preventDefault();search.focus();}});',
    'route();})();'
  ].join('');

  /* ------------------------------------------------------------ path rules */

  /**
   * Resolve a relative href against a page path, as a browser would.
   *
   * Kept here because the sidebar needs it for every href in every toctree it
   * reads, and the exporter needs the identical rule for image and stylesheet
   * references. Two copies is how the two would come to disagree.
   */
  function resolvePath(basePath, href) {
    var parts = basePath.split('/');
    parts.pop();                       // drop the page's own filename
    href.split('/').forEach(function (seg) {
      if (seg === '..') { parts.pop(); }
      else if (seg && seg !== '.') { parts.push(seg); }
    });
    return parts.join('/');
  }

  /* -------------------------------------------------- reading the toctrees */

  /**
   * Inner HTML of an element, found by counting nested tags rather than
   * stopping at the first closing one.
   */
  function innerOf(html, openRe, tag) {
    var open = openRe.exec(html);
    if (!open) { return ''; }
    var from = open.index + open[0].length;
    var scan = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    scan.lastIndex = from;
    var depth = 1, m;
    while ((m = scan.exec(html)) !== null) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { return html.slice(from, m.index); }
    }
    return html.slice(from);
  }

  /** The balanced top-level <ul> blocks in a fragment, and nothing else. */
  function topLevelLists(inner) {
    var out = '', re = /<(\/?)ul\b[^>]*>/gi, depth = 0, start = -1, m;
    while ((m = re.exec(inner)) !== null) {
      if (!m[1]) {
        if (depth === 0) { start = m.index; }
        depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out += inner.slice(start, m.index + m[0].length);
          start = -1;
        }
      }
    }
    return out;
  }

  /** Visible text of a fragment: toctree labels may carry <code> and friends. */
  function textOf(fragment) {
    return fragment.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * What one sidebar href means as a path into the exported file.
   *
   * Returns null for anything that is not a page of its own - the headings
   * within the page being read, which the theme lists under the current entry
   * and which mean nothing once the tree is shared by every page.
   */
  function navHref(raw, pagePath) {
    if (!raw) { return null; }
    if (/^(https?:|mailto:)/i.test(raw)) { return { href: raw, external: true }; }
    // The theme writes the page you are on as href="#", so on this page that
    // is a name for this page.
    if (raw === '#') {
      return { href: pagePath.replace(/\.html?$/, ''), external: false };
    }
    if (raw.charAt(0) === '#') { return null; }
    var clean = raw.split('#')[0].split('?')[0];
    if (!clean) { return null; }
    // A leading slash means the href is already a path from the site root.
    // Archives arrive that way: rewrite_site_links turns the absolute
    // cross-wiki links in the About wiki's sidebar into /copter/index.html.
    // Resolving those against the reading page produced #/ardupilot//copter/
    // index, which resolves to nothing, so every cross-wiki sidebar entry
    // landed on "Not in this offline copy" even when that wiki was sitting in
    // the same file.
    var path = clean.charAt(0) === '/' ? clean : resolvePath(pagePath, clean);
    return { href: path.replace(/\.html?$/, ''), external: false };
  }

  /**
   * Parse a sidebar fragment into nested nodes.
   *
   * A tokeniser rather than a DOM: this runs once per page of the export, in
   * the page that is generating the download, and the markup is machine
   * written and utterly regular.
   */
  function parseToc(fragment, pagePath) {
    var root = { children: [] };
    var parents = [root];    // where the next <li> attaches
    var open = [];           // <li> elements not yet closed
    var re = /<ul\b[^>]*>|<\/ul\s*>|<li\b[^>]*>|<\/li\s*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    var m;
    while ((m = re.exec(fragment)) !== null) {
      var tok = m[0];
      if (/^<ul/i.test(tok)) {
        parents.push(open.length ? open[open.length - 1] : root);
      } else if (/^<\/ul/i.test(tok)) {
        if (parents.length > 1) { parents.pop(); }
        while (open.length && open[open.length - 1].depth >= parents.length) {
          open.pop();
        }
      } else if (/^<li/i.test(tok)) {
        // A missing </li> is legal HTML, so close by depth rather than trust
        // the closing tag to arrive.
        while (open.length && open[open.length - 1].depth >= parents.length) {
          open.pop();
        }
        var node = { href: null, external: false, label: '', children: [],
                     depth: parents.length };
        parents[parents.length - 1].children.push(node);
        open.push(node);
      } else if (/^<\/li/i.test(tok)) {
        open.pop();
      } else {
        var cur = open[open.length - 1];
        if (cur && cur.href === null) {
          var h = /href="([^"]*)"/i.exec(m[1] || '');
          var t = navHref(h ? h[1] : '', pagePath);
          cur.href = t ? t.href : '';
          cur.external = !!(t && t.external);
          cur.label = textOf(m[2] || '');
        }
      }
    }
    return prune(root.children);
  }

  /** Drop the entries that name no page of their own, subtree and all. */
  function prune(nodes) {
    var out = [];
    nodes.forEach(function (n) {
      if (!n.href) { return; }
      out.push({ href: n.href, external: n.external, label: n.label,
                 children: prune(n.children) });
    });
    return out;
  }

  /** The sidebar of one built page, as nodes. */
  function navNodes(html, pagePath) {
    var inner = innerOf(
      html, /<div class="wy-menu wy-menu-vertical"[^>]*>/i, 'div');
    // Only the toctree lists: the same div carries a donation form whose links
    // are live and useless offline.
    var lists = topLevelLists(inner);
    return lists ? parseToc(lists, pagePath) : [];
  }

  /* ------------------------------------------------- merging the toctrees */

  /**
   * Fold one page's sidebar into the tree accumulated so far.
   *
   * sphinx_rtd_theme is built with collapse_navigation on, so no single page
   * carries the whole tree: each one expands the branch it sits in and leaves
   * the rest as a flat list of top-level entries. That is why the export used
   * to show a flat list - it read the wiki's index page, and the index page is
   * the one page that expands nothing.
   *
   * Every page does list all of its siblings, and all of its ancestors'
   * siblings, in order. So the union over every page in the export is the
   * complete tree, and each level's order is the same in every page that shows
   * it, which is what makes appending safe.
   */
  function mergeToc(into, incoming) {
    incoming.forEach(function (n) {
      var found = null;
      for (var i = 0; i < into.length; i++) {
        if (into[i].href === n.href) { found = into[i]; break; }
      }
      if (!found) {
        found = { href: n.href, external: n.external, label: n.label,
                  children: [] };
        into.push(found);
      } else if (!found.label && n.label) {
        found.label = n.label;
      }
      if (n.children.length) { mergeToc(found.children, n.children); }
    });
  }

  /** Somewhere to accumulate one merged toctree per wiki. */
  function newNav() { return { trees: {} }; }

  /** Take whatever this page's sidebar knows that the tree does not. */
  function addNav(state, html, pagePath) {
    var wiki = pagePath.split('/')[1];
    if (!wiki) { return; }
    var nodes = navNodes(html, pagePath);
    if (!nodes.length) { return; }
    if (!state.trees[wiki]) { state.trees[wiki] = []; }
    mergeToc(state.trees[wiki], nodes);
  }

  /* ------------------------------------------------ rendering the sidebar */

  /**
   * Fallback navigation: a flat list of the wiki's pages.
   *
   * Used when no toctree could be recovered at all. A plain list is poor
   * compared with the real structure, but an empty sidebar makes the file
   * unusable, and that is what happened before.
   */
  function listNav(pages, wiki) {
    var items = pages.filter(function (p) {
      return p.path.split('/')[1] === wiki;
    }).map(function (p) {
      var anchor = p.path.replace(/\.html?$/, '');
      var label = anchor.split('/').pop().replace(/[-_]/g, ' ');
      return '<li class="toctree-l1"><a class="reference internal" href="#' +
             anchor + '">' + label + '</a></li>';
    });
    return '<ul>' + items.join('') + '</ul>';
  }

  /** Flat page list for a wiki, in the same order listNav renders it. */
  function listOrder(pages, wiki) {
    return pages.filter(function (p) {
      return p.path.split('/')[1] === wiki;
    }).map(function (p) { return p.path.replace(/\.html?$/, ''); });
  }

  /**
   * The theme's own markup, down to the expand button.
   *
   * theme.js prepends that button to any sidebar link with a list beside it;
   * doing it here rather than in the shell means the buttons survive the
   * sidebar being replaced by search results and put back again.
   */
  function renderNodes(nodes, level) {
    var out = '<ul>';
    nodes.forEach(function (n) {
      var kids = n.children.length ? renderNodes(n.children, level + 1) : '';
      out += '<li class="toctree-l' + level + '">' +
             '<a class="reference ' + (n.external ? 'external' : 'internal') +
             '" href="' + (n.external ? n.href : '#' + n.href) + '">' +
             (kids ? '<button class="toctree-expand" ' +
                     'title="Open/close menu"></button>' : '') +
             n.label + '</a>' + kids + '</li>';
    });
    return out + '</ul>';
  }

  /**
   * The sidebar and the reading order, from one tree.
   *
   * These have to be produced together. Built separately - the sidebar from
   * the toctree, the order from the page list - they disagree the moment a
   * page appears in one and not the other, and "next" starts skipping pages
   * the sidebar is showing.
   */
  function buildNav(state, wikis, pages) {
    var html = '', order = [], seen = {};

    wikis.forEach(function (wiki) {
      var tree = state.trees[wiki];
      html += '<p class="caption">' + wiki + '</p>';
      if (!tree || !tree.length) {
        html += listNav(pages, wiki);
        listOrder(pages, wiki).forEach(function (p) {
          if (!seen[p]) { seen[p] = 1; order.push(p); }
        });
        return;
      }
      html += renderNodes(tree, 1);
      (function walk(nodes) {
        nodes.forEach(function (n) {
          // Cross-wiki entries belong to the reading order of the wiki they
          // are in, not to this one, or the About wiki's sidebar would splice
          // Copter's front page into the middle of it. A page listed twice in
          // one toctree - and several are - is read at its first position, as
          // Sphinx reads it.
          if (!n.external && n.href.charAt(0) === '/' &&
              n.href.split('/')[1] === wiki && !seen[n.href]) {
            seen[n.href] = 1;
            order.push(n.href);
          }
          walk(n.children);
        });
      })(tree);
    });

    return { html: html, order: order };
  }

  /* -------------------------------------- versioned parameter pages */

  /*
   * How much parameter-list history the export carries. --paramversioning
   * publishes ~40 pages per vehicle back to 3.x (one is 5.8 MB), several hundred
   * MB nobody reads offline, so carry the newest few. Two numbers because
   * "release" is ambiguous: SERIES counts major.minor lines, PER_SERIES releases
   * within each. 3 x 1 is three pages per vehicle; raise PER_SERIES for a whole line.
   */
  var PARAM_SERIES = 3;
  var PARAM_PER_SERIES = 1;

  // /rover/docs/parameters-Rover-stable-V4.7.0. The plain /rover/docs/
  // parameters is the latest, carries no version of its own, and is always
  // kept - which is also how the site behaves: it is not in the switcher.
  var PARAM_PAGE = /^\/([^/]+)\/docs\/parameters-([^/]+)$/;

  /**
   * Which versioned parameter pages the file carries. Labels are rebuilt from
   * filenames, not the wiki's parameters-<Vehicle>.json (not in the export),
   * which also keeps the list honest - it can only name pages that are here.
   */
  function parameterVersions(paths) {
    var found = {}, byWiki = {}, drop = {};

    paths.forEach(function (p) {
      var m = PARAM_PAGE.exec(p);
      if (!m) { return; }
      var v = /V(\d+)\.(\d+)\.(\d+)/.exec(m[2]);
      if (!v) { return; }
      if (!found[m[1]]) { found[m[1]] = []; }
      found[m[1]].push({
        p: p,
        // "parameters-Rover-stable-V4.7.0" -> "Rover stable V4.7.0", which is
        // exactly what the site's own switcher shows.
        n: m[2].split('-').join(' '),
        s: v[1] + '.' + v[2],
        v: [+v[1], +v[2], +v[3]]
      });
    });

    Object.keys(found).forEach(function (w) {
      var list = found[w].sort(function (a, b) {
        return b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2];
      });
      var series = [], perSeries = {}, kept = [];
      list.forEach(function (e) {
        if (series.indexOf(e.s) === -1) {
          if (series.length >= PARAM_SERIES) { drop[e.p] = 1; return; }
          series.push(e.s);
          perSeries[e.s] = 0;
        }
        if (perSeries[e.s] >= PARAM_PER_SERIES) { drop[e.p] = 1; return; }
        perSeries[e.s]++;
        kept.push({ n: e.n, p: e.p });
      });
      if (kept.length) { byWiki[w] = kept; }
    });

    return { byWiki: byWiki, drop: drop };
  }

  /* -------------------------------------------------------- the front page */

  // Listing order for the picker, most recognisable first. Anything else
  // follows alphabetically.
  var HOME_ORDER = ['ardupilot', 'copter', 'plane', 'rover'];

  // Directory names are not product names. Kept in step with DISPLAY_NAMES in
  // scripts/build_offline_artifacts.py.
  var DISPLAY_NAMES = {
    ardupilot: 'About ArduPilot', copter: 'Copter', plane: 'Plane',
    rover: 'Rover', sub: 'Sub', blimp: 'Blimp', dev: 'Developer',
    antennatracker: 'Antenna Tracker', planner: 'Mission Planner',
    planner2: 'APM Planner 2', mavproxy: 'MAVProxy'
  };

  /** Front page and page count for each wiki in the export, in listing order. */
  function wikiHomes(index, wikis) {
    var homes = wikis.map(function (w) {
      var prefix = '/' + w + '/';
      var root = null, first = null, count = 0;
      index.forEach(function (p) {
        if (p.p.indexOf(prefix) !== 0) { return; }
        count++;
        if (!first) { first = p.p; }
        if (p.p === prefix + 'index') { root = p.p; }
      });
      return { id: w, name: DISPLAY_NAMES[w] || w, path: root || first,
               pages: count };
    }).filter(function (h) { return h.path; });

    return homes.sort(function (a, b) {
      var ai = HOME_ORDER.indexOf(a.id), bi = HOME_ORDER.indexOf(b.id);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return a.id < b.id ? -1 : 1;
    });
  }

  /* ------------------------------------------------------ the file, in parts */

  /*
   * The shell: a single-page app, not a concatenation.
   *
   * Pages are written as inert <script type="text/plain"> blocks. The browser
   * parses them as text but never renders them or decodes the data URIs inside,
   * so opening the file costs one parse rather than laying out hundreds of
   * pages and decoding several hundred megabytes of images at once. A page is
   * materialised only when you navigate to it.
   */
  function head(wikis, themeCss) {
    return '<!DOCTYPE html><html lang="en" class="writer-html5"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>ArduPilot wiki (offline)</title>' +
      '<style>' + themeCss + '</style><style>' + SHELL_CSS + '</style>' +
      '</head><body class="wy-body-for-nav">' +
      '<div class="wy-grid-for-nav">' +
      '<nav data-toggle="wy-nav-shift" class="wy-nav-side">' +
      '<div id="ap-brand">ArduPilot<small>offline copy &middot; ' +
      wikis.join(', ') + '</small></div>' +
      '<input id="ap-search" placeholder="Search all pages  ( / )" autocomplete="off">' +
      '<div class="wy-menu wy-menu-vertical" id="ap-nav"></div></nav>' +
      '<section data-toggle="wy-nav-shift" class="wy-nav-content-wrap">' +
      '<div class="wy-nav-content"><div class="rst-content">' +
      '<div id="ap-bar">Offline copy built from pages saved on your device. ' +
      'It does not update itself.</div>' +
      '<div id="ap-miss"></div><div id="ap-crumb"></div>' +
      '<div itemprop="articleBody" id="ap-doc"></div>' +
      // Where the theme puts its next/previous buttons: after the article,
      // still inside the content column.
      '<footer id="ap-foot"></footer>' +
      '</div></div></section></div>';
  }

  /** One page, plus any image it is the first to use. */
  function pageBlock(i, html, fresh) {
    var body = html.split('</script>').join('<\\/script>');
    var blocks = fresh.map(function (f) {
      return '<script type="text/plain" id="i' + f.id + '">' +
             f.uri + '<\/script>';
    }).join('');
    return blocks + '<script type="text/plain" id="p' + i + '">' +
           body + '<\/script>';
  }

  /*
   * Full-text search, written as its own inert block rather than folded into
   * the routing payload. That one is parsed on load; a few megabytes of index
   * is not, and is only read the first time somebody searches.
   */
  function searchBlock(byWiki, stemmerSrc) {
    return '<script type="application/json" id="ap-fts">' +
      JSON.stringify(byWiki).split('</').join('<\\/') +
      '<\/script>' +
      (stemmerSrc
        ? '<script>' + stemmerSrc.split('<\/script>').join('<\\/script>') +
          '<\/script>'
        : '');
  }

  /** The routing payload and the shell that reads it. */
  function tail(payload) {
    return '<script type="application/json" id="ap-index">' +
      JSON.stringify(payload).split('</').join('<\\/') +
      '<\/script><script>' + SHELL_JS + '<\/script></body></html>';
  }

  global.ArduPilotOfflineDocument = {
    head: head,
    pageBlock: pageBlock,
    searchBlock: searchBlock,
    tail: tail,
    newNav: newNav,
    addNav: addNav,
    buildNav: buildNav,
    navNodes: navNodes,
    parameterVersions: parameterVersions,
    wikiHomes: wikiHomes,
    resolvePath: resolvePath,
    SHELL_CSS: SHELL_CSS,
    SHELL_JS: SHELL_JS
  };
})(window);
