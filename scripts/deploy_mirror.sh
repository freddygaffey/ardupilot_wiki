#!/bin/bash
#
# Push a locally built wiki to a mirror.
#
#   scripts/deploy_mirror.sh root@203.0.113.10
#
# Build first, in place, with the archives:
#
#   ARDUPILOT_OFFLINE_BASE=https://your.host/offline \
#     python3 update.py --fast --cached-parameter-files
#
# WHY THIS EXISTS RATHER THAN --destdir
#
# update.py --destdir is how production deploys: the build server writes
# straight into the web root. That is the right thing on a machine that builds.
# It is wrong here for two reasons. It MOVES <wiki>/build/html rather than
# copying, so it destroys the local build output and leaves the tests with
# nothing to run against. And a mirror may not be the machine that builds:
# Sphinx across eleven wikis wants several GB of RAM, which a small droplet
# does not have.
#
# So: build locally, ship the result. The tree that lands is identical to what
# --destdir would have written.
#
# TODO(mirror): unnecessary once the mirror builds from cron like production.

set -euo pipefail

# --frontend-only skips the wikis and the archives and ships just the web root:
# sw.js, js/pwa.js, the manifest, the icons, the offline fallback.
#
# WHY IT EXISTS
#
# Those files are copied verbatim by this script. Sphinx does not touch them,
# no build step transforms them, and nothing in <wiki>/build/html depends on
# them. Yet the loop for a one-line change to the service worker was: full
# build (3.3 minutes), rsync eleven wikis and 700 MB of archives, verify. That
# is minutes of waiting for a 40 KB file that was already sitting on disk,
# and it is most of what made iterating on the worker feel slow.
#
# Use the full deploy when wiki CONTENT or the archives changed. Use this when
# only frontend/ changed, which for this feature is most of the time.
FRONTEND_ONLY=""
ARGS=()
for a in "$@"; do
    case "$a" in
        --frontend-only) FRONTEND_ONLY=1 ;;
        *) ARGS+=("$a") ;;
    esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
    echo "usage: $0 user@host [webroot] [--frontend-only]" >&2
    exit 1
fi
WEBROOT="${2:-/var/sites/wiki/web}"

WIKIS="copter plane rover sub blimp dev antennatracker planner planner2 ardupilot mavproxy"

if [ -z "$FRONTEND_ONLY" ]; then
    for w in $WIKIS; do
        if [ ! -d "$w/build/html" ]; then
            echo "missing $w/build/html - build before deploying" >&2
            exit 1
        fi
    done
    if [ ! -f offline/offline-manifest.json ]; then
        echo "no offline/offline-manifest.json - run a full build first" >&2
        exit 1
    fi
fi

echo "deploying to $TARGET:$WEBROOT${FRONTEND_ONLY:+  (frontend only)}"

if [ -n "$FRONTEND_ONLY" ]; then
    printf '  %-16s' 'frontend (root)'
    rsync -az frontend/ "$TARGET:$WEBROOT/"
    echo ok
    echo
    echo "verifying, on the server:"
    ssh "$TARGET" "
        echo -n '  worker at root:  '; [ -f $WEBROOT/sw.js ] && echo yes || echo 'NO - scope will not cover the wikis'
        echo -n '  worker version:  '; grep -o \"CACHE_VERSION = '[^']*'\" $WEBROOT/sw.js || echo unknown
    "
    exit 0
fi

for w in $WIKIS; do
    printf '  %-16s' "$w"
    rsync -az --delete "$w/build/html/" "$TARGET:$WEBROOT/$w/"
    echo ok
done

# The offline directory, in two passes so the manifest lands LAST.
#
# rsync transfers in sorted order, which puts offline-manifest.json ahead of
# five of the archives (plane, planner, planner2, rover, sub) and every
# <wiki>-files.json ahead of its own <wiki>-offline.tar.gz. A reader who
# checks for updates in that window reads a manifest, or a hash table, that
# points at archives not yet replaced, and fetches content from the wrong
# build. The hash verification added to the client catches the bad bytes, but
# it is better not to publish the mismatch at all.
#
# So: everything EXCEPT the manifest first, then the manifest by itself as the
# final step. The manifest is the one file a client uses to decide anything is
# new, so nothing else should ever be newer than it. --delete on the first pass
# still removes retired archives; the second pass carries only the manifest.
printf '  %-16s' 'offline (files)'
rsync -az --delete --exclude='offline-manifest.json' \
    offline/ "$TARGET:$WEBROOT/offline/"
echo ok

printf '  %-16s' 'offline (manifest)'
rsync -az offline/offline-manifest.json "$TARGET:$WEBROOT/offline/"
echo ok

# The frontend goes to the ROOT, not to a frontend/ subdirectory.
#
# This is not cosmetic. A service worker's scope is its own directory, so a
# worker served from /frontend/sw.js registers cleanly, reports no error, and
# controls no wiki page at all. Verified against production: ardupilot.org/
# serves the frontend's own index and /frontend/ is a 404.
#
# No --delete here, or it would erase the wiki directories just uploaded.
printf '  %-16s' 'frontend (root)'
rsync -az frontend/ "$TARGET:$WEBROOT/"
# The mirror is a review demo: keep every crawler out, or bots pull the
# 700 MB archive set on repeat and drain the droplet's bandwidth. Written
# after the frontend rsync, which ships the site's allow-all robots.txt.
printf 'User-agent: *\nDisallow: /\n' | ssh "$TARGET" "cat > '$WEBROOT/robots.txt'"
echo ok

echo
echo "verifying, on the server:"
ssh "$TARGET" "
    echo -n '  wikis present:   '; ls $WEBROOT | grep -cE '^(copter|plane|rover|sub|blimp|dev|antennatracker|planner|planner2|ardupilot|mavproxy)\$'
    echo -n '  archives:        '; ls $WEBROOT/offline/*.tar.gz 2>/dev/null | wc -l
    echo -n '  worker at root:  '; [ -f $WEBROOT/sw.js ] && echo yes || echo 'NO - scope will not cover the wikis'
    echo -n '  frontend index:  '; [ -f $WEBROOT/index.html ] && echo yes || echo NO
"
