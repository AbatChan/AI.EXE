"""Smoke test for live model prices (stubbed fetcher: runs offline)."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.model_prices import ModelPriceCache, normalize

SAMPLE = {
    "gpt-6-luna": {"litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-07, "output_cost_per_token": 5e-07,
                   "cache_read_input_token_cost": 1e-08, "cache_creation_input_token_cost": 1.25e-07,
                   "input_cost_per_token_flex": 5e-08, "output_cost_per_token_flex": 2.5e-07, "cache_read_input_token_cost_flex": 5e-09,
                   "input_cost_per_token_priority": 2e-07, "output_cost_per_token_priority": 1e-06},
    "deepseek/deepseek-flash": {"litellm_provider": "deepseek", "input_cost_per_token": 3e-07, "output_cost_per_token": 1.2e-06, "cache_read_input_token_cost": 6e-09},
    "text-embedding-9": {"litellm_provider": "openai", "mode": "embedding", "input_cost_per_token": 1e-08, "output_cost_per_token": 0},
    "some-other/model": {"litellm_provider": "together_ai", "input_cost_per_token": 1e-07, "output_cost_per_token": 1e-07},
    "broken": {"litellm_provider": "openai", "input_cost_per_token": "free"},
    "sample_spec": "not a dict",
}


def main():
    m = normalize(SAMPLE)
    luna = m["openai"]["gpt-6-luna"]
    assert luna["input"] == 0.1 and luna["output"] == 0.5 and luna["cached"] == 0.01 and luna["write"] == 0.125, luna
    assert luna["tiers"]["flex"] == {"input": 0.05, "cached": 0.005, "output": 0.25}, luna
    assert luna["tiers"]["fast"]["output"] == 1.0
    assert m["deepseek"]["deepseek-flash"]["input"] == 0.3
    assert "text-embedding-9" not in m["openai"] and "broken" not in m["openai"] and set(m) == {"openai", "deepseek"}

    d = Path(tempfile.mkdtemp())
    calls = []
    cache = ModelPriceCache(d / "p.json", fetcher=lambda: calls.append(1) or SAMPLE)
    first = cache.get(now=1000)
    assert first["models"]["openai"]["gpt-6-luna"]["input"] == 0.1 and first["source"]
    cache.get(now=1000 + 3600)
    assert len(calls) == 1, "cached for a day"
    cache.get(now=1000 + 90000)
    assert len(calls) == 2, "refreshed after a day"

    def down():
        raise OSError("offline")
    stale = ModelPriceCache(d / "p.json", fetcher=down).get(force=True, now=1000 + 200000)
    assert stale.get("stale") and stale["models"]["openai"], "offline keeps the last good list"
    empty = ModelPriceCache(d / "none.json", fetcher=down).get()
    assert empty["offline"] and empty["models"] == {}, "no list yet = UI uses its built-in table"
    bad = ModelPriceCache(d / "bad.json", fetcher=lambda: {"x": "y"}).get()
    assert bad["models"] == {}
    print("smoke_model_prices: ok")


if __name__ == "__main__":
    main()
