#pragma once

#include "app_config.h"
#include "inference_engine.h"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>

struct WebRuntimeStatus {
  std::string root_path;
  std::string model_path;
  bool model_exists = false;
  bool model_loaded = false;
  std::uint64_t model_size_bytes = 0;
  std::string model_format;
  std::string model_sha256;

  std::string backend_path;
  bool backend_configured = false;
  bool backend_selftest_ok = false;
  std::string backend_selftest_details;
  std::string backend_version;

  std::string last_error;
  std::string last_inference_route;
  std::string last_persistent_error;
  std::string last_completion_status;
  bool last_completion_likely_truncated = false;
  int last_completion_max_tokens = 0;
};

class WebRuntimeBridge {
 public:
  bool Initialize(const std::filesystem::path& root_hint, bool force_cpu, std::string* err);
  WebRuntimeStatus GetStatus() const;

  bool Refresh(std::string* err);
  bool VerifyModel(std::string* err);
  bool ImportModelFromPath(const std::filesystem::path& source_path, std::string* err);
  bool AppendDebugLog(const std::string& channel,
                      const std::string& entry_json,
                      std::string* err);

  std::string Generate(const std::string& prompt,
                       std::string* err,
                       int max_tokens = 0,
                       const std::string& grammar = std::string());
  bool GenerateStream(const std::string& prompt,
                      const std::function<void(const std::string&)>& on_delta,
                      std::string* output,
                      std::string* err,
                      int max_tokens = 0,
                      const std::string& grammar = std::string());
  const AppConfig& Config() const;

 private:
  bool RefreshLocked(std::string* err);
  bool ConfigureBackendLocked(std::string* err);
  bool UpdateModelChecksumLocked(std::string* err);
  static bool ComputeSha256File(const std::filesystem::path& file, std::string* hex, std::string* err);

  mutable std::mutex mu_;
  AppConfig cfg_{};
  InferenceEngine inference_{};
  WebRuntimeStatus status_{};
  bool initialized_ = false;
  bool force_cpu_ = false;
};
