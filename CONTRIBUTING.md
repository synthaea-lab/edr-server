# Contributing to the Synthaea server

Thank you for helping. This guide covers what is specific to this repository. The
[organization's contributing guide](https://github.com/synthaea-lab/.github/blob/main/CONTRIBUTING.md)
states the rules that hold for every Synthaea repository: issues, the Developer Certificate of
Origin and the license of your contribution.

## Set up

You need Node.js 20 (the version the Docker image ships), Docker with Compose v2 for the
databases, and Git. [README-SETUP.md](README-SETUP.md) runs the full stack.

```bash
git clone https://github.com/synthaea-lab/server.git
cd server
npm ci
npx prisma generate
```

## Repository layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js App Router: API routes under `app/api/`, console pages under `app/console/` |
| `lib/` | Server logic, most of it pure functions the routes call |
| `components/` | React components of the console |
| `prisma/schema.prisma` | The database schema |
| `middleware.ts` | Session check and tenant context for protected routes |
| `nginx.conf`, `docker-compose.yml`, `Dockerfile` | The development stack |
| `tests/` | Unit and integration suites ([tests/README.md](tests/README.md)) |
| `ingest/`, `datalake/`, `hunt/`, ... | Module notes: design and status of each functional area |

## Check your change

Run these before you open a pull request:

```bash
npm run typecheck
npm run lint
npx vitest run tests/unit
```

Integration tests run the route handlers against a real PostgreSQL. Start the test database,
create the schema, then run them:

```bash
docker compose -f docker-compose.test.yml up -d
DATABASE_URL="postgresql://synthaea:synthaea_test@localhost:5433/synthaea_test" \
  npx prisma db push --skip-generate --accept-data-loss
npm run test:integration
```

[tests/README.md](tests/README.md) explains the suites, the contract tests that read the sibling
repositories, and the helpers.

## Conventions

- **Tenancy.** Every query a route runs is scoped to the caller's tenant. A route reads the
  tenant from the context the middleware set (`getTenantId` in `lib/tenant.ts`), never from the
  request body. `tests/integration/tenancy.test.ts` checks isolation across routes; extend it when
  you add one.
- **Agent and console identities stay separate.** Agent routes authenticate with the mTLS
  certificate passed by the proxy (`lib/agent-auth.ts`); console routes with a better-auth
  session. The two never mix.
- **Middleware runs on the Edge runtime.** `middleware.ts` cannot import Prisma or `lib/auth.ts`;
  it asks `/api/auth/get-session` over the loopback (`lib/session-lookup.ts`), which fails closed.
  Server components and route handlers run on Node and call `auth.api.getSession` with the request
  headers.
- **Tenants and organizations share an id.** A session's `activeOrganizationId` is the tenant id.
  Tenants are created only through `provisionTenant` (`lib/tenant-provisioning.ts`), which creates
  both rows together; better-auth's own organization creation and deletion are disabled.
- **Schema changes.** The schema is applied with `prisma db push`; there are no migration files.
  The better-auth tables are Prisma models, and an integration test fails if a better-auth upgrade
  needs a field the schema lacks.
- **Module notes.** When a change alters what a functional area does, update its notes in the
  matching directory (`hunt/README.md`, `datalake/README.md`, ...).

## Submit

- Open the pull request against `main`, with a description of what changes and how you tested it.
- Sign off every commit: `git commit -s`.
- Report security issues privately, never in a pull request or issue: see the
  [security policy](https://github.com/synthaea-lab/.github/blob/main/SECURITY.md).
