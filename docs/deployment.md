# Deployment

How the server is packaged and run: the Docker image stages, the development Compose stack, the
nginx proxy, certificates, and the state that has to persist. [README-SETUP.md](../README-SETUP.md)
walks through starting the stack and signing in; this page is the reference behind it.

The supplied stack is a development and lab deployment. Nothing here is a supported production
configuration yet.

## Docker image

[`Dockerfile`](../Dockerfile) builds from `node:20-alpine` (Node 20 is also what CI tests on) in
five stages:

| Stage | Contents | Used by |
| --- | --- | --- |
| `base` | Node 20 on Alpine plus OpenSSL, which Prisma's query engine links against | Every stage |
| `deps` | `npm ci` | `dev`, `builder` |
| `dev` | The source tree, a generated Prisma client, `npm run dev` on port 3000 | `docker-compose.yml` |
| `builder` | `prisma generate` and `next build` with `output: 'standalone'` | `runner` |
| `runner` | The standalone server and static assets only, run as the unprivileged `nextjs` user (uid 1001) with `NODE_ENV=production` and `NEXT_MANUAL_SIG_HANDLE=true` | Production-style runs |

The standalone output is served by `node server.js`, not by `next start`.
[`scripts/start-standalone.mjs`](../scripts/start-standalone.mjs) (`npm start`) does the same
outside Docker after `npm run build`: it copies the static assets and `public/` next to the
standalone server, as the image does, then starts it.

