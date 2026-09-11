# Auto-Improve Eval Example Scorers

These examples are intentionally small, deterministic, and dependency-free.
They read one proposal JSON object from stdin and print one eval response JSON
object to stdout.

Use them as templates, not as universal quality gates. Real projects should
replace the checks with project-specific invariants that are safe to run before
an auto-improvement proposal is staged.

```toml
[auto_improve.eval]
enabled = true
command = "python3 docs/examples/auto-improve-eval/score_proposal.py"
timeout_secs = 30
targets = ["_rules", "procedures"]
min_delta = 0.0
```

Smoke test:

```bash
python3 docs/examples/auto-improve-eval/score_proposal.py < \
  docs/examples/auto-improve-eval/sample-proposal.json
sh docs/examples/auto-improve-eval/score_proposal.sh < \
  docs/examples/auto-improve-eval/sample-proposal.json
```
