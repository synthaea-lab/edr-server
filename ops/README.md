# Fleet operations

The operator's view of the fleet, at `/console/ops`: an EDR that cannot see its own health
degrades silently.

Built:

- **Agent health.** Status per agent (healthy, degraded, silent), version, ring, last check-in and
  silent sensors, from heartbeats and health beacons.
- **Ingest health.** Per-agent upload volume, malformed entries dropped, and the loss the agent
  reports.
- **Rollout control.** The status of each content ring, with halt and rollback for a tenant owner
  or admin. Every action is audited.

Planned: alerting on telemetry-loss anomalies (a host that stops losing events and stops sending
is a tamper signal) and per-tenant ingest quotas.

Code: `app/console/ops/`, `app/api/ops/`, `lib/fleet-health.ts`, `lib/ingest-stats.ts`,
`lib/rings.ts`, `lib/ring-actions.ts`. Tests: `tests/integration/fleet-health.test.ts`,
`ops-ring-controls.test.ts`, `ring-status.test.ts`.
