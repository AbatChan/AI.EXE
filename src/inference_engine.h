#pragma once

#include "process_runner.h"

#include <filesystem>
#include <functional>
#include <cstdint>
#include <string>
#include <vector>

struct ModelInfo {
  std::filesystem::path path;
  std::uint64_t size_bytes = 0;
  std::string format;
};

struct InferenceBackendConfig {
  std::filesystem::path executable;
  std::uint32_t timeout_seconds = 20;
  std::uint64_t memory_limit_bytes = 1024ULL * 1024ULL * 1024ULL;
  std::uint32_t output_limit_bytes = 64 * 1024;
  std::uint32_t cpu_rate_percent = 50;
};

class InferenceEngine {
 public:
  bool LoadModel(const std::filesystem::path& model_path, std::string* err);
  bool ConfigureBackend(const InferenceBackendConfig& config, std::string* err);
  void DisableBackend();
  bool RunBackendSelfTest(std::string* details) const;
  bool QueryBackendVersion(std::string* version_text);
  bool IsLoaded() const;
  bool IsBackendConfigured() const;
  std::string BackendPath() const;
  std::string BackendVersion() const;
  ModelInfo GetModelInfo() const;

  std::string Generate(const std::string& prompt,
                       int max_tokens = 0,
                       const std::string& grammar = std::string()) const;
  bool GenerateStream(const std::string& prompt,
                      const std::function<void(const std::string&)>& on_delta,
                      std::string* output,
                      std::string* err,
                      int max_tokens = 0,
                      const std::string& grammar = std::string()) const;

 private:
  bool InvokeBackend(const std::vector<std::string>& args,
                     ProcessResult* result,
                     std::string* err,
                     const std::function<void(const std::string&)>* on_output_chunk = nullptr) const;
  std::string GenerateWithBackend(const std::string& prompt,
                                  int max_tokens,
                                  const std::string& grammar) const;
  bool GenerateWithBackendStream(const std::string& prompt,
                                 const std::function<void(const std::string&)>* on_delta,
                                 std::string* output,
                                 std::string* err,
                                 int max_tokens,
                                 const std::string& grammar) const;

  std::filesystem::path loaded_model_;
  std::uint64_t model_size_bytes_ = 0;
  std::string model_format_;
  InferenceBackendConfig backend_config_;
  std::string backend_version_;
  bool backend_configured_ = false;
  bool loaded_ = false;
};
