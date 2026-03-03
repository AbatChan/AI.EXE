#ifdef _WIN32

#include "app_config.h"
#include "diagnostics.h"
#include "inference_engine.h"
#include "logger.h"
#include "memory_store.h"
#include "rollback.h"
#include "sandbox.h"

#include <windows.h>
#include <commctrl.h>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr int kIdEditOutput = 1001;
constexpr int kIdEditInput = 1002;
constexpr int kIdBtnSend = 1003;
constexpr int kIdBtnStatus = 1004;
constexpr int kIdBtnDiag = 1005;
constexpr int kIdBtnBackendStatus = 1006;
constexpr int kIdBtnBackendSelfTest = 1007;
constexpr int kIdBtnTimeline = 1008;
constexpr int kIdBtnClear = 1009;
constexpr int kIdBtnReloadBackend = 1010;

std::string DiagnosticsText(const DiagnosticReport& d) {
  std::ostringstream oss;
  oss << "=== Hardware Diagnostics ===\n";
  oss << "GPU present: " << (d.gpu_present ? "yes" : "no") << '\n';
  oss << "GPU name: " << (d.gpu_name.empty() ? "(unknown)" : d.gpu_name) << '\n';
  oss << "VRAM: " << Diagnostics::FormatBytes(d.vram_bytes) << '\n';
  oss << "System RAM: " << Diagnostics::FormatBytes(d.ram_bytes) << '\n';
  oss << "Free storage: " << Diagnostics::FormatBytes(d.free_storage_bytes) << '\n';
  oss << "CUDA driver: " << (d.cuda_driver_detected ? "detected" : "not detected") << '\n';
  if (d.cuda_driver_detected) {
    oss << "CUDA driver version: " << d.cuda_driver_version_text << " (raw " << d.cuda_driver_version << ")\n";
  }

  for (const auto& w : d.warnings) {
    oss << "[warn] " << w << '\n';
  }

  for (const auto& e : d.errors) {
    oss << "[error] " << e << '\n';
  }

  oss << "Diagnostics status: " << (d.ok ? "PASS" : "FAIL") << "\n";
  return oss.str();
}

std::string TrimLeft(const std::string& s) {
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) {
    ++i;
  }
  return s.substr(i);
}

std::vector<std::string> TailFileLines(const std::filesystem::path& file, std::size_t n) {
  std::vector<std::string> lines;
  if (n == 0) {
    return lines;
  }

  std::ifstream in(file);
  if (!in.good()) {
    return lines;
  }

  std::string line;
  while (std::getline(in, line)) {
    lines.push_back(line);
  }

  if (lines.size() <= n) {
    return lines;
  }

  return std::vector<std::string>(lines.end() - static_cast<std::ptrdiff_t>(n), lines.end());
}

std::string ExtractJsonStringField(const std::string& line, const std::string& key) {
  const std::string marker = "\"" + key + "\":\"";
  const auto start = line.find(marker);
  if (start == std::string::npos) {
    return std::string();
  }

  std::string out;
  bool escaped = false;
  for (std::size_t i = start + marker.size(); i < line.size(); ++i) {
    const char c = line[i];
    if (escaped) {
      switch (c) {
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        default:
          out.push_back(c);
          break;
      }
      escaped = false;
      continue;
    }

    if (c == '\\') {
      escaped = true;
      continue;
    }

    if (c == '"') {
      break;
    }

    out.push_back(c);
  }

  return out;
}

std::string NormalizeForEdit(std::string text) {
  std::string out;
  out.reserve(text.size() * 2);

  for (std::size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '\n') {
      if (i == 0 || text[i - 1] != '\r') {
        out.push_back('\r');
      }
      out.push_back('\n');
    } else {
      out.push_back(text[i]);
    }
  }

  return out;
}

void AppendEditText(HWND edit, const std::string& text) {
  const std::string normalized = NormalizeForEdit(text);
  SendMessageA(edit, EM_SETSEL, static_cast<WPARAM>(-1), static_cast<LPARAM>(-1));
  SendMessageA(edit, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(normalized.c_str()));
  SendMessageA(edit, EM_SCROLLCARET, 0, 0);
}

