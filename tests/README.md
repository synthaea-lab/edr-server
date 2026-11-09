# Tests

The server's test suites, run with [Vitest](https://vitest.dev).

| Directory | What it holds | Needs |
| --- | --- | --- |
| `unit/` | Pure logic, payload parsing, file formats and the console's client bundle rules | Nothing |
| `integration/` | Route handlers called directly against a real database: ingest, cases, hunts, rings, notifications, the telemetry archive, tenant isolation | PostgreSQL |
| `fixtures/` | Golden files and sample inputs the unit tests compare against | |
| `helpers/` | Database fixtures (`db.ts`), agent request builders (`http.ts`), sibling repository lookup (`siblings.ts`) | |
| `setup.ts` | Loads `.env.test` and the test defaults | |

## Run

Unit tests run anywhere:

```bash
npx vitest run tests/unit
```

Integration tests expect the database of `docker-compose.test.yml` on port 5433:

```bash
docker compose -f docker-compose.test.yml up -d
DATABASE_URL="postgresql://synthaea:synthaea_test@localhost:5433/synthaea_test" \
  npx prisma db push --skip-generate --accept-data-loss
npm run test:integration
```

The integration files run one at a time, because each clears the same database. To start again
from an empty schema, add `--force-reset` to the `prisma db push` command.

## Contract tests and sibling repositories

A few tests check files published by the other Synthaea repositories: the agent's event schema
and updater fixtures, the ML pipeline's common-set snapshot fixture and the IOC feeds in rules.
They look for the repositories cloned next to this one:

```text
<parent>/
  agent/    https://github.com/synthaea-lab/agent
  ml/       https://github.com/synthaea-lab/ml
  rules/    https://github.com/synthaea-lab/rules
  server/   this repository
```

`SYNTHAEA_ROOT` points at another parent directory. A test whose sibling is missing is skipped
with a notice; with `SYNTHAEA_REQUIRE_SIBLINGS=1`, it fails instead.

## Write a test

- Integration tests import the route handler and call it with a `NextRequest`; `helpers/db.ts`
  creates tenants and agents, and `helpers/http.ts` builds the headers the proxy would pass for an
  agent.
- Clear the database in `beforeEach` with `cleanDatabase()` and disconnect Prisma in `afterAll`.
- Cover the other tenant: a route that returns data has a case showing that another tenant's rows
  stay out of reach.
