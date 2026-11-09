# Data model

The server's state is in PostgreSQL, defined by one Prisma schema,
[`prisma/schema.prisma`](../prisma/schema.prisma). Model names in this page are the Prisma ones;
table and column names are their `snake_case` mappings (`Agent` is `agents`, `lastSeen` is
`last_seen`). The only state outside the database is the optional
[telemetry archive](../datalake/README.md) and the file-system
[artifact store](content-and-releases.md#the-artifact-store).

## Tenancy in the schema

`Tenant` is the root. Every tenant-owned model carries a `tenantId` and, with the few exceptions
noted below, a relation to `Tenant` with `onDelete: Cascade`, so a tenant's rows go with it.
Isolation between tenants is the application's job: every query filters on `tenantId`, and the
database has no row-level security policies ([Security model](security-model.md#tenant-isolation)).

`Organization`, better-auth's tenancy table, shares its `id` with `Tenant`. Nothing in the schema
links the two; [`provisionTenant`](../lib/tenant-provisioning.ts) creates both in one transaction,
and a session's `activeOrganizationId` is used as the tenant id.

## Models by area

### Fleet

| Model | One row per | Notes |
| --- | --- | --- |
| `Tenant` | Tenant | `lakeRetentionDays` (default 90) is the telemetry archive retention; `0` keeps nothing. |
| `Agent` | Enrolled agent | `enrollmentId` is the certificate CN, unique across tenants. `ring` defaults to `prod`. `lastSeen` is updated by every authenticated upload. |
| `AgentHealth` | Agent | The latest health beacon, overwritten by each one: version, per-sensor state (`sensors` JSON), spool size, cumulative loss, rarity, self-protection and IOC counters (`BigInt`), and `lossObservedAt`, the server time a loss counter last rose. |
| `IngestStat` | Tenant, agent, kind and hour | Received, accepted, skipped and refused counts and event lag for `events`, `detection` and `beacon`. |
| `DecoyToken` | Agent and token hash | SHA-256 of a planted decoy credential. Unique per agent and hash; several agents may hold the same hash. The relation to `Agent` is `NoAction`, so an agent holding decoys cannot be deleted while they would silently stop alarming. |

### Detections and cases

| Model | One row per | Notes |
| --- | --- | --- |
| `Detection` | Detection | `event` holds the triggering event and `meta` the rest of the agent's detection ([Agent protocol](agent-protocol.md#detections)). `caseId` is null until `group-detections` assigns it; `fleetCaseId` is set when `join-fleet-cases` links it. `(agentId, ingestId)` is unique for idempotent uploads. `updatedAt` moves on every change, which is what a narrative's staleness is checked against. |
| `Case` | Case of one host | `severity` (`low` to `critical`), `status` (`open`, `investigating`, `resolved`, `false_positive`). Deleting a case sets its detections' `caseId` to null; evidence is never deleted with a case. |
| `FleetCase` | Cross-host case | Written only by `join-fleet-cases`; rebuildable from the detections. `severity` is the highest of its detections and never decreases. |
| `FleetCaseEntity` | Tenant, kind and key | A `sha256` or `identity` a fleet case joined on. Unique per tenant, so a later sighting grows the existing fleet case instead of opening another. |
| `CaseNarrative` | Generated narrative | Append-only: text, citations (detection id and claim), model, provider label, prompt version and who generated it. |

### Prevalence

| Model | One row per | Notes |
| --- | --- | --- |
| `PrevalenceSighting` | Tenant, kind, key and agent | `kind` is `sha256`, `image_path`, `transition` or `domain`. First seen, last seen and a count. "Seen on N hosts" is a count of rows for a key, so it is exact. |
| `CommonSetSnapshot` | Tenant | The latest signed common-set snapshot: the Bloom filter bytes (`artifact`), the signed `manifest` and the build parameters. Replaced by each build. |

### Hunting

| Model | One row per | Notes |
| --- | --- | --- |
| `Hunt` | Saved hunt | `query` is a validated, versioned structured query, never SQL. `version` increases on every change to the query. `scheduleMinutes` null means manual only. |
| `HuntRun` | Run of a hunt | Append-only. The query as it ran, match and new-match counts, up to 100 sample detection ids, and an error when the run failed. The newest 100 runs per hunt are kept. |

### Content and releases

| Model | One row per | Notes |
| --- | --- | --- |
| `ContentRelease` | Tenant, ring and version | Points at a signed content manifest (`manifestUrl`, `manifestSha256`). `status` is `active`, `halted` or `rolled_back`. |
| `BinaryRelease` | Tenant, ring and version | Points at a signed binary release manifest. `status` is `active` or `halted`. |
| `CorpusVersion`, `CorpusSample` | Corpus version, sample | Benign telemetry samples per tenant, finalized into a JSONL export. |

### Notifications

| Model | One row per | Notes |
| --- | --- | --- |
| `NotificationChannel` | Webhook | URL and signing secret sealed with AES-256-GCM (`*Sealed`, `*KeyId`), the previous secret during a 24-hour rotation overlap, the subscribed events and hunts, `status` (`active`, `paused`, `disabled`), a per-subject cooldown and the last delivery outcome. |
| `NotificationState` | Channel and subject | The host state (`healthy`, `degraded`, `silent`) this channel was last told about this agent, so transitions are found per channel. |
| `Notification` | Channel and event | The outbox. `seq` increases per channel and subject so receivers can order events. Lease fields (`lockedUntil`, `leaseId`) let one delivery tick own a row; `deliveredAt` or `failedAt` closes it. |

### Telemetry archive

| Model | One row per | Notes |
| --- | --- | --- |
| `LakeBatch` | Accepted event batch | The queue between ingest and the Parquet writer, filled only while the archive is on. `flushId` assigns a batch to one flush before any file is written, so a retried flush rewrites the same files. |
| `LakeDeletion` | Deleted `date=` partition | Written before a retention deletion (object count, bytes, a SHA-256 over the listing) and completed after it. No relation to `Tenant`, so the record outlives the tenant it is about. |

### Audit and authentication

| Model | Notes |
| --- | --- |
| `AuditLog` | Tenant, user (`system` for jobs), action, resource and JSON details of every administrative change. Actions are listed in [`AuditAction`](../lib/audit.ts). |
| `User`, `Session`, `Account`, `Verification`, `Organization`, `Member`, `Invitation` | better-auth's tables (`auth_*`), with its own model and field names. `Member.role` holds the tenant role. A better-auth upgrade can require new fields; [`tests/integration/console-auth.test.ts`](../tests/integration/console-auth.test.ts) fails when one is missing. |

## Applying the schema

There are no migration files: `prisma/migrations/` is ignored by Git, and every environment
applies the schema with `prisma db push`.

- The Compose stack runs `npx prisma db push --skip-generate` before starting the application.
- CI and [`scripts/run-tests.sh`](../scripts/run-tests.sh) push the schema to a fresh test
  database with `--accept-data-loss`.
- Outside Docker, run `npx prisma db push` after changing the schema, and `npx prisma generate`
  to update the client. In the Compose stack, rebuild the image (`docker compose build server`)
  so the client inside it matches.

A change that cannot be applied without losing data stops `db push` unless `--accept-data-loss`
is given. Because there is no migration path, upgrading a server with data in it may require
resetting the database; this is part of what "alpha" means for the server.

At start-up the server checks that the `decoy_tokens` table exists and logs an error if it does
not ([`checkDecoyTable`](../lib/decoy.ts)), since a missing table would otherwise only show when
a decoy is first used.

## Growth and retention

| Data | Bound |
| --- | --- |
| `AgentHealth`, `CommonSetSnapshot` | One row per agent / tenant. |
| `PrevalenceSighting` | `prune-prevalence` deletes sightings not renewed for `PREVALENCE_RETENTION_DAYS` (180) and caps each tenant at `PREVALENCE_MAX_ROWS_PER_TENANT` (5,000,000), oldest seen first. Keys are capped at 1024 characters. |
| `IngestStat` | Kept 14 days, pruned by `prune-prevalence`. |
| `HuntRun` | Newest 100 per hunt, pruned by `run-hunts`. |
| `Notification` | Delivered rows kept 30 days, failed rows 90, pruned by `deliver-notifications`. |
| `LakeBatch` | Drained by `write-lake`. Unbounded if the archive is on and the job is not scheduled. |
| Parquet archive | `prune-lake` deletes partitions older than the tenant's `lakeRetentionDays`. |
| `Detection`, `Case`, `FleetCase`, `CaseNarrative`, `AuditLog`, `DecoyToken` | Not pruned. |
| Content artifacts on disk | `prune-artifacts` deletes artifacts no content release lists. |
