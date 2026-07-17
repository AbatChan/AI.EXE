#include "web_runtime_bridge.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#else
#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#endif
#endif

namespace {

std::string ToHex(const unsigned char* bytes, std::size_t len) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.resize(len * 2);
  for (std::size_t i = 0; i < len; ++i) {
    const unsigned char b = bytes[i];
    out[i * 2] = kHex[(b >> 4) & 0x0F];
    out[i * 2 + 1] = kHex[b & 0x0F];
  }
  return out;
}

bool StartsWith(const std::string& text, const std::string& prefix) {
  return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

std::string TrimAsciiWhitespace(const std::string& text) {
  std::size_t start = 0;
  while (start < text.size() &&
         std::isspace(static_cast<unsigned char>(text[start])) != 0) {
    start += 1;
  }

  std::size_t end = text.size();
  while (end > start &&
         std::isspace(static_cast<unsigned char>(text[end - 1])) != 0) {
    end -= 1;
  }
  return text.substr(start, end - start);
}

bool HasTerminalAsciiPunctuation(const std::string& text) {
  if (text.empty()) return false;
  const char last = text.back();
  return last == '.' || last == '!' || last == '?' || last == '\'' ||
         last == '"' || last == '`' || last == ')' || last == ']' ||
         last == '}';
}

bool EndsWithOpenDelimiter(const std::string& text) {
  if (text.empty()) return false;
  const char last = text.back();
  return last == ',' || last == ':' || last == ';' || last == '(' ||
         last == '[' || last == '{' || last == '`' || last == '"';
}

bool LikelyIncompleteResponse(const std::string& text) {
  const std::string clean = TrimAsciiWhitespace(text);
  if (clean.empty() || clean == "<DONE>" || clean == "DONE") return false;

  std::size_t fence_count = 0;
  std::size_t pos = 0;
  while ((pos = clean.find("```", pos)) != std::string::npos) {
    fence_count += 1;
    pos += 3;
  }
  if ((fence_count % 2u) != 0u) return true;
  if (EndsWithOpenDelimiter(clean)) return true;
  if (!HasTerminalAsciiPunctuation(clean) && clean.size() >= 320) return true;
  return false;
}

int EffectiveMaxTokens(int requested_max_tokens) {
  return requested_max_tokens > 0 ? std::min(requested_max_tokens, 4096) : 3072;
}

bool IsSafeDebugChannel(const std::string& channel) {
  if (channel.empty()) {
    return false;
  }
  for (const char c : channel) {
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-')) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool WebRuntimeBridge::Initialize(const std::filesystem::path& root_hint, bool force_cpu, std::string* err) {
  std::lock_guard<std::mutex> lock(mu_);

  std::error_code ec;
  std::filesystem::path root = root_hint;
  if (root.empty()) {
    root = std::filesystem::current_path(ec);
    if (ec) {
      root = std::filesystem::path(".");
    }
  }

  cfg_ = BuildDefaultConfig(root);
  force_cpu_ = force_cpu;

  std::filesystem::create_directories(cfg_.model_path.parent_path(), ec);
  std::filesystem::create_directories(cfg_.runtime_backend_path.parent_path(), ec);
  std::filesystem::create_directories(cfg_.log_path.parent_path(), ec);
  std::filesystem::create_directories(cfg_.memory_path.parent_path(), ec);
  std::filesystem::create_directories(cfg_.snapshot_dir, ec);
  std::filesystem::create_directories(cfg_.sandbox_root, ec);

  if (force_cpu_) {
#ifdef _WIN32
    _putenv_s("AI_EXE_FORCE_CPU", "1");
#else
    setenv("AI_EXE_FORCE_CPU", "1", 1);
#endif
  }

  initialized_ = true;
  return RefreshLocked(err);
}

WebRuntimeStatus WebRuntimeBridge::GetStatus() const {
  std::lock_guard<std::mutex> lock(mu_);
  return status_;
}

bool WebRuntimeBridge::Refresh(std::string* err) {
  std::lock_guard<std::mutex> lock(mu_);
  return RefreshLocked(err);
}

bool WebRuntimeBridge::VerifyModel(std::string* err) {
  std::lock_guard<std::mutex> lock(mu_);
  return UpdateModelChecksumLocked(err);
}

bool WebRuntimeBridge::ImportModelFromPath(const std::filesystem::path& source_path, std::string* err) {
  std::lock_guard<std::mutex> lock(mu_);

  std::error_code ec;
  if (source_path.empty() || !std::filesystem::exists(source_path, ec) ||
      !std::filesystem::is_regular_file(source_path, ec)) {
    if (err) {
      *err = "Selected model file does not exist.";
    }
    return false;
  }

  std::filesystem::create_directories(cfg_.model_path.parent_path(), ec);
  std::filesystem::copy_file(source_path, cfg_.model_path, std::filesystem::copy_options::overwrite_existing, ec);
  if (ec) {
    if (err) {
      *err = "Failed to copy model into runtime path: " + ec.message();
    }
    return false;
  }

  return RefreshLocked(err);
}

bool WebRuntimeBridge::AppendDebugLog(const std::string& channel,
                                      const std::string& entry_json,
                                      std::string* err) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!initialized_) {
    if (err) {
      *err = "Runtime bridge not initialized.";
    }
    return false;
  }

  const std::string trimmed_channel = TrimAsciiWhitespace(channel);
  if (!IsSafeDebugChannel(trimmed_channel)) {
    if (err) {
      *err = "Invalid debug log channel.";
    }
    return false;
  }

  const std::string trimmed_entry = TrimAsciiWhitespace(entry_json);
  if (trimmed_entry.empty()) {
    if (err) {
      *err = "Debug log entry is empty.";
    }
    return false;
  }

  std::error_code ec;
  const auto log_dir = cfg_.log_path.parent_path();
  std::filesystem::create_directories(log_dir, ec);
  if (ec) {
    if (err) {
      *err = "Failed to prepare debug log directory: " + ec.message();
    }
    return false;
  }

  const auto file_path = log_dir / (trimmed_channel + ".jsonl");
  // Rotate at 64MB (debug_trace grew unbounded to 800MB+); keep one .1 backup.
  constexpr uintmax_t kMaxDebugLogBytes = 64ull * 1024 * 1024;
  const auto current_size = std::filesystem::file_size(file_path, ec);
  if (!ec && current_size >= kMaxDebugLogBytes) {
    const auto rotated_path = log_dir / (trimmed_channel + ".jsonl.1");
    std::filesystem::remove(rotated_path, ec);
    std::filesystem::rename(file_path, rotated_path, ec);
  }
  ec.clear();
  std::ofstream out(file_path, std::ios::app);
  if (!out.good()) {
    if (err) {
      *err = "Failed to open debug log file.";
    }
    return false;
  }

  out << trimmed_entry << '\n';
  if (!out.good()) {
    if (err) {
      *err = "Failed to append debug log entry.";
    }
    return false;
  }

  if (err) {
    err->clear();
  }
  return true;
}

