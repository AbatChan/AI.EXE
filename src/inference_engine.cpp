#include "inference_engine.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

std::string TrimTrailingNewline(std::string text) {
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) {
    text.pop_back();
  }
  return text;
}

std::string Trim(std::string text) {
  while (!text.empty() &&
         std::isspace(static_cast<unsigned char>(text.front()))) {
    text.erase(text.begin());
  }
  while (!text.empty() &&
         std::isspace(static_cast<unsigned char>(text.back()))) {
    text.pop_back();
  }
  return text;
}

bool StartsWith(const std::string &text, const std::string &prefix) {
  return text.size() >= prefix.size() &&
         text.compare(0, prefix.size(), prefix) == 0;
}

bool IsTruthyEnv(const char *value) {
  if (!value || value[0] == '\0') {
    return false;
  }

  std::string normalized(value);
  for (char &c : normalized) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return normalized == "1" || normalized == "true" || normalized == "yes" ||
         normalized == "on";
}

bool OutputIndicatesAccelerator(const std::string &output) {
  std::string normalized(output);
  for (char &c : normalized) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }

  static const std::vector<std::string> markers = {
      "cuda", "metal", "vulkan", "sycl", "hip", "musa", "cann"};
  for (const auto &marker : markers) {
    if (normalized.find(marker) != std::string::npos) {
      return true;
    }
  }
  return false;
}

bool EngineHasAccelerator(const std::filesystem::path &engine) {
  if (engine.empty()) {
    return true;
  }

  ProcessLimits limits;
  limits.timeout_seconds = 5;
  limits.memory_limit_bytes = 256ULL * 1024ULL * 1024ULL;
  limits.output_limit_bytes = 32 * 1024;
  limits.max_active_processes = 1;
  limits.cpu_rate_percent = 0;
  limits.try_restricted_token = true;

  ProcessResult result;
  std::string err;
  if (!ProcessRunner::RunExe(engine, {"--list-devices"}, engine.parent_path(),
                             limits, &result, nullptr, &err)) {
    return true;
  }
  if (result.timed_out || result.exit_code != 0) {
    return true;
  }
  return OutputIndicatesAccelerator(result.output);
}

std::filesystem::path
ResolveLocalEnginePath(const std::filesystem::path &backend_exe) {
  const char *override_path = std::getenv("AI_EXE_LLM_ENGINE_PATH");
  if (override_path && override_path[0] != '\0') {
    std::error_code ec;
    const auto candidate = std::filesystem::weakly_canonical(
        std::filesystem::path(override_path), ec);
    if (!ec && std::filesystem::exists(candidate, ec) &&
        std::filesystem::is_regular_file(candidate, ec)) {
      return candidate;
    }
  }

  if (backend_exe.empty()) {
    return {};
  }

  std::error_code ec;
  const auto base =
      std::filesystem::weakly_canonical(backend_exe.parent_path(), ec);
  if (ec || base.empty()) {
    return {};
  }

#ifdef _WIN32
  const std::vector<std::string> names = {"llama-cli.exe", "llama_main.exe",
                                          "main.exe"};
#else
  const std::vector<std::string> names = {"llama-cli", "llama_main", "main"};
#endif

  for (const auto &name : names) {
    const auto candidate = base / name;
    if (std::filesystem::exists(candidate, ec) &&
        std::filesystem::is_regular_file(candidate, ec)) {
      const auto canonical = std::filesystem::weakly_canonical(candidate, ec);
      return ec ? candidate : canonical;
    }
  }

  return {};
}

bool ExtractUntilPrompt(std::string *buffer, std::string *payload) {
  if (!buffer || !payload) {
    return false;
  }

  auto is_whitespace_only = [](const std::string &s) {
    for (char c : s) {
      if (!std::isspace(static_cast<unsigned char>(c))) {
        return false;
      }
    }
    return true;
  };

  auto marker_pos = buffer->rfind("\n> ");
  std::size_t marker_len = 3;
  if (marker_pos == std::string::npos && StartsWith(*buffer, "> ")) {
    marker_pos = 0;
    marker_len = 2;
  }
  if (marker_pos == std::string::npos) {
    return false;
  }

  const std::string tail = buffer->substr(marker_pos + marker_len);
  if (!is_whitespace_only(tail)) {
    return false;
  }

  *payload = buffer->substr(0, marker_pos);
  buffer->clear();
  return true;
}

std::string NormalizeLlamaResponse(std::string raw, const std::string &prompt) {
  raw = Trim(raw);
  if (raw.empty()) {
    return raw;
  }

  for (char &ch : raw) {
    if (ch == '\r') {
      ch = '\n';
    }
  }

  const std::vector<std::string> cut_markers = {
      "[ Prompt:",   "llama_memory_breakdown_print:",   "Exiting...",
      "\n[ Prompt:", "\nllama_memory_breakdown_print:", "\nExiting...",
  };
  for (const auto &marker : cut_markers) {
    const auto pos = raw.find(marker);
    if (pos != std::string::npos) {
      raw = raw.substr(0, pos);
    }
  }

  raw = Trim(raw);
  if (raw.empty()) {
    return raw;
  }

  const auto prompt_pos = raw.find(prompt);
  if (prompt_pos != std::string::npos) {
    raw = Trim(raw.substr(prompt_pos + prompt.size()));
  }

  const std::vector<std::string> response_markers = {
      "AI_EXE_RESPONSE:",
      "Assistant response:",
      "Assistant:",
  };
  for (const auto &marker : response_markers) {
    const auto pos = raw.rfind(marker);
    if (pos != std::string::npos) {
      const std::size_t begin = pos + marker.size();
      if (begin < raw.size()) {
        raw = Trim(raw.substr(begin));
      }
      break;
    }
  }

  return Trim(raw);
}

