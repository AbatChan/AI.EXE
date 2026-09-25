"""Smoke test for the npm package vetter (stubbed network — runs offline)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.npm_vet import NpmVetter, vet_one

OLD = [0] * 5 + [9000] * 360        # published ~360 days ago, busy
NEW = [0] * 335 + [9000] * 30       # 30 days old
QUIET = [10] * 365                  # old but nobody uses it


def doc(version="1.2.3", deprecated=None):
    d = {"name": "x", "version": version}
    if deprecated:
        d["deprecated"] = deprecated
    return d


def check(name, latest, history, trusted, reason_part=""):
    res = vet_one(name, lambda n: latest, lambda n: history)
    assert res["trusted"] is trusted, (name, res)
    if reason_part:
        assert reason_part in res["reason"], (name, res)
    return res


def main():
    ok = check("bcryptjs", doc("3.0.3"), OLD, True)
    assert ok["version"] == "^3.0.3", ok
    check("@auth/prisma-adapter", doc("2.11.3"), OLD, True)
    check("reactt-domm", None, OLD, False, "does not exist")
    check("left-pad", doc("1.3.0", "use String.prototype.padStart()"), OLD, False, "deprecated")
    check("brand-new-pkg", doc(), NEW, False, "days old")
    check("sleepy-pkg", doc(), QUIET, False, "downloads")
    check("../etc/passwd", doc(), OLD, False, "not a valid")
    check("Bad Name", doc(), OLD, False, "not a valid")

    def boom(_):
        raise OSError("offline")

    off = vet_one("react", boom, lambda n: OLD)
    assert not off["trusted"] and off.get("offline"), off

    calls = []
    v = NpmVetter(lambda n: calls.append(n) or doc(), lambda n: OLD)
    v.vet(["zod", "zod", "ZOD"])
    v.vet(["zod"])
    assert calls == ["zod"], calls  # deduped + cached

    flaky = NpmVetter(boom, lambda n: OLD)
    assert flaky.vet(["zod"])[0].get("offline")
    assert "zod" not in flaky._cache  # offline results aren't cached
    print("smoke_npm_vet: ok")


if __name__ == "__main__":
    main()
