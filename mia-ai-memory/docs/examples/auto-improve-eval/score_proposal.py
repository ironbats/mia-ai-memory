#!/usr/bin/env python3
"""Example ai-memory auto-improve eval scorer.

Reads proposal JSON from stdin and emits:
  {"passed": bool, "score_before": float, "score_after": float, "reason": str?}

The checks are intentionally simple and deterministic:
- procedures should have a Purpose/Steps shape;
- rules should avoid placeholders and use imperative language;
- all targeted docs should avoid TODO placeholders.
"""

from __future__ import annotations

import json
import re
import sys


def score_body(path: str, body: str) -> tuple[float, list[str]]:
    score = 0.0
    reasons: list[str] = []
    lowered = body.lower()

    if re.search(r"^#\s+\S", body, re.MULTILINE):
        score += 0.25
    else:
        reasons.append("missing H1 heading")

    if "todo" not in lowered and "tbd" not in lowered:
        score += 0.20
    else:
        reasons.append("contains TODO/TBD placeholder")

    if path.startswith("procedures/"):
        if "## purpose" in lowered or "## overview" in lowered:
            score += 0.20
        else:
            reasons.append("procedure lacks Purpose/Overview section")
        if "## steps" in lowered or "## checklist" in lowered:
            score += 0.25
        else:
            reasons.append("procedure lacks Steps/Checklist section")
    elif path.startswith("_rules/"):
        if re.search(r"\b(always|never|must|do not|prefer)\b", lowered):
            score += 0.35
        else:
            reasons.append("rule lacks imperative guidance")
        if len(body.strip()) <= 2400:
            score += 0.10
        else:
            reasons.append("rule is too long for an agent instruction")
    else:
        score += 0.45

    return min(score, 1.0), reasons


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"passed": False, "reason": f"invalid input JSON: {exc}"}))
        return 0

    path = str(payload.get("path", ""))
    before_body = str(payload.get("before_body", ""))
    after_body = str(payload.get("after_body", ""))

    score_before, _ = score_body(path, before_body)
    score_after, reasons = score_body(path, after_body)
    passed = score_after >= 0.70 and score_after >= score_before

    response: dict[str, object] = {
        "passed": passed,
        "score_before": round(score_before, 4),
        "score_after": round(score_after, 4),
    }
    if not passed:
        response["reason"] = "; ".join(reasons) or "score did not improve"

    print(json.dumps(response, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
