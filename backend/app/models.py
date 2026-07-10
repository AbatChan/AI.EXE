"""Pydantic response models for the backend API."""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class SubsystemStatus(BaseModel):
    name: str
    state: str  # "ready" | "not_implemented" | "error"
    detail: str = ""


class StatusResponse(BaseModel):
    service: str
    version: str
    core_state: str  # "online" | "degraded" | "offline"
    uptime_seconds: float
    subsystems: List[SubsystemStatus]


class UsageResponse(BaseModel):
    period: str
    credits_used: int
    credits_limit: int
    credits_remaining: int
    credit_cost_per_request: int
    requests_in_window: int
    rate_limit_max: int
    rate_limit_window_seconds: int
    requests_remaining_in_window: int
    warning: Optional[str] = None


class ApiKeySetRequest(BaseModel):
    api_key: str


class ApiKeyStatusResponse(BaseModel):
    set: bool
    masked: Optional[str] = None


class ProviderRequest(BaseModel):
    base_url: str
    model: str
    kind: str = "openai"  # "openai" | "ollama" (native /api/chat, e.g. Venice Pro adapter)


class ProviderInfo(BaseModel):
    base_url: str
    model: str
    kind: str = "openai"
    configured: bool


class ProviderHealthResponse(BaseModel):
    reachable: bool
    kind: str = ""
    base_url: str = ""
    models: List[str] = []
    detail: str = ""
    current_model: str = ""   # Venice adapter: the model the Venice page is actually on
    credits: str = ""         # Venice adapter: cached account balance text, e.g. "10,279 Credits"
    priced_models: List[str] = []  # Venice adapter: models marked with the credit/coin icon


class ProviderCompleteRequest(BaseModel):
    messages: List[Dict[str, str]]
    max_tokens: int = 4096
    temperature: float = 0.2
    chat_id: str = ""   # AI.EXE chat id — the adapter maps it to one Venice conversation
    think: str = ""     # "on" | "off" — adapter normalizes Venice's per-chat Reasoning switch
    chat_name: str = "" # AI.EXE chat name — adapter renames the Venice conversation to match
    attachments: List[Dict[str, Any]] = []  # images the adapter uploads via Venice's file input
    structured_output: bool = False  # internal planner JSON; enables strict adapter bounds
    max_output_chars: int = 0        # hard character cap for structured adapter output


class ProviderDeleteChatRequest(BaseModel):
    chat_id: str = ""
    slug: str = ""


class ProviderRenameChatRequest(BaseModel):
    chat_id: str = ""
    slug: str = ""
    name: str = ""


class ProviderStopGenerationRequest(BaseModel):
    chat_id: str = ""


class ProviderCompleteResponse(BaseModel):
    ok: bool
    content: str = ""
    error: str = ""


class AdapterStartRequest(BaseModel):
    username: str = ""
    password: str = ""
    port: int = 9999
    headless: bool = True
    hide_prompt: bool = False  # hide the raw typed prompt in the Venice window (off by default)
    model: str = ""            # app's selected model — preselected at boot while the window is visible


class AdapterStatusResponse(BaseModel):
    installed: bool
    running: bool
    serving: bool = False  # port bound + serving = login done, actually ready (not just launching)
    pid: Optional[int] = None
    port: int = 9999
    install_dir: str = ""
    stage: str = ""         # "not_installed" | "installing" | "starting" | "login" | "network" | "ready" | "stopped"
    detail: str = ""        # short user-facing status detail
    network_issue: bool = False
    retry_hint: str = ""


class AdapterActionResponse(BaseModel):
    ok: bool
    detail: str = ""
    pid: Optional[int] = None
    port: int = 9999


class ProviderUsageResponse(BaseModel):
    available: bool
    source: str = ""
    balances: dict = {}
    detail: str = ""


class RunPythonRequest(BaseModel):
    code: Optional[str] = None          # single-file program (written to `entry`)
    files: Optional[Dict[str, str]] = None  # OR a multi-file project: relpath -> content
    entry: str = "main.py"
    requirements: List[str] = []
    stdin: Optional[str] = None
    args: List[str] = []
    timeout_seconds: int = 30


class RunPythonResult(BaseModel):
    ok: bool
    exit_code: Optional[int] = None
    timed_out: bool
    blocked: bool
    block_reason: Optional[str] = None
    stdout: str
    stderr: str
    duration_seconds: float
    sandbox_dir: str
    install_log: str = ""
    retry_hint: Optional[str] = None
    isolation: str = "none"  # "seatbelt" (macOS FS jail) | "none" (rlimits+guard only)


class GenerateRequest(BaseModel):
    prompt: str
    language: str = "python"  # "python" (run in sandbox) | "web" (static files, no run)
    entry: str = "main.py"
    run: bool = True
    auto_correct: bool = True
    max_retries: int = 2
    requirements: List[str] = []
    timeout_seconds: int = 30
    project: Optional[str] = None  # if set, save the generated files to this project folder


class GenerateAttempt(BaseModel):
    files: List[str]
    ok: Optional[bool] = None
    exit_code: Optional[int] = None
    stderr_excerpt: str = ""


class GenerateResult(BaseModel):
    ok: bool
    files: Dict[str, str]
    prose: str = ""
    stdout: str = ""
    stderr: str = ""
    blocked: bool = False
    attempts: List[GenerateAttempt] = []
    stopped_reason: Optional[str] = None
    error: Optional[str] = None
    project: Optional[str] = None  # saved project slug, if `project` was requested


class ProjectSaveRequest(BaseModel):
    name: str
    files: Dict[str, str]


class ProjectSummary(BaseModel):
    name: str
    file_count: int
    updated_at: Optional[float] = None


class ProjectInfo(BaseModel):
    name: str
    file_count: int
    created_at: Optional[float] = None
    updated_at: Optional[float] = None
    files: List[str]
    meta: dict = {}


class ProjectListResponse(BaseModel):
    projects: List[ProjectSummary]


class PackageRequest(BaseModel):
    target: str  # "py" | "exe" (apk/pt later)
    project: Optional[str] = None        # package an existing saved project, OR
    files: Optional[Dict[str, str]] = None  # package inline files
    entry: str = "main.py"
    name: Optional[str] = None
    timeout_seconds: int = 300


class PackageResult(BaseModel):
    ok: bool
    target: str
    artifact: Optional[str] = None
    artifact_id: Optional[str] = None
    download_path: Optional[str] = None
    build_log: str = ""
    error: Optional[str] = None


class ModuleSummary(BaseModel):
    id: str
    name: str
    type: str
    status: str
    file_count: int


class ModuleInfo(BaseModel):
    id: str
    name: str
    type: str
    status: str
    files: List[str]
    entry: Optional[str] = None
    uploaded_at: Optional[float] = None
    connected_at: Optional[float] = None
    registration_token: Optional[str] = None


class ModuleListResponse(BaseModel):
    modules: List[ModuleSummary]


class PdfToSoftwareResult(BaseModel):
    ok: bool
    project: Optional[str] = None
    files: Dict[str, str]
    sections: List[str] = []
    mapping: dict = {}
    build_log: str = ""
    run_ok: Optional[bool] = None
    download_path: Optional[str] = None
    error: Optional[str] = None


class FileContentResponse(BaseModel):
    path: str
    content: str
