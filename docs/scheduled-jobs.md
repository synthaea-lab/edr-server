# Scheduled jobs

The server has no background worker. Everything that is not a direct answer to a request (case
grouping, silent-agent detection, notification delivery, archive writes, retention, snapshot
builds) runs when an external scheduler calls a route under `/api/cron/`. Each call does a bounded
amount of work and answers with what it did, so a backlog drains over several calls and a
scheduler or monitoring system can read progress from the responses.

## Calling a job

Every job is a `GET` with the `CRON_SECRET` as a bearer token:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://cp.example/api/cron/group-detections
```

[`verifyCronRequest`](../lib/cron-auth.ts) compares the header in constant time. With
`CRON_SECRET` unset every call answers `500`, and a wrong bearer answers `401`. A wrong bearer
that is one of an agent's decoy credentials also raises an alarm
([Security model](security-model.md#decoy-credentials)). Through the proxy, `/api/cron/` is
limited to 10 requests per second per client address, burst 20.

Any scheduler that can send an HTTP request works: cron with `curl`, a systemd timer, a
Kubernetes `CronJob`. A crontab covering every job:

```cron
* * * * *    curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/detect-silent-agents
* * * * *    curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/group-detections
* * * * *    curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/deliver-notifications
*/5 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/join-fleet-cases
*/5 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/check-ring-health
*/5 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/run-hunts
*/5 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/write-lake
30 3 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/prune-lake
40 3 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/prune-prevalence
50 3 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/prune-artifacts
0 4 * * *    curl -fsS -H "Authorization: Bearer $CRON_SECRET" $CP/api/cron/build-snapshots
```

`write-lake` and `prune-lake` answer `503` while the telemetry archive is off, and
`build-snapshots` while no snapshot signer is configured; leave them out of the schedule in that
case.

## The jobs

| Route | What it does | Interval |
| --- | --- | --- |
| [`detect-silent-agents`](../app/api/cron/detect-silent-agents/route.ts) | Opens a `high` case `Agent Silent: <host>` for every agent with no heartbeat for 5 minutes, unless an open case already names it ([`silent-agent-case.ts`](../lib/silent-agent-case.ts)). | Every minute |
| [`group-detections`](../app/api/cron/group-detections/route.ts) | Assigns ungrouped detections to cases: same agent, same or related ATT&CK technique, within 30 minutes of the case's earliest detection; otherwise opens a case ([`case-grouping.ts`](../lib/case-grouping.ts)). Up to 500 detections per tenant per call. | Every minute |
| [`join-fleet-cases`](../app/api/cron/join-fleet-cases/route.ts) | Joins the last 7 days of detections across agents into fleet cases on a shared executed hash or identity within 24 hours, skipping generic accounts, hashes most of the fleet runs and entities seen on more than 20 agents ([`fleet-case.ts`](../lib/fleet-case.ts)). Up to 5,000 detections per tenant per call. | Every few minutes |
| [`deliver-notifications`](../app/api/cron/deliver-notifications/route.ts) | Turns host state changes into outbox rows, sends due rows with retries and back-off, and purges old rows ([`lib/notify/outbox.ts`](../lib/notify/outbox.ts)). The three phases are independent; one that fails is reported and the others still run. | Every minute (the outbox assumes a 60-second period) |
| [`check-ring-health`](../app/api/cron/check-ring-health/route.ts) | Compares each canary ring with `prod` and halts a regressing ring's content release ([Content and releases](content-and-releases.md#halt-rollback-and-auto-halt)). | Every 5 minutes |
| [`run-hunts`](../app/api/cron/run-hunts/route.ts) | Runs the scheduled hunts that are due (at most 20 per call, none started after 30 seconds), then keeps the newest 100 runs per hunt. New matches are queued as `hunt.new_matches` notifications. | Every few minutes |
| [`write-lake`](../app/api/cron/write-lake/route.ts) | Writes up to `LAKE_WRITER_MAX_BATCHES` queued event batches to Parquet and reports `remaining`. | Every few minutes, when the archive is on |
| [`prune-lake`](../app/api/cron/prune-lake/route.ts) | Deletes archive partitions past each tenant's retention, with an audit row per deletion. | Daily |
| [`prune-prevalence`](../app/api/cron/prune-prevalence/route.ts) | Applies the prevalence retention and row cap, and deletes ingest statistics older than 14 days. | Daily |
| [`prune-artifacts`](../app/api/cron/prune-artifacts/route.ts) | Deletes content artifacts no release lists, older than 24 hours; deletes nothing if a manifest cannot be read. | Daily |
| [`build-snapshots`](../app/api/cron/build-snapshots/route.ts) | Builds, checks, signs and stores each tenant's common-set snapshot. | Daily, when a signer is configured |

## Overlapping and concurrent runs

A job can be called again before the previous call finished: a slow tick, a retry, a manual run,
or several application instances behind one scheduler. The jobs are written for it.

- **Per-tenant transactions.** `group-detections` and `join-fleet-cases` run through
  [`runPerTenant`](../lib/cron/per-tenant.ts): one transaction per tenant, each with its own
  timeout and its own `pg_try_advisory_xact_lock(<job key>, hashtext(<tenant id>))`. A tenant
  whose lock another call holds is skipped, not waited for; a tenant whose transaction fails is
  counted and the loop goes on. They answer `200`, `207` when some tenants failed, and `502` when
  all of them did.
- **Idempotence.** Grouping only reads detections whose `caseId` is still null; joining fleet
  cases over the same detections changes nothing; the silent-agent job checks for an open case
  naming the agent before opening one.
- **Leases.** Notification delivery claims due rows with a 5-minute lease and a lease id that
  every outcome write names, so a tick whose lease expired cannot overwrite the result of the tick
  that took the row over.
- **Flush assignment.** The archive writer assigns batches to a flush id, committed before any
  file is written, so a retried flush writes the same files under the same names.
- **Per-tenant isolation.** `build-snapshots`, `check-ring-health` and the notification and hunt
  jobs handle one tenant's failure without stopping the others; notification delivery also serves
  tenants round-robin, at most 10 rows per tenant per tick.

## Failure signals

The status code is the signal a scheduler should alert on:

| Job | Answers other than `200` |
| --- | --- |
| Any | `401` wrong bearer, `500` `CRON_SECRET` unset or an unexpected failure |
| `group-detections`, `join-fleet-cases` | `207` some tenants failed, `502` all tenants failed |
| `deliver-notifications` | `500` when one of its phases failed (the body lists which) |
| `write-lake` | `503` archive off |
| `prune-lake` | `503` archive off; `500` before deleting anything when the S3 bucket is versioned or its versioning cannot be read; `500` with counts when a partition was not fully deleted |
| `prune-artifacts` | `500` when a manifest could not be read (nothing deleted) |
| `build-snapshots` | `503` no signer configured |