The `runner` image does not apply the schema. Run `npx prisma db push` against its database from
a build environment first ([Data model](data-model.md#applying-the-schema)).

## The Compose stack

[`docker-compose.yml`](../docker-compose.yml) runs three services:

| Service | Image | Role | Published on the host |
| --- | --- | --- | --- |
| `postgres` | `postgres:15-alpine` | Database, with a `pg_isready` health check and a named volume `postgres_data` | `5432` |
| `server` | `dev` stage of the Dockerfile | Pushes the schema (`prisma db push --skip-generate`), then runs `next dev`. Starts once `postgres` is healthy. | Nothing; port 3000 inside the network |
| `proxy` | `nginx:alpine` | Terminates TLS and mTLS on 8443 | `8443` |

The `server` service bind-mounts the repository at `/app` (with anonymous volumes over
`node_modules` and `.next`), so code changes reload without a rebuild. A schema change needs a
rebuild (`docker compose build server`) so the generated Prisma client in the image matches. The
mounts carry `:z` so they are readable under SELinux.

The application port is deliberately not published: everything should reach the application
through the proxy. To use the console from the same machine, publish it on loopback only with an
override file ([README-SETUP.md](../README-SETUP.md#open-the-console)).

[`docker-compose.test.yml`](../docker-compose.test.yml) is separate: one PostgreSQL on port 5433
for the test suites ([Testing](testing.md)).

## The proxy

[`nginx.conf`](../nginx.conf) is mounted as a template; the nginx image substitutes
`${NGINX_PROXY_SECRET}` into it at start, and only `NGINX_*` variables, so nginx's own `$variables`
are untouched.

On every request the proxy sets, overwriting any value the client sent:

| Header | Value |
| --- | --- |
| `X-Client-Cert-Verified` | `$ssl_client_verify`: `SUCCESS`, `NONE` or a failure reason |
| `X-Client-Cert-Subject` | `$ssl_client_s_dn`, the client certificate's subject |
| `X-Proxy-Secret` | `NGINX_PROXY_SECRET` |
| `X-Real-IP` | The connection's address |
| `X-Forwarded-For`, `X-Forwarded-Proto`, `Host` | The usual forwarding values |

Client certificates are requested but optional at the TLS layer (`ssl_verify_client optional`),
because browsers and the scheduler use the same port. Locations then decide:

| Location | Client certificate | Other limits |
| --- | --- | --- |
| `/api/ingest/`, `/api/v1/ingest/` | Required (`401` otherwise) | Body up to 8 MiB |
| `/api/release/{manifest,artifact,key-rotation}`, `/api/content/manifest/<ring>`, `/api/content/artifact`, `/api/snapshot/{manifest,artifact}` | Required | |
| `/api/content/ioc-feed` | Not used (session-authenticated) | Body up to 32 MiB, matching the route's own limit |
| `/api/cron/` | Not used (bearer-authenticated) | 10 requests/s per address, burst 20, `429` past it |
| Everything else | Not used | nginx default 1 MiB body |

Several application instances can sit behind one proxy by adding them to the `upstream server`
block; the application keeps its state in PostgreSQL, the archive and the artifact store, which
must then be shared.

## Certificates

[`scripts/generate-dev-certs.sh`](../scripts/generate-dev-certs.sh) writes a throwaway PKI to
`certs/`, which the proxy mounts read-only:

| File | Purpose |
| --- | --- |
| `ca.crt`, `ca.key` | Development CA. nginx trusts it for client certificates; agents trust it for the server. |
| `server.crt`, `server.key` | Proxy certificate, with `localhost`, `127.0.0.1` and `::1` as subject alternative names, plus any in `DEV_CERT_SANS` |
| `agent-test.crt`, `agent-test.key` | Test agent certificate, `CN=agent-test-001` |

The agent's TLS stack is strict: it needs X.509 v3 certificates, a CA with
`basicConstraints=CA:TRUE`, and the server's name in `subjectAltName` (a CN alone is refused). The
script produces exactly that, and your own PKI must too. Agent certificates need
`extendedKeyUsage=clientAuth`; their CN is the enrollment ID ([Agent protocol](agent-protocol.md#enrollment-and-identity)).
The agent trusts only public roots unless given a CA (`--ca-cert`, or `server.ca_cert` in
`agent.toml`).

## Persistent state

| State | Where | Notes |
| --- | --- | --- |
| Database | `postgres_data` volume | Everything except what follows. |
| Artifact store | `storage/` under the application's working directory | Content artifacts, signed manifests, release files and key rotations ([Content and releases](content-and-releases.md#the-artifact-store)). In the Compose stack this is `storage/` in the repository checkout, through the bind mount. The `runner` image has no volume for it: mount one at `/app/storage`, writable by uid 1001. |
| Telemetry archive | `LAKE_DIR` or the `LAKE_S3_*` bucket | Optional. The Compose stack includes no object store. |
| Certificates | `certs/` | Mounted into the proxy. |

## Network

Outbound connections the application may make, each only when configured:

- PostgreSQL (`DATABASE_URL`);
- the LLM endpoint (`LLM_BASE_URL`), when an analyst generates a narrative;
- webhook receivers, from the notification job;
- the S3 endpoint of the archive;
- a release `manifestUrl` that is not `storage://`.

Inbound, only the proxy port needs to be reachable: by agents, console users and the scheduler.

## Before the stack leaves one machine

The development defaults are public. Before anything other than the local machine can reach the
stack:

- Replace every secret with a random value: `BETTER_AUTH_SECRET`, `CRON_SECRET`,
  `NGINX_PROXY_SECRET` (the same value on `server` and `proxy`) and the PostgreSQL password in
  both `POSTGRES_PASSWORD` and `DATABASE_URL`.
- Never publish the application port. The proxy secret is what keeps a client from talking to the
  application directly with forged certificate headers, and it only works if the application is
  unreachable except through the proxy.
- Do not publish PostgreSQL. Publish the proxy only on the address the lab uses
  ([README-SETUP.md](../README-SETUP.md#restrict-the-published-ports) has an override file).
- Replace the development CA and certificates with your own PKI.
- Keep `SYNTHAEA_SNAPSHOT_SIGNER` unset outside labs: the test key is public.
- Schedule the [jobs](scheduled-jobs.md); without them no case is grouped, no silent agent is
  noticed and no notification is sent.

[Security model](security-model.md#not-defended-yet) lists what remains undefended after that.
