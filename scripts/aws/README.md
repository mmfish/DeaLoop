# DeaLoop on AWS

The AWS deployment runs a Next.js standalone Node server behind Caddy. The frontend remains in `app/`, API/domain rules in `backend/`, and repository/schema in `db/`. `runtime/sqlite.ts` implements the prepared-query and atomic-batch contract on durable SQLite. The normal Sites build retains Cloudflare bindings.

## Build and deploy

Use Node 24 LTS. Run `npm ci`, `npm test`, and `npm run build:aws` on the build machine. Run `node scripts/aws/package-release.mjs /absolute/path/release.tar.gz`. The runtime uses Node's SQLite module, so the database adapter has no compiled native add-on. Images use normal HTML image elements, not platform-specific image optimization.

Provision Ubuntu24.04 Lightsail `micro_3_0`, a static IPv4, and a private `small_1_0` Lightsail bucket in the same region. Attach bucket resource access to the instance; the S3 SDK obtains instance credentials, never administrator credentials. Keep bucket versioning disabled for bounded rotating backups. Open80/443; restrict22 to the deployment operator's public IP. Use `bootstrap.sh` for initial system setup. It creates the unprivileged service user, systemd units and daily backup timer.

`node scripts/aws/access.mjs INSTANCE PROFILE REGION` obtains short-lived provider-issued SSH material in `~/.config/dealoop-deploy/` and pins SSH host keys obtained through AWS. Use that identity with `StrictHostKeyChecking=yes`. Remove its private key and certificate after the deployment session. Do not copy an administrator AWS key onto the instance.

Transfer the release archive to `/home/ubuntu/release.tar.gz`. For the initial deployment only, transfer a validated database and install it at `/var/lib/dealoop/data/dealoop.sqlite`, owned by dealoop, mode0600. Never replace a live database during a code-only release. Install a root-owned0640 `/etc/dealoop.env`, group dealoop, with:

- `NODE_ENV=production`, `HOSTNAME=127.0.0.1`, `PORT=3000`
- `DEALOOP_RUNTIME=aws`, `DEALOOP_ORIGIN=https://dealoop.miracleraven.com`
- `DEALOOP_DB_PATH=/var/lib/dealoop/data/dealoop.sqlite`
- `DEALOOP_MIGRATIONS_PATH=/opt/dealoop/current/drizzle`
- `AWS_REGION=us-west-2`, `DEALOOP_BUCKET=<private bucket name>`
- `DEALOOP_ALLOWED_EMAILS=<comma-separated invited verified emails>`
- `DEALOOP_OWNER_BINDINGS=<operator-reviewed JSON mapping invited emails to imported owner IDs>` when migrating an owner without an existing Firebase identity. This is never supplied by a browser request.

Install the Caddyfile and run `install-release.sh` as root. It downloads a pinned Node24 binary with checksum verification and activates a dated release. For supply-chain pins: export `CADDY_KEY_FINGERPRINT` with the independently published Caddy repository fingerprint before running `bootstrap.sh` (it always prints the observed fingerprint and aborts on mismatch), and provision `/etc/dealoop/node-release-keys.gpg` with the Node.js release-team keys (fingerprints cross-checked out of band) to enable checksum-signature verification in `install-release.sh`. For subsequent releases, extract into a new release directory, atomically change `/opt/dealoop/current`, and `systemctl restart dealoop`. Keep the prior release for rollback. Schema migrations run transactionally and are recorded; a schema-incompatible rollback needs the corresponding pre-release database backup.

## Authentication and migration

Authorize the domain in Firebase Authentication; the existing Firebase auth handler remains the Google/Facebook redirect target. The AWS app rejects Sites identity headers. New owner admission requires a verified invited email. In Firebase separate-provider mode, Google profile claims are verified using a second signed Google ID token, with its audience and subject bound to the Firebase identity. Existing explicitly linked provider identities retain access through the operator-reviewed invited owner map; a new Facebook identity must be connected from an already authenticated invited account. Raw provider profile fields are never trusted. Public routes: marketplace browsing/search, post details and photos attached to published posts, login, About, agent guides, schema, capabilities and liveness. Unattached photo previews are owner-only. Posting, offers/conversations, owner activity and agent management require authenticated access. Caddy passes the original client IP for bounded pairing rate limits; CSRF and secure cookies use the configured external origin, not caller forwarding headers.

`import-data.mjs` reads a complete bounded Sites table export from hidden stdin and imports into an empty SQLite file. It checks columns, foreign keys and integrity. Existing sessions are omitted, copied agent grants are revoked, and only operator-approved owner identity mappings are preserved. Keep exports/databases in protected native state, never Git or shared task artifacts. Re-enroll Muse against the new exact origin with fresh owner-issued scoped keys. The previous Sites service remains independent; it is not synchronized with AWS.

## Operations and recovery

`systemctl status dealoop caddy`, `/healthz`, and `journalctl -u dealoop` cover application liveness. `systemctl start dealoop-backup` makes a consistent `VACUUM INTO` snapshot, checks SQLite integrity, uploads it to `backups/day-N.sqlite`, and verifies the uploaded bytes. Seven daily slots bound retained backup storage. Check `systemctl list-timers dealoop-backup.timer` and backup-service logs. This is a single-server deployment; daily backup recovery can lose changes since the last successful backup.

To restore: stop dealoop and the backup timer, download the selected private backup through an authorized S3 client, open it read-only and run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, preserve the current DB/WAL/SHM files, install the restored file with mode0600 and owner dealoop, then start the app and verify sign-in/post/deal counts before restarting the timer. Never copy a live SQLite main file while its WAL is active as a backup substitute.

Base resources are $7/month compute + $1/month storage, plus existing DNS charges, overages and tax. This is not a hard spend cap. No load balancer, NAT gateway or managed database is provisioned. Removing DNS alone does not stop resource billing; remove the instance/bucket/static-IP only after preserving needed data.

## Agent SSE

`/api/v1/events/stream` streams private negotiation metadata under `events:read`.
The same MCP-resource OAuth token is valid only at the explicit stream/metadata
companions; general REST resource rules are unchanged. See
[`examples/sse/README.md`](../../examples/sse/README.md) for the client contract.
The existing durable negotiation event table and owner/sequence index are reused;
there is no migration or additional paid service for this change.

Next compression is disabled for the AWS build because Caddy compresses ordinary
responses. When deploying this version, install the updated `scripts/aws/Caddyfile`
(compression excludes the SSE path), run `caddy validate --config ...`, then reload
Caddy. Caddy recognizes `text/event-stream` and flushes it immediately; do not add
response buffering or a proxy timeout shorter than the heartbeat interval. A code
release alone does not install the Caddyfile. Verify actual external chunk arrival
and disconnect/reconnect through the proxy before claiming production push works.

Connections have a five-minute lifetime,15-second heartbeat,5-second server-side
catch-up/auth check, bounded queues and per-instance limits. SQLite batch commit
callbacks wake local listeners; other processes or DB handles are covered by the
server-side tail check. No agent polling/LLM calls are involved in this check.
A restart disconnects streams; clients replay from durable IDs. Delivery remains
at-least-once, not an agent-processing acknowledgement. There is no independent
subscription registry: an authorized HTTP stream is the subscription. Multi-server
scale-out needs shared admission limits/wake infrastructure and remains untested.
