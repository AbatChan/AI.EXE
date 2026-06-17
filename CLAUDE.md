# AI.EXE — project rules (always apply)

## Version bumping — ODOMETER scheme (NOT semver). READ THIS BEFORE EVERY BUMP.
Single source of truth: `CMakeLists.txt` (`AI_EXE_APP_VERSION`, `AI_EXE_BUILD_TAG`, `AI_EXE_BUILD_LABEL`).

- Bump the version on **every** change shipped to a build (it's the "did my reload take?" signal).
- Segments are **single digits that roll over at 9** — **NEVER write a two-digit segment** (no `4.2.10`).
  - PATCH (3rd): default for fixes. `x.y.9` → next is **`x.(y+1).0`** (carries into minor).
  - MINOR (2nd): a real new feature. `x.9.z` → next minor bump is **`(x+1).0.0`** (carries into major).
  - MAJOR (1st): big/breaking, or the carry target. Unbounded.
- Monotonically increasing only. When unsure, PATCH.
- Example: `4.2.9` → **`4.3.0`** (NOT `4.2.10`).

## Other standing conventions
- Code comments: terse — a few words, not paragraphs.
- Don't second-guess the model with brittle regex/keyword heuristics; trust model judgment, regex only as a last-resort fallback.
- Mac preview lives at `build-mac-preview/` (build there; launch the binary directly so macOS `open` doesn't re-focus a stale instance).

## Memory
Durable project knowledge is in `~/.claude/projects/-Users-macbookair2020-Downloads-Projects-and-Code-AI-EXE/memory/` (index: `MEMORY.md`). Check it before acting; update it after non-obvious changes.
