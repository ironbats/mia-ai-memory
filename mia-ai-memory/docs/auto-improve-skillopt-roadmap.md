# Auto-Improve SkillOpt-Inspired Roadmap

This is the ongoing implementation plan for borrowing the best safety ideas from
SkillOpt without turning ai-memory into a workflow manager, benchmark harness, or
agent orchestration platform.

## Boundary

ai-memory remains a memory substrate:

- automatic capture from lifecycle hooks;
- markdown wiki as the source of truth;
- SQLite as the derived index and audit store;
- small, auditable wiki proposals through pending-writes;
- optional LLM review outside hook latency.

This roadmap does **not** add a spec-driven workflow, mandatory task scoring,
agent replay engine, skill router, code graph, or benchmark registry.

## Why this work matters

The current auto-improvement loop validates proposals structurally: path, kind,
confidence, evidence, size, duplicate checks, and approval policy. That is useful
but not enough for high-impact pages such as `_rules/` and `procedures/`, where a
bad edit can shape future agent behavior. The biggest wins are to make proposed
changes smaller, easier to review, harder to repeat after rejection, and optionally
measurable when a project supplies its own scoring command.

## Invariants

- Existing full-page `create_or_update` proposals must continue to validate,
  stage, diff, approve, reject, and audit.
- New behavior must be additive migrations/config; existing installs keep the
  same defaults.
- Target wiki mutations must still pass through `Wiki::write_page`,
  `Wiki::apply_batch`, or existing approval helpers.
- Server/admin/MCP paths must preserve `ScopeResolver` and
  `AuthLevel::authorize(Capability::...)` boundaries.
- Hooks must remain fire-and-forget and must not run LLM review, patching, or
  evaluation gates.
- No new public MCP tool surface unless the existing `memory_auto_improve` and
  pending-writes surface cannot express the workflow.

## Phase 1 — Structured Patch Proposals With Minimal Budgets

Add patch proposals as a backwards-compatible extension to the existing proposal
shape. Full-page bodies remain supported forever, especially for new pages.

Preferred update mode for `_rules/` and `procedures/` should become small
structured patches, but only when the reviewer has enough target-page context to
name stable anchors. Full-page proposals still must not overwrite existing
semantic/procedural pages; patch proposals require an existing target page.

```json
{
  "edit_mode": "patch",
  "edits": [
    {"op": "append", "anchor": "## Release process", "content": "..."},
    {"op": "replace_section", "anchor": "## Gotchas", "content": "..."}
  ]
}
```

Initial supported operations:

- `add_section`
- `append`
- `replace_section` only with section hash/context verification

`delete_section` is deferred. If it is later added, it must either be excluded
from auto-approval or force manual approval even when global auto-approve is
enabled.

Patch semantics:

- Anchors use exact markdown heading text, including marker, e.g.
  `## Release process`.
- Anchors must be unique after normalized whitespace comparison; duplicate
  anchors reject.
- H1 replacement/deletion is not supported.
- A section span starts at the anchor heading and ends before the next heading of
  equal or higher level. Child subsections are included in `replace_section`.
- `append` inserts content at the end of the anchored section before the next
  equal-or-higher heading, preserving a blank-line boundary.
- `add_section` inserts a new sibling section after the anchored section span.
- `replace_section` requires a pre-edit section hash or exact context and
  rejects if the section changed.
- Final materialized bodies must still pass the normal H1, path, kind, and size
  validation.

Minimum Phase 1 budget caps:

- max edits per proposal;
- max content chars per edit;
- max changed chars per proposal;
- max final body size.

Implementation notes:

- Materialize patches into final `body_markdown` for compatibility with the
  existing approval flow, but close the materialize-to-stage race by passing an
  expected base hash into staging and rejecting if the current target hash
  differs. Materialization may also move inside the same writer transaction if
  that proves cleaner.
- Store original patch JSON for audit/diff/debug.
- Store `edit_mode`, original `patch_json`, expected base hash, materialized
  base hash, and final body metadata through an additive migration. Existing
  rows default to full-page mode.
- Include bounded target page bodies or heading outlines for patchable `_rules/`
  and `procedures/` pages in the reviewer prompt. Do not request patches for
  pages whose anchors were not provided.
- Store target page hash at staging and reject approval if the page changed.
- Use markdown heading anchors and context/hash checks, not line-number patches.

Required tests:

- old full-page proposals still work;
- each patch operation materializes correctly;
- invalid/missing anchors reject cleanly;
- target hash conflict blocks approval;
- page changes between materialization and staging reject;
- old pending proposals remain readable and approvable after migration;
- duplicate anchors reject;
- patch to missing target rejects;
- full-page proposal to an existing non-slot page still rejects;
- destructive operations cannot auto-approve if added later;
- `_rules/` and `procedures/` reviewer instructions prefer patch mode.

## Phase 2 — Bounded Edit Budgets

Phase 1 absorbed the minimum per-proposal caps needed to ship patch proposals
safely: patchable page/context bounds, edits per proposal, edit content chars,
changed chars per proposal, and global final body chars. Phase 2 adds the
remaining run-level and page-class budgets. Defer cosine decay or maturity
schedules until there is real operational data.

