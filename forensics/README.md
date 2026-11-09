# DFIR workbench

**Status: planned.** Nothing in this area is built yet.

Deep-dive investigation on top of a case, for when triage needs more than the correlated evidence.

- **Triage acquisitions.** Collection packages from an endpoint: process listing, persistence
  points, browser artifacts, prefetch and shimcache on Windows, shell history, targeted file and
  memory-region grabs. Acquisitions ride the agent's live-response channel and its policy and audit
  gates; forensics adds packages and parsing, never a second remote-access mechanism.
- **Timeline.** One filterable timeline per case: sensor events, detections, acquired artifacts and
  analyst annotations.
- **Artifact parsing.** Server-side parsers turn raw acquisitions into structured, searchable
  records attached to the case and to the entity graph.
- **Evidence integrity.** Acquisitions are hashed at collection and stored immutably, and the chain
  of custody (who collected what, when and from where) is part of the case's audit record.
