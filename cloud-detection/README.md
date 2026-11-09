# Cloud-side detection

**Status: planned.** Nothing in this area is built yet. The [telemetry archive](../datalake/README.md)
it will run over is built.

Detection that runs where the agent cannot: with the whole fleet's history in view and no endpoint
CPU budget. Three modes over the same content model:

- **Streaming.** Rules evaluated on the ingest path, for detections too stateful or too fleet-wide
  for the device: joins across hosts, long windows, heavy regular expressions or models.
- **Scheduled.** Periodic sweeps over the archive for low-and-slow patterns whose window (days or
  weeks) no on-device buffer can hold.
- **Retrospective.** When new content arrives (an IOC set, a rule, a model), replay it over the
  archive and report past matches as detections.

Contracts:

- Cloud detections are detection-as-code like the rest of the content: metadata, samples, tests and
  ring rollout.
- Their output is the same `Detection` record, flowing into the same cases, tagged with its
  provenance.
- Cloud detection adds to the device; it never replaces on-device detection, so offline endpoints
  stay protected.