Proposed config shape:

```toml
[auto_improve]
max_proposals_per_run = 5
max_patch_edits_per_proposal = 4
max_patch_edits_per_run = 8
max_changed_chars_per_proposal = 4000
max_rule_page_tokens = 2000
max_procedure_page_tokens = 2000
```

Validation rejects proposals that exceed the run-level patch edit budget or
procedural/rule final-page budgets. The earlier Phase 1 validators continue to
enforce per-proposal edit count, changed-char, edit-content, and global final
body limits.

Required tests:

- per-run patch edit limits;
- `_rules/` / `procedures/` page-budget enforcement;
- existing non-patch behavior remains unchanged except existing global limits.

## Phase 3 — Rejected Proposal Buffer

Status: implemented.

Persist useful rejection memory and feed a bounded summary into future reviewer
prompts so the model does not repeat failed edit patterns.

Proposed table:

```text
auto_improve_rejections
- id
- workspace_id
- project_id
- target_path
- kind
- operation/edit_mode
- reason
- normalized_fingerprint
- summary
- evidence_json
- source_run_id
- source_proposal_id nullable
- created_at
```

Populate from:

- validator rejects;
- human pending-writes rejects;
- approval conflicts;
- admission failures;
- future eval-gate failures.

Prompt context should include only a bounded recent subset, e.g. latest 50 per
project or 180 days. Do not add embeddings initially.

Implementation notes:

- `V24__auto_improve_rejections.sql` adds `auto_improve_rejections` with
  workspace/project pairing enforcement plus recent, fingerprint, and path
  indexes.
- Human rejects, admission failures, and approval conflicts write rejection
  records in the same decision transaction.
- Validator/model rejected candidates are persisted at run staging when a reason
  is present; target path/kind/operation/edit-mode are stored when the rejection
  carries that metadata.
- Reviewer prompts include recent same-scope rejection summaries bounded by
  `max_rejection_context` and `rejection_context_days`.

Required tests:

- human rejection creates a reusable rejection record;
- validator rejection creates a record when enough metadata is available;
- future prompts include relevant prior rejections;
- workspace/project isolation is preserved;
- old pending proposals remain approvable/rejectable.

## Phase 4 — Optional Executable Evaluation Gate

Status: implemented.

Only run when a project explicitly supplies a scoring command. Disabled means the
current validation + approval behavior is unchanged.

Proposed config:

```toml
[auto_improve.eval]
enabled = false
command = "./scripts/score-auto-improve-proposal"
timeout_secs = 120
targets = ["_rules", "procedures"]
min_delta = 0.0
```

Contract:

- ai-memory does not build a benchmark registry, replay harness, scoring DSL, or
  agent simulator;
- the external command is executed directly (not through a shell) with JSON on
  stdin containing proposal metadata plus before/after bodies;
- the command returns JSON such as
  `{ "score_before": 0.72, "score_after": 0.76, "passed": true }`;
- when scores are present, `score_after - score_before` must meet `min_delta`;
- failed, timed-out, errored, or invalid-JSON evaluations fail closed for targeted
  proposals and are recorded as rejected candidates with reasons such as
  `eval_gate_failed`, `eval_gate_timeout`, or `eval_gate_error`.

If every proposal in a run fails eval, ai-memory stages the run with zero
proposals and the eval rejections so the rejection buffer still learns from the
attempt. Non-targeted proposals bypass eval even when the gate is enabled. Hook
paths remain fire-and-forget and never run the eval command.

Non-goals:

- no replay orchestration;
- no benchmark/task registry;
- no scoring DSL;
- no agent simulator.

Required tests:

- eval disabled preserves current behavior;
- passing eval allows staging/approval;
- failing eval rejects and records rejection;
- timeout/error fail closed for eval-targeted proposals;
- eval never runs from hook paths.

## Phase 5 — Slow / Meta Update Later

Status: report-only step implemented; `_meta` update and cross-project
optimizer memory not started.

Defer the rest until patch proposals, edit budgets, rejections, and optional
evals produce enough data.

First version should be report-only. `auto_improve_telemetry.rs` ships this:
a structured `AutoImproveTelemetryReport` (terminal rates, bounded findings,
blind spots) built from persisted proposal outcomes, staged and approved like
any other report — approval writes the report page only and performs no
learning-memory changes, and it explicitly does not edit rules, procedures,
notes, or `_meta` pages.

Later, a protected `_meta` section can be updated through a normal pending
proposal, never directly by a per-session review. Cross-project optimizer
memory is explicitly out of scope until there is evidence it helps ai-memory
users. Neither has been started.

## Completion Criteria

This roadmap is complete when phases 1–4 are implemented with docs, migrations,
tests, and changelog entries, and phase 5 has either a report-only design or a
documented deferral with evidence requirements. Phases 1–4 and phase 5's
report-only step are done; the `_meta` update and cross-project optimizer
memory remain deferred pending evidence.
