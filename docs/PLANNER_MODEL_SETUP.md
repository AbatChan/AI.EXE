**Planner Model Setup**

Goal: run a separate local planner model for agent decisions while keeping the current model for file/code generation.

Recommended test model:
- `Qwen/Qwen3-1.7B`

Stronger option:
- `Qwen/Qwen3-4B`

Local environment:
- Python venv already prepared at:
  - `/Users/macbookair2020/Downloads/AI EXE/.agent-venv`

The planner server script is:
- `/Users/macbookair2020/Downloads/AI EXE/scripts/functiongemma_planner_server.py`

Despite the filename, it is now a generic planner server and defaults to Qwen3.

Quick start

1. Open Terminal and go to the project:

```bash
cd "/Users/macbookair2020/Downloads/AI EXE"
```

2. Start the planner server with Qwen3-1.7B:

```bash
export AI_EXE_PLANNER_MODEL=Qwen/Qwen3-1.7B
.agent-venv/bin/python scripts/functiongemma_planner_server.py
```

3. Optional: use the stronger 4B model instead:

```bash
export AI_EXE_PLANNER_MODEL=Qwen/Qwen3-4B
.agent-venv/bin/python scripts/functiongemma_planner_server.py
```

4. Health check in another terminal:

```bash
curl -s http://127.0.0.1:8765/health
```

5. Start AI.EXE normally:

```bash
cd "/Users/macbookair2020/Downloads/AI EXE"
./RUN_MAC_PREVIEW.command
```

Notes

- The app will try the local planner server first and fall back to the built-in planner if the server is not running.
- Qwen models are open, so you typically do not need a gated-model token like Gemma.
- This planner setup is for development/testing only.
- The shipped client still needs to remain self-contained and zero-dependency.

Official references

- [Qwen function calling docs](https://qwen.readthedocs.io/en/stable/framework/function_call.html)
- [Qwen tool calling concepts](https://qwen.readthedocs.io/en/latest/getting_started/concepts.html)
- [Qwen-Agent quickstart](https://qwenlm.github.io/Qwen-Agent/en/guide/get_started/quickstart/)
- [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B)
- [Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B)
