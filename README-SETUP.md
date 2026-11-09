# Running the development stack

This guide runs the Synthaea control plane on one machine with Docker Compose, signs in to the
console, enrolls an agent and lists every configuration variable. The stack is for development
and lab use; it is not a production deployment.

## Requirements

- Docker with Compose v2
- Git, OpenSSL and a Bash shell (on Windows, use WSL)
- Network access for the first build, which downloads the Node and nginx images

## Start the stack

```bash
git clone https://github.com/synthaea-lab/server.git
cd server
./scripts/generate-dev-certs.sh
docker compose up --build
```

| Service | What it is | Published on the host |
| --- | --- | --- |
| `postgres` | PostgreSQL 15 | `5432` |
| `server` | The Next.js application, in development mode | nothing (port 3000 inside the network) |
| `proxy` | nginx, terminating the agents' mTLS | `8443` |

`scripts/generate-dev-certs.sh` writes to `certs/`:

| File | Purpose |
| --- | --- |
| `ca.crt`, `ca.key` | The development CA |
| `server.crt`, `server.key` | The proxy's certificate, for `localhost`, `127.0.0.1` and `::1` |
| `agent-test.crt`, `agent-test.key` | A test agent client certificate, `CN=agent-test-001` |

These are development keys. Do not reuse them anywhere else, and do not commit them.

The server creates its database schema at startup with `prisma db push`; there is no migration
history. After editing `prisma/schema.prisma`, rebuild the image (`docker compose build server`) so
the Prisma client inside the container matches the new schema.

Check that the stack answers through the proxy:

```bash
curl --cacert certs/ca.crt https://localhost:8443/api/health
```

```json
{"status":"ok","timestamp":"..."}
```

## Open the console

The application port is not published by default, so that nothing reaches the application
without passing through the proxy. To use the console from a browser on the same machine, publish
it on the loopback address only, with an override file:

```yaml
# override.yml
services:
  server:
    ports:
      - "127.0.0.1:3000:3000"
```

```bash
docker compose -f docker-compose.yml -f override.yml up --build
```

The console is then at <http://localhost:3000>.

## Create the first account and tenant

Every console user acts inside a tenant, and only a platform operator can create one. On a fresh
stack:

1. **Create a user.** Sign-up is open on the better-auth endpoint:

   ```bash
   curl -X POST http://localhost:3000/api/auth/sign-up/email \
     -H "Origin: http://localhost:3000" \
     -H "Content-Type: application/json" \
     -d '{"email": "admin@example.com", "password": "change-me-please", "name": "Admin"}'
   ```

   The response contains the user's `id`.

2. **Make that user a platform operator.** Add `PLATFORM_OPERATOR_USER_IDS` to the `server`
   service in `override.yml` and restart the stack:

   ```yaml
   services:
     server:
       ports:
         - "127.0.0.1:3000:3000"
       environment:
         PLATFORM_OPERATOR_USER_IDS: "<the user id>"
   ```

3. **Sign in and create the tenant.** The caller becomes the tenant's owner:

   ```bash
   curl -c cookies.txt -X POST http://localhost:3000/api/auth/sign-in/email \
     -H "Origin: http://localhost:3000" \
     -H "Content-Type: application/json" \
     -d '{"email": "admin@example.com", "password": "change-me-please"}'

   curl -b cookies.txt -X POST http://localhost:3000/api/admin/tenants \
     -H "Content-Type: application/json" \
     -d '{"name": "Lab"}'
   ```

4. **Make the tenant active for the session**, with the tenant `id` from the previous response:

   ```bash
   curl -b cookies.txt -X POST http://localhost:3000/api/auth/organization/set-active \
     -H "Origin: http://localhost:3000" \
     -H "Content-Type: application/json" \
     -d '{"organizationId": "<the tenant id>"}'
   ```

better-auth refuses a request that carries a session cookie without a trusted `Origin` header,
hence the header above.

The active tenant belongs to a session, and the login page does not choose one. After signing in
at <http://localhost:3000/login>, make the tenant active for the browser session as well, for
example from the browser's developer console:

```js
await fetch("/api/auth/organization/set-active", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ organizationId: "<the tenant id>" }),
});
```

Then reload the console.

## Enroll an agent

