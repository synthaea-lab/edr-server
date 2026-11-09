# Synthaea Server

The self-hosted control plane of [Synthaea](https://www.synthaea.com), an open-source EDR/XDR for
Linux, Windows and macOS. Agents connect to it over mutual TLS and upload their detections,
telemetry and health. Analysts triage cases in a web console. Operators roll detection content
and agent releases out to the fleet by rings.

The agent detects on the device and keeps working without a control plane. The server adds what
needs the whole fleet in view: cases across hosts, prevalence, hunting over history, and rollout
control. There is no Synthaea cloud: you run the server yourself.

> [!WARNING]
> **Status: alpha.** The server runs as a development stack with Docker Compose. It is not
> hardened for production, and its API and database schema change without a migration path. Run
> it on a lab network and do not expose it to the internet.

## Features

Built today:

- **Agent ingest.** mTLS endpoints for event batches, detections and heartbeats. Agents register
  the decoy credentials they plant, and any request that presents one raises an alarm. An agent
  that stops sending heartbeats opens a case.
- **Cases.** Detections are grouped into cases per host and joined into fleet cases when hosts
  share a file hash or a signed-in identity. The case page shows the fleet prevalence of what
  each detection touched and an optional narrative written by an LLM over the case's evidence
  (any OpenAI-compatible endpoint; a local Ollama by default). The API also returns a case's
  entity graph and pivots from a file or domain to every host that showed it.
- **Fleet prevalence.** First-seen, last-seen and host counts for file hashes, image paths,
  parent-child pairs and domains, fed by every uploaded event.
- **Hunting.** Saved and scheduled hunts over detections, search over cases and the telemetry
  archive, and draft Sigma rules or IOC sets built from a hunt's matches.
- **Content and releases.** Signed content manifests and agent releases served per ring, with
  halt and rollback from the console, and IOC feeds imported from CSV, MISP and STIX.
- **Telemetry archive.** An optional Parquet archive on a local directory or an S3-compatible
  bucket, with per-tenant retention and an audit row for every deletion.
- **Notifications.** Signed HTTPS webhooks for host health changes and new hunt matches.
- **Multi-tenancy.** Every record belongs to a tenant; console users authenticate with
  [better-auth](https://www.better-auth.com) and act through their role in the tenant.

Planned: a DFIR workbench, case-level attack disruption, cloud-side and retrospective detection,
ticketing and paging integrations, and SIEM forwarding. The [module notes](#documentation)
describe each area and what is built.

## Architecture

```text
 agents ──mTLS──▶ nginx :8443 ──▶ Next.js app ──▶ PostgreSQL
                  (verifies the     (ingest, API,   (system of record)
                   client cert)      console)  └──▶ telemetry archive (optional:
                                                     directory or S3 bucket)
```

One Next.js application (App Router, TypeScript) serves the agent endpoints, the management API
and the console. nginx terminates the agents' mTLS and passes the verified certificate subject to
the application, which identifies an agent by its certificate's common name. Console sessions and
agent identity are separate: users sign in with better-auth, agents authenticate only with their
enrollment certificate.

## Quick start

Requirements: Docker with Compose v2, Git, OpenSSL and a Bash shell. On Windows, run the commands
in WSL.

```bash
git clone https://github.com/synthaea-lab/server.git
cd server
./scripts/generate-dev-certs.sh
docker compose up --build
```

This starts PostgreSQL, the application and the mTLS proxy, which listens on port 8443. The
certificate script writes a development CA, the proxy's certificate and a test agent certificate
(`CN=agent-test-001`) to `certs/`. Check the stack from another terminal:

```bash
curl --cacert certs/ca.crt https://localhost:8443/api/health
```

[README-SETUP.md](README-SETUP.md) continues from here: opening the console, creating the first
account and tenant, enrolling an agent, reaching the stack from a lab VM, and every configuration
variable.

To connect an agent, follow
[Standalone or with a control plane](https://www.synthaea.com/en/docs/standalone-and-control-plane)
in the documentation.

## Documentation

- [Project documentation](https://www.synthaea.com/en/docs): installing and configuring the agent and
  the control plane.
- [README-SETUP.md](README-SETUP.md): the development stack, first sign-in, enrollment and
  configuration reference.
- [CONTRIBUTING.md](CONTRIBUTING.md): building, testing and submitting changes.
- Module notes, one per functional area. The code itself lives in `app/`, `lib/` and `prisma/`.

  | Area | Notes |
  | --- | --- |
  | Agent ingest | [ingest/](ingest/README.md) |
  | Fleet operations and rollout | [ops/](ops/README.md) |
  | Telemetry archive | [datalake/](datalake/README.md) |
  | Fleet prevalence | [prevalence/](prevalence/README.md) |
  | Entity graph | [graph/](graph/README.md) |
  | Threat hunting | [hunt/](hunt/README.md) |
  | Cross-host correlation | [fleet/](fleet/README.md) |
  | Analyst assistant | [assistant/](assistant/README.md) |
  | Notifications and integrations | [integrations/](integrations/README.md) |
  | Cloud-side detection (planned) | [cloud-detection/](cloud-detection/README.md) |
  | DFIR workbench (planned) | [forensics/](forensics/README.md) |
  | Attack disruption (planned) | [disruption/](disruption/README.md) |

## Related repositories

| Repository | Relation to the server |
| --- | --- |
| [agent](https://github.com/synthaea-lab/agent) | The endpoint agent that enrolls with and reports to the server |
| [rules](https://github.com/synthaea-lab/rules) | Detection content the server distributes to the fleet |
| [ml](https://github.com/synthaea-lab/ml) | The ML pipeline; the server's contract tests read its common-set snapshot fixture |
| [scenarios](https://github.com/synthaea-lab/scenarios) | Benign attack scenarios that validate detection end to end |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and
test suites. Every commit carries a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off (`git commit -s`); there is no CLA.

## Security

Do not report vulnerabilities in public issues. Use GitHub private vulnerability reporting on this
repository (*Security*, then *Report a vulnerability*) and see the
[security policy](https://github.com/synthaea-lab/.github/blob/main/SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
