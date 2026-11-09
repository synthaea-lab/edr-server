# Content and releases

What the server sends to agents: detection content, agent binaries, key rotations and the
common-set snapshot. All four are signed **offline**, with keys the server never holds. The
server stores what an operator publishes, checks that an agent could install it, decides which
agent is offered what, and serves it over mTLS. Every agent verifies every signature and refuses
a release number lower than one it has applied. How the agent verifies and applies them is in
the agent's
[updates and releases documentation](https://github.com/synthaea-lab/agent/blob/main/docs/updates-and-releases.md).

## Rings

Each agent belongs to one ring, stored on its `agents` row: `canary_0`, `canary_1`, `canary_2`
or `prod` (the default at enrollment). Rings are per tenant: each tenant has its own releases
in each ring.

A tenant `owner` or `admin` moves an agent with `POST /api/agents/{agentId}/ring`
([route](../app/api/agents/[agentId]/ring/route.ts)), audited as `agent.ring.assignment`. No
agent endpoint takes a ring the agent could choose: the release, key-rotation and snapshot
routes have no ring in the path, and the content manifest route, which does, answers `403` when
the ring is not the agent's own.

`GET /api/ops/rings` ([`loadRings`](../lib/rings.ts)) reports for each ring its rollout state
(`serving`, `halted`, `rolled_back` or `no_release`), the newest and the served version, whether
a rollback has somewhere to go, and the health of the agents in it. The operations console shows
it and offers halt and rollback where they apply ([`ring-actions.ts`](../lib/ring-actions.ts)).

## The artifact store

Release files live on the application's file system, under `storage/` in its working directory:

| Path | Contents | Written by |
| --- | --- | --- |
| `storage/artifacts/<sha256>` | Content artifacts (rules, models, policies, IOC feeds), named by the SHA-256 of their bytes | The operator, or `POST /api/content/ioc-feed` for IOC feeds |
| `storage/manifests/content-<ring>-v<N>.json` | Signed content manifests (the conventional name; any `storage://` path is accepted) | The operator |
| `storage/manifests/release-<ring>-v<N>.json` | Signed binary release manifests (same convention) | The operator |
| `storage/releases/v<N>/<path>` | Binary release files | The operator |
| `storage/key-rotations/<ring>.json` | The pending key rotation for a ring | The operator |

A release row's `manifestUrl` is either `storage://<path>`, read from that directory with `..`
and absolute paths refused, or any other URL, which is fetched as-is
([`loadManifestBytes`](../lib/content-manifest.ts)). Artifacts are always read from the local
store.

The content store is content-addressed, so the same bytes are stored once whatever path the
manifests give them, and a release's bytes stay available as long as any release lists them. The
`prune-artifacts` job ([`content-retention.ts`](../lib/content-retention.ts)) deletes files that
no content release of any tenant, ring or status lists, keeps files younger than 24 hours (an
artifact is uploaded before the release that lists it), and deletes nothing if any manifest cannot
be read.

The store is shared by all tenants. Isolation comes from what is served: an agent can only fetch
a path its own active manifest lists (see below).

## Content releases

A content manifest ([`ContentManifest`](../lib/content-manifest.ts)) is signed JSON:

```json
{
  "schema_version": 1,
  "release_version": 42,
  "ring": "canary_0",
  "released_at": "2026-01-01T00:00:00Z",
  "entries": [
    { "path": "rules/beacon.sigma", "type": "rule", "sha256": "<64 hex>", "size": 1234 }
  ],
  "signature": "<Ed25519, hex>"
}
```

Entry types are `rule`, `model`, `policy` and `ioc`. The signature covers the canonical bytes:
two-space indented JSON with keys sorted at every level and `signature` present but empty
([`canonicalJSON`](../lib/content-manifest.ts)). The agent's updater uses the same scheme, and
both sides test against [`tests/fixtures/content-manifest-golden.json`](../tests/fixtures/content-manifest-golden.json).

### Publishing

1. Put each artifact at `storage/artifacts/<sha256>`.
2. Build the manifest with the number the release will get (one above the ring's highest,
   rolled-back releases included), sign it offline with the agent repository's `release-tool`,
   and store it under `storage/manifests/`.
3. `POST /api/content/release` with `{ ring, manifestUrl, manifestSha256, releasedAt?, restoresVersion? }`
   as a tenant `owner` or `admin` ([route](../app/api/content/release/route.ts)).

[`publishRelease`](../lib/release-publish.ts) numbers the release and refuses it with `422`
unless everything an agent would check at install time already holds: the manifest bytes hash to
`manifestSha256`, the manifest matches the schema with at least one entry, names this ring and
carries this number, every entry path is a safe relative path, every artifact is in the store and
hashes to its listed value, and every `ioc` entry is a feed the device would load whole
([`validatePublishable`](../lib/content-publish.ts)). The row and its `content.release.create` audit
entry are written in one transaction. The signature is not checked: the server has no key.

### Serving

[`loadActiveManifest`](../lib/active-content-manifest.ts) decides what an agent is offered: the
newest `active` release of its tenant and ring. Before serving it re-reads the manifest, checks
its SHA-256 against the row, its schema, and its ring and version against the row; any mismatch
is a `502`, never a different manifest.

| Route | Answers |
| --- | --- |
| `GET /api/content/manifest/{ring}` | The manifest as signed. `400` for an unknown ring, `403` for another ring than the agent's, `404` when the ring has no release, `423` when its newest release is halted. |
| `GET /api/content/artifact?path=&sha256=` | The bytes of an entry of the agent's active manifest. A path the manifest does not list is `404`, whatever is on disk; a `sha256` that differs from the manifest's is `409`; stored bytes that do not hash to the manifest's value are `502`. |

### Halt, rollback and auto-halt

- **Halt.** `POST /api/content/halt` with `{ ring, reason? }` marks the ring's latest active
  release `halted`. While the newest release of a ring is halted, the manifest route answers
  `423` instead of falling back to older content: a halt stops delivery. Publishing a new release
  or rolling back ends it.
- **Rollback.** `POST /api/content/rollback` with `{ ring, targetVersion?, reason? }` marks the
  newest active or halted release `rolled_back` and reactivates `targetVersion`, or the release
  just below it ([`findRollbackReleases`](../lib/content-rollback.ts)). This only reaches agents
  that have not applied the rolled-back release: an agent never moves to a lower release number.
  The answer therefore includes a corrective-release advice: the number the next release will
  get and the version whose content it should carry. Withdrawing the content from agents that
  already applied it takes that corrective release, built and signed offline and published with
  `restoresVersion` set.
- **Auto-halt.** The `check-ring-health` job compares each canary ring with `prod` in the same
  tenant and halts the canary's active release when its silent-agent rate exceeds 5 %, its
  false-positive count is more than twice prod's, or its detection count dropped more than 20 %.
  It opens a `high` case and writes a `content.release.auto_halt` audit row with the metrics.

Halt and rollback are tenant `owner`/`admin` actions, serialized per tenant and ring by an
advisory lock, and audited. The console's buttons call the same routes.

### IOC feeds

`POST /api/content/ioc-feed` ([route](../app/api/content/ioc-feed/route.ts),
[`ioc-stage.ts`](../lib/ioc-stage.ts)) turns a threat-intelligence source into IOC feed artifacts:
plain `kind:value` text, CSV with a column mapping, a MISP export (attributes flagged `to_ids`)
or a STIX 2.1 bundle (single-comparison indicator patterns, expired ones dropped). It builds the
feed with the same rules the device applies, drops lines the device would skip, refuses a
registrable public suffix as a domain, writes `ioc/<feed>.txt` and optionally `ioc/VERSION` to
the artifact store, and answers the manifest entries to put in the next manifest with a report of
what was dropped.

It publishes nothing. A source that leaves no indicator is refused unless `allowEmpty` is set,
because a release listing an empty feed unloads that feed on every agent of the ring. The body
may be up to 32 MiB; nginx allows the same on this route.

## Binary releases

A binary release offers a new agent version to a ring. Its manifest
([`ReleaseManifest`](../lib/release-manifest.ts)) has no ring and maps each file path to its
SHA-256:

```json
{ "schema_version": 1, "release_version": 7, "entries": { "linux-x86_64/agent": "<64 hex>" }, "signature": "<hex>" }
```

- **Publish.** `POST /api/release` with `{ ring, releaseVersion, manifestUrl, manifestSha256, releasedAt? }`,
  as a tenant `owner` or `admin`. Unlike content, the caller names the number, which must be above
  the ring's latest (`409` otherwise), mirroring the agent's anti-rollback check. The manifest
  must hash to `manifestSha256`, carry that number, use only paths the agent accepts (no `..`, no
  absolute or drive paths, no Windows reserved names), and every file must already be at
  `storage/releases/v<N>/<path>` with the listed hash. Audited as `release.create`.
- **Serve.** `GET /api/release/manifest` answers the newest active release of the agent's tenant
  and ring, as signed. `GET /api/release/artifact?release_version=&path=&sha256=` serves a file
  only from an active release of the agent's ring and only at a path its manifest lists, checks
  the stored bytes against the manifest's hash before sending, and sets `X-Content-SHA256`.

## Key rotation

An operator replaces the `release` or `content` public key agents trust by placing a rotation
manifest, signed offline by the `recovery` key, at `storage/key-rotations/<ring>.json`.
`GET /api/release/key-rotation` serves the file for the agent's ring byte for byte, or `404` when
there is none ([`key-rotation.ts`](../lib/key-rotation.ts)). The server checks only the shape: a
strict schema (unknown fields would fall outside the signed bytes), retired and new key given in
pairs, at least one key rotated, a validity of at most 30 days. Agents check the signature, that
the rotation retires the key they trust now, the expiry, and that it is newer than any they
applied. One file per ring lets a rotation reach canaries before `prod`.

## Common-set snapshot

The common-set snapshot gives each agent its tenant's "commonly seen" file hashes as a signed
Bloom filter, a weak rarity signal it can use offline.

- **Build.** The `build-snapshots` job ([`snapshot-publish.ts`](../lib/snapshot-publish.ts))
  takes, per tenant, the hashes seen on at least `SNAPSHOT_MIN_HOSTS` hosts (default 2) from the
  prevalence table, builds the filter ([`common-set-snapshot.ts`](../lib/common-set-snapshot.ts)),
  signs the manifest and replaces the tenant's `common_set_snapshots` row. A build is skipped,
  keeping the previous snapshot, when too few hosts have reported, when there are more hashes than
  the entry cap, when the artifact would exceed its size cap, or when it has fewer than half the
  previous build's entries without a fall in hosts covered (a truncated build). The [configuration](configuration.md#prevalence-and-snapshots) lists
  the tuning variables.
- **Sign.** Signing goes through a `SnapshotSigner` that holds the `snapshot` key
  ([`snapshot-manifest.ts`](../lib/snapshot-manifest.ts)). The only signer today is the public
  test key, enabled with `SYNTHAEA_SNAPSHOT_SIGNER=test` for lab use. Without a signer the job
  answers `503` and nothing is served.
- **Serve.** `GET /api/snapshot/manifest` answers the agent's own tenant's signed manifest, `404`
  when none was published. `GET /api/snapshot/artifact?sha256=` answers the bytes after checking
  them against the stored hash, and `409` when `sha256` names a build that has since been
  replaced.
