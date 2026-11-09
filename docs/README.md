# Server technical documentation

The server is Synthaea's self-hosted control plane: one Next.js application behind an nginx
mTLS proxy, with PostgreSQL as its system of record. Enrolled agents upload their events,
detections and health to it and download signed content, releases and snapshots from it.
Analysts triage cases in its console, and operators roll content out to the fleet by rings.

These pages explain how the server works, with links into the code that implements each
part. The root [README](../README.md) is the front page and [README-SETUP.md](../README-SETUP.md)
the hands-on guide to running the development stack; this documentation is the reference
behind them. When the code and a page disagree, fix the page in the same pull request.

> [!WARNING]
> The server is alpha software. It runs as a development stack with Docker Compose, its API
> and schema change without a migration path, and it is not hardened for exposure to the
> internet. [Deployment](deployment.md#before-the-stack-leaves-one-machine) lists what to change
> before it leaves a single machine.

## Pages

Start with the architecture, then the page for the area you are working on.

- [architecture.md](architecture.md): the process model, the three kinds of caller, the code
  layout, the functional modules and the data flows between them.
- [agent-protocol.md](agent-protocol.md): enrollment, agent identity, every agent endpoint with
  its payload, limits, status codes and retry semantics.
- [content-and-releases.md](content-and-releases.md): rings, signed content and binary
  releases, the artifact store, halt, rollback and auto-halt, IOC feed staging, key rotation and
  common-set snapshots.
- [security-model.md](security-model.md): trust boundaries, how each kind of caller is
  authenticated, roles, tenant isolation, keys and secrets, and what is not defended.
- [data-model.md](data-model.md): the PostgreSQL schema by area, tenancy in the schema, how the
  schema is applied, and what grows and how it is bounded.
- [scheduled-jobs.md](scheduled-jobs.md): the `/api/cron/*` routes, what each does, how they
  authenticate and how overlapping runs are kept apart.
- [configuration.md](configuration.md): every environment variable the server reads.
- [deployment.md](deployment.md): the Docker images, the Compose stack, the nginx proxy,
  certificates, persistent state and the exposure checklist.
- [development.md](development.md): setting up, the repository layout, conventions every change
  follows, and adding a route or a schema field.
- [testing.md](testing.md): the unit, integration, contract and acceptance suites and how to run
  them.

## Module notes

Each functional area also has a short note next to its name in the repository, stating what is
built and what is planned: [ingest](../ingest/README.md), [ops](../ops/README.md),
[datalake](../datalake/README.md), [prevalence](../prevalence/README.md),
[graph](../graph/README.md), [hunt](../hunt/README.md), [fleet](../fleet/README.md),
[assistant](../assistant/README.md), [integrations](../integrations/README.md),
[cloud-detection](../cloud-detection/README.md), [forensics](../forensics/README.md) and
[disruption](../disruption/README.md). The pages here link to them rather than repeat them.

Contribution rules (DCO sign-off, pull requests) are in [CONTRIBUTING.md](../CONTRIBUTING.md).
