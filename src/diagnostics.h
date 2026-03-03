#pragma once

#include "app_config.h"

#include <cstdint>
#include <string>
#include <vector>

struct DiagnosticReport {
  bool ok = false;
  bool gpu_present = false;
  bool cuda_driver_detected = false;
  int cuda_driver_version = -1;
  std::string cuda_driver_version_text;
  std::uint64_t vram_bytes = 0;
  std::uint64_t ram_bytes = 0;
  std::uint64_t free_storage_bytes = 0;
  std::string gpu_name;
  std::vector<std::string> errors;
  std::vector<std::string> warnings;
};

class Diagnostics {
 public:
  static DiagnosticReport Run(const AppConfig& cfg);
  static std::string FormatBytes(std::uint64_t bytes);
  static std::string FormatCudaDriverVersion(int raw_version);
};
