#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

struct AppConfig {
  std::filesystem::path root;
  std::filesystem::path model_path;
  std::filesystem::path runtime_backend_path;
  std::filesystem::path log_path;
  std::filesystem::path memory_path;
  std::filesystem::path snapshot_dir;
  std::filesystem::path sandbox_root;

  std::uint64_t min_vram_bytes =
      10ULL * 1024ULL * 1024ULL * 1024ULL; // 10 GiB minimum
  std::uint64_t min_ram_bytes =
      8ULL * 1024ULL * 1024ULL * 1024ULL; // 8 GiB minimum
  std::uint64_t min_storage_bytes =
      8ULL * 1024ULL * 1024ULL * 1024ULL; // 8 GiB free minimum
  std::uint32_t max_prompt_chars = 32768;
  std::uint32_t max_runtime_seconds = 180;
  std::uint64_t max_child_memory_bytes =
      6ULL * 1024ULL * 1024ULL * 1024ULL;          // 6 GiB
  std::uint32_t max_exec_output_bytes = 64 * 1024; // 64 KiB
  std::uint32_t max_child_cpu_percent = 90;        // 90% per child process
};

inline AppConfig BuildDefaultConfig(const std::filesystem::path &root) {
  AppConfig cfg;
  cfg.root = root;
  cfg.model_path = root / "data" / "model" / "model.gguf";
#ifdef _WIN32
  cfg.runtime_backend_path = root / "data" / "runtime" / "infer_backend.exe";
#else
  cfg.runtime_backend_path = root / "data" / "runtime" / "infer_backend";
#endif
  cfg.log_path = root / "data" / "logs" / "events.log";
  cfg.memory_path = root / "data" / "memory" / "state.kv";
  cfg.snapshot_dir = root / "data" / "snapshots";
  cfg.sandbox_root = root / "data" / "sandbox";
  return cfg;
}