bool WebRuntimeBridge::ReadDebugLog(const std::string& channel,
                                    size_t max_bytes,
                                    std::string* out,
                                    std::string* err) {
  std::lock_guard<std::mutex> lock(mu_);
  if (out) {
    out->clear();
  }
  if (!initialized_) {
    if (err) {
      *err = "Runtime bridge not initialized.";
    }
    return false;
  }

  const std::string trimmed_channel = TrimAsciiWhitespace(channel);
  if (!IsSafeDebugChannel(trimmed_channel)) {
    if (err) {
      *err = "Invalid debug log channel.";
    }
    return false;
  }

  const auto file_path = cfg_.log_path.parent_path() / (trimmed_channel + ".jsonl");
  std::error_code ec;
  if (!std::filesystem::exists(file_path, ec)) {
    // Missing log = no entries yet; empty output, not an error.
    if (err) {
      err->clear();
    }
    return true;
  }

  std::ifstream in(file_path, std::ios::binary);
  if (!in.good()) {
    if (err) {
      *err = "Failed to open debug log file.";
    }
    return false;
  }

  in.seekg(0, std::ios::end);
  const std::streamoff size = in.tellg();
  const std::streamoff cap = static_cast<std::streamoff>(
      max_bytes > 0 ? max_bytes : static_cast<size_t>(400000));
  const std::streamoff start = size > cap ? size - cap : 0;
  in.seekg(start, std::ios::beg);

  std::string content;
  content.resize(static_cast<size_t>(size - start));
  in.read(content.data(), static_cast<std::streamsize>(content.size()));
  content.resize(static_cast<size_t>(in.gcount()));

  // Truncated read: drop the torn first line so output is line-aligned JSONL.
  if (start > 0) {
    const size_t newline = content.find('\n');
    content = newline == std::string::npos ? std::string() : content.substr(newline + 1);
  }

  if (out) {
    *out = std::move(content);
  }
  if (err) {
    err->clear();
  }
  return true;
}

