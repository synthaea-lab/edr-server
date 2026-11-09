# Agent protocol

How an agent becomes known to the server, how the server recognizes it on every request, and
what each agent endpoint accepts and answers. The agent's side of the same channel (spooling,
retries, back-off) is described in the agent's
[transport documentation](https://github.com/synthaea-lab/agent/blob/main/docs/transport.md).

## Enrollment and identity

An agent is identified by the **common name (CN) of its client certificate**. There is no
token, no API key and no agent-chosen identifier: the `agent_id` field an agent puts in a body
is ignored.

Enrolling is an administrative act on the console side. A tenant `owner` or `admin` registers
the certificate's CN as an enrollment ID:

```http
POST /api/enrollment
Content-Type: application/json
Cookie: <session>

{ "enrollmentId": "agent-test-001", "hostname": "lab-vm-01", "version": "0.1.0" }
```

[`app/api/enrollment/route.ts`](../app/api/enrollment/route.ts) creates the `agents` row in the
caller's tenant, in ring `prod` by default, and writes an `enrollment.create` audit row. It
answers:

| Answer | When |
| --- | --- |
| `200 { status: "enrolled", agentId, ring }` | A new agent row was created. |
| `200 { status: "already_enrolled", agentId, ring }` | The ID is already enrolled in the caller's tenant. |
| `409 Enrollment id already in use` | The ID belongs to another tenant. The answer does not say which, nor return that agent's id or ring. |
| `400` | `hostname` longer than 253 characters or containing control characters, or a missing `enrollmentId`. |
| `401` / `403` | No session with an active tenant / the caller is not an owner or admin. |

`enrollment_id` is unique across all tenants, so one certificate CN can only ever name one
agent. The server does not issue certificates: the CA that signs agent certificates is the one
nginx is configured with ([Deployment](deployment.md#certificates)). An agent whose certificate
the proxy accepts but whose CN is not enrolled gets `403 Agent not enrolled` on every endpoint.

### How a request is authenticated

Every agent endpoint calls [`authenticateAgent`](../lib/agent-auth.ts) first:

1. **Proxy secret.** `X-Proxy-Secret` must equal `NGINX_PROXY_SECRET`, compared in constant
   time ([`verifyProxyAuth`](../lib/tenant.ts)). Without it the certificate headers below could
   have been written by any client that reached the application port. `403` otherwise, and also
   when `NGINX_PROXY_SECRET` is unset.
2. **Verified certificate.** nginx sets `X-Client-Cert-Verified` from `$ssl_client_verify` and
   `X-Client-Cert-Subject` from `$ssl_client_s_dn`, overwriting anything the client sent. The
   first must be `SUCCESS` and the second present: `401` otherwise.
3. **Enrollment ID.** The CN is taken from the subject ([`extractEnrollmentId`](../lib/tenant.ts));
   `400` if there is none.
4. **Enrolled agent.** The `agents` row with that enrollment ID gives the agent's id, tenant and
   ring; `403 Agent not enrolled` if there is none.

nginx additionally refuses `/api/ingest/`, `/api/v1/ingest/` and the download paths with `401`
before the application sees them when the client presented no valid certificate.

From then on the tenant and ring are the agent row's. No agent endpoint takes a tenant, and the
ones that take a ring check it against the row.

## Endpoints

| Purpose | Method and path | Route |
| --- | --- | --- |
| Event batch | `POST /api/ingest/events`, alias `POST /api/v1/ingest/events` | [`ingest/events`](../app/api/ingest/events/route.ts) |
| One detection | `POST /api/ingest/detection` | [`ingest/detection`](../app/api/ingest/detection/route.ts) |
| Heartbeat and health beacon | `POST /api/ingest/heartbeat`, alias `POST /api/v1/ingest/heartbeat` | [`ingest/heartbeat`](../app/api/ingest/heartbeat/route.ts) |
| Decoy credential hashes | `POST /api/ingest/decoy` | [`ingest/decoy`](../app/api/ingest/decoy/route.ts) |
| Content manifest | `GET /api/content/manifest/{ring}` | [`content/manifest/[ring]`](../app/api/content/manifest/[ring]/route.ts) |
| Content artifact | `GET /api/content/artifact?path=&sha256=` | [`content/artifact`](../app/api/content/artifact/route.ts) |
| Release manifest | `GET /api/release/manifest` | [`release/manifest`](../app/api/release/manifest/route.ts) |
| Release artifact | `GET /api/release/artifact?release_version=&path=&sha256=` | [`release/artifact`](../app/api/release/artifact/route.ts) |
| Key-rotation manifest | `GET /api/release/key-rotation` | [`release/key-rotation`](../app/api/release/key-rotation/route.ts) |
| Common-set snapshot | `GET /api/snapshot/manifest`, `GET /api/snapshot/artifact?sha256=` | [`snapshot/*`](../app/api/snapshot) |

The `v1` aliases re-export the same handlers: the agent's compiled-in event path carries the
version prefix. The download endpoints are described in
[Content and releases](content-and-releases.md); the rest of this page covers ingest.

### Status codes and retries

The agent keeps an upload in its spool until it gets a `2xx`. The server's answers are chosen
with that in mind:

- **`2xx`** means the server has taken responsibility for the data: stored, or, for events with
  the archive on, durably queued.
- **`4xx`** means the request will never succeed as sent (malformed, oversized, not enrolled).
  An agent does not retry it, so the server answers `4xx` only for faults of the request itself,
  and cuts agent-controlled text rather than refusing it wherever a process on the host could
  choose that text (see [Detections](#detections)).
- **`5xx`** means "try again". Work that is not essential to the upload (prevalence counters,
  `last_seen`, ingest statistics) is best effort and never turns an accepted upload into a `5xx`,
  which would make the agent resend data the server already has.

### Events

`POST /api/ingest/events` takes one batch from the agent's event spool:

```json
{ "agent_id": null, "events": [ { "type": "exec", "ts": 1730000000000000000, "...": "..." } ] }
```

| Limit | Value | Answer past it |
| --- | --- | --- |
| Body, counted on the bytes read | 4 MiB (`MAX_BODY_BYTES`) | `413` |
| nginx body limit on the ingest paths | 8 MiB | `413` from nginx |
| Events per batch | 1000 (`MAX_EVENTS_PER_BATCH`; the agent sends 100) | `413` |

The body must be JSON with an `events` array (`400` otherwise). An entry that is not an object
with a string `type` is skipped and counted, not a reason to refuse the batch: one bad event
would otherwise make the agent retry the whole segment forever. For each accepted event the
route:

1. reads its time ([`eventTime`](../lib/event-time.ts)) and the observations prevalence counts
   (file hash, image path, parent-child transition, domain;
   [`extractObservations`](../lib/prevalence.ts));
2. with the telemetry archive on, queues the batch, each event as the exact text received, in
   `lake_batches` ([`enqueueLakeBatch`](../lib/lake-writer.ts)). This step is not best effort: if
   it fails the route answers `500` and the agent keeps its segment;
3. upserts the batch's prevalence sightings in one statement, best effort;
4. updates `agents.last_seen` and the hourly ingest statistics, best effort.

It answers `{ "accepted": <n>, "batch_id": "<uuid>" }`, the shape the agent's uploader reads.
With the archive off, events are counted into prevalence and statistics and then dropped. An
event sent twice (a `2xx` lost on the way back, then a resend) is counted and archived twice.

### Detections

`POST /api/ingest/detection` takes one detection, in either of two wire formats validated by
[`parseDetectionPayload`](../lib/detection-payload.ts):

- **Structured** (current agents): the agent's `Detection` JSON with `timestamp_ns`, `severity`,
  `title`, `source` (one of the `rule`, `sigma`, `ml`, `correlator`, `yara` or `ioc` engines,
  each with its own identifying fields), `score`, `attributions`, `techniques` and `events`
  (the triggering event first, then the evidence).
- **Legacy** (older agents): `timestamp_ns`, `technique`, `severity`, `event` and `meta`.

Both are projected onto one row: `detections.event` holds the first triggering event and
`detections.meta` the title, source, score, attributions, techniques and further events.
`detections.technique` is the first listed technique, or the engine name when there is none.

Bounds depend on who controls the field:

- **Fields shipped content controls** (rule IDs, model IDs, feed labels, techniques) are refused
  with `400` when oversized or malformed: an oversized one is a bug or a forged payload.
  Techniques must match `[A-Za-z0-9._-]{1,64}`, at most 16 of them.
- **Fields a monitored process controls** (the title, which embeds a command line, and the
  correlator's case ID) are cut, never refused, so a process cannot pad its own command line until
  its detections stop reaching the server. The title keeps its head and tail around a marker
  (64 KiB), so padding cannot push the payload out of view.
- **Event trees** are cut to 128 events, 64 KiB per string and 32 Ki items per array; nesting
  deeper than 16 levels, keys longer than 128 bytes or more than 256 keys in one object are
  refused as forged. NUL characters, which PostgreSQL's `jsonb` cannot store, are replaced.
  Whenever anything was cut, here or by the agent before upload, `meta.events_cut` records what,
  so an analyst knows the evidence is partial.

**Idempotency.** An agent sends a UUID `Idempotency-Key` header, generated when the detection is
spooled and reused on every retry. `(agent_id, ingest_id)` is unique, and the row stores a
SHA-256 of the body. A replay with the same key and the same body answers `200` without a second
row; the same key with a different body answers `409`. Detections without the header (older
agents) are stored as they come.

After the insert, the route records the event's prevalence observations and updates `last_seen`,
both best effort, and answers `{ "status": "accepted" }`. The detection has no case yet: the
[`group-detections`](scheduled-jobs.md) job assigns one.

### Heartbeats and health beacons

`POST /api/ingest/heartbeat` first updates `agents.last_seen`; that alone is the liveness signal
the silent-agent job reads. It then tries to store the beacon in the body,
`{ "agent_id": ..., "beacon": { ... } }`, validated by [`HealthBeacon`](../lib/health-beacon.ts):
agent version, per-sensor pulse counts and silence, spool size, loss counters, and the rarity,
self-protection and IOC engine counters. Counters added after an agent was released default to
zero, so an older agent's beacon is still stored.

A missing or malformed beacon never fails the heartbeat. One row per agent in `agent_health`
holds the latest beacon. A beacon older than the stored one is dropped. Loss is recognized as a
loss counter (`spool_dropped` or `enrich_dropped`) rising between two beacons, stamped with the
server's clock ([`nextLossObservedAt`](../lib/fleet-health.ts)); a counter that falls is an agent
restart, not loss.

The answer is `{ status: "ok", agentId, ring, lastSeen }`. From these rows
[`fleetStatus`](../lib/fleet-health.ts) derives each agent's state on the operations page:

| State | Meaning |
| --- | --- |
| `silent` | No heartbeat for 5 minutes. |
| `degraded` | Heartbeating, but a sensor reports silent or a loss counter rose in the last 10 minutes. |
| `no_beacon` | Heartbeating, but no beacon stored (an older agent, or rejected beacons). |
| `healthy` | Otherwise. |

### Decoy credentials

Agents plant fake credentials (tokens beginning `syn_dk_`) in canary files and register only
their SHA-256 with `POST /api/ingest/decoy`:

```json
{ "tokens": ["<64 hex>", "..."] }
```

Registration is idempotent and capped at 256 hashes per agent (`409` past it). A hash belongs to
every agent that registers it, so an agent that read another's decoy cannot take its hash over.
The server never sees a token in clear and cannot issue one.

The alarm side is on the bearer-authenticated routes: when a request to `/api/cron/*` presents a
bearer that has the decoy shape and whose hash is registered,
[`reportDecoyUse`](../lib/decoy.ts) records a `high` severity detection (technique `T1552.001`)
against each agent that planted it, naming the host and the address nginx saw. The check runs after the `401` is ready, so
a decoy and any other wrong bearer take the same time to refuse, and alarms are limited to one per
decoy and address per minute. See [Security model](security-model.md#decoy-credentials).

## Ingest statistics

Every request that identified an enrolled agent is counted in `ingest_stats`, per agent, kind
(`events`, `detection`, `beacon`) and hour: items received, accepted and skipped, refusals by
status, and the lag between event time and receipt ([`recordIngest`](../lib/ingest-stats.ts)).
A refusal before the agent is known (bad proxy secret, no certificate, unknown CN) has no agent
to count against. The operations console reads these rows; they are kept 14 days and pruned by
the `prune-prevalence` job.
