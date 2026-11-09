# Attack disruption

**Status: planned.** Nothing in this area is built yet.

Automated, case-level containment: when a case crosses a confidence threshold and policy allows,
the control plane runs a disruption playbook scoped to the case, at machine speed rather than as a
human reaction to a single alert.

Planned actions, each gated by policy, audited and reversible where possible:

- **Isolate device.** Network isolation carried out by the agent (only control-plane traffic
  allowed), for every host in the case.
- **Suspend user.** Disable or step up the implicated identity through directory connectors such
  as Entra ID, Active Directory or Okta.
- **Block indicators.** Push the case's hashes, domains and addresses to the fleet as IOC sets.
- **Quarantine artifacts.** Case-wide quarantine of dropped files by the agent.

Design rule: disruption composes response actions the agent already has. This module owns the
decision (case threshold and policy) and the orchestration (fan-out, rollback, audit), never a new
endpoint capability.