std::string WebRuntimeBridge::Generate(const std::string& prompt,
                                       std::string* err,
                                       int max_tokens,
                                       const std::string& grammar) {
  std::lock_guard<std::mutex> lock(mu_);
  const int effective_max_tokens = EffectiveMaxTokens(max_tokens);
  auto capture_inference_telemetry = [&]() {
    status_.last_inference_route = inference_.LastInferenceRoute();
    status_.last_persistent_error = inference_.LastPersistentError();
  };
  auto set_completion_status = [&](const std::string& output, bool ok) {
    status_.last_completion_max_tokens = effective_max_tokens;
    status_.last_completion_likely_truncated =
        ok ? LikelyIncompleteResponse(output) : false;
    status_.last_completion_status =
        ok ? (status_.last_completion_likely_truncated ? "likely_truncated"
                                                       : "completed")
           : "error";
  };

  const std::string trimmed = prompt;
  if (trimmed.empty()) {
    set_completion_status(std::string(), false);
    if (err) {
      *err = "Prompt is empty.";
    }
    return std::string();
  }

  if (!status_.model_loaded) {
    set_completion_status(std::string(), false);
    if (err) {
      *err = "Model not loaded (" + cfg_.model_path.string() + ").";
    }
    return std::string();
  }

  const std::string output = inference_.Generate(trimmed, max_tokens, grammar);
  capture_inference_telemetry();
  if (output.empty()) {
    set_completion_status(std::string(), false);
    if (err) {
      *err = "Inference returned empty output.";
    }
    return std::string();
  }

  if (StartsWith(output, "[offline-inference backend failure]") ||
      StartsWith(output, "[offline-inference backend timeout]") ||
      StartsWith(output, "[offline-inference backend error]") ||
      StartsWith(output, "[offline-inference backend empty-output]") ||
      StartsWith(output, "[offline-inference placeholder]")) {
    set_completion_status(std::string(), false);
    if (err) {
      *err = output;
    }
    return std::string();
  }

  set_completion_status(output, true);
  return output;
}

