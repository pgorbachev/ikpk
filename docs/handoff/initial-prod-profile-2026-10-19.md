# Initial production profile setup

This is preparation for the single approved operation `initial-prod-20261019-A-01`. Run it only from the reviewed source revision after the exact `main` commit has passed canonical Tests and the code reviews. These commands do not start or enable `ikpk-cms.service`, alter its unit, change the database, or restart payments.

The fixed host policy is `scripts/initial-prod-rehearsal.json`. The installer writes it as root-owned `/etc/ikpk/rehearsal-initial-prod.json`, creates the missing passwd HOME `/home/ikpk-cms` with owner `ikpk-cms` and mode `0700`, and creates the private journal/backup directories using the existing staging installer checks. The production unit's runtime `HOME=/var/lib/ikpk-cms/trial/data` remains unchanged. The installer validates the configured current pointers and paths:

```sh
sudo bash scripts/install-rehearsal-host.sh --prefix /usr/local --initial-prod-config
```

The currently active TLS and IP vhosts both proxy CMS paths through `/etc/nginx/snippets/ikpk-cms-trial.conf`. `/etc/nginx/sites-enabled/ikpk-tls.conf` and `/etc/nginx/sites-enabled/ikpk.conf` are absolute symlinks to `/etc/nginx/sites-available/ikpk-tls.conf` and `/etc/nginx/sites-available/ikpk.conf`; the preparation script verifies those exact links and regular, non-symlink targets. It edits and backs up only the two fixed `sites-available` files, and leaves both enabled links untouched. Both vhosts need the server gate include; the payments include and all existing route directives stay byte-for-byte intact. The map starts open (`default 0`, no writer matches). The host helper switches its map to blocked only after the durable operation start and maintenance flag.

Before adding the includes, the fixed preparation script makes a private exact copy and records hashes of both actual vhost targets. It refuses to continue if the backup directory or either gate file already exists. It then creates the initially-open map and server snippet, inserts one include immediately after the unique existing CMS snippet include in each CMS-proxy vhost, atomically replaces each vhost, runs `nginx -t`, reloads nginx, and verifies the effective config:

```sh
sudo bash scripts/prepare-initial-prod-nginx-gate.sh
```

On any insertion, syntax-test, or reload failure the script restores both vhosts from the private copies and removes the two newly created gate files before returning. Retain the pre-change copies and hash output with the operation evidence. A missing or repeated CMS include, an existing gate include, or any unexpected file/hash change is a hard refusal.

The operator must verify the effective `nginx -T` output contains the map and server snippet paths and the variable in both CMS-proxy vhosts. The CMS writer routes are probed through `https://ikpk.su`; payments are checked with a read-only status GET. After the production routes, media, browser checks, and served release are accepted and the operation has a durable `committed` record, enable the intended CMS service at boot with `sudo systemctl enable ikpk-cms.service`; do not restart or change the payment service. The production profile never invokes database recovery, and a pre-commit fault keeps the writer gate closed until the same admitted operation is safely completed or the owner separately approves database restore.