std::string ReadEditText(HWND edit) {
  const int len = GetWindowTextLengthA(edit);
  if (len <= 0) {
    return std::string();
  }

  std::string out(static_cast<std::size_t>(len), '\0');
  GetWindowTextA(edit, out.data(), len + 1);
  return out;
}

class RuntimeController {
 public:
  RuntimeController() : cfg_(BuildDefaultConfig(std::filesystem::current_path())), logger_(cfg_.log_path) {}

  bool Initialize(std::string* out) {
    std::error_code ec;
    std::filesystem::create_directories(cfg_.model_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.runtime_backend_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.log_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.memory_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.snapshot_dir, ec);
    std::filesystem::create_directories(cfg_.sandbox_root, ec);

    if (!logger_.Initialize()) {
      *out = "Logger initialization failed.";
      return false;
    }

    logger_.Info("startup", "AI.EXE GUI boot sequence started");

    startup_diag_ = Diagnostics::Run(cfg_);
    std::string msg = DiagnosticsText(startup_diag_);

    if (!startup_diag_.ok) {
      logger_.Error("diagnostics", "Startup diagnostics failed (GUI)");
      *out = msg + "\nSystem requirements not satisfied. Runtime features are disabled.\n";
      ready_ = false;
      return false;
    }

    memory_ = std::make_unique<MemoryStore>(cfg_.memory_path);
    std::string err;
    if (!memory_->Load(&err)) {
      logger_.Error("memory", err);
      *out = msg + "\nMemory load failed: " + err + "\n";
      ready_ = false;
      return false;
    }

    rollback_ = std::make_unique<RollbackManager>(cfg_.snapshot_dir);
    if (!rollback_->EnsureDirectory(&err)) {
      logger_.Error("rollback", err);
      *out = msg + "\nRollback init failed: " + err + "\n";
      ready_ = false;
      return false;
    }

    sandbox_ = std::make_unique<Sandbox>(SandboxPolicy{{cfg_.sandbox_root, cfg_.memory_path.parent_path()},
                                                       cfg_.max_prompt_chars,
                                                       cfg_.max_runtime_seconds,
                                                       cfg_.max_child_memory_bytes,
                                                       cfg_.max_exec_output_bytes,
                                                       cfg_.max_child_cpu_percent});

    if (!inference_.LoadModel(cfg_.model_path, &err)) {
      logger_.Error("model", err);
      *out = msg + "\nModel load failed: " + err + "\n";
      ready_ = false;
      return false;
    }

    model_info_ = inference_.GetModelInfo();
    ConfigureBackend();

    logger_.Info("model", "Model loaded successfully (GUI)");
    ready_ = true;

    std::ostringstream oss;
    oss << msg << "\n"
        << "Model loaded: " << model_info_.path.string() << "\n"
        << "Model format: " << model_info_.format << "\n"
        << "Model size: " << Diagnostics::FormatBytes(model_info_.size_bytes) << "\n"
        << "Backend: "
        << (inference_.IsBackendConfigured() ? inference_.BackendPath() : "unconfigured")
        << (backend_version_.empty() ? "" : " (" + backend_version_ + ")") << "\n"
        << "GUI runtime ready.\n";
    *out = oss.str();
    return true;
  }

  std::string Prompt(const std::string& prompt) {
    if (!ready_) {
      return "Runtime is not ready due to startup failures.\n";
    }

    std::string err;
    if (!sandbox_->ValidatePrompt(prompt, &err)) {
      logger_.Error("prompt_blocked", err);
      return "Prompt blocked: " + err + "\n";
    }

    logger_.Info("inference", "Prompt received (GUI)");
    const std::string response = inference_.Generate(prompt);
    return response + "\n";
  }