bool WebRuntimeBridge::GenerateStream(const std::string& prompt,
                                      const std::function<void(const std::string&)>& on_delta,
                                      std::string* output,
                                      std::string* err,
                                      int max_tokens,
                                      const std::string& grammar) {
  std::lock_guard<std::mutex> lock(mu_);
  const int effective_max_tokens = EffectiveMaxTokens(max_tokens);
  auto capture_inference_telemetry = [&]() {
    status_.last_inference_route = inference_.LastInferenceRoute();
    status_.last_persistent_error = inference_.LastPersistentError();
  };
  auto set_completion_status = [&](const std::string& output_text, bool ok) {
    status_.last_completion_max_tokens = effective_max_tokens;
    status_.last_completion_likely_truncated =
        ok ? LikelyIncompleteResponse(output_text) : false;
    status_.last_completion_status =
        ok ? (status_.last_completion_likely_truncated ? "likely_truncated"
                                                       : "completed")
           : "error";
  };

  if (prompt.empty()) {
    set_completion_status(std::string(), false);
    if (err) {
      *err = "Prompt is empty.";
    }
    return false;
  }

  if (!status_.model_loaded) {
    set_completion_status(std::string(), false);
    if (err) {
      *err = "Model not loaded (" + cfg_.model_path.string() + ").";
    }
    return false;
  }

  std::string local_output;
  std::string local_err;
  if (!inference_.GenerateStream(prompt, on_delta, &local_output, &local_err, max_tokens, grammar)) {
    capture_inference_telemetry();
    set_completion_status(std::string(), false);
    if (err) {
      *err = local_err.empty() ? "Inference failed." : local_err;
    }
    return false;
  }
  capture_inference_telemetry();
  set_completion_status(local_output, true);

  if (output) {
    *output = local_output;
  }
  if (err) {
    err->clear();
  }
  return true;
}

const AppConfig& WebRuntimeBridge::Config() const {
  return cfg_;
}

bool WebRuntimeBridge::RefreshLocked(std::string* err) {
  if (!initialized_) {
    if (err) {
      *err = "Runtime bridge not initialized.";
    }
    return false;
  }

  status_ = WebRuntimeStatus{};
  status_.root_path = cfg_.root.string();
  status_.model_path = cfg_.model_path.string();
  status_.backend_path = cfg_.runtime_backend_path.string();

  std::error_code ec;
  status_.model_exists = std::filesystem::exists(cfg_.model_path, ec) && std::filesystem::is_regular_file(cfg_.model_path, ec);

  std::string model_err;
  status_.model_loaded = inference_.LoadModel(cfg_.model_path, &model_err);
  if (status_.model_loaded) {
    const ModelInfo model = inference_.GetModelInfo();
    status_.model_format = model.format;
    status_.model_size_bytes = model.size_bytes;
  } else {
    status_.last_error = model_err;
  }

  std::string backend_err;
  if (ConfigureBackendLocked(&backend_err)) {
    status_.backend_configured = true;
    std::string details;
    if (inference_.RunBackendSelfTest(&details)) {
      status_.backend_selftest_ok = true;
      status_.backend_selftest_details = details;
      std::string version;
      if (inference_.QueryBackendVersion(&version)) {
        status_.backend_version = version;
      } else {
        status_.backend_version = "unknown";
      }
    } else {
      status_.backend_selftest_ok = false;
      status_.backend_selftest_details = details;
      if (status_.last_error.empty()) {
        status_.last_error = details;
      }
    }
  } else {
    status_.backend_configured = false;
    status_.backend_selftest_ok = false;
    status_.backend_selftest_details = backend_err;
    if (status_.last_error.empty()) {
      status_.last_error = backend_err;
    }
  }

  if (err) {
    *err = status_.last_error;
  }
  status_.last_inference_route = inference_.LastInferenceRoute();
  status_.last_persistent_error = inference_.LastPersistentError();
  return status_.model_loaded;
}

bool WebRuntimeBridge::ConfigureBackendLocked(std::string* err) {
  InferenceBackendConfig backend_cfg;
  backend_cfg.executable = cfg_.runtime_backend_path;
  backend_cfg.timeout_seconds = cfg_.max_runtime_seconds;
  backend_cfg.memory_limit_bytes = cfg_.max_child_memory_bytes;
  backend_cfg.output_limit_bytes = cfg_.max_exec_output_bytes;
  backend_cfg.cpu_rate_percent = cfg_.max_child_cpu_percent;

  std::string backend_err;
  if (!inference_.ConfigureBackend(backend_cfg, &backend_err)) {
    inference_.DisableBackend();
    if (err) {
      *err = backend_err;
    }
    return false;
  }

  if (err) {
    err->clear();
  }
  return true;
}

