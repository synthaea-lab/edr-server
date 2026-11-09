# Testing

The server's tests run with [Vitest](https://vitest.dev) ([`vitest.config.ts`](../vitest.config.ts)).
[`tests/README.md`](../tests/README.md) is the short version of this page, next to the tests.

## Suites

| Suite | Path | Needs | What it covers |
| --- | --- | --- | --- |
| Unit | [`tests/unit/`](../tests/unit) | Nothing | Pure logic in `lib/`: payload parsing and bounds, case grouping, fleet joins, prevalence, hunts and their query compiler, manifests and canonical JSON, IOC feed builders, the archive writer and reader against in-memory stores, notification signing and the SSRF guard, middleware and route guards with mocked dependencies, and rules on what the console's client bundle may import. |
| Integration | [`tests/integration/`](../tests/integration) | PostgreSQL | Route handlers called directly with a `NextRequest` against a real database: ingest, enrollment, cases, fleet cases, hunts, rings and releases, notifications, the archive, tenant provisioning, better-auth's tables, and tenant isolation. |
| Contract | Inside both suites | Sibling checkouts | Wire formats shared with other repositories (see below). |
| Acceptance | [`tests/e2e/run-acceptance-tests.sh`](../tests/e2e/run-acceptance-tests.sh) | A running stack | A `curl` walk through enrollment, a detection, a heartbeat and the silent-agent job. |

All suites load [`tests/setup.ts`](../tests/setup.ts), which reads [`.env.test`](../.env.test)
and defaults `DATABASE_URL` to the test database on port 5433.

## Running them

The whole unit and integration run, with a throwaway database:

```bash
scripts/run-tests.sh
```

[`scripts/run-tests.sh`](../scripts/run-tests.sh) starts
[`docker-compose.test.yml`](../docker-compose.test.yml) and waits for its `pg_isready` health
check, pushes the schema, runs both suites once with `vitest run`, and removes the database
container and volume on exit, whether the run passed, failed or was interrupted. It needs Docker
with Compose v2 and port 5433 free.

Step by step:

```bash
npx vitest run tests/unit                     # anywhere, no database

docker compose -f docker-compose.test.yml up -d --wait
DATABASE_URL="postgresql://synthaea:synthaea_test@localhost:5433/synthaea_test" \
  npx prisma db push --skip-generate --accept-data-loss
npm run test:integration                      # vitest run tests/integration
docker compose -f docker-compose.test.yml down --volumes
```

`npm test` starts Vitest in watch mode, which is what you want while editing and never exits on
its own; use `npx vitest run <path>` for a one-off run, and `npm run test:ui` for the browser UI.

Test files run one at a time (`fileParallelism: false`): every integration file clears the same
database between tests.

## Contract tests and sibling repositories

Some formats are owned by another repository, and the server must agree with it byte for byte.
Contract tests read those files from sibling checkouts
([`tests/helpers/siblings.ts`](../tests/helpers/siblings.ts)):

| Sibling | What the server checks against it |
| --- | --- |
| [`agent`](https://github.com/synthaea-lab/agent) | The schema's serialized event and detection fixtures, how the agent's sink splits technique tags, the generic-SID vectors fleet joins skip, and the updater's key-rotation golden file |
| [`ml`](https://github.com/synthaea-lab/ml) | The common-set snapshot fixture |
| [`rules`](https://github.com/synthaea-lab/rules) | The shipped IOC feeds, which the server's feed builder must accept |

They look for the repositories cloned next to this one, or under `SYNTHAEA_ROOT`:

```text
<parent>/
  agent/
  ml/
  rules/
  server/   this repository
```

A test whose sibling is missing is skipped with a notice; with `SYNTHAEA_REQUIRE_SIBLINGS=1` it
fails instead. The server's own side of the canonical-JSON signing scheme is pinned by golden
files in [`tests/fixtures/`](../tests/fixtures) (`content-manifest-golden.json`,
`snapshot-manifest-golden.json`) that the agent's updater tests against too.

## Continuous integration

[`.github/workflows/server.yml`](../.github/workflows/server.yml) runs on every pull request and
on `main`:

- **`server`** (Linux): checks out this repository with `agent`, `ml` and `rules` beside it, sets
  `SYNTHAEA_REQUIRE_SIBLINGS=1`, starts PostgreSQL 15 as a service on port 5433, pushes the schema
  and runs the unit then the integration suite.
- **`unit-cross-os`** (Windows and macOS): the unit suite with the same siblings, no database.

[`.github/workflows/dco.yml`](../.github/workflows/dco.yml) checks that every commit carries a
`Signed-off-by` line matching its author.

## The acceptance script

`tests/e2e/run-acceptance-tests.sh` drives a running server with `curl` (`SERVER_URL`, default
`http://localhost:3000`, and `CRON_SECRET`). It predates the session requirement on enrollment and
the proxy secret on agent routes, so against the current server it needs a session cookie and the
proxy headers it does not send. It is not run in CI.

## Writing a test

- Put logic in a pure function in `lib/` and unit-test it there; keep the route thin.
- An integration test imports the route's handler and calls it with a `NextRequest`.
  [`tests/helpers/db.ts`](../tests/helpers/db.ts) creates tenants, agents, members, detections
  and cases; [`tests/helpers/http.ts`](../tests/helpers/http.ts) builds the certificate headers
  the proxy would set and the `x-tenant-id`/`x-user-id` headers the middleware would set. Set
  `NGINX_PROXY_SECRET` in the test and send it as `X-Proxy-Secret` for agent routes.
- Clear the database in `beforeEach` with `cleanDatabase()` and disconnect Prisma in `afterAll`.
- Cover the other tenant: a route that returns or changes data has a case showing another tenant's
  rows stay out of reach, and [`tests/integration/tenancy.test.ts`](../tests/integration/tenancy.test.ts)
  is extended when a route is added.
- Cover refusals as well as success: missing proxy secret, plain member on an admin route,
  oversized and malformed bodies.