  std::string Status() const {
    std::ostringstream oss;
    oss << "=== Runtime Status ===\n";
    oss << "Ready: " << (ready_ ? "yes" : "no") << "\n";
    oss << "Model: " << model_info_.path.string() << "\n";
    oss << "Model format: " << model_info_.format << "\n";
    oss << "Model size: " << Diagnostics::FormatBytes(model_info_.size_bytes) << "\n";
    oss << "Backend path: "
        << (inference_.IsBackendConfigured() ? inference_.BackendPath() : "unconfigured") << "\n";
    oss << "Backend version: " << (backend_version_.empty() ? "unknown" : backend_version_) << "\n";
    oss << "Backend self-test: "
        << (backend_selftest_ok_ ? "OK" : (backend_selftest_details_.empty() ? "UNKNOWN" : "FAILED")) << "\n";
    if (!backend_selftest_ok_ && !backend_selftest_details_.empty()) {
      oss << "Backend detail: " << backend_selftest_details_ << "\n";
    }

    if (memory_) {
      oss << "Memory entries: " << memory_->All().size() << "\n";
    }

    if (rollback_) {
      oss << "Snapshots: " << rollback_->ListSnapshots().size() << "\n";
    }

    oss << "Sandbox root: " << cfg_.sandbox_root.string() << "\n";
    oss << "Log file: " << cfg_.log_path.string() << "\n";
    return oss.str();
  }

  std::string RerunDiagnostics() {
    startup_diag_ = Diagnostics::Run(cfg_);
    logger_.Info("diagnostics", startup_diag_.ok ? "Manual diagnostics pass (GUI)" : "Manual diagnostics fail (GUI)");
    return DiagnosticsText(startup_diag_) + "\n";
  }

  std::string BackendStatus() const {
    std::ostringstream oss;
    if (inference_.IsBackendConfigured()) {
      oss << "configured: " << inference_.BackendPath() << "\n";
      oss << "version: " << (backend_version_.empty() ? "unknown" : backend_version_) << "\n";
      oss << "self-test: " << (backend_selftest_ok_ ? "OK" : "UNKNOWN/FAILED") << "\n";
    } else {
      oss << "not configured (placeholder inference active)\n";
      if (!backend_selftest_details_.empty()) {
        oss << "reason: " << backend_selftest_details_ << "\n";
      }
    }
    return oss.str();
  }

  std::string BackendSelfTest() {
    if (!inference_.IsBackendConfigured()) {
      std::ostringstream oss;
      oss << "backend is not configured\n";
      if (!backend_selftest_details_.empty()) {
        oss << "reason: " << backend_selftest_details_ << "\n";
      }
      return oss.str();
    }

    std::string details;
    if (inference_.RunBackendSelfTest(&details)) {
      backend_selftest_ok_ = true;
      backend_selftest_details_ = details;
      std::string version_text;
      if (inference_.QueryBackendVersion(&version_text)) {
        backend_version_ = version_text;
      }
      logger_.Info("backend", "Manual self-test passed (GUI)");
      return "backend self-test OK: " + details +
             " (version: " + (backend_version_.empty() ? "unknown" : backend_version_) + ")\n";
    }

    inference_.DisableBackend();
    backend_selftest_ok_ = false;
    backend_version_.clear();
    backend_selftest_details_ = details;
    logger_.Error("backend", "Manual self-test failed (GUI): " + details);
    return "backend self-test FAILED: " + details + " (backend disabled)\n";
  }

  std::string BackendReload() {
    ConfigureBackend();
    if (inference_.IsBackendConfigured() && backend_selftest_ok_) {
      return "backend reloaded: " + inference_.BackendPath() +
             " (self-test: OK, version: " + (backend_version_.empty() ? "unknown" : backend_version_) + ")\n";
    }

    return "backend reload failed: " + backend_selftest_details_ + "\n";
  }

