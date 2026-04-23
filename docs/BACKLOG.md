# Backlog

## Done
- Model manager UI shows current model path and checksum.
- Import / replace model action is wired to the native runtime bridge.
- Verify model action computes the local checksum.
- Optional model URL field exists for operator notes / future workflow.
- Keep existing model on update setting exists in the UI.
- Release UI defaults to offline-only providers.
- Localhost development planner is gated behind `AI_EXE_ENABLE_DEV_PLANNER`.
- Bundle validation checks required UI files, prompts, vendor assets, manifest hashes, and strict model/runtime presence.

## Remaining
- Run full Windows release build and `validate_bundle.ps1` on the RTX 3060 target.
- Bundle and validate a real Windows `llama-cli.exe` next to `data/runtime/infer_backend.exe`.
- Confirm `data/model/model.gguf` loads and generates on the target machine.
- Run an acceptance flow: prompt -> generated project files -> generated output runs independently.
- Clean repository state before handoff by staging only intentional source/docs changes.
