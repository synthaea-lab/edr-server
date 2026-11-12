# Telemetry archive

The full-fidelity store of the events agents upload. PostgreSQL stays the system of record for
detections, cases and policy; the archive keeps raw telemetry at scale: columnar, partitioned by
tenant, day and event type, and retention-managed. It is optional and off by default.

It serves [hunting](../hunt/README.md) over event history and lets the
[prevalence](../prevalence/README.md) counters be recomputed from events; it is also the
substrate planned for [cloud-side detection](../cloud-detection/README.md).

## How it works

- **Queue.** When the archive is on, `POST /api/ingest/events` queues each accepted batch in the
  `lake_batches` table.
- **Writer.** The `write-lake` scheduled job drains up to `LAKE_WRITER_MAX_BATCHES` batches
  (default 200) per call into Parquet files (Snappy compression) at
  `tenant=<id>/date=<YYYY-MM-DD>/type=<event_type>/<flush>.parquet`. A flush that fails is retried
  under the same file names, so a retry replaces its files instead of adding a copy. The response
  reports `remaining`: a number that keeps growing means the schedule does not keep up. The job
  answers `503` while the archive is off.
- **File contents.** Columns `agent_id`, `ts`, `comm`, `path`, `image_path`, `daddr`, `query`,
  `sha256` and `event`, the event's source text as the agent sent it. Tenant, date and type are in
  the path. An event type outside `[a-z][a-z0-9_]{0,63}` is stored under `type=other`.
- **Retention.** `tenants.lake_retention_days` (default 90) sets each tenant's retention; `0` keeps
  nothing. The writer drops events already past retention, so a deleted day never refills. The
  `prune-lake` job, run daily, deletes every `date=` partition that has reached its tenant's
  retention.
- **Audited deletion.** Each deletion writes a `lake_deletions` row before it starts (file count,
  bytes, a SHA-256 over the listing) and completes it afterwards from what the store lists:
  files deleted, files remaining, whether the starting listing is gone (`verified_empty`) and
  `completed_at`. A row with `completed_at` unset is a deletion that never finished. A failure on
  one partition is recorded and the run continues; the job answers `500` when any partition was not
  fully deleted. A `tenant=` prefix with no matching tenant is left in place and reported as
  `orphanTenantPrefixes`. The audit row covers the store itself, not a provider's backups.
- **Reading.** `queryLake` (`lib/lake-query.ts`) reads one tenant's events over a range of days
  (at most 366) with optional type and exact-match filters, listing one day at a time so history
  outside the range is never touched. Every key read is checked against the tenant, day and type
  asked for. It reads with `hyparquet`, in process; this is sized for a hunt over days on one
  tenant and has not been measured at fleet volume.

## Configuration

Set exactly one of `LAKE_DIR` or `LAKE_S3_BUCKET` to turn the archive on; setting both is refused.

| Variable | Meaning |
| --- | --- |
| `LAKE_DIR` | A directory, such as a mounted volume. Files are written under a temporary name and renamed. |
| `LAKE_S3_BUCKET` | An S3-compatible bucket. |
| `LAKE_S3_ENDPOINT` | A custom endpoint for S3-compatible servers; unset for AWS S3. |
| `LAKE_S3_REGION` | Default `us-east-1`. |
| `LAKE_S3_ACCESS_KEY_ID`, `LAKE_S3_SECRET_ACCESS_KEY` | The writer's credentials, both or neither. Neither uses the SDK's default credential chain. |
| `LAKE_S3_READER_ACCESS_KEY_ID`, `LAKE_S3_READER_SECRET_ACCESS_KEY` | The reader's credentials, both or neither. The reader never falls back to the writer's variables. |
| `LAKE_S3_PREFIX` | A key prefix inside the bucket, to share it. |
| `LAKE_S3_FORCE_PATH_STYLE` | `true` or `false`; defaults to `true` when an endpoint is set. |
| `LAKE_WRITER_MAX_BATCHES` | Batches one `write-lake` call drains (default 200). |

On S3:

- **The bucket must not be versioned.** On a versioned bucket a delete leaves the bytes behind, so
  an audit row would report an empty prefix whose objects still exist. The retention job checks
  the bucket's versioning status before each run and answers `500` if versioning is enabled or
  suspended, or if the status cannot be read.
- **Writer permissions:** put, list, delete and `s3:GetBucketVersioning`.
- **Reader permissions:** give the reader its own read-only pair (`s3:ListBucket`,
  `s3:GetObject`), ideally limited to a tenant prefix by a bucket policy. Without a reader pair the
  reader uses the SDK's default chain, which may hold write rights; the server logs a warning
  (naming the variables, never their values) on the first archive search.

The development compose file does not include an object store; point `LAKE_S3_*` at one you run.

## Limits

- No compaction: every drain writes new small files.
- No bound on the queue: with the archive on and `write-lake` not scheduled, `lake_batches` grows
  without limit. `/console/ops` shows the tenant's queue (batches, events, age of the oldest) while the
  archive is on, and flags it past 15 minutes; it is shown, not alerted on, and bounds nothing.
- An event an agent sends twice (a lost `2xx`, then a resend) is stored twice.
- Ingest parses JSON as double-precision numbers, so integers above 2^53 in typed fields are
  rounded; the `event` column keeps the original text.

Code: `lib/lake-*.ts`, `app/api/cron/write-lake/`, `app/api/cron/prune-lake/`. Tests:
`tests/integration/lake-*.test.ts`; the S3 tests use an in-memory bucket.
