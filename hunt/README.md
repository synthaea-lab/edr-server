# Threat hunting

Analyst-driven hunting: ad-hoc searches over detections, cases and the telemetry archive, saved
hunts with a schedule and a result history, and drafts of detection content built from what a hunt
found.

## Built

- **Saved hunts.** A structured, versioned query over the tenant's detections (`lastHours`,
  `techniques`, `severities`, `agentIds`, `text`; not SQL), with an owner, an optional schedule and
  a run history. API: `GET`/`POST /api/hunts`, `GET`/`PATCH`/`DELETE /api/hunts/[id]`,
  `POST /api/hunts/[id]/run`. The `run-hunts` scheduled job runs the hunts that are due and prunes
  old runs.
- **Search.** `POST /api/hunts/search` returns one page of detections, of cases (`kind: "cases"`)
  or of archived events (`source: "events"`). Detection and case searches return 50 rows a page,
  newest first, with a keyset cursor. Each tenant has at most two searches in flight across server
  instances (`429` past that), and a search that runs too long answers `504`. A row carries ids,
  times, technique, severity, the case title and the rule title, never the rest of the stored
  event. `GET /api/hunts/[id]/matches` shows what a saved hunt matches now without recording a run.
- **Event archive search.** With `source: "events"`, the search reads the
  [telemetry archive](../datalake/README.md): up to 90 days, filtered by event type and exact
  matches on `agentId`, `comm`, `path`, `imagePath`, `daddr`, `query` and `sha256`. It returns the
  newest 50 events, typed columns only, within a 10-second deadline, and answers `503` while the
  archive is off.
- **Graduation.** `POST /api/hunts/[id]/graduate` drafts a Sigma rule and its samples file from
  the hunt's latest finished run, for a person to review and propose to the
  [rules](https://github.com/synthaea-lab/rules) repository. With `{ "kind": "ioc" }` it drafts an
  IOC feed file of the hashes, addresses and domains in the matches, each annotated with its fleet
  prevalence. Nothing is written server-side.
- **Console.** `/console/hunts` lists hunts with their latest results; hunts can be created,
  edited, run, deleted and graduated from there, and `/console/hunts/search` runs ad-hoc searches.

## Not built

- Saved hunts over the event archive, a cursor over it, and a console page for it.
- Opening the rules pull request from the server, and YARA drafts.
- Live queries to an endpoint, which will use the agent's live-response channel.

Code: `lib/hunt*.ts`, `app/api/hunts/`, `app/console/hunts/`, `components/*Hunt*.tsx`. Tests:
`tests/integration/hunts.test.ts`, `hunt-search.test.ts`, `notify-hunt-matches.test.ts`.