bool WebRuntimeBridge::UpdateModelChecksumLocked(std::string* err) {
  status_.model_sha256.clear();
  if (!status_.model_exists) {
    if (err) {
      *err = "Model file not found for checksum.";
    }
    return false;
  }

  std::string digest;
  std::string hash_err;
  if (!ComputeSha256File(cfg_.model_path, &digest, &hash_err)) {
    if (err) {
      *err = hash_err;
    }
    return false;
  }

  status_.model_sha256 = digest;
  if (err) {
    err->clear();
  }
  return true;
}

bool WebRuntimeBridge::ComputeSha256File(const std::filesystem::path& file, std::string* hex, std::string* err) {
  if (!hex) {
    if (err) {
      *err = "Checksum output buffer is null.";
    }
    return false;
  }

  std::ifstream in(file, std::ios::binary);
  if (!in.good()) {
    if (err) {
      *err = "Failed to open file for checksum.";
    }
    return false;
  }

#ifdef _WIN32
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_len = 0;
  DWORD bytes = 0;
  DWORD hash_len = 0;
  std::vector<unsigned char> object_buf;
  std::vector<unsigned char> digest;

  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
    if (err) {
      *err = "BCryptOpenAlgorithmProvider failed.";
    }
    return false;
  }

  if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_len),
                        sizeof(object_len), &bytes, 0) != 0 ||
      object_len == 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    if (err) {
      *err = "BCryptGetProperty(object length) failed.";
    }
    return false;
  }

  if (BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_len),
                        sizeof(hash_len), &bytes, 0) != 0 ||
      hash_len == 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    if (err) {
      *err = "BCryptGetProperty(hash length) failed.";
    }
    return false;
  }

  object_buf.resize(object_len);
  digest.resize(hash_len);

  if (BCryptCreateHash(alg, &hash, object_buf.data(), object_len, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(alg, 0);
    if (err) {
      *err = "BCryptCreateHash failed.";
    }
    return false;
  }

  std::vector<char> buffer(1024 * 1024);
  while (in.good()) {
    in.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
    const std::streamsize got = in.gcount();
    if (got <= 0) {
      break;
    }

    if (BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()), static_cast<ULONG>(got), 0) != 0) {
      BCryptDestroyHash(hash);
      BCryptCloseAlgorithmProvider(alg, 0);
      if (err) {
        *err = "BCryptHashData failed.";
      }
      return false;
    }
  }

  if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) != 0) {
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0);
    if (err) {
      *err = "BCryptFinishHash failed.";
    }
    return false;
  }

  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  *hex = ToHex(digest.data(), digest.size());
  return true;
#else
#if defined(__APPLE__)
  CC_SHA256_CTX ctx;
  CC_SHA256_Init(&ctx);
  std::vector<char> buffer(1024 * 1024);
  while (in.good()) {
    in.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
    const std::streamsize got = in.gcount();
    if (got <= 0) {
      break;
    }
    CC_SHA256_Update(&ctx, buffer.data(), static_cast<CC_LONG>(got));
  }

  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &ctx);
  *hex = ToHex(digest, CC_SHA256_DIGEST_LENGTH);
  return true;
#else
  // Fallback non-cryptographic checksum for unsupported platforms.
  std::uint64_t h = 1469598103934665603ULL;
  std::vector<char> buffer(1024 * 1024);
  while (in.good()) {
    in.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
    const std::streamsize got = in.gcount();
    if (got <= 0) {
      break;
    }
    for (std::streamsize i = 0; i < got; ++i) {
      h ^= static_cast<unsigned char>(buffer[static_cast<std::size_t>(i)]);
      h *= 1099511628211ULL;
    }
  }
  unsigned char digest[8];
  for (int i = 0; i < 8; ++i) {
    digest[i] = static_cast<unsigned char>((h >> (8 * (7 - i))) & 0xFFU);
  }
  *hex = ToHex(digest, 8);
  if (err) {
    *err = "SHA-256 unavailable on this platform; using fallback checksum.";
  }
  return true;
#endif
#endif
}
