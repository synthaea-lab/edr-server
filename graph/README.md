# Entity graph

The entities the fleet's telemetry mentions (hosts, processes, files by hash or path, network
endpoints, domains and identities) and the relations between them (`spawned`, `opened`,
`connected_to`, `resolved`, `logged_in`, `ran_on`). The graph backs cases, cross-host
correlation, hunting pivots and prevalence.

## How it works

The graph is **computed on read**, not stored. `lib/graph.ts` holds two pure functions:

- `caseSubgraph` folds a case's detection events (`exec`, `file_open`, `connect`, `dns_query`,
  `session`) into deduplicated nodes and edges. Served by `GET /api/cases/[id]/graph`.
- `hashPivot` turns the prevalence sightings of one file hash, image path or domain into a subject
  node and one host node per agent that showed it. Served by `GET /api/graph/pivot?kind=&key=`,
  with `truncated: true` when the host list was capped.

A file is keyed the same way in both (`sha256:<hash>` or `path:<normalized path>`), so a pivot
node and a case node for the same file are the same node.

Because nothing is persisted, the graph cannot drift from the rows it is computed from, and
recomputing it gives the same result whatever order the rows are read in;
`tests/unit/graph.test.ts` checks this.

## Limits

- The graph is only as complete as what is stored: an event that fired no rule appears only
  through the prevalence counts.
- It cannot be computed as of a past date.

A materialized graph built from the [telemetry archive](../datalake/README.md) is the natural next
step when a consumer needs history or the read-time cost grows.

Tests: `tests/unit/graph.test.ts`, `tests/integration/graph.test.ts`.
