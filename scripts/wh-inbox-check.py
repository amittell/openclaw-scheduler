#!/usr/bin/env python3
"""Canonical WritHub (wh) inbox + obligations check for both Kebablebot seats.

Replaces the ad-hoc /Volumes/Storage/agent-work/wh-inbox-*.py one-offs.

Bug fixed here: `wh inbox --json` returns `active_repos` as an INT count (not a
list). The ad-hoc script called `len(active_repos)` -> `TypeError: object of
type 'int' has no len()` -> printed `PARSE_FAIL` for both seats. This script
normalizes every field to its real shape (int OR list) and prints a stable
summary. It also isolates each seat so one failure never masks the other.

Usage:
    python3 scripts/wh-inbox-check.py
    WH_SEATS=openclaw,agent python3 scripts/wh-inbox-check.py   # subset

Output (stdout), one block per seat:
    === openclaw inbox ===
    key=1cd4593f... active_repos=3 addressed=0 errors=0
    addressed: []
    errors: []
    obligations: total=175 pending=0
    PEND: {...}            # first <=10 pending obligations
    === agent inbox ===
    ...
    INBOX_CHECK_DONE

Exit code: 0 if every requested seat produced a parseable inbox (even with
errors=non-empty), 1 if any seat failed auth/inbox/parse. PARSE_FAIL reports
invalid JSON or unusable response shapes; valid obligations lists and items
objects are both accepted.
"""
import json
import os
import subprocess
import sys

SEATS = {
    "openclaw": "/Users/alexm/.config/wh-seats/kebablebot-openclaw",
    "agent": "/Users/alexm/.config/wh-seats/kebablebot-agent",
}
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin", "HOME": "/Users/alexm"}


def run(args, env):
    return subprocess.run(["wh"] + args, env=env, capture_output=True, text=True)


def count(value):
    """Normalize a field that may be an int count OR a list -> its count."""
    if isinstance(value, list):
        return len(value)
    if isinstance(value, int):
        return value
    return 0


def as_list(value):
    """Normalize a field that may be a list OR a scalar -> a list."""
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def main():
    want = [s for s in os.environ.get("WH_SEATS", "openclaw,agent").split(",") if s in SEATS]
    failures = 0
    for tag in want:
        seat = SEATS[tag]
        handle = "kebablebot-" + tag
        env = dict(ENV)
        env["WH_CONFIG_DIR"] = seat
        print(f"=== {tag} inbox ===")
        try:
            st = run(["auth", "status", "--json"], env)
            if st.returncode != 0:
                print(f"AUTH FAIL {st.stderr.strip()}")
                failures += 1
                continue
            kid = json.loads(st.stdout).get("key_id", "")

            ib = run(["inbox", "--chat", "--self-handle", handle, "--json"], env)
            if ib.returncode != 0:
                print(f"INBOX FAIL key={kid[:12]}... {ib.stderr.strip()}")
                failures += 1
                continue
            j = json.loads(ib.stdout)
            addressed = as_list(j.get("addressed"))
            errors = as_list(j.get("errors"))
            active_raw = j.get("active_repos", j.get("repos"))
            active = count(active_raw)
            print(f"key={kid[:12]}... active_repos={active} addressed={len(addressed)} errors={len(errors)}")
            print("addressed: " + json.dumps(addressed))
            print("errors: " + json.dumps(errors))

            ob = run(["obligations", "list", "--handle", handle, "--json"], env)
            if ob.returncode == 0:
                oj = json.loads(ob.stdout)
                items = oj if isinstance(oj, list) else oj.get("items", [])
                if not isinstance(items, list):
                    items = []
                pend = [i for i in items if str(i.get("status", "")).lower() != "handled"]
                print(f"obligations: total={len(items)} pending={len(pend)}")
                for i in pend[:10]:
                    print("PEND: " + json.dumps(i)[:200])
            else:
                print(f"obligations FAIL: {ob.stderr.strip()[:200]}")
        except Exception as e:  # noqa: BLE001 - report, don't crash the other seat
            print(f"PARSE_FAIL {type(e).__name__}: {e}")
            failures += 1
    print("INBOX_CHECK_DONE")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
