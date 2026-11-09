# Fleet prevalence

How common is this file hash, process path, parent-child pair or domain on this fleet? Rarity is
one of the cheapest and most valuable detection signals, and the fleet-derived half of it is
something an attacker cannot reproduce offline.

## Built

- **Counters.** One row per tenant, kind, key and agent, with first-seen, last-seen and an event
  count, so "seen on N hosts" is exact. Kinds: `sha256`, `image_path`, `transition`
  (`parent -> child`) and `domain`. Windows paths and domains are case-insensitive keys; POSIX
  paths are not. Keys are capped at 1024 characters.
- **Fed by every upload.** `POST /api/ingest/events` and `POST /api/ingest/detection` record the
  observations of each event, one upsert per batch. First-seen only moves earlier and last-seen
  later, so a spool flushed after an outage cannot make anything look newer. A counter failure
  never rejects an upload.
- **Read.** `GET /api/prevalence?kind=&key=` (tenant-scoped) and, on every case page, a line under
  each detection: "seen on N hosts, first seen <date>", rarest first. The count includes the host
  that raised the detection, so "seen on 1 host" means only this host.
- **Retention.** The `prune-prevalence` job, run daily, drops sightings not renewed for
  `PREVALENCE_RETENTION_DAYS` (default 180) and, for a tenant over
  `PREVALENCE_MAX_ROWS_PER_TENANT` (default 5,000,000), the oldest-seen rows. Agents choose their
  own paths and domains, so without a bound the table would grow with every key anyone can invent.
- **Common-set snapshot.** The `build-snapshots` job builds, for each tenant, a signed Bloom filter
  of the hashes seen on enough hosts, which agents download over mTLS (`/api/snapshot/manifest`,
  `/api/snapshot/artifact`) and use as a weak "not in the common set" signal. Signing is off
  unless `SYNTHAEA_SNAPSHOT_SIGNER=test`, which uses a public test key for lab use only.
- **Recompute from the archive.** `rebuildSightings` (`lib/prevalence-rebuild.ts`) recomputes the
  counters from the [telemetry archive](../datalake/README.md) with the same functions ingest uses,
  and `compareSightings` reports the differences with the table. It reads and compares only;
  nothing rewrites the table. A rebuild cannot reach events the archive dropped or deleted.

## Not decided

Opt-in global (cross-tenant) prevalence, which would only ever be aggregated, k-anonymous
statistics. Per-tenant data stays per-tenant.

Code: `lib/prevalence.ts`, `lib/fleet-prevalence.ts`, `lib/common-set-snapshot.ts`,
`lib/snapshot-publish.ts`, `app/api/prevalence/`. Tests: `tests/integration/prevalence*.test.ts`,
`snapshot-delivery.test.ts`, `tests/unit/common-set-snapshot.test.ts`.
