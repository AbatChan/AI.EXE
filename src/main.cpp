#include "app_config.h"
#include "diagnostics.h"
#include "inference_engine.h"
#include "logger.h"
#include "memory_store.h"
#include "rollback.h"
#include "sandbox.h"

#include <filesystem>
#include <cctype>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void PrintDiagnostics(const DiagnosticReport& d) {
  std::cout << "=== Hardware Diagnostics ===\n";
  std::cout << "GPU present: " << (d.gpu_present ? "yes" : "no") << '\n';
  std::cout << "GPU name: " << (d.gpu_name.empty() ? "(unknown)" : d.gpu_name) << '\n';
  std::cout << "VRAM: " << Diagnostics::FormatBytes(d.vram_bytes) << '\n';
  std::cout << "System RAM: " << Diagnostics::FormatBytes(d.ram_bytes) << '\n';
  std::cout << "Free storage: " << Diagnostics::FormatBytes(d.free_storage_bytes) << '\n';
  std::cout << "CUDA driver: " << (d.cuda_driver_detected ? "detected" : "not detected") << '\n';
  if (d.cuda_driver_detected) {
    std::cout << "CUDA driver version: " << d.cuda_driver_version_text
              << " (raw " << d.cuda_driver_version << ")\n";
  }

  for (const auto& w : d.warnings) {
    std::cout << "[warn] " << w << '\n';
  }

  for (const auto& e : d.errors) {
    std::cout << "[error] " << e << '\n';
  }

  std::cout << "Diagnostics status: " << (d.ok ? "PASS" : "FAIL") << "\n\n";
}

void PrintHelp() {
  std::cout << "Commands:\n"
            << "  :help                    show help\n"
            << "  :diag                    rerun diagnostics\n"
            << "  :mem-get <key>           read memory key\n"
            << "  :mem-set <key> <value>   write memory key\n"
            << "  :mem-list                list memory keys\n"
            << "  :snapshot                snapshot memory file\n"
            << "  :snapshots               list snapshots\n"
            << "  :restore <path>          restore memory file from snapshot\n"
            << "  :sandbox-write <rel> <text> write text under sandbox root\n"
            << "  :sandbox-read <rel>      read text under sandbox root\n"
            << "  :exec <rel-exe> [args]   execute sandboxed .exe under sandbox root\n"
            << "  :backend-status          show inference backend status\n"
            << "  :backend-selftest        run backend self-test now\n"
            << "  :backend-reload          reload backend config and rerun self-test\n"
            << "  :status                  show runtime dashboard summary\n"
            << "  :log-tail [n]            show last n log entries (default 10)\n"
            << "  :timeline [n]            show parsed activity timeline (default 10)\n"
            << "  :quit                    exit\n";
}

std::string TrimLeft(const std::string& s) {
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) {
    ++i;
  }
  return s.substr(i);
}

std::vector<std::string> TokenizeArgs(const std::string& input) {
  std::vector<std::string> out;
  std::string current;
  bool in_quotes = false;
  bool escaped = false;

  for (char c : input) {
    if (escaped) {
      current.push_back(c);
      escaped = false;
      continue;
    }

    if (c == '\\') {
      escaped = true;
      continue;
    }

    if (c == '\"') {
      in_quotes = !in_quotes;
      continue;
    }

    if (std::isspace(static_cast<unsigned char>(c)) && !in_quotes) {
      if (!current.empty()) {
        out.push_back(current);
        current.clear();
      }
      continue;
    }

    current.push_back(c);
  }

  if (!current.empty()) {
    out.push_back(current);
  }

  return out;
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

    if (c == '\"') {
      break;
    }

    out.push_back(c);
  }

  return out;
}

}  // namespace

