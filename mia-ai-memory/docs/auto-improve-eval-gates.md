# Auto-Improve Eval Gates

`[auto_improve.eval]` lets operators guard high-impact auto-improvement
proposals with a small executable scorer. The scorer runs after LLM validation
and before staging or auto-approval. Hooks never run eval commands.

## Configuration

```toml
[auto_improve.eval]
enabled = true
command = "python3 docs/examples/auto-improve-eval/score_proposal.py"
timeout_secs = 30
targets = ["_rules", "procedures"]
min_delta = 0.0
```

The command is split on whitespace and executed directly, not through a shell.
Use a wrapper script if you need quoting, environment setup, or multiple
commands.

## Request contract

The scorer receives one JSON object on stdin:

```json
{
  "path": "procedures/release.md",
  "kind": "procedure",
  "operation": "update",
  "edit_mode": "patch",
  "title": "Release Procedure",
  "confidence": 0.91,
  "rationale": "Capture the repeated release checklist.",
  "before_body": "# Release Procedure\n\n## Steps\n- Run tests\n",
  "after_body": "# Release Procedure\n\n## Steps\n- Run tests\n- Run deploy smoke checks\n",
  "expected_base_body_sha256": "..."
}
```

`before_body` is empty for create proposals. `expected_base_body_sha256` is
present only for patch proposals that were materialized against a known base.

## Response contract

The scorer must print one JSON object to stdout:

```json
{ "score_before": 0.72, "score_after": 0.76, "passed": true }
```

Fields:

- `passed` is required. `false` rejects the targeted proposal.
- `score_before` and `score_after` are optional. When both are present,
  `score_after - score_before` must be at least `min_delta`.
- `reason` is optional and should explain a rejection in one short sentence.

Command errors, timeouts, invalid JSON, missing `passed`, `passed = false`, and
insufficient score delta all fail closed for the targeted proposal. Other
proposals in the same run can still proceed.

## Scorer design rules

- Keep scorers deterministic, fast, and side-effect-free.
- Read only stdin and local project files that are safe to inspect.
- Do not call LLMs, mutate files, run deploys, or depend on network services.
- Return bounded reasons; ai-memory caps captured eval evidence.
- Prefer simple checks that match the target path: heading structure for
  procedures, forbidden placeholders for `_rules`, or project-specific smoke
  assertions for critical docs.

## Examples

This repository includes two dependency-free templates:

- [`docs/examples/auto-improve-eval/score_proposal.py`](examples/auto-improve-eval/score_proposal.py)
  — Python scorer that checks basic structure and placeholders.
- [`docs/examples/auto-improve-eval/score_proposal.sh`](examples/auto-improve-eval/score_proposal.sh)
  — POSIX shell wrapper around an embedded Python scorer for hosts that prefer a
  script entrypoint.

Try them with the sample payload:

```bash
python3 docs/examples/auto-improve-eval/score_proposal.py \
  < docs/examples/auto-improve-eval/sample-proposal.json

sh docs/examples/auto-improve-eval/score_proposal.sh \
  < docs/examples/auto-improve-eval/sample-proposal.json
```

Both print compact JSON suitable for ai-memory's eval gate.
