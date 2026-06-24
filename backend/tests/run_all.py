"""Run every backend smoke test and report a single pass/fail summary.

Run:  python backend/tests/run_all.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = [
    "smoke_usage",      # §8 rate limit, credits, key
    "smoke_sandbox",    # §3 sandboxed python
    "smoke_generate",   # §2 LLM -> code -> run -> auto-correct
    "smoke_projects",   # §2 file output manager
    "smoke_packager",   # §4 .py packaging
    "smoke_modules",    # §6/§7 workshop modules
    "smoke_pdf",        # §10 PDF -> software
    "smoke_provider",   # §9 provider config
    "smoke_provider_usage",  # §8 real provider balance
    "smoke_codeparse",  # code extraction + tolerant fallbacks
]


def main() -> int:
    failed = []
    for name in TESTS:
        print(f"\n========== {name} ==========")
        rc = subprocess.run([sys.executable, os.path.join(HERE, f"{name}.py")]).returncode
        if rc != 0:
            failed.append(name)
    print("\n" + "=" * 40)
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    print(f"ALL {len(TESTS)} SUITES PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