  std::string Timeline(std::size_t count) const {
    const auto lines = TailFileLines(cfg_.log_path, count);
    if (lines.empty()) {
      return "(no timeline entries)\n";
    }

    std::ostringstream oss;
    for (const auto& entry : lines) {
      const auto ts = ExtractJsonStringField(entry, "ts");
      const auto level = ExtractJsonStringField(entry, "level");
      const auto event = ExtractJsonStringField(entry, "event");
      const auto message = ExtractJsonStringField(entry, "message");
      if (ts.empty() && event.empty()) {
        oss << entry << '\n';
      } else {
        oss << ts << " [" << level << "] " << event << " :: " << message << '\n';
      }
    }
    return oss.str();
  }

  std::string LogTail(std::size_t count) const {
    const auto lines = TailFileLines(cfg_.log_path, count);
    if (lines.empty()) {
      return "(no log entries)\n";
    }

    std::ostringstream oss;
    for (const auto& line : lines) {
      oss << line << '\n';
    }
    return oss.str();
  }

  bool ready() const { return ready_; }

 private:
  void ConfigureBackend() {
    InferenceBackendConfig backend_cfg;
    backend_cfg.executable = cfg_.runtime_backend_path;
    backend_cfg.timeout_seconds = cfg_.max_runtime_seconds;
    backend_cfg.memory_limit_bytes = cfg_.max_child_memory_bytes;
    backend_cfg.output_limit_bytes = cfg_.max_exec_output_bytes;
    backend_cfg.cpu_rate_percent = cfg_.max_child_cpu_percent;

    std::string backend_err;
    if (inference_.ConfigureBackend(backend_cfg, &backend_err)) {
      if (inference_.RunBackendSelfTest(&backend_selftest_details_)) {
        backend_selftest_ok_ = true;
        std::string version_text;
        if (inference_.QueryBackendVersion(&version_text)) {
          backend_version_ = version_text;
        } else {
          backend_version_ = "unknown";
        }
        logger_.Info("backend", "Local backend configured and healthy (GUI): " + inference_.BackendPath());
        return;
      }

      backend_selftest_ok_ = false;
      backend_version_.clear();
      logger_.Error("backend", "Backend self-test failed (GUI): " + backend_selftest_details_);
      inference_.DisableBackend();
      return;
    }

    backend_selftest_ok_ = false;
    backend_version_.clear();
    backend_selftest_details_ = backend_err;
    logger_.Info("backend", "Local backend not configured (GUI): " + backend_err);
  }

  AppConfig cfg_;
  Logger logger_;
  InferenceEngine inference_;
  ModelInfo model_info_;
  DiagnosticReport startup_diag_;
  std::unique_ptr<Sandbox> sandbox_;
  std::unique_ptr<MemoryStore> memory_;
  std::unique_ptr<RollbackManager> rollback_;
  bool ready_ = false;
  bool backend_selftest_ok_ = false;
  std::string backend_selftest_details_;
  std::string backend_version_;
};

struct UiState {
  RuntimeController runtime;
  HWND output_edit = nullptr;
  HWND input_edit = nullptr;
  HWND send_btn = nullptr;
};

UiState* GetState(HWND hwnd) {
  return reinterpret_cast<UiState*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));
}

void LayoutControls(HWND hwnd, UiState* s) {
  RECT rc{};
  GetClientRect(hwnd, &rc);

  const int margin = 10;
  const int row1_h = 28;
  const int row2_h = 28;
  const int button_w = 120;
  const int button_gap = 8;

  int x = margin;
  int y = margin;

  const std::vector<int> row1 = {
      kIdBtnStatus,
      kIdBtnDiag,
      kIdBtnBackendStatus,
      kIdBtnBackendSelfTest,
      kIdBtnReloadBackend,
      kIdBtnTimeline,
      kIdBtnClear,
  };

  for (int id : row1) {
    HWND h = GetDlgItem(hwnd, id);
    if (h) {
      MoveWindow(h, x, y, button_w, row1_h, TRUE);
      x += button_w + button_gap;
    }
  }

  y += row1_h + margin;
  const int input_w = (rc.right - rc.left) - (margin * 3) - button_w;
  MoveWindow(s->input_edit, margin, y, input_w, row2_h, TRUE);
  MoveWindow(s->send_btn, margin + input_w + margin, y, button_w, row2_h, TRUE);

  y += row2_h + margin;
  const int output_h = (rc.bottom - rc.top) - y - margin;
  MoveWindow(s->output_edit, margin, y, (rc.right - rc.left) - (margin * 2), output_h, TRUE);
}

