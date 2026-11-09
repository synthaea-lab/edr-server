# Agent ingest

The endpoints enrolled agents call, behind the mTLS proxy. nginx verifies the client certificate
and the application identifies the agent by its common name; a request that did not come through
the proxy is refused.

| Route | Accepts |
| --- | --- |
| `POST /api/ingest/events` (also `/api/v1/ingest/events`) | Batches of events from the agent's spool |
| `POST /api/ingest/heartbeat` (also `/api/v1/ingest/heartbeat`) | Heartbeats and health beacons |
| `POST /api/ingest/detection` | One detection, in the agent's `Detection` JSON shape |
| `POST /api/ingest/decoy` | The SHA-256 of decoy credentials the agent planted; a later request that presents one raises an alarm |

Every uploaded event feeds [fleet prevalence](../prevalence/README.md). Events are kept only when
the [telemetry archive](../datalake/README.md) is on; otherwise they are counted and dropped.
Agents that stop sending heartbeats are detected by the `detect-silent-agents` scheduled job.

A detection's first triggering event is stored in `Detection.event`; the other events and the
structured fields (score, attributions, techniques) are kept in `Detection.meta`. The agent's own
case identifier is kept there too, but cases are formed server-side.

Code: `app/api/ingest/`, `lib/agent-auth.ts`, `lib/detection-payload.ts`, `lib/health-beacon.ts`.
Tests: `tests/integration/ingest.test.ts`, `event-ingest.test.ts`, `decoy-tokens.test.ts`.
