#!/usr/bin/env python3
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.environ.get("AI_EXE_PLANNER_HOST", "127.0.0.1")
PORT = int(os.environ.get("AI_EXE_PLANNER_PORT", "8765"))
MODEL_ID = (
    os.environ.get("AI_EXE_PLANNER_MODEL")
    or os.environ.get("QWEN_PLANNER_MODEL")
    or os.environ.get("FUNCTIONGEMMA_MODEL")
    or "Qwen/Qwen3-1.7B"
)
DEVICE = (
    os.environ.get("AI_EXE_PLANNER_DEVICE")
    or os.environ.get("QWEN_PLANNER_DEVICE")
    or os.environ.get("FUNCTIONGEMMA_DEVICE")
    or "cpu"
)
MAX_NEW_TOKENS = int(
    os.environ.get("AI_EXE_PLANNER_MAX_TOKENS")
    or os.environ.get("QWEN_PLANNER_MAX_TOKENS")
    or os.environ.get("FUNCTIONGEMMA_MAX_TOKENS")
    or "256"
)

MODEL = None
TOKENIZER = None
IS_QWEN_FAMILY = False


def stderr(msg):
    sys.stderr.write(f"{msg}\n")
    sys.stderr.flush()


def load_model():
    global MODEL, TOKENIZER, IS_QWEN_FAMILY
    if MODEL is not None and TOKENIZER is not None:
        return
    from transformers import AutoModelForCausalLM, AutoTokenizer

    stderr(f"[planner] loading model: {MODEL_ID}")
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    tokenizer_kwargs = {
        "token": token,
        "trust_remote_code": True,
    }
    TOKENIZER = AutoTokenizer.from_pretrained(MODEL_ID, **tokenizer_kwargs)
    IS_QWEN_FAMILY = "qwen" in MODEL_ID.lower()
    model_kwargs = {
        "token": token,
        "trust_remote_code": True,
        "torch_dtype": "auto",
    }
    if DEVICE == "cpu":
        model_kwargs["device_map"] = "cpu"
    else:
        model_kwargs["device_map"] = "auto"
    MODEL = AutoModelForCausalLM.from_pretrained(MODEL_ID, **model_kwargs)
    stderr("[planner] model loaded")


def build_inputs_for_generation(prompt):
    load_model()
    if hasattr(TOKENIZER, "apply_chat_template"):
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a strict planning model. "
                    "Return only the requested planner output and do not add commentary."
                ),
            },
            {"role": "user", "content": prompt},
        ]
        try:
            return TOKENIZER.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            )
        except TypeError:
            pass
        try:
            tokens = TOKENIZER.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
            )
            return {"input_ids": tokens}
        except Exception:
            pass
    return TOKENIZER(prompt, return_tensors="pt")


def run_generation(prompt, max_tokens):
    load_model()
    import torch

    inputs = build_inputs_for_generation(prompt)
    if DEVICE == "cpu":
        inputs = {k: v.to("cpu") for k, v in inputs.items()}
    with torch.no_grad():
        output = MODEL.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=False,
            temperature=None,
            pad_token_id=TOKENIZER.eos_token_id,
        )
    input_ids = inputs["input_ids"]
    generated = output[0][input_ids.shape[1]:]
    text = TOKENIZER.decode(generated, skip_special_tokens=True)
    return text.strip()


class Handler(BaseHTTPRequestHandler):
    def _write_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._write_json(200, {
                "ok": True,
                "model": MODEL_ID,
                "loaded": MODEL is not None,
                "chat_template": bool(TOKENIZER is not None and hasattr(TOKENIZER, "apply_chat_template")),
                "qwen_family": IS_QWEN_FAMILY,
            })
        return self._write_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path != "/plan":
            return self._write_json(404, {"ok": False, "error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode("utf-8"))
            prompt = str(data.get("prompt") or "").strip()
            max_tokens = int(data.get("max_tokens") or MAX_NEW_TOKENS)
            if not prompt:
                return self._write_json(400, {"ok": False, "error": "missing_prompt"})
            output = run_generation(prompt, max_tokens)
            return self._write_json(200, {"ok": True, "output": output})
        except Exception as exc:
            stderr(f"[planner] error: {exc}")
            return self._write_json(500, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):
        return


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    stderr(f"[planner] listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
