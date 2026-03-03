#pragma once

#include "process_runner.h"

#include <filesystem>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct SandboxPolicy {
  std::vector<std::filesystem::path> allowed_roots;
  std::uint32_t max_prompt_chars = 4096;
  std::uint32_t max_runtime_seconds = 20;
  std::uint64_t max_child_memory_bytes = 1024ULL * 1024ULL * 1024ULL;
  std::uint32_t max_exec_output_bytes = 64 * 1024;
  std::uint32_t max_child_cpu_percent = 50;
};

using SandboxExecutionResult = ProcessResult;

class Sandbox {
 public:
  explicit Sandbox(SandboxPolicy policy);

  bool IsPathAllowed(const std::filesystem::path& p) const;
  bool WriteText(const std::filesystem::path& target, const std::string& content, std::string* err) const;
  std::optional<std::string> ReadText(const std::filesystem::path& target, std::string* err) const;
  bool ExecuteFile(const std::filesystem::path& executable,
                   const std::vector<std::string>& args,
                   SandboxExecutionResult* result,
                   std::string* err) const;
  bool ValidatePrompt(const std::string& prompt, std::string* err) const;

 private:
  SandboxPolicy policy_;
  static bool ContainsSuspiciousToken(const std::string& text);
};
