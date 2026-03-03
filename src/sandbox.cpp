#include "sandbox.h"

#include <algorithm>
#include <cctype>
#include <fstream>

Sandbox::Sandbox(SandboxPolicy policy) : policy_(std::move(policy)) {}

bool Sandbox::IsPathAllowed(const std::filesystem::path& p) const {
  std::error_code ec;
  const auto canonical_target = std::filesystem::weakly_canonical(p, ec);
  if (ec) {
    return false;
  }

  for (const auto& root : policy_.allowed_roots) {
    std::error_code rc;
    const auto canonical_root = std::filesystem::weakly_canonical(root, rc);
    if (rc) {
      continue;
    }

    auto root_it = canonical_root.begin();
    auto target_it = canonical_target.begin();
    bool prefix_match = true;

    for (; root_it != canonical_root.end(); ++root_it, ++target_it) {
      if (target_it == canonical_target.end() || *root_it != *target_it) {
        prefix_match = false;
        break;
      }
    }

    if (prefix_match) {
      return true;
    }
  }

  return false;
}

bool Sandbox::WriteText(const std::filesystem::path& target, const std::string& content, std::string* err) const {
  if (!IsPathAllowed(target)) {
    *err = "Sandbox policy denied write path.";
    return false;
  }

  std::error_code ec;
  std::filesystem::create_directories(target.parent_path(), ec);
  if (ec) {
    *err = "Failed to create parent directories.";
    return false;
  }

  std::ofstream out(target, std::ios::binary | std::ios::trunc);
  if (!out.good()) {
    *err = "Failed to open target file for write.";
    return false;
  }

  out << content;
  if (!out.good()) {
    *err = "Write failed.";
    return false;
  }

  return true;
}

std::optional<std::string> Sandbox::ReadText(const std::filesystem::path& target, std::string* err) const {
  if (!IsPathAllowed(target)) {
    *err = "Sandbox policy denied read path.";
    return std::nullopt;
  }

  std::ifstream in(target, std::ios::binary);
  if (!in.good()) {
    *err = "Failed to open file for read.";
    return std::nullopt;
  }

  std::string data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return data;
}

bool Sandbox::ExecuteFile(const std::filesystem::path& executable,
                          const std::vector<std::string>& args,
                          SandboxExecutionResult* result,
                          std::string* err) const {
  if (!result) {
    *err = "Execution result pointer is null.";
    return false;
  }

  std::error_code ec;
  const auto canonical_exec = std::filesystem::weakly_canonical(executable, ec);
  if (ec || !std::filesystem::exists(canonical_exec)) {
    *err = "Executable not found.";
    return false;
  }

  if (!IsPathAllowed(canonical_exec)) {
    *err = "Sandbox policy denied executable path.";
    return false;
  }

  std::string ext = canonical_exec.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });

  if (ext != ".exe") {
    *err = "Only .exe binaries are allowed for sandbox execution.";
    return false;
  }

  ProcessLimits limits;
  limits.timeout_seconds = policy_.max_runtime_seconds;
  limits.memory_limit_bytes = policy_.max_child_memory_bytes;
  limits.output_limit_bytes = policy_.max_exec_output_bytes;
  limits.max_active_processes = 1;
  limits.cpu_rate_percent = policy_.max_child_cpu_percent;
  limits.try_restricted_token = true;

  ProcessResult process_result;
  if (!ProcessRunner::RunExe(canonical_exec, args, canonical_exec.parent_path(), limits, &process_result, nullptr, err)) {
    return false;
  }

  *result = process_result;
  return true;
}

bool Sandbox::ValidatePrompt(const std::string& prompt, std::string* err) const {
  if (prompt.size() > policy_.max_prompt_chars) {
    *err = "Prompt exceeds configured size limit.";
    return false;
  }

  if (ContainsSuspiciousToken(prompt)) {
    *err = "Prompt blocked by sandbox token filter.";
    return false;
  }

  return true;
}

bool Sandbox::ContainsSuspiciousToken(const std::string& text) {
  static const char* kBlocked[] = {
      "reg add",
      "reg delete",
      "sc start",
      "sc stop",
      "powershell -enc",
      "format c:",
      "del /f /s /q",
      "rm -rf /",
      "shutdown /s",
      "bcdedit",
  };

  std::string lowered = text;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });

  for (const char* token : kBlocked) {
    if (lowered.find(token) != std::string::npos) {
      return true;
    }
  }

  return false;
}