int main() {
  const auto root = std::filesystem::current_path();
  const auto cfg = BuildDefaultConfig(root);

  std::error_code ec;
  std::filesystem::create_directories(cfg.model_path.parent_path(), ec);
  std::filesystem::create_directories(cfg.log_path.parent_path(), ec);
  std::filesystem::create_directories(cfg.memory_path.parent_path(), ec);
  std::filesystem::create_directories(cfg.snapshot_dir, ec);
  std::filesystem::create_directories(cfg.sandbox_root, ec);
  std::filesystem::create_directories(cfg.runtime_backend_path.parent_path(), ec);

  Logger logger(cfg.log_path);
  if (!logger.Initialize()) {
    std::cerr << "Failed to initialize logger.\n";
    return 1;
  }

  logger.Info("startup", "AI.EXE boot sequence started");

  const DiagnosticReport startup_diag = Diagnostics::Run(cfg);
  PrintDiagnostics(startup_diag);
  if (!startup_diag.ok) {
    logger.Error("diagnostics", "Startup diagnostics failed");
    std::cerr << "System requirements not satisfied. Exiting safely.\n";
    return 1;
  }

  MemoryStore memory(cfg.memory_path);
  std::string err;
  if (!memory.Load(&err)) {
    logger.Error("memory", err);
    std::cerr << "Memory load error: " << err << '\n';
    return 1;
  }
  logger.Info("memory", "Memory store loaded");

  RollbackManager rollback(cfg.snapshot_dir);
  if (!rollback.EnsureDirectory(&err)) {
    logger.Error("rollback", err);
    std::cerr << "Snapshot directory error: " << err << '\n';
    return 1;
  }

  Sandbox sandbox(SandboxPolicy{{cfg.sandbox_root, cfg.memory_path.parent_path()},
                                cfg.max_prompt_chars,
                                cfg.max_runtime_seconds,
                                cfg.max_child_memory_bytes,
                                cfg.max_exec_output_bytes,
                                cfg.max_child_cpu_percent});

  InferenceEngine inference;
  if (!inference.LoadModel(cfg.model_path, &err)) {
    logger.Error("model", err);
    std::cerr << "Model load error: " << err << '\n';
    std::cerr << "Place your local quantized model at: " << cfg.model_path.string() << '\n';
    return 1;
  }

  const ModelInfo model_info = inference.GetModelInfo();

  InferenceBackendConfig backend_cfg;
  backend_cfg.executable = cfg.runtime_backend_path;
  backend_cfg.timeout_seconds = cfg.max_runtime_seconds;
  backend_cfg.memory_limit_bytes = cfg.max_child_memory_bytes;
  backend_cfg.output_limit_bytes = cfg.max_exec_output_bytes;
  backend_cfg.cpu_rate_percent = cfg.max_child_cpu_percent;
  bool backend_selftest_ok = false;
  std::string backend_selftest_details;
  std::string backend_version_text;

  auto configure_backend = [&]() -> bool {
    std::string backend_err;
    if (inference.ConfigureBackend(backend_cfg, &backend_err)) {
      if (inference.RunBackendSelfTest(&backend_selftest_details)) {
        if (!inference.QueryBackendVersion(&backend_version_text)) {
          backend_version_text = "unknown";
        }
        backend_selftest_ok = true;
        logger.Info("backend", "Local backend configured and healthy: " + inference.BackendPath());
        return true;
      }

      backend_selftest_ok = false;
      backend_version_text.clear();
      logger.Error("backend", "Backend self-test failed: " + backend_selftest_details);
      inference.DisableBackend();
      return false;
    }

    backend_selftest_ok = false;
    backend_version_text.clear();
    backend_selftest_details = backend_err;
    logger.Info("backend", "Local backend not configured. " + backend_err);
    return false;
  };

  if (configure_backend()) {
    std::cout << "Backend: " << inference.BackendPath() << " (self-test: OK, version: "
              << (backend_version_text.empty() ? "unknown" : backend_version_text) << ")\n";
  } else {
    std::cout << "Backend: unavailable/unhealthy (" << backend_selftest_details
              << "), using placeholder path.\n";
  }

  logger.Info("model", "Model loaded successfully");
  logger.Info("model",
              "Model format=" + model_info.format +
                  ", size=" + Diagnostics::FormatBytes(model_info.size_bytes));
  std::cout << "Model loaded: " << model_info.path.string() << '\n';
  std::cout << "Model format: " << model_info.format << '\n';
  std::cout << "Model size: " << Diagnostics::FormatBytes(model_info.size_bytes) << '\n';
  std::cout << "AI.EXE ready (offline mode). Type :help for commands.\n";

  std::string line;
  while (true) {
    std::cout << "> ";
    if (!std::getline(std::cin, line)) {
      break;
    }

    if (line == ":quit") {
      logger.Info("shutdown", "User requested shutdown");
      break;
    }

    if (line == ":help") {
      PrintHelp();
      continue;
    }

    if (line == ":backend-status") {
      if (inference.IsBackendConfigured()) {
        std::cout << "configured: " << inference.BackendPath() << '\n';
        std::cout << "version: " << (backend_version_text.empty() ? "unknown" : backend_version_text) << '\n';
        std::cout << "self-test: " << (backend_selftest_ok ? "OK" : "UNKNOWN/FAILED") << '\n';
      } else {
        std::cout << "not configured (placeholder inference active)\n";
        if (!backend_selftest_details.empty()) {
          std::cout << "reason: " << backend_selftest_details << '\n';
        }
      }
      continue;
    }

    if (line == ":backend-reload") {
      if (configure_backend()) {
        std::cout << "backend reloaded: " << inference.BackendPath()
                  << " (self-test: OK, version: "
                  << (backend_version_text.empty() ? "unknown" : backend_version_text) << ")\n";
      } else {
        std::cout << "backend reload failed: " << backend_selftest_details
                  << " (placeholder inference active)\n";
      }
      continue;
    }

    if (line == ":backend-selftest") {
      if (!inference.IsBackendConfigured()) {
        std::cout << "backend is not configured\n";
        if (!backend_selftest_details.empty()) {
          std::cout << "reason: " << backend_selftest_details << '\n';
        }
        continue;
      }

      std::string details;
      if (inference.RunBackendSelfTest(&details)) {
        backend_selftest_ok = true;
        backend_selftest_details = details;
        if (!inference.QueryBackendVersion(&backend_version_text)) {
          backend_version_text = "unknown";
        }
        logger.Info("backend", "Manual self-test passed");
        std::cout << "backend self-test OK: " << details
                  << " (version: " << (backend_version_text.empty() ? "unknown" : backend_version_text) << ")\n";
      } else {
        inference.DisableBackend();
        backend_selftest_ok = false;
        backend_version_text.clear();
        backend_selftest_details = details;
        logger.Error("backend", "Manual self-test failed: " + details);
        std::cout << "backend self-test FAILED: " << details << " (backend disabled)\n";
      }
      continue;
    }

    if (line == ":status") {
      const auto snapshots = rollback.ListSnapshots();
      const auto memory_entries = memory.All().size();
      std::cout << "=== Runtime Status ===\n";
      std::cout << "Model: " << model_info.path.string() << '\n';
      std::cout << "Model format: " << model_info.format << '\n';
      std::cout << "Model size: " << Diagnostics::FormatBytes(model_info.size_bytes) << '\n';
      std::cout << "Backend: "
                << (inference.IsBackendConfigured() ? inference.BackendPath() : "unconfigured (placeholder)")
                << '\n';
      std::cout << "Backend version: " << (backend_version_text.empty() ? "unknown" : backend_version_text) << '\n';
      std::cout << "Backend self-test: "
                << (backend_selftest_ok ? "OK" : (backend_selftest_details.empty() ? "UNKNOWN" : "FAILED"))
                << '\n';
      if (!backend_selftest_ok && !backend_selftest_details.empty()) {
        std::cout << "Backend detail: " << backend_selftest_details << '\n';
      }
      std::cout << "Memory entries: " << memory_entries << '\n';
      std::cout << "Snapshots: " << snapshots.size() << '\n';
      std::cout << "Sandbox root: " << cfg.sandbox_root.string() << '\n';
      std::cout << "Log file: " << cfg.log_path.string() << '\n';
      continue;
    }

    if (line.rfind(":log-tail", 0) == 0) {
      std::size_t count = 10;
      if (line.size() > 9) {
        std::istringstream iss(line.substr(9));
        std::size_t parsed = 0;
        if (iss >> parsed) {
          count = parsed;
        }
      }

      const auto tail = TailFileLines(cfg.log_path, count);
      if (tail.empty()) {
        std::cout << "(no log entries)\n";
      } else {
        for (const auto& entry : tail) {
          std::cout << entry << '\n';
        }
      }
      continue;
    }

    if (line.rfind(":timeline", 0) == 0) {
      std::size_t count = 10;
      if (line.size() > 9) {
        std::istringstream iss(line.substr(9));
        std::size_t parsed = 0;
        if (iss >> parsed) {
          count = parsed;
        }
      }

      const auto tail = TailFileLines(cfg.log_path, count);
      if (tail.empty()) {
        std::cout << "(no timeline entries)\n";
      } else {
        for (const auto& entry : tail) {
          const auto ts = ExtractJsonStringField(entry, "ts");
          const auto level = ExtractJsonStringField(entry, "level");
          const auto event = ExtractJsonStringField(entry, "event");
          const auto message = ExtractJsonStringField(entry, "message");
          if (ts.empty() && event.empty()) {
            std::cout << entry << '\n';
          } else {
            std::cout << ts << " [" << level << "] " << event << " :: " << message << '\n';
          }
        }
      }
      continue;
    }

    if (line == ":diag") {
      const auto d = Diagnostics::Run(cfg);
      PrintDiagnostics(d);
      logger.Info("diagnostics", d.ok ? "Manual diagnostics pass" : "Manual diagnostics fail");
      continue;
    }

    if (line.rfind(":mem-get ", 0) == 0) {
      const auto key = line.substr(9);
      const auto value = memory.Get(key);
      if (value.has_value()) {
        std::cout << key << " = " << *value << '\n';
      } else {
        std::cout << "(missing)\n";
      }
      continue;
    }

    if (line.rfind(":mem-set ", 0) == 0) {
      std::istringstream iss(line.substr(9));
      std::string key;
      if (!(iss >> key)) {
        std::cout << "Usage: :mem-set <key> <value>\n";
        continue;
      }

      std::string value;
      std::getline(iss, value);
      value = TrimLeft(value);

      if (key.empty() || value.empty()) {
        std::cout << "Usage: :mem-set <key> <value>\n";
        continue;
      }

      if (std::filesystem::exists(cfg.memory_path)) {
        const auto snap = rollback.CreateSnapshot(cfg.memory_path, &err);
        if (!snap.has_value()) {
          logger.Error("rollback", "Pre-write memory snapshot failed: " + err);
          std::cout << "Checkpoint failed. Write aborted: " << err << '\n';
          continue;
        }
        logger.Info("rollback", "Pre-write memory snapshot created: " + snap->string());
      }

      memory.Set(key, value);
      if (!memory.Save(&err)) {
        logger.Error("memory", err);
        std::cout << "Save failed: " << err << '\n';
      } else {
        logger.Info("memory", "Memory key updated: " + key);
        std::cout << "OK\n";
      }
      continue;
    }

    if (line == ":mem-list") {
      const auto& all = memory.All();
      if (all.empty()) {
        std::cout << "(empty)\n";
      } else {
        for (const auto& [k, v] : all) {
          std::cout << k << " = " << v << '\n';
        }
      }
      continue;
    }

    if (line == ":snapshot") {
      const auto snap = rollback.CreateSnapshot(cfg.memory_path, &err);
      if (!snap.has_value()) {
        logger.Error("rollback", err);
        std::cout << "Snapshot failed: " << err << '\n';
      } else {
        logger.Info("rollback", "Snapshot created: " + snap->string());
        std::cout << "Snapshot: " << snap->string() << '\n';
      }
      continue;
    }

    if (line == ":snapshots") {
      const auto snaps = rollback.ListSnapshots();
      if (snaps.empty()) {
        std::cout << "(none)\n";
      } else {
        for (const auto& snap : snaps) {
          std::cout << snap.string() << '\n';
        }
      }
      continue;
    }

    if (line.rfind(":restore ", 0) == 0) {
      const auto snap = std::filesystem::path(line.substr(9));
      if (!rollback.RestoreSnapshot(snap, cfg.memory_path, &err)) {
        logger.Error("rollback", err);
        std::cout << "Restore failed: " << err << '\n';
      } else {
        if (!memory.Load(&err)) {
          logger.Error("memory", err);
          std::cout << "Memory reload failed after restore: " << err << '\n';
        }
        logger.Info("rollback", "Restore completed from: " + snap.string());
        std::cout << "Restore OK\n";
      }
      continue;
    }

    if (line.rfind(":sandbox-write ", 0) == 0) {
      std::istringstream iss(line.substr(15));
      std::string relative_path;
      if (!(iss >> relative_path)) {
        std::cout << "Usage: :sandbox-write <relative-path> <text>\n";
        continue;
      }

      std::string text;
      std::getline(iss, text);
      text = TrimLeft(text);

      const auto target = cfg.sandbox_root / relative_path;
      if (std::filesystem::exists(target)) {
        const auto snap = rollback.CreateSnapshot(target, &err);
        if (!snap.has_value()) {
          logger.Error("rollback", "Pre-write sandbox snapshot failed: " + err);
          std::cout << "Checkpoint failed. Write aborted: " << err << '\n';
          continue;
        }
        logger.Info("rollback", "Pre-write sandbox snapshot created: " + snap->string());
      }

      std::string sandbox_err;
      if (!sandbox.WriteText(target, text, &sandbox_err)) {
        logger.Error("sandbox", sandbox_err);
        std::cout << "Sandbox write denied: " << sandbox_err << '\n';
      } else {
        logger.Info("sandbox", "Wrote file: " + target.string());
        std::cout << "OK\n";
      }
      continue;
    }

    if (line.rfind(":sandbox-read ", 0) == 0) {
      const auto target = cfg.sandbox_root / line.substr(14);
      std::string sandbox_err;
      const auto data = sandbox.ReadText(target, &sandbox_err);
      if (!data.has_value()) {
        logger.Error("sandbox", sandbox_err);
        std::cout << "Sandbox read denied: " << sandbox_err << '\n';
      } else {
        logger.Info("sandbox", "Read file: " + target.string());
        std::cout << *data << '\n';
      }
      continue;
    }

    if (line.rfind(":exec ", 0) == 0) {
      const auto tokens = TokenizeArgs(line.substr(6));
      if (tokens.empty()) {
        std::cout << "Usage: :exec <relative-exe-path> [args]\n";
        continue;
      }

      const auto executable = cfg.sandbox_root / tokens[0];
      std::vector<std::string> args;
      if (tokens.size() > 1) {
        args.assign(tokens.begin() + 1, tokens.end());
      }

      SandboxExecutionResult exec_result;
      std::string sandbox_err;
      if (!sandbox.ExecuteFile(executable, args, &exec_result, &sandbox_err)) {
        logger.Error("sandbox_exec", sandbox_err);
        std::cout << "Execution denied: " << sandbox_err << '\n';
      } else {
        logger.Info("sandbox_exec",
                    "Process launched=" + std::string(exec_result.launched ? "true" : "false") +
                        ", restricted_token=" + (exec_result.used_restricted_token ? "true" : "false") +
                        ", cpu_limited=" + (exec_result.cpu_rate_limited ? "true" : "false") +
                        ", exit_code=" + std::to_string(exec_result.exit_code) +
                        ", timed_out=" + (exec_result.timed_out ? "true" : "false"));
        std::cout << "launched=" << (exec_result.launched ? "true" : "false")
                  << " restricted_token=" << (exec_result.used_restricted_token ? "true" : "false")
                  << " cpu_limited=" << (exec_result.cpu_rate_limited ? "true" : "false")
                  << " exit_code=" << exec_result.exit_code
                  << " timed_out=" << (exec_result.timed_out ? "true" : "false") << '\n';
        if (!exec_result.output.empty()) {
          std::cout << exec_result.output << '\n';
        }
      }
      continue;
    }

    std::string prompt_err;
    if (!sandbox.ValidatePrompt(line, &prompt_err)) {
      logger.Error("prompt_blocked", prompt_err);
      std::cout << "Prompt blocked: " << prompt_err << '\n';
      continue;
    }

    logger.Info("inference", "Prompt received");
    const std::string response = inference.Generate(line);
    std::cout << response << '\n';
  }

  return 0;
}
