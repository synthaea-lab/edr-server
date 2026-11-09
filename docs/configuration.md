# Configuration

The server is configured only through environment variables. There is no configuration file;
[`.env.example`](../.env.example) lists the core variables for a run outside Docker, and
[`docker-compose.yml`](../docker-compose.yml) sets them for the development stack. Variables are
read when they are used, not validated at start-up: a missing secret shows as a refused request
(`500`, `503`), never as a silent default.

The development values below are public. Replace every secret before the stack leaves one
machine ([Deployment](deployment.md#before-the-stack-leaves-one-machine)); generate one with
`openssl rand -base64 32`.

## Core

| Variable | Required | Description | Development value |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string, read by Prisma. | `postgresql://synthaea:synthaea_dev@localhost:5432/synthaea` |
| `BETTER_AUTH_SECRET` | Yes | Signs and encrypts console sessions (read by better-auth). | `dev_secret_change_in_production` |
| `NGINX_PROXY_SECRET` | Yes | Shared secret nginx adds to every request as `X-Proxy-Secret`. Agent endpoints refuse a request without it, and refuse everything while it is unset. Set the same value on the application and the proxy. | `dev_nginx_secret_change_in_production` |
| `CRON_SECRET` | For scheduled jobs | Bearer token of the `/api/cron/*` routes. Unset, every job call is refused. | `dev_cron_secret` |
| `PLATFORM_OPERATOR_USER_IDS` | To create tenants | Comma-separated `auth_user.id` values allowed to call `POST /api/admin/tenants`. Unset, nobody can. | unset |
| `NEXTAUTH_URL` | No | Public base URL of the console. Used only as the fallback for `NOTIFY_CONSOLE_URL`. | `http://localhost:3000` |
| `NODE_ENV` | No | `development` logs every Prisma query; the production image sets `production`. | `development` |
| `PORT`, `HOSTNAME` | No | Where the Next.js server listens (default `3000` and, in the images, `0.0.0.0`). The middleware calls the session route on `127.0.0.1:$PORT`. | `3000`, `0.0.0.0` |
| `NEXT_MANUAL_SIG_HANDLE` | In production | `true` hands `SIGINT`/`SIGTERM` to the server's own handler, which writes pending decoy alarms (at most 5 seconds) before exiting. The production image sets it; the server logs a warning at start when it is missing. | set in the `runner` image |

`docker-compose.yml` also sets `NEXTAUTH_SECRET`, which nothing reads.

## Case narratives

Any OpenAI-compatible chat-completions endpoint ([`assistant/llm-client.ts`](../assistant/llm-client.ts)).
Narratives are generated only when an analyst asks for one.

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://localhost:11434/v1` (Ollama) | Base URL; `/chat/completions` is appended. |
| `LLM_MODEL` | `llama3.1` | Model name. |
| `LLM_API_KEY` | `ollama` | Sent as a bearer token. Ollama ignores it. |
| `LLM_PROVIDER_LABEL` | `self-hosted` | Label stored with, and shown next to, each narrative. |
| `LLM_TIMEOUT_MS` | `30000` | Request timeout. |

In the Compose stack, `localhost` is the application container itself: point `LLM_BASE_URL` at
an address the container can reach.

## Notifications

[`lib/notify/`](../lib/notify). Without `NOTIFY_SECRET_KEY`, creating a channel answers `503`.

| Variable | Description |
| --- | --- |
| `NOTIFY_SECRET_KEY` | `<keyId>:<64 hex>` (key id: up to 16 of `A-Za-z0-9_-`). Seals channel URLs and signing secrets with AES-256-GCM. Generate with `echo "k1:$(openssl rand -hex 32)"`. |
| `NOTIFY_SECRET_KEY_PREVIOUS` | Older keys in the same form, comma-separated, used only to open values sealed before a rotation. The delivery job re-seals them under the current key; then the old key can be removed. |
| `NOTIFY_ALLOWED_PRIVATE_HOSTS` | Comma-separated `<tenant id>:<host>` entries: hosts that tenant's webhooks may resolve to a private address (an on-premises receiver). No wildcard tenant. Loopback, link-local and cloud metadata addresses stay refused. An entry trusts a name and DNS decides the address, so prefer IP literals or names only the operator controls; `/etc/hosts` is not read. |
| `NOTIFY_ALLOWED_PORTS` | Comma-separated ports allowed besides 443. |
| `NOTIFY_CONSOLE_URL` | Base URL for console links in payloads. Falls back to `NEXTAUTH_URL`; without either, links are `null`. |

## Telemetry archive

Off unless exactly one of `LAKE_DIR` or `LAKE_S3_BUCKET` is set; both set is an error
([`lib/lake-env.ts`](../lib/lake-env.ts)). The [datalake note](../datalake/README.md#configuration)
covers bucket permissions and the versioning requirement.

| Variable | Default | Description |
| --- | --- | --- |
| `LAKE_DIR` | | Write the archive to this directory (files written under a temporary name and renamed). |
| `LAKE_S3_BUCKET` | | Write the archive to this S3-compatible bucket. |
| `LAKE_S3_ENDPOINT` | AWS | Endpoint of an S3-compatible server. |
| `LAKE_S3_REGION` | `us-east-1` | |
| `LAKE_S3_PREFIX` | empty | Key prefix inside the bucket. |
| `LAKE_S3_FORCE_PATH_STYLE` | `true` with an endpoint, else `false` | `true` or `false`; anything else is an error. |
| `LAKE_S3_ACCESS_KEY_ID`, `LAKE_S3_SECRET_ACCESS_KEY` | SDK default chain | The writer's credentials, both or neither. |
| `LAKE_S3_READER_ACCESS_KEY_ID`, `LAKE_S3_READER_SECRET_ACCESS_KEY` | SDK default chain | The reader's credentials, both or neither. Never falls back to the writer's. |
| `LAKE_WRITER_MAX_BATCHES` | `200` | Queued batches one `write-lake` call writes. |

## Prevalence and snapshots

A numeric variable that is set but not a positive number is an error, not the default.

| Variable | Default | Description |
| --- | --- | --- |
| `PREVALENCE_RETENTION_DAYS` | `180` | Days a sighting is kept without being seen again. |
| `PREVALENCE_MAX_ROWS_PER_TENANT` | `5000000` | Sightings kept per tenant; the oldest seen go first. |
| `SYNTHAEA_SNAPSHOT_SIGNER` | unset | `test` signs common-set snapshots with the **public** test key, for labs only. Unset, no snapshot is built or served. Any other value is an error. |
| `SNAPSHOT_MIN_HOSTS` | `2` | Hosts a hash must be seen on to enter the snapshot. |
| `SNAPSHOT_MIN_HOSTS_COVERED` | `2` | Reporting hosts a tenant needs before a snapshot is built. |
| `SNAPSHOT_FALSE_POSITIVE_RATE` | `0.01` | Bloom filter false-positive rate. |
| `SNAPSHOT_MAX_BYTES` | `4194304` | Largest artifact. |
| `SNAPSHOT_MAX_ENTRIES` | `500000` | Most hashes; a tenant with more is skipped. |
| `SNAPSHOT_MIN_ENTRY_FRACTION` | `0.5` | A build with fewer entries than this fraction of the previous one, with no fall in hosts covered, is refused as truncated. |

## Proxy and certificates

| Variable | Read by | Description |
| --- | --- | --- |
| `NGINX_PROXY_SECRET` | nginx (`proxy` service) | Substituted into [`nginx.conf`](../nginx.conf) by the nginx image's template step. Must equal the application's. |
| `NGINX_ENVSUBST_OUTPUT_DIR`, `NGINX_ENVSUBST_FILTER` | nginx image | Render the template over `/etc/nginx/nginx.conf`, substituting only `NGINX_*` variables so nginx's own `$variables` stay intact. |
| `DEV_CERT_SANS` | [`scripts/generate-dev-certs.sh`](../scripts/generate-dev-certs.sh) | Extra subject alternative names for the development server certificate, such as `DNS:cp.lab,IP:192.0.2.10`. |

## Tests

| Variable | Description |
| --- | --- |
| `SYNTHAEA_ROOT` | Parent directory of the sibling repository checkouts the contract tests read. Default: this repository's parent. |
| `SYNTHAEA_REQUIRE_SIBLINGS` | `1` makes a contract test fail, instead of skip, when its sibling is missing. CI sets it. |

[`.env.test`](../.env.test) and [`tests/setup.ts`](../tests/setup.ts) set `DATABASE_URL`,
`BETTER_AUTH_SECRET` and `CRON_SECRET` for the suites.

## Not configurable

- Rings (`canary_0`, `canary_1`, `canary_2`, `prod`), the silence threshold (5 minutes), the
  grouping window (30 minutes) and the fleet join window (24 hours) are constants in the code.
- better-auth's trusted origins are fixed in [`lib/auth.ts`](../lib/auth.ts).
- The artifact store is always `storage/` under the application's working directory.
