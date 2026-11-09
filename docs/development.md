# Development

Setting up a working copy, the conventions every change follows, and what to touch when adding a
route, a variable or a schema field. [CONTRIBUTING.md](../CONTRIBUTING.md) has the pull request
rules; [Testing](testing.md) has the suites.

## Set up

You need Node.js 20, Docker with Compose v2 (for the databases) and Git.

```bash
git clone https://github.com/synthaea-lab/server.git
cd server
npm ci
npx prisma generate
```

Two ways to run the application:

- **The Compose stack** ([README-SETUP.md](../README-SETUP.md)): PostgreSQL, the application in
  development mode with the repository bind-mounted, and the mTLS proxy. Closest to how agents
  reach the server.
- **Directly on Node**, against any PostgreSQL 15:

  ```bash
  cp .env.example .env          # set DATABASE_URL and the secrets
  npx prisma db push
  npm run dev                   # http://localhost:3000
  ```

  Without the proxy, agent routes refuse every request (no proxy secret, no certificate
  headers). Use the Compose stack, or call the handlers from tests, to exercise them.

| Command | Does |
| --- | --- |
| `npm run dev` | Next.js development server |
| `npm run build`, `npm start` | Production build, then the standalone server ([Deployment](deployment.md#docker-image)) |
| `npm run lint` | ESLint ([`.eslintrc.cjs`](../.eslintrc.cjs)) through `next lint`. The configuration uses `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`, which `package.json` does not list yet; install them to run it. |
| `npx tsc --noEmit` | Type check |
| `npx vitest run tests/unit` | Unit tests |
| `scripts/run-tests.sh` | Unit and integration tests against a throwaway database |
| `npm run db:push`, `npm run db:generate`, `npm run db:studio` | Apply the schema, regenerate the client, browse the database |

## Conventions

- **Tenancy comes from the identity, never the request.** A console route gets the tenant from
  [`requireTenantMember`](../lib/admin-auth.ts) or [`requireTenantAdmin`](../lib/admin-auth.ts);
  an agent route from [`authenticateAgent`](../lib/agent-auth.ts). Every query filters on it.
  Another tenant's record is a `404`.
- **Agent and console identities never mix.** Agent routes authenticate with the certificate the
  proxy passed; console routes with a session. A route serves one or the other.
- **The middleware runs on the Edge runtime.** [`middleware.ts`](../middleware.ts) and what it
  imports cannot use Prisma, `lib/auth.ts` or `node:` modules. Server components and route
  handlers run on Node.
- **Tenants and organizations share an id.** Create tenants only with
  [`provisionTenant`](../lib/tenant-provisioning.ts).
- **Logic in `lib/`, I/O at the edge.** Keep decisions in pure functions that take plain data and
  a clock; keep Prisma calls in the route or a thin store module. Most of the unit suite depends on
  this split.
- **Errors.** Wrap handlers in [`route`](../lib/http/handler.ts) and throw `HttpError`
  subclasses (`BadRequest`, `NotFound`) for expected refusals; validate bodies with zod. Never put
  a driver message or stack in a response.
- **Audit in the same transaction.** An administrative change writes its row with
  [`recordAudit`](../lib/audit.ts), passed the transaction the change runs in, and adds its action
  to `AuditAction`.
- **Agent data is hostile.** Bound every agent-supplied string, array and depth. Cut text a
  process on the host controls, refuse only what shipped content controls, and never answer `4xx`
  for something the agent would have to retry ([Agent protocol](agent-protocol.md#status-codes-and-retries)).
- **Best effort after acceptance.** Once an upload is stored or queued, secondary work
  (counters, `last_seen`) must not turn the answer into a `5xx`.
- **Shared wire formats follow their owner.** The agent owns the event, detection, beacon and
  manifest formats. Change the server's validation with the owner's golden fixtures, and keep the
  contract tests passing ([Testing](testing.md#contract-tests-and-sibling-repositories)).
- **Code comments say why.** State the invariant or the reason; the documentation explains the
  mechanism. When a change alters what a functional area does, update its module note and the
  page here that describes it.

## Adding things

### A console route

1. Create `app/api/<resource>/route.ts`; guard it with `requireTenantMember` or
   `requireTenantAdmin` first.
2. Scope every query to the caller's tenant.
3. Add an integration test with another tenant's data, and extend
   [`tests/integration/tenancy.test.ts`](../tests/integration/tenancy.test.ts).

Console routes need nothing in the middleware or nginx: every path not listed as public is
session-protected by default.

### An agent route

1. Create the route and call `authenticateAgent` first.
2. Add the exact path to the public list in [`middleware.ts`](../middleware.ts), or the
   middleware redirects the agent to `/login`.
3. Add an nginx location that requires a verified client certificate, unless the path is already
   under `/api/ingest/` ([`nginx.conf`](../nginx.conf)), and size its body limit.
4. Document the endpoint in [Agent protocol](agent-protocol.md).

### A scheduled job

Create `app/api/cron/<name>/route.ts`, call `verifyCronRequest` first, bound the work per call,
make a rerun harmless, and list it in [Scheduled jobs](scheduled-jobs.md). `/api/cron/*` is
already public in the middleware and rate-limited in nginx.

### An environment variable

Read it where it is used, refuse a set-but-invalid value rather than falling back to the default,
and add it to [Configuration](configuration.md) (and to [`.env.example`](../.env.example) if a
local run needs it).

### A schema field

Edit [`prisma/schema.prisma`](../prisma/schema.prisma), then `npx prisma db push` and
`npx prisma generate`. A new non-null column on a table with rows needs a default. There is no
migration file to write ([Data model](data-model.md#applying-the-schema)). In the Compose stack,
rebuild the `server` image afterwards.
