#!/bin/sh
# POSIX-shell entrypoint for ai-memory auto-improve eval gates.
# It embeds a tiny Python scorer so the configured command can be a single
# script path while keeping JSON parsing correct.

python3 -c '
import json, re, sys

try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    print(json.dumps({"passed": False, "reason": f"invalid input JSON: {exc}"}))
    raise SystemExit(0)

path = str(payload.get("path", ""))
body = str(payload.get("after_body", ""))
lowered = body.lower()
checks = [
    bool(re.search(r"^#\s+\S", body, re.MULTILINE)),
    "todo" not in lowered and "tbd" not in lowered,
]
if path.startswith("procedures/"):
    checks.extend([
        "## steps" in lowered or "## checklist" in lowered,
        "## purpose" in lowered or "## overview" in lowered,
    ])
elif path.startswith("_rules/"):
    checks.append(bool(re.search(r"\b(always|never|must|do not|prefer)\b", lowered)))

score_after = sum(1 for ok in checks if ok) / len(checks)
passed = score_after >= 0.75
response = {"passed": passed, "score_after": round(score_after, 4)}
if not passed:
    response["reason"] = "proposal did not satisfy the example structure checks"
print(json.dumps(response, separators=(",", ":")))
'