std::string NormalizeLlamaPreview(std::string raw, const std::string &prompt) {
  if (raw.empty()) {
    return raw;
  }

  for (char &ch : raw) {
    if (ch == '\r') {
      ch = '\n';
    }
  }

  const std::vector<std::string> cut_markers = {
      "[ Prompt:",   "llama_memory_breakdown_print:",   "Exiting...",
      "\n[ Prompt:", "\nllama_memory_breakdown_print:", "\nExiting...",
  };
  for (const auto &marker : cut_markers) {
    const auto pos = raw.find(marker);
    if (pos != std::string::npos) {
      raw = raw.substr(0, pos);
    }
  }

  const auto prompt_pos = raw.find(prompt);
  if (prompt_pos != std::string::npos) {
    raw = raw.substr(prompt_pos + prompt.size());
  }

  while (!raw.empty() && (raw.front() == '\n' || raw.front() == '\r')) {
    raw.erase(raw.begin());
  }

  const std::vector<std::string> response_markers = {
      "AI_EXE_RESPONSE:",
      "Assistant response:",
      "Assistant:",
  };
  for (const auto &marker : response_markers) {
    if (StartsWith(raw, marker)) {
      raw = raw.substr(marker.size());
      while (!raw.empty() && (raw.front() == ' ' || raw.front() == '\n' ||
                              raw.front() == '\r')) {
        raw.erase(raw.begin());
      }
      break;
    }
  }

  return raw;
}

// llama-cli interactive stdin is line-oriented. Our prompts are multiline
// ChatML blocks, so send escaped newlines to preserve full prompt structure in
// one interactive turn.
std::string EncodeInteractivePrompt(const std::string &prompt) {
  std::string encoded;
  encoded.reserve(prompt.size() + 64);

  for (std::size_t i = 0; i < prompt.size(); ++i) {
    const char ch = prompt[i];
    switch (ch) {
    case '\\':
      encoded += "\\\\";
      break;
    case '\n':
      encoded += "\\n";
      break;
    case '\r':
      if (i + 1 >= prompt.size() || prompt[i + 1] != '\n') {
        encoded += "\\n";
      }
      break;
    case '\t':
      encoded += "\\t";
      break;
    default:
      encoded.push_back(ch);
      break;
    }
  }

  return encoded;
}

class LlamaPersistentSession {
public:
  ~LlamaPersistentSession() { Stop(); }

  bool IsRunning() const { return running_; }

  std::filesystem::path EnginePath() const { return engine_path_; }

  std::filesystem::path ModelPath() const { return model_path_; }