The server identifies an agent by the common name of its client certificate: an agent record whose
enrollment ID equals that name must exist in the tenant, or the agent endpoints answer
`403 Agent not enrolled`. A tenant owner or admin creates the record. For the test certificate:

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/enrollment \
  -H "Content-Type: application/json" \
  -d '{"enrollmentId": "agent-test-001", "hostname": "lab-vm-01"}'
```

Then point the agent at `https://<host>:8443` with the CA and the client certificate, as
[Standalone or with a control plane](https://www.synthaea.com/en/docs/standalone-and-control-plane)
describes. To try a connection from the agent's command line:

```bash
agent check-content-manifest --server https://localhost:8443 --ring canary_0 \
  --ca-cert certs/ca.crt --cert certs/agent-test.crt --key certs/agent-test.key
```

`--ca-cert`, `--cert` and `--key` are also accepted by `agent run`, `apply-release` and
`apply-content-manifest`. In `agent.toml`, `server.ca_cert` sets the CA for a configured agent.
The agent trusts only the public roots unless it is given a CA.

## Reach the stack from another machine

The proxy's certificate names `localhost`, `127.0.0.1` and `::1` only, and the agent refuses a
server name that is not in the certificate. To reach the proxy from a lab VM, add its address when
generating the certificates:

```bash
DEV_CERT_SANS="IP:192.0.2.10" ./scripts/generate-dev-certs.sh
```

`DEV_CERT_SANS` takes a comma-separated list such as `DNS:cp.lab,IP:192.0.2.10`.

### Restrict the published ports

The compose file publishes PostgreSQL (with the development password) and the proxy on every
interface of the host. On a shared network, publish only the proxy, on the address the lab uses,
and nothing for the database:

```yaml
# override.yml, used with: docker compose -f docker-compose.yml -f override.yml up
services:
  postgres:
    ports: !reset []
  proxy:
    ports: !override
      - "192.0.2.10:8443:8443"
```

On a host with SELinux enforcing (Fedora, RHEL), the bind mounts carry `:z`, which relabels the
repository and `certs/` for the containers.

## Scheduled jobs

Background work runs when a scheduler calls the routes under `/api/cron/`, each with the header
`Authorization: Bearer <CRON_SECRET>`. With `CRON_SECRET` unset, every call is refused.

| Route | Does | Suggested interval |
| --- | --- | --- |
| `detect-silent-agents` | Opens a case for agents with no heartbeat for 5 minutes | Every minute |
| `group-detections` | Groups new detections into cases | Every minute |
| `join-fleet-cases` | Joins cases across hosts into fleet cases | Every few minutes |
| `check-ring-health` | Checks the health of each rollout ring | Every 5 minutes |
| `deliver-notifications` | Sends queued webhook notifications | Every minute |
| `run-hunts` | Runs the scheduled hunts that are due | Every few minutes |
| `write-lake` | Writes queued events to the telemetry archive | Every few minutes, when the archive is on |
| `build-snapshots` | Builds each tenant's common-set snapshot | Daily, when snapshot signing is on |
| `prune-lake` | Applies the archive's retention | Daily |
| `prune-prevalence` | Applies the prevalence retention | Daily |
| `prune-artifacts` | Deletes content artifacts no release refers to | Daily |

For example:

```bash
curl -H "Authorization: Bearer dev_cron_secret" \
  http://localhost:3000/api/cron/detect-silent-agents
```

## Run outside Docker

The application also runs directly on Node.js 20 against any PostgreSQL 15 database:

```bash
cp .env.example .env        # then edit DATABASE_URL and the secrets
npm ci
npx prisma db push
npm run dev
```

`npm run build` followed by `npm start` runs the production build, the same standalone server the
Docker image ships; `PORT` and `HOSTNAME` apply as usual. `next start` does not serve this build.

## Configuration

The compose file sets the variables the stack needs. [`.env.example`](.env.example) lists them for a
run outside Docker.

### Core

| Variable | Description | Development value |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://synthaea:synthaea_dev@localhost:5432/synthaea` |
| `BETTER_AUTH_SECRET` | Signs console sessions | `dev_secret_change_in_production` |
| `NEXTAUTH_URL` | Public URL of the console, used for links | `http://localhost:3000` |
| `NGINX_PROXY_SECRET` | Shared secret the proxy adds to every request; agent endpoints refuse a request without it | `dev_nginx_secret_change_in_production` |
| `CRON_SECRET` | Bearer token of the scheduled jobs | `dev_cron_secret` |
| `PLATFORM_OPERATOR_USER_IDS` | Comma-separated user ids allowed to create tenants | unset (nobody) |
| `NODE_ENV` | Environment mode | `development` |

### Case narratives

| Variable | Description | Default in `.env.example` |
| --- | --- | --- |
| `LLM_BASE_URL` | Base URL of an OpenAI-compatible chat-completions API | `http://localhost:11434/v1` (Ollama) |
| `LLM_MODEL` | Model name | `llama3.1` |
| `LLM_API_KEY` | API key | `ollama` |
| `LLM_PROVIDER_LABEL` | Label shown next to a narrative | `self-hosted` |
| `LLM_TIMEOUT_MS` | Request timeout | `30000` |

### Notifications

| Variable | Description |
| --- | --- |
| `NOTIFY_SECRET_KEY` | `<keyId>:<64 hex>`, seals the webhook signing secrets (AES-256-GCM). Generate one with `echo "k1:$(openssl rand -hex 32)"`. Unset, creating a channel answers `503`. |
| `NOTIFY_SECRET_KEY_PREVIOUS` | Older keys of the same form, comma-separated, used only to open secrets sealed before a rotation. The delivery job re-seals them under the current key, after which the old key can be retired. |
| `NOTIFY_ALLOWED_PRIVATE_HOSTS` | `<tenant id>:<host>` entries, comma-separated: hosts that a tenant's webhook URL may resolve to a private address (an on-premises SOAR, for example). No entry ever opens loopback, link-local or cloud metadata addresses. An entry trusts a name, but DNS decides the address, so prefer IP literals or names only the operator controls. |
| `NOTIFY_ALLOWED_PORTS` | Ports besides 443 that a webhook URL may use |
| `NOTIFY_CONSOLE_URL` | Base URL of the console for links in payloads; falls back to `NEXTAUTH_URL` |

### Telemetry archive, prevalence and snapshots

| Variable | Description |
| --- | --- |
| `LAKE_DIR`, `LAKE_S3_*` | Turn the telemetry archive on, on a directory or an S3-compatible bucket. See [datalake/README.md](datalake/README.md). |
| `LAKE_WRITER_MAX_BATCHES` | Batches one `write-lake` call drains (default 200) |
| `PREVALENCE_RETENTION_DAYS` | Days a sighting is kept without being seen again (default 180) |
| `PREVALENCE_MAX_ROWS_PER_TENANT` | Row cap per tenant; the oldest-seen rows go first (default 5,000,000) |
| `SYNTHAEA_SNAPSHOT_SIGNER` | `test` signs common-set snapshots with the public test key, for lab use only. Unset, no snapshot is built or served. |
| `SNAPSHOT_MIN_HOSTS`, `SNAPSHOT_MIN_HOSTS_COVERED`, `SNAPSHOT_FALSE_POSITIVE_RATE`, `SNAPSHOT_MAX_BYTES`, `SNAPSHOT_MAX_ENTRIES`, `SNAPSHOT_MIN_ENTRY_FRACTION` | Tune the snapshot build; the defaults are in `lib/snapshot-publish.ts` |

## Before you expose the stack

The development defaults are public. Before the stack leaves a single machine:

- Replace every secret above with a random value, for example `openssl rand -base64 32`, and set
  the same `NGINX_PROXY_SECRET` on the `server` and `proxy` services.
- Never publish the application port. Only the proxy's port should be reachable; the proxy secret
  is what stops a client from talking to the application directly with forged certificate
  headers.
- Do not publish PostgreSQL.
- Replace the development CA and certificates with your own PKI.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `403 Agent not enrolled` | No agent record has the certificate's CN as its enrollment ID. Enroll it first. |
| `401` from the proxy on an agent route | The client sent no certificate, or one the CA did not sign. |
| The agent refuses the server's certificate | The address it uses is not in the certificate. Regenerate with `DEV_CERT_SANS`. |
| The console shows `No organization selected` | The session has no active tenant. Make it active as [Create the first account and tenant](#create-the-first-account-and-tenant) describes. |
| The database is unreachable | Check `docker compose ps postgres` and `docker compose logs postgres`. |