void HandlePrompt(HWND hwnd, UiState* s) {
  std::string input = TrimLeft(ReadEditText(s->input_edit));
  SetWindowTextA(s->input_edit, "");

  if (input.empty()) {
    return;
  }

  AppendEditText(s->output_edit, "> " + input + "\n");

  if (input == ":status") {
    AppendEditText(s->output_edit, s->runtime.Status() + "\n");
    return;
  }

  if (input == ":diag") {
    AppendEditText(s->output_edit, s->runtime.RerunDiagnostics() + "\n");
    return;
  }

  if (input == ":backend-status") {
    AppendEditText(s->output_edit, s->runtime.BackendStatus() + "\n");
    return;
  }

  if (input == ":backend-selftest") {
    AppendEditText(s->output_edit, s->runtime.BackendSelfTest() + "\n");
    return;
  }

  if (input == ":backend-reload") {
    AppendEditText(s->output_edit, s->runtime.BackendReload() + "\n");
    return;
  }

  if (input.rfind(":timeline", 0) == 0) {
    std::size_t n = 20;
    if (input.size() > 9) {
      std::istringstream iss(input.substr(9));
      std::size_t parsed = 0;
      if (iss >> parsed) {
        n = parsed;
      }
    }
    AppendEditText(s->output_edit, s->runtime.Timeline(n) + "\n");
    return;
  }

  if (input.rfind(":log-tail", 0) == 0) {
    std::size_t n = 20;
    if (input.size() > 9) {
      std::istringstream iss(input.substr(9));
      std::size_t parsed = 0;
      if (iss >> parsed) {
        n = parsed;
      }
    }
    AppendEditText(s->output_edit, s->runtime.LogTail(n) + "\n");
    return;
  }

  AppendEditText(s->output_edit, s->runtime.Prompt(input));
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  UiState* s = GetState(hwnd);

  switch (msg) {
    case WM_CREATE: {
      auto* state = new UiState();
      SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
      s = state;

      CreateWindowExA(0,
                      "BUTTON",
                      "Status",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnStatus),
                      nullptr,
                      nullptr);

      CreateWindowExA(0,
                      "BUTTON",
                      "Diagnostics",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnDiag),
                      nullptr,
                      nullptr);

      CreateWindowExA(0,
                      "BUTTON",
                      "Backend Status",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnBackendStatus),
                      nullptr,
                      nullptr);

      CreateWindowExA(0,
                      "BUTTON",
                      "Backend SelfTest",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnBackendSelfTest),
                      nullptr,
                      nullptr);

      CreateWindowExA(0,
                      "BUTTON",
                      "Backend Reload",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnReloadBackend),
                      nullptr,
                      nullptr);

      CreateWindowExA(0,
                      "BUTTON",
                      "Timeline",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnTimeline),
                      nullptr,
                      nullptr);

      CreateWindowExA(0,
                      "BUTTON",
                      "Clear",
                      WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                      0,
                      0,
                      0,
                      0,
                      hwnd,
                      reinterpret_cast<HMENU>(kIdBtnClear),
                      nullptr,
                      nullptr);

      s->input_edit = CreateWindowExA(WS_EX_CLIENTEDGE,
                                      "EDIT",
                                      "",
                                      WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                                      0,
                                      0,
                                      0,
                                      0,
                                      hwnd,
                                      reinterpret_cast<HMENU>(kIdEditInput),
                                      nullptr,
                                      nullptr);

      s->send_btn = CreateWindowExA(0,
                                    "BUTTON",
                                    "Send",
                                    WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
                                    0,
                                    0,
                                    0,
                                    0,
                                    hwnd,
                                    reinterpret_cast<HMENU>(kIdBtnSend),
                                    nullptr,
                                    nullptr);

      s->output_edit = CreateWindowExA(WS_EX_CLIENTEDGE,
                                       "EDIT",
                                       "",
                                       WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY |
                                           WS_VSCROLL | WS_HSCROLL,
                                       0,
                                       0,
                                       0,
                                       0,
                                       hwnd,
                                       reinterpret_cast<HMENU>(kIdEditOutput),
                                       nullptr,
                                       nullptr);

      SendMessageA(s->output_edit, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(ANSI_FIXED_FONT)), TRUE);
      SendMessageA(s->input_edit, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);

      std::string init_text;
      const bool ready = s->runtime.Initialize(&init_text);
      AppendEditText(s->output_edit, init_text + "\n");

      if (!ready) {
        EnableWindow(s->input_edit, FALSE);
        EnableWindow(s->send_btn, FALSE);
      }

      LayoutControls(hwnd, s);
      return 0;
    }

    case WM_SIZE:
      if (s) {
        LayoutControls(hwnd, s);
      }
      return 0;

    case WM_COMMAND: {
      if (!s) {
        return 0;
      }

      const int id = LOWORD(wparam);
      const int code = HIWORD(wparam);

      if (id == kIdBtnSend && code == BN_CLICKED) {
        HandlePrompt(hwnd, s);
        return 0;
      }

      if (id == kIdBtnStatus && code == BN_CLICKED) {
        AppendEditText(s->output_edit, s->runtime.Status() + "\n");
        return 0;
      }

      if (id == kIdBtnDiag && code == BN_CLICKED) {
        AppendEditText(s->output_edit, s->runtime.RerunDiagnostics() + "\n");
        return 0;
      }

      if (id == kIdBtnBackendStatus && code == BN_CLICKED) {
        AppendEditText(s->output_edit, s->runtime.BackendStatus() + "\n");
        return 0;
      }

      if (id == kIdBtnBackendSelfTest && code == BN_CLICKED) {
        AppendEditText(s->output_edit, s->runtime.BackendSelfTest() + "\n");
        return 0;
      }

      if (id == kIdBtnReloadBackend && code == BN_CLICKED) {
        AppendEditText(s->output_edit, s->runtime.BackendReload() + "\n");
        return 0;
      }

      if (id == kIdBtnTimeline && code == BN_CLICKED) {
        AppendEditText(s->output_edit, s->runtime.Timeline(20) + "\n");
        return 0;
      }

      if (id == kIdBtnClear && code == BN_CLICKED) {
        SetWindowTextA(s->output_edit, "");
        return 0;
      }

      if (id == kIdEditInput && code == EN_MAXTEXT) {
        return 0;
      }

      return 0;
    }

    case WM_DESTROY:
      if (s) {
        delete s;
        SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
      }
      PostQuitMessage(0);
      return 0;

    default:
      return DefWindowProc(hwnd, msg, wparam, lparam);
  }
}

}  // namespace

int WINAPI WinMain(HINSTANCE hinst, HINSTANCE, LPSTR, int show_cmd) {
  INITCOMMONCONTROLSEX icex{};
  icex.dwSize = sizeof(icex);
  icex.dwICC = ICC_STANDARD_CLASSES;
  InitCommonControlsEx(&icex);

  const char* kClassName = "AiexeGuiWindow";
  WNDCLASSA wc{};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hinst;
  wc.lpszClassName = kClassName;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);

  if (!RegisterClassA(&wc)) {
    return 1;
  }

  HWND hwnd = CreateWindowExA(0,
                              kClassName,
                              "AI.EXE Phase 1 Dashboard (Offline)",
                              WS_OVERLAPPEDWINDOW,
                              CW_USEDEFAULT,
                              CW_USEDEFAULT,
                              1200,
                              760,
                              nullptr,
                              nullptr,
                              hinst,
                              nullptr);

  if (!hwnd) {
    return 1;
  }

  ShowWindow(hwnd, show_cmd);
  UpdateWindow(hwnd);

  MSG msg;
  while (GetMessage(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);
  }

  return static_cast<int>(msg.wParam);
}

#endif
