# Temporal validity (bi-temporal-lite)

*2.0 item 4.* The entity index carries an **ingestion-time** validity
window, so "what did we know about X as of June" is answerable from
the store — the one mainstream graph-camp mechanism (Zep/Graphiti)
worth having at our scale.

## Honest scope

- **Ingestion time only.** `valid_from` / `superseded_at` record when
  ai-memory *learned* and *replaced* a fact, not when it was true in
  the world. A world-time split (Graphiti's `valid_at`/`invalid_at`
  extracted by an LLM) is deliberately out of scope: it requires
  trusting an LLM to date facts, and our zero-LLM default path could
  never populate it.
- **Entity links only.** Page versions already form a timeline
  (`supersedes` + `created_at`); entity links now inherit it. Typed
  relation edges (item 3) die with their page version, which is
  already a timeline — no extra columns needed there yet.
- **Deletion is deletion.** Purged pages cascade their entity links
  away; the timeline does not survive an explicit purge (that is what
  purge means here — see the purge docs).

## Schema

`entity_page_links` gains two additive columns:

| column | meaning |
|---|---|
| `valid_from` | `created_at` of the page version the link belongs to |
| `superseded_at` | `created_at` of the version that superseded it; `NULL` while the version is latest |

Backfill is a one-shot data migration inside refinery: `valid_from`
from the linked version's `created_at`; `superseded_at` from the
superseding version's `created_at` (found via `pages.supersedes`),
`NULL` for latest versions. New writes populate `valid_from` at
insert, and the supersede path closes the outgoing version's windows
in the same transaction — a link's window can never be open-ended in
a superseded version.

## When to reach for it

Ordinary `memory_query` answers "what do we know NOW" and is the right
call 99% of the time. `as_of` is for audits and post-mortems: "what
did the wiki say when that decision was made", "did we already know
about this gotcha before the incident".

## A worked example

A project recorded `postgres` as its database, then migrated:

```jsonc
// June: notes/db.md says "we use postgres"    (entity: postgres)
// August: the page is superseded — "we migrated to sqlite" (entity: sqlite)

memory_query { "query": "postgres" }
// → no hits: current knowledge has moved on

memory_query { "query": "postgres", "as_of": "2026-07-01T00:00:00Z" }
// → the JUNE version of notes/db.md — the page that carried the
//   `postgres` entity when July began, even though it has since been
//   superseded
```

## Query

`memory_query` accepts `as_of` (ISO-8601). When present the query is
a **time-travel entity lookup**: the entity stream runs alone against
links whose window contains the instant
(`valid_from <= T AND (superseded_at IS NULL OR superseded_at > T)`),
returning the page versions that carried the matched entities at that
time. FTS / vector / graph streams are deliberately skipped — mixing
"current text relevance" with "historical entity validity" in one
ranked list would answer neither question honestly. Omit `as_of` and
nothing changes.

## Where entities come from

`as_of` and the entity retrieval stream both read the entity index, so
they only answer once pages actually carry entities. Entities are the
salient nouns a page is *about*, and they are populated from each page's
frontmatter at write time:

- an explicit `entities:` list, when an LLM consolidator emits one; and
- the page's `tags:` list, which nearly every page carries — tags *are*
  "what this page is about", so they seed the entity index deterministically
  with no LLM pass and no re-consolidation.

Broad tags do not distort ranking: the entity stream weights each match
by inverse page-frequency, so a tag shared by many pages contributes
proportionally little.

Existing stores self-heal. On the first start after upgrading, a
one-shot, idempotent backfill scans latest pages that have no entity
links yet, derives their entities from the same frontmatter, and opens
each link's validity window at the page version's own `created_at` — so
`as_of` works historically, not just from the upgrade forward. A store
whose pages were all written through the current path finds no
candidates and the pass is a no-op. No command is required; a manual
`reindex` is only needed if you deliberately cleared the index.
