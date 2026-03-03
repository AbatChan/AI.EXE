#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

struct ProcessLimits {
  std::uint32_t timeout_seconds = 20;
  std::uint64_t memory_limit_bytes = 1024ULL * 1024ULL * 1024ULL;
  std::uint32_t output_limit_bytes = 64 * 1024;
  std::uint32_t max_active_processes = 1;
  std::uint32_t cpu_rate_percent = 50;  // 1..100, 0 disables CPU rate capping.
  bool try_restricted_token = true;
};

struct ProcessResult {
  bool launched = false;
  bool timed_out = false;
  bool used_restricted_token = false;
  bool cpu_rate_limited = false;
  int exit_code = -1;
  std::string output;
};

class ProcessRunner {
 public:
  static bool RunExe(const std::filesystem::path& executable,
                     const std::vector<std::string>& args,
                     const std::filesystem::path& working_dir,
                     const ProcessLimits& limits,
                     ProcessResult* result,
                     const std::function<void(const std::string&)>* on_output_chunk,
                     std::string* err);
};
