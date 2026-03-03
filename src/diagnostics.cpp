#include "diagnostics.h"

#include <filesystem>
#include <sstream>

#ifdef _WIN32
#include <windows.h>
#include <dxgi.h>
#pragma comment(lib, "dxgi.lib")
#elif defined(__APPLE__)
#include <sys/types.h>
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <sys/sysinfo.h>
#endif

namespace {

#ifdef _WIN32
bool ProbeCudaDriver(int* out_version) {
  HMODULE module = LoadLibraryA("nvcuda.dll");
  if (!module) {
    return false;
  }

  using CuDriverGetVersionFn = int(__stdcall*)(int*);
  auto fn = reinterpret_cast<CuDriverGetVersionFn>(GetProcAddress(module, "cuDriverGetVersion"));
  bool ok = false;
  if (fn) {
    int version = 0;
    if (fn(&version) == 0) {
      *out_version = version;
      ok = true;
    }
  }

  FreeLibrary(module);
  return ok;
}

void ProbeGpuDxgi(bool* gpu_present, std::string* gpu_name, std::uint64_t* vram_bytes) {
  IDXGIFactory* factory = nullptr;
  if (CreateDXGIFactory(__uuidof(IDXGIFactory), reinterpret_cast<void**>(&factory)) != S_OK || !factory) {
    return;
  }

  IDXGIAdapter* adapter = nullptr;
  if (factory->EnumAdapters(0, &adapter) != S_OK || !adapter) {
    factory->Release();
    return;
  }

  DXGI_ADAPTER_DESC desc{};
  if (adapter->GetDesc(&desc) == S_OK) {
    *gpu_present = true;
    *vram_bytes = static_cast<std::uint64_t>(desc.DedicatedVideoMemory);

    std::wstring wname(desc.Description);
    gpu_name->assign(wname.begin(), wname.end());
  }

  adapter->Release();
  factory->Release();
}

std::uint64_t ProbeRamBytes() {
  MEMORYSTATUSEX status{};
  status.dwLength = sizeof(status);
  if (!GlobalMemoryStatusEx(&status)) {
    return 0;
  }
  return static_cast<std::uint64_t>(status.ullTotalPhys);
}
#else
bool ProbeCudaDriver(int* out_version) {
  (void)out_version;
  return false;
}

void ProbeGpuDxgi(bool* gpu_present, std::string* gpu_name, std::uint64_t* vram_bytes) {
  *gpu_present = false;
  *gpu_name = "Unsupported non-Windows diagnostic path";
  *vram_bytes = 0;
}

std::uint64_t ProbeRamBytes() {
#ifdef __APPLE__
  std::uint64_t bytes = 0;
  size_t len = sizeof(bytes);
  if (sysctlbyname("hw.memsize", &bytes, &len, nullptr, 0) == 0 && len == sizeof(bytes)) {
    return bytes;
  }
  return 0;
#elif defined(__linux__)
  struct sysinfo info {};
  if (sysinfo(&info) == 0) {
    return static_cast<std::uint64_t>(info.totalram) * static_cast<std::uint64_t>(info.mem_unit);
  }
  return 0;
#else
  return 0;
#endif
}
#endif

}  // namespace

DiagnosticReport Diagnostics::Run(const AppConfig& cfg) {
  DiagnosticReport report;

  ProbeGpuDxgi(&report.gpu_present, &report.gpu_name, &report.vram_bytes);

  int cuda_version = -1;
  report.cuda_driver_detected = ProbeCudaDriver(&cuda_version);
  report.cuda_driver_version = cuda_version;
  report.cuda_driver_version_text = FormatCudaDriverVersion(cuda_version);

  report.ram_bytes = ProbeRamBytes();

  std::error_code ec;
  const auto space = std::filesystem::space(cfg.root, ec);
  if (!ec) {
    report.free_storage_bytes = static_cast<std::uint64_t>(space.available);
  }

  if (!report.gpu_present) {
    report.errors.push_back("No supported GPU detected.");
  }

  if (report.vram_bytes < cfg.min_vram_bytes) {
    report.errors.push_back(
        "Insufficient VRAM. Required >= " + FormatBytes(cfg.min_vram_bytes) +
        ", found " + FormatBytes(report.vram_bytes) + ".");
  }

  if (!report.cuda_driver_detected) {
    report.warnings.push_back("CUDA driver not detected. Ensure NVIDIA driver with CUDA runtime is available.");
  }

  if (report.ram_bytes < cfg.min_ram_bytes) {
    report.errors.push_back(
        "Insufficient system RAM. Required >= " + FormatBytes(cfg.min_ram_bytes) +
        ", found " + FormatBytes(report.ram_bytes) + ".");
  }

  if (report.free_storage_bytes < cfg.min_storage_bytes) {
    report.errors.push_back(
        "Insufficient free storage. Required >= " + FormatBytes(cfg.min_storage_bytes) +
        ", found " + FormatBytes(report.free_storage_bytes) + ".");
  }

  report.ok = report.errors.empty();
  return report;
}

std::string Diagnostics::FormatBytes(std::uint64_t bytes) {
  static const char* kUnits[] = {"B", "KiB", "MiB", "GiB", "TiB"};
  double value = static_cast<double>(bytes);
  int unit = 0;

  while (value >= 1024.0 && unit < 4) {
    value /= 1024.0;
    ++unit;
  }

  std::ostringstream oss;
  oss.setf(std::ios::fixed);
  oss.precision(2);
  oss << value << ' ' << kUnits[unit];
  return oss.str();
}

std::string Diagnostics::FormatCudaDriverVersion(int raw_version) {
  if (raw_version <= 0) {
    return "unknown";
  }

  const int major = raw_version / 1000;
  const int minor = (raw_version % 1000) / 10;
  return std::to_string(major) + "." + std::to_string(minor);
}
