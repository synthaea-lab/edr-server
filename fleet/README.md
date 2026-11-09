# Cross-host correlation

Detections on one machine change how the rest of the fleet is read.

**Built: fleet cases.** The `join-fleet-cases` scheduled job joins cases of different agents into
one fleet case when their detections share an executed file hash or a signed-in identity within
24 hours. The join is deliberately narrow, because an attacker who can make a detection fire could
otherwise link hosts they do not control: generic accounts such as `root` or `SYSTEM` are not
joined on, nor is a hash that most of the fleet runs, nor an entity seen on too many agents. Fleet
cases are listed at `/console/fleet-cases`.

**Planned: adaptive posture.** A fleet case above a severity threshold would raise the alertness of
a computed set of related hosts (same subnet, same identity, recent lateral peers) through a signed
policy overlay: lower model thresholds, wider telemetry, a shorter heartbeat interval. A posture
only ever heightens, never disables, and expires on its own, enforced by the server.

Code: `lib/fleet-case.ts`, `app/api/cron/join-fleet-cases/`, `app/api/fleet-cases/`,
`app/console/fleet-cases/`. Tests: `tests/unit/fleet-case.test.ts`,
`tests/integration/join-fleet-cases-cron.test.ts`, `fleet-cases-console.test.ts`.