  void Stop() {
    if (!running_) {
      return;
    }

#ifdef _WIN32
    if (stdin_write_) {
      const char *quit = "/exit\n";
      DWORD wrote = 0;
      (void)WriteFile(stdin_write_, quit, static_cast<DWORD>(std::strlen(quit)),
                      &wrote, nullptr);
      FlushFileBuffers(stdin_write_);
    }

    if (process_handle_) {
      const DWORD waited = WaitForSingleObject(process_handle_, 1200);
      if (waited == WAIT_TIMEOUT) {
        TerminateProcess(process_handle_, 1);
      }
    }

    if (stdin_write_) {
      CloseHandle(stdin_write_);
      stdin_write_ = nullptr;
    }
    if (stdout_read_) {
      CloseHandle(stdout_read_);
      stdout_read_ = nullptr;
    }
    if (thread_handle_) {
      CloseHandle(thread_handle_);
      thread_handle_ = nullptr;
    }
    if (process_handle_) {
      CloseHandle(process_handle_);
      process_handle_ = nullptr;
    }
#else
    if (stdin_fd_ >= 0) {
      const char *quit = "/exit\n";
      const ssize_t ignored = write(stdin_fd_, quit, std::strlen(quit));
      (void)ignored;
      close(stdin_fd_);
      stdin_fd_ = -1;
    }
    if (stdout_fd_ >= 0) {
      close(stdout_fd_);
      stdout_fd_ = -1;
    }
    if (pid_ > 0) {
      int status = 0;
      const auto start = std::chrono::steady_clock::now();
      while (waitpid(pid_, &status, WNOHANG) == 0) {
        if (std::chrono::steady_clock::now() - start >
            std::chrono::milliseconds(1200)) {
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
      if (waitpid(pid_, &status, WNOHANG) == 0) {
        (void)kill(pid_, SIGKILL);
        (void)waitpid(pid_, &status, 0);
      }
      pid_ = -1;
    }
#endif

    running_ = false;
    engine_path_.clear();
    model_path_.clear();
    conversation_mode_ = false;
  }

  bool Start(const std::filesystem::path &engine,
             const std::filesystem::path &model, std::uint32_t timeout_seconds,
             std::string *err) {
    Stop();

    if (engine.empty() || model.empty()) {
      if (err) {
        *err = "Persistent session start failed: missing engine or model path.";
      }
      return false;
    }

    // We provide full ChatML prompt text from UI, so do not enable
    // --conversation wrapping here. Keep moderate creativity and mild
    // anti-repetition defaults for chat UX.
    std::vector<std::string> args = {
        "-m",
        model.string(),
        "-n",
        "2048",
        "--ctx-size",
        "8192",
        "--temp",
        "0.6",
        "--top-p",
        "0.9",
        "--top-k",
        "40",
        "--repeat-penalty",
        "1.1",
        "--presence-penalty",
        "0.2",
        "--flash-attn",
        "auto",
        "--escape",
        "--no-show-timings",
        "--no-display-prompt",
        "--simple-io",
        "--offline",
        "--no-warmup",
    };

    const bool force_cpu =
        IsTruthyEnv(std::getenv("AI_EXE_FORCE_CPU")) ||
        !EngineHasAccelerator(engine);
    if (force_cpu) {
      args.push_back("--device");
      args.push_back("none");
      args.push_back("--n-gpu-layers");
      args.push_back("0");
    } else {
      args.push_back("--n-gpu-layers");
      args.push_back("99");
    }

    if (!Launch(engine, args, err)) {
      Stop();
      return false;
    }

    std::string startup;
    std::string read_err;
    if (!ReadUntilPrompt(timeout_seconds, &startup, &read_err, nullptr,
                         nullptr)) {
      if (err) {
        *err = "Persistent session failed to initialize: " + read_err;
      }
      Stop();
      return false;
    }

    running_ = true;
    engine_path_ = engine;
    model_path_ = model;
    conversation_mode_ =
        std::find(args.begin(), args.end(), "--conversation") != args.end();
    return true;
  }

  bool ResetConversation(std::uint32_t timeout_seconds, std::string *err) {
    if (!running_) {
      if (err) {
        *err = "Persistent session is not running.";
      }
      return false;
    }

    // "/clear" is only meaningful in interactive conversation mode.
    // Without that mode, writing it would pollute model context.
    if (!conversation_mode_) {
      return true;
    }

    if (!WriteLine("/clear", err)) {
      return false;
    }

    std::string payload;
    return ReadUntilPrompt(timeout_seconds, &payload, err, nullptr, nullptr);
  }

  bool Query(const std::string &prompt, std::uint32_t timeout_seconds,
             std::string *output, std::string *err,
             const std::function<void(const std::string &)> *on_delta) {
    if (!output) {
      if (err) {
        *err = "Persistent session output buffer is null.";
      }
      return false;
    }
    output->clear();

    if (!running_) {
      if (err) {
        *err = "Persistent session is not running.";
      }
      return false;
    }

    // Clear any residual control output (e.g. from /clear) before sending the
    // next prompt.
    std::string drain_err;
    if (!DrainStaleOutput(&drain_err)) {
      if (err) {
        *err = drain_err;
      }
      return false;
    }

    const std::string encoded_prompt = EncodeInteractivePrompt(prompt);
    if (!WriteLine(encoded_prompt, err)) {
      return false;
    }

    std::string payload;
    if (!ReadUntilPrompt(timeout_seconds, &payload, err, &prompt, on_delta)) {
      return false;
    }

    const std::string normalized = NormalizeLlamaResponse(payload, prompt);
    if (normalized.empty()) {
      if (err) {
        *err = "Persistent session produced empty output.";
      }
      return false;
    }

    *output = normalized;
    return true;
  }

private:
  bool DrainStaleOutput(std::string *err) {
#ifdef _WIN32
    if (!stdout_read_) {
      if (err) {
        *err = "Persistent session stdout handle is unavailable.";
      }
      return false;
    }
    std::string sink;
    for (int i = 0; i < 128; ++i) {
      DWORD available = 0;
      if (!PeekNamedPipe(stdout_read_, nullptr, 0, nullptr, &available,
                         nullptr)) {
        if (err) {
          *err = "PeekNamedPipe failed while draining stale output.";
        }
        return false;
      }
      if (available == 0) {
        return true;
      }
      const DWORD to_read = (available > 4096U) ? 4096U : available;
      std::string chunk(static_cast<std::size_t>(to_read), '\0');
      DWORD got = 0;
      if (!ReadFile(stdout_read_, chunk.data(), to_read, &got, nullptr)) {
        if (err) {
          *err = "ReadFile failed while draining stale output.";
        }
        return false;
      }
      if (got > 0) {
        sink.append(chunk.data(), chunk.data() + got);
      }
    }
    return true;
#else
    if (stdout_fd_ < 0) {
      if (err) {
        *err = "Persistent session stdout fd is unavailable.";
      }
      return false;
    }
    char chunk[4096];
    for (int i = 0; i < 128; ++i) {
      const ssize_t n = read(stdout_fd_, chunk, sizeof(chunk));
      if (n > 0) {
        continue;
      }
      if (n == 0 || errno == EAGAIN || errno == EWOULDBLOCK) {
        return true;
      }
      if (errno == EINTR) {
        continue;
      }
      if (err) {
        *err = "read() failed while draining stale output.";
      }
      return false;
    }
    return true;
#endif
  }

  bool ProcessExited(int *exit_code) {
#ifdef _WIN32
    if (!process_handle_) {
      if (exit_code) {
        *exit_code = 1;
      }
      return true;
    }
    DWORD code = STILL_ACTIVE;
    if (!GetExitCodeProcess(process_handle_, &code)) {
      if (exit_code) {
        *exit_code = 1;
      }
      return true;
    }
    if (code == STILL_ACTIVE) {
      return false;
    }
    if (exit_code) {
      *exit_code = static_cast<int>(code);
    }
    return true;
#else
    if (pid_ <= 0) {
      if (exit_code) {
        *exit_code = 1;
      }
      return true;
    }
    int status = 0;
    const pid_t w = waitpid(pid_, &status, WNOHANG);
    if (w == 0) {
      return false;
    }
    if (w == pid_) {
      if (WIFEXITED(status)) {
        if (exit_code) {
          *exit_code = WEXITSTATUS(status);
        }
      } else if (WIFSIGNALED(status)) {
        if (exit_code) {
          *exit_code = 128 + WTERMSIG(status);
        }
      } else if (exit_code) {
        *exit_code = 1;
      }
      pid_ = -1;
      return true;
    }
    if (exit_code) {
      *exit_code = 1;
    }
    return true;
#endif
  }

  bool ReadOnce(std::string *buffer, std::string *err) {
#ifdef _WIN32
    if (!stdout_read_) {
      if (err) {
        *err = "Persistent session stdout handle is unavailable.";
      }
      return false;
    }

    DWORD available = 0;
    if (!PeekNamedPipe(stdout_read_, nullptr, 0, nullptr, &available,
                       nullptr)) {
      if (err) {
        *err = "PeekNamedPipe failed.";
      }
      return false;
    }
    if (available == 0) {
      return true;
    }

    const DWORD to_read = (available > 4096U) ? 4096U : available;
    std::string chunk(static_cast<std::size_t>(to_read), '\0');
    DWORD got = 0;
    if (!ReadFile(stdout_read_, chunk.data(), to_read, &got, nullptr)) {
      if (err) {
        *err = "ReadFile failed while reading persistent output.";
      }
      return false;
    }
    if (got > 0) {
      buffer->append(chunk.data(), chunk.data() + got);
    }
    return true;
#else
    if (stdout_fd_ < 0) {
      if (err) {
        *err = "Persistent session stdout fd is unavailable.";
      }
      return false;
    }

    char chunk[4096];
    const ssize_t n = read(stdout_fd_, chunk, sizeof(chunk));
    if (n > 0) {
      buffer->append(chunk, static_cast<std::size_t>(n));
      return true;
    }
    if (n == 0) {
      return true;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return true;
    }
    if (err) {
      *err = "read() failed while reading persistent output.";
    }
    return false;
#endif
  }

  bool
  ReadUntilPrompt(std::uint32_t timeout_seconds, std::string *payload,
                  std::string *err, const std::string *query_prompt,
                  const std::function<void(const std::string &)> *on_delta) {
    if (!payload) {
      if (err) {
        *err = "Persistent payload buffer is null.";
      }
      return false;
    }
    payload->clear();

    std::string buffer;
    buffer.reserve(16384);
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(timeout_seconds);
    constexpr std::size_t kMaxBuffer = 256 * 1024;
    std::size_t streamed_chars = 0;

    for (;;) {
      if (ExtractUntilPrompt(&buffer, payload)) {
        if (query_prompt && on_delta && *on_delta) {
          const std::string preview =
              NormalizeLlamaPreview(*payload, *query_prompt);
          if (preview.size() > streamed_chars) {
            (*on_delta)(preview.substr(streamed_chars));
            streamed_chars = preview.size();
          }
        }
        return true;
      }

      int code = 0;
      if (ProcessExited(&code)) {
        if (err) {
          *err = "Persistent session exited unexpectedly (code " +
                 std::to_string(code) + ").";
        }
        return false;
      }

      std::string read_err;
      if (!ReadOnce(&buffer, &read_err)) {
        if (err) {
          *err = read_err;
        }
        return false;
      }

      if (buffer.size() > kMaxBuffer) {
        if (err) {
          *err = "Persistent session output exceeded safety limit.";
        }
        return false;
      }

      if (query_prompt && on_delta && *on_delta) {
        const std::string preview =
            NormalizeLlamaPreview(buffer, *query_prompt);
        if (preview.size() > streamed_chars) {
          (*on_delta)(preview.substr(streamed_chars));
          streamed_chars = preview.size();
        }
      }

      if (std::chrono::steady_clock::now() >= deadline) {
        if (err) {
          *err = "Persistent session timed out waiting for model output.";
        }
        return false;
      }

      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }

  bool WriteLine(const std::string &line, std::string *err) {
    const std::string data = line + "\n";
#ifdef _WIN32
    if (!stdin_write_) {
      if (err) {
        *err = "Persistent session stdin handle is unavailable.";
      }
      return false;
    }
    DWORD written = 0;
    if (!WriteFile(stdin_write_, data.data(), static_cast<DWORD>(data.size()),
                   &written, nullptr) ||
        written != data.size()) {
      if (err) {
        *err = "Failed to write prompt into persistent session.";
      }
      return false;
    }
    if (!FlushFileBuffers(stdin_write_)) {
      if (err) {
        *err = "Failed to flush prompt into persistent session.";
      }
      return false;
    }
    return true;
#else
    if (stdin_fd_ < 0) {
      if (err) {
        *err = "Persistent session stdin fd is unavailable.";
      }
      return false;
    }
    std::size_t offset = 0;
    while (offset < data.size()) {
      const ssize_t n =
          write(stdin_fd_, data.data() + offset, data.size() - offset);
      if (n > 0) {
        offset += static_cast<std::size_t>(n);
        continue;
      }
      if (n < 0 && errno == EINTR) {
        continue;
      }
      if (err) {
        *err = "Failed to write prompt into persistent session.";
      }
      return false;
    }
    return true;
#endif
  }

  bool Launch(const std::filesystem::path &engine,
              const std::vector<std::string> &args, std::string *err) {
#ifdef _WIN32
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE stdout_read = nullptr;
    HANDLE stdout_write = nullptr;
    HANDLE stdin_read = nullptr;
    HANDLE stdin_write = nullptr;

    if (!CreatePipe(&stdout_read, &stdout_write, &sa, 0) ||
        !CreatePipe(&stdin_read, &stdin_write, &sa, 0)) {
      if (err) {
        *err = "Failed to create pipes for persistent session.";
      }
      if (stdout_read)
        CloseHandle(stdout_read);
      if (stdout_write)
        CloseHandle(stdout_write);
      if (stdin_read)
        CloseHandle(stdin_read);
      if (stdin_write)
        CloseHandle(stdin_write);
      return false;
    }

    if (!SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0)) {
      if (err) {
        *err = "Failed to configure persistent session pipes.";
      }
      CloseHandle(stdout_read);
      CloseHandle(stdout_write);
      CloseHandle(stdin_read);
      CloseHandle(stdin_write);
      return false;
    }

    auto utf8_to_wide = [](const std::string &s) -> std::wstring {
      if (s.empty())
        return {};
      const int needed = MultiByteToWideChar(
          CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
      if (needed <= 0)
        return {};
      std::wstring out(static_cast<std::size_t>(needed), L'\0');
      const int written =
          MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                              out.data(), needed);
      return (written > 0) ? out : std::wstring();
    };

    auto quote_arg = [&](const std::wstring &arg) -> std::string {
      if (arg.empty())
        return "\"\"";
      bool needs_quotes = false;
      for (wchar_t c : arg) {
        if (c == L' ' || c == L'\t' || c == L'"') {
          needs_quotes = true;
          break;
        }
      }
      if (!needs_quotes) {
        std::string raw;
        raw.reserve(arg.size());
        for (wchar_t c : arg)
          raw.push_back(static_cast<char>(c));
        return raw;
      }
      std::string out = "\"";
      for (wchar_t c : arg) {
        if (c == L'"')
          out += "\\\"";
        else
          out.push_back(static_cast<char>(c));
      }
      out += "\"";
      return out;
    };

    std::string cmd_utf8 = quote_arg(engine.wstring());
    for (const auto &arg : args) {
      cmd_utf8.push_back(' ');
      cmd_utf8 += quote_arg(utf8_to_wide(arg));
    }
    std::wstring cmdline = utf8_to_wide(cmd_utf8);
    std::vector<wchar_t> cmdline_buf(cmdline.begin(), cmdline.end());
    cmdline_buf.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = stdin_read;
    si.hStdOutput = stdout_write;
    si.hStdError = stdout_write;

    PROCESS_INFORMATION pi{};
    const std::wstring run_dir = engine.parent_path().wstring();
    const BOOL created = CreateProcessW(
        engine.wstring().c_str(), cmdline_buf.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW, nullptr, run_dir.c_str(), &si, &pi);

    CloseHandle(stdout_write);
    CloseHandle(stdin_read);
    if (!created) {
      CloseHandle(stdout_read);
      CloseHandle(stdin_write);
      if (err) {
        *err = "Failed to launch persistent llama session.";
      }
      return false;
    }

    process_handle_ = pi.hProcess;
    thread_handle_ = pi.hThread;
    stdout_read_ = stdout_read;
    stdin_write_ = stdin_write;
    return true;
#else
    int stdin_pipe[2] = {-1, -1};
    int stdout_pipe[2] = {-1, -1};
    if (pipe(stdin_pipe) != 0 || pipe(stdout_pipe) != 0) {
      if (err) {
        *err = "Failed to create pipes for persistent session.";
      }
      if (stdin_pipe[0] >= 0)
        close(stdin_pipe[0]);
      if (stdin_pipe[1] >= 0)
        close(stdin_pipe[1]);
      if (stdout_pipe[0] >= 0)
        close(stdout_pipe[0]);
      if (stdout_pipe[1] >= 0)
        close(stdout_pipe[1]);
      return false;
    }

    const pid_t pid = fork();
    if (pid < 0) {
      close(stdin_pipe[0]);
      close(stdin_pipe[1]);
      close(stdout_pipe[0]);
      close(stdout_pipe[1]);
      if (err) {
        *err = "fork() failed for persistent session.";
      }
      return false;
    }

    if (pid == 0) {
      close(stdin_pipe[1]);
      close(stdout_pipe[0]);
      (void)dup2(stdin_pipe[0], STDIN_FILENO);
      (void)dup2(stdout_pipe[1], STDOUT_FILENO);
      (void)dup2(stdout_pipe[1], STDERR_FILENO);
      close(stdin_pipe[0]);
      close(stdout_pipe[1]);

      std::vector<std::string> owned;
      owned.reserve(args.size() + 1);
      owned.push_back(engine.string());
      for (const auto &arg : args) {
        owned.push_back(arg);
      }
      std::vector<char *> argv;
      argv.reserve(owned.size() + 1);
      for (auto &token : owned) {
        argv.push_back(token.data());
      }
      argv.push_back(nullptr);
      execv(engine.string().c_str(), argv.data());
      _exit(127);
    }

    close(stdin_pipe[0]);
    close(stdout_pipe[1]);
    stdin_fd_ = stdin_pipe[1];
    stdout_fd_ = stdout_pipe[0];
    pid_ = pid;

    const int flags = fcntl(stdout_fd_, F_GETFL, 0);
    if (flags >= 0) {
      (void)fcntl(stdout_fd_, F_SETFL, flags | O_NONBLOCK);
    }
    return true;
#endif
  }

  bool running_ = false;
  std::filesystem::path engine_path_;
  std::filesystem::path model_path_;
  bool conversation_mode_ = false;

#ifdef _WIN32
  HANDLE process_handle_ = nullptr;
  HANDLE thread_handle_ = nullptr;
  HANDLE stdin_write_ = nullptr;
  HANDLE stdout_read_ = nullptr;
#else
  pid_t pid_ = -1;
  int stdin_fd_ = -1;
  int stdout_fd_ = -1;
#endif
};

struct PersistentState {
  std::mutex mu;
  LlamaPersistentSession session;
};

PersistentState &GetPersistentState() {
  static PersistentState state;
  return state;
}

} // namespace

bool InferenceEngine::LoadModel(const std::filesystem::path &model_path,
                                std::string *err) {
  if (!std::filesystem::exists(model_path)) {
    *err = "Model file not found at: " + model_path.string();
    loaded_ = false;
    return false;
  }

  std::ifstream in(model_path, std::ios::binary);
  if (!in.good()) {
    *err = "Failed to open model file at: " + model_path.string();
    loaded_ = false;
    return false;
  }

  char magic[4] = {};
  in.read(magic, 4);
  if (in.gcount() != 4) {
    *err = "Model file too small: invalid header.";
    loaded_ = false;
    return false;
  }

  const bool is_gguf = (magic[0] == 'G' && magic[1] == 'G' && magic[2] == 'U' &&
                        magic[3] == 'F');
  if (!is_gguf) {
    *err = "Unsupported model format. Expected GGUF header.";
    loaded_ = false;
    return false;
  }

  std::error_code ec;
  const auto size = std::filesystem::file_size(model_path, ec);
  if (ec) {
    *err = "Failed to read model size metadata.";
    loaded_ = false;
    return false;
  }

  loaded_model_ = model_path;
  model_size_bytes_ = static_cast<std::uint64_t>(size);
  model_format_ = "GGUF";
  loaded_ = true;
  return true;
}

bool InferenceEngine::ConfigureBackend(const InferenceBackendConfig &config,
                                       std::string *err) {
  backend_configured_ = false;
  backend_version_.clear();
  backend_config_ = config;

  if (config.executable.empty()) {
    *err = "Backend path is empty.";
    return false;
  }

  std::error_code ec;
  const auto canonical =
      std::filesystem::weakly_canonical(config.executable, ec);
  if (ec || !std::filesystem::exists(canonical)) {
    *err = "Backend executable not found at: " + config.executable.string();
    return false;
  }

#ifdef _WIN32
  std::string ext = canonical.extension().string();
  for (char &c : ext) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  if (ext != ".exe") {
    *err = "Backend executable must be a .exe file.";
    return false;
  }
#endif

  backend_config_.executable = canonical;
  backend_configured_ = true;
  return true;
}

void InferenceEngine::DisableBackend() {
  backend_configured_ = false;
  backend_version_.clear();
}

bool InferenceEngine::QueryBackendVersion(std::string *version_text) {
  if (!version_text) {
    return false;
  }

  if (!backend_configured_) {
    *version_text = "backend not configured";
    backend_version_.clear();
    return false;
  }

  ProcessResult result;
  std::string err;
  if (!InvokeBackend({"--version"}, &result, &err)) {
    *version_text = err;
    backend_version_.clear();
    return false;
  }

  if (result.timed_out) {
    *version_text = "version query timeout";
    backend_version_.clear();
    return false;
  }

  if (result.exit_code != 0) {
    *version_text =
        "version query exit_code=" + std::to_string(result.exit_code);
    const std::string output = TrimTrailingNewline(result.output);
    if (!output.empty()) {
      *version_text += " output=" + output;
    }
    backend_version_.clear();
    return false;
  }

  const std::string output = TrimTrailingNewline(result.output);
  if (output.empty()) {
    *version_text = "empty version output";
    backend_version_.clear();
    return false;
  }

  *version_text = output;
  backend_version_ = output;
  return true;
}

bool InferenceEngine::IsLoaded() const { return loaded_; }

bool InferenceEngine::IsBackendConfigured() const {
  return backend_configured_;
}

std::string InferenceEngine::BackendPath() const {
  return backend_configured_ ? backend_config_.executable.string()
                             : std::string();
}

std::string InferenceEngine::BackendVersion() const { return backend_version_; }

std::string InferenceEngine::LastInferenceRoute() const {
  std::lock_guard<std::mutex> lock(telemetry_mu_);
  return last_inference_route_;
}

std::string InferenceEngine::LastPersistentError() const {
  std::lock_guard<std::mutex> lock(telemetry_mu_);
  return last_persistent_error_;
}

void InferenceEngine::UpdateLastInferenceTelemetry(
    const std::string &route, const std::string &persistent_error) const {
  std::lock_guard<std::mutex> lock(telemetry_mu_);
  last_inference_route_ = route;
  last_persistent_error_ = persistent_error;
}

ModelInfo InferenceEngine::GetModelInfo() const {
  return ModelInfo{loaded_model_, model_size_bytes_, model_format_};
}

std::string InferenceEngine::Generate(const std::string &prompt, int max_tokens,
                                      const std::string &grammar) const {
  if (!loaded_) {
    return "[offline-inference] model not loaded";
  }

  if (!backend_configured_) {
    return std::string("[offline-inference placeholder] Prompt accepted: ") +
           prompt;
  }

  std::string output;
  std::string err;
  if (GenerateWithBackendStream(prompt, nullptr, &output, &err, max_tokens,
                                grammar)) {
    return output;
  }
  return "[offline-inference backend failure] " + err;
}

bool InferenceEngine::GenerateStream(
    const std::string &prompt,
    const std::function<void(const std::string &)> &on_delta,
    std::string *output, std::string *err, int max_tokens,
    const std::string &grammar) const {
  if (output) {
    output->clear();
  }
  if (!loaded_) {
    if (err) {
      *err = "model not loaded";
    }
    return false;
  }
  if (!backend_configured_) {
    if (err) {
      *err = "backend is not configured";
    }
    return false;
  }
  return GenerateWithBackendStream(prompt, &on_delta, output, err, max_tokens,
                                   grammar);
}

bool InferenceEngine::RunBackendSelfTest(std::string *details) const {
  if (!details) {
    return false;
  }

  if (!backend_configured_) {
    *details = "backend not configured";
    return false;
  }

  ProcessResult result;
  std::string err;
  if (!InvokeBackend({"--self-test"}, &result, &err)) {
    *details = err;
    return false;
  }

  if (result.timed_out) {
    *details = "self-test timeout";
    return false;
  }

  if (result.exit_code != 0) {
    *details = "self-test exit_code=" + std::to_string(result.exit_code);
    const std::string output = TrimTrailingNewline(result.output);
    if (!output.empty()) {
      *details += " output=" + output;
    }
    return false;
  }

  const std::string output = TrimTrailingNewline(result.output);
  if (output == "SELF_TEST_OK") {
    *details = output;
    return true;
  }

  *details = "unexpected self-test output: " + output;
  return false;
}

bool InferenceEngine::InvokeBackend(
    const std::vector<std::string> &args, ProcessResult *result,
    std::string *err,
    const std::function<void(const std::string &)> *on_output_chunk) const {
  if (!backend_configured_) {
    *err = "backend is not configured";
    return false;
  }

  ProcessLimits limits;
  limits.timeout_seconds = backend_config_.timeout_seconds;
  limits.memory_limit_bytes = backend_config_.memory_limit_bytes;
  limits.output_limit_bytes = backend_config_.output_limit_bytes;
  limits.max_active_processes = 1;
  limits.cpu_rate_percent = backend_config_.cpu_rate_percent;
  limits.try_restricted_token = true;

  const auto working_dir = backend_config_.executable.parent_path();
  return ProcessRunner::RunExe(backend_config_.executable, args, working_dir,
                               limits, result, on_output_chunk, err);
}

std::string
InferenceEngine::GenerateWithBackend(const std::string &prompt, int max_tokens,
                                     const std::string &grammar) const {
  std::string output;
  std::string err;
  if (!GenerateWithBackendStream(prompt, nullptr, &output, &err, max_tokens,
                                 grammar)) {
    return "[offline-inference backend failure] " + err;
  }
  return output;
}

bool InferenceEngine::GenerateWithBackendStream(
    const std::string &prompt,
    const std::function<void(const std::string &)> *on_delta,
    std::string *output, std::string *err, int max_tokens,
    const std::string &grammar) const {
  std::string persistent_failure_reason;
  bool persistent_attempted = false;

  if (output) {
    output->clear();
  }
  if (!err) {
    return false;
  }
  if (prompt.empty()) {
    *err = "prompt is empty";
    UpdateLastInferenceTelemetry("error_prompt_empty", persistent_failure_reason);
    return false;
  }

  const int capped_max_tokens =
      (max_tokens > 0) ? std::min(max_tokens, 4096) : 3072;
  // The current persistent stdin-driven llama-cli session is not truly
  // stateless between prompts, so keep it opt-in until a safe context-reset
  // strategy is implemented.
  const bool persistent_enabled =
      IsTruthyEnv(std::getenv("AI_EXE_ENABLE_PERSISTENT_SESSION"));
  // Explicit max_tokens requests (e.g. chat-title generation) must bypass
  // persistent mode so per-request caps/grammar remain strict.
  const bool force_one_shot =
      !persistent_enabled || max_tokens > 0 || !grammar.empty();

  if (!force_one_shot) {
    const auto engine_path = ResolveLocalEnginePath(backend_config_.executable);
    if (!engine_path.empty()) {
      auto &state = GetPersistentState();
      std::lock_guard<std::mutex> lock(state.mu);

      std::string persistent_err;
      persistent_attempted = true;
      const bool same_session = state.session.IsRunning() &&
                                state.session.EnginePath() == engine_path &&
                                state.session.ModelPath() == loaded_model_;
      if (!same_session) {
        if (!state.session.Start(engine_path, loaded_model_,
                                 backend_config_.timeout_seconds,
                                 &persistent_err)) {
          state.session.Stop();
        }
      }

      if (state.session.IsRunning()) {
        if (state.session.ResetConversation(backend_config_.timeout_seconds,
                                            &persistent_err)) {
          std::string out;
          if (state.session.Query(prompt, backend_config_.timeout_seconds, &out,
                                  &persistent_err, on_delta)) {
            if (output) {
              *output = out;
            }
            err->clear();
            UpdateLastInferenceTelemetry("persistent", std::string());
            return true;
          }
        }
        persistent_failure_reason = persistent_err;
        state.session.Stop();
      } else {
        persistent_failure_reason = persistent_err;
      }
    }
  }

  const std::vector<std::string> args = {
      "--model",
      loaded_model_.string(),
      "--prompt",
      prompt,
      "--max-tokens",
      std::to_string(capped_max_tokens),
      "--ctx-size",
      "8192",
      "--temp",
      "0.6",
      "--top-p",
      "0.9",
      "--top-k",
      "40",
      "--repeat-penalty",
      "1.1",
      "--presence-penalty",
      "0.2",
      "--flash-attn",
      "auto",
  };
  std::vector<std::string> runtime_args = args;
  if (!grammar.empty()) {
    runtime_args.push_back("--grammar");
    runtime_args.push_back(grammar);
  }

  std::string streamed_raw;
  std::size_t streamed_preview_chars = 0;
  std::function<void(const std::string &)> output_chunk_handler;
  if (on_delta && *on_delta) {
    output_chunk_handler = [&](const std::string &chunk) {
      streamed_raw.append(chunk);
      const std::string preview = NormalizeLlamaPreview(streamed_raw, prompt);
      if (preview.size() > streamed_preview_chars) {
        (*on_delta)(preview.substr(streamed_preview_chars));
        streamed_preview_chars = preview.size();
      }
    };
  }

  ProcessResult result;
  std::string invoke_err;
  if (!InvokeBackend(runtime_args, &result, &invoke_err,
                     output_chunk_handler ? &output_chunk_handler : nullptr)) {
    *err = invoke_err;
    if (persistent_attempted && persistent_failure_reason.empty()) {
      persistent_failure_reason = invoke_err;
    }
    UpdateLastInferenceTelemetry("error_backend_invoke", persistent_failure_reason);
    return false;
  }

  if (result.timed_out) {
    *err = "execution exceeded time limit";
    UpdateLastInferenceTelemetry("error_backend_timeout", persistent_failure_reason);
    return false;
  }

  if (result.exit_code != 0) {
    std::string msg = "exit_code=" + std::to_string(result.exit_code);
    const std::string trimmed_output = TrimTrailingNewline(result.output);
    if (!trimmed_output.empty()) {
      msg += " output=" + trimmed_output;
    }
    *err = msg;
    UpdateLastInferenceTelemetry("error_backend_exit", persistent_failure_reason);
    return false;
  }

  const std::string out = NormalizeLlamaResponse(result.output, prompt);
  if (out.empty()) {
    *err = "backend empty output";
    UpdateLastInferenceTelemetry("error_backend_empty_output", persistent_failure_reason);
    return false;
  }

  if (on_delta && *on_delta) {
    if (out.size() > streamed_preview_chars) {
      (*on_delta)(out.substr(streamed_preview_chars));
    }
  }
  if (output) {
    *output = out;
  }
  err->clear();
  UpdateLastInferenceTelemetry(
      persistent_attempted ? "one_shot_after_persistent_fallback" : "one_shot",
      persistent_failure_reason);
  return true;
}
