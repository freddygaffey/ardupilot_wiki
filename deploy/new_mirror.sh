#!/bin/bash
#
# Turn a fresh Ubuntu 24.04 droplet into the mirror. Run ON the new box as
# root, once. Then from the laptop:
#
#   scripts/deploy_mirror.sh root@NEW_IP          # ship the built wikis
#   rsync -az wiki:/etc/letsencrypt/ root@NEW_IP:/etc/letsencrypt/   # reuse the cert
#   ssh root@NEW_IP 'certbot install --nginx -d offline-wiki.pebnum.com && nginx -t && systemctl reload nginx'
#
# then point the DNS record at NEW_IP and destroy the old droplet.
#
# WHY A NEW BOX RATHER THAN A RESIZE
#
# DigitalOcean can grow a droplet's disk but never shrink it, so the 160 GB
# 4 vCPU / 8 GB box cannot be resized down. What it actually does is serve
# 3.5 GB of static files with nginx at load 0.0 and 600 MB used, which fits
# the smallest sensible size (1 vCPU / 1 GB / 25 GB, $6 a month) with room
# to spare. The one thing the old size bought, RAM to build Sphinx on the
# server, was never used: the mirror is built locally and rsynced.

set -euo pipefail

WEBROOT=/var/sites/wiki/web
FQDN=offline-wiki.pebnum.com

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx rsync

mkdir -p "$WEBROOT"
chown -R www-data:www-data /var/sites/wiki

# The repo's config, verbatim. certbot appends the TLS server blocks to it.
install -m 644 "$(dirname "$0")/nginx-wiki.conf" /etc/nginx/sites-available/wiki
ln -sf /etc/nginx/sites-available/wiki /etc/nginx/sites-enabled/wiki
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# Ubuntu's stock journal grows to 4 GB; 431 MB of it was on the old box.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

echo "ready: deploy from the laptop, then TLS for $FQDN (see the header of this script)"
