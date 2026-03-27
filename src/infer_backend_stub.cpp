#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

bool ValidateGguf(const std::filesystem::path &model) {
  if (!std::filesystem::exists(model)) {
    return false;
  }

  std::ifstream in(model, std::ios::binary);
  if (!in.good()) {
    return false;
  }

  char magic[4] = {};
  in.read(magic, 4);
  return in.gcount() == 4 && magic[0] == 'G' && magic[1] == 'G' &&
         magic[2] == 'U' && magic[3] == 'F';
}

std::string Truncate(const std::string &text, std::size_t max_chars) {
  if (text.size() <= max_chars) {
    return text;
  }
  return text.substr(0, max_chars) + "...";
}

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

bool IsBannerGlyphLine(const std::string &line) {
  if (line.empty()) {
    return false;
  }
  for (char ch : line) {
    if (std::isspace(static_cast<unsigned char>(ch))) {
      continue;
    }
    if (static_cast<unsigned char>(ch) >= 0x80) {
      continue;
    }
    return false;
  }
  return true;
}

bool IsEngineNoiseLine(const std::string &line) {
  const std::string trimmed = Trim(line);
  if (trimmed.empty()) {
    return true;
  }

  std::string lower(trimmed);
  std::transform(
      lower.begin(), lower.end(), lower.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

  if (StartsWith(lower, "ggml_") || StartsWith(lower, "llama_") ||
      StartsWith(lower, "load_tensors:") ||
      StartsWith(lower, "main: ") ||
      StartsWith(lower, "metal device name:")) {
    return true;
  }
  if (lower == "loading model..." || lower == "available commands:" ||
      StartsWith(lower, "build      :") || StartsWith(lower, "model      :") ||
      StartsWith(lower, "modalities :") || StartsWith(lower, "/exit") ||
      StartsWith(lower, "/regen") || StartsWith(lower, "/clear") ||
      StartsWith(lower, "/read") || StartsWith(lower, "> ")) {
    return true;
  }
  return IsBannerGlyphLine(trimmed);
}

std::string StripLeadingEngineNoise(std::string raw) {
  std::istringstream in(raw);
  std::string line;
  std::string out;
  bool keeping = false;

  while (std::getline(in, line)) {
    if (!keeping && IsEngineNoiseLine(line)) {
      continue;
    }
    if (!keeping && Trim(line).empty()) {
      continue;
    }
    keeping = true;
    if (!out.empty()) {
      out.push_back('\n');
    }
    out += line;
  }
  return out;
}

std::string StripLeadingPromptLeak(std::string raw) {
  raw = Trim(raw);
  if (raw.empty()) {
    return raw;
  }

  std::istringstream in(raw);
  std::string line;
  std::vector<std::string> lines;
  while (std::getline(in, line)) {
    lines.push_back(line);
  }

  std::size_t first_non_empty = lines.size();
  for (std::size_t i = 0; i < lines.size(); ++i) {
    if (!Trim(lines[i]).empty()) {
      first_non_empty = i;
      break;
    }
  }
  if (first_non_empty >= lines.size()) {
    return Trim(raw);
  }

  const std::string first_line = Trim(lines[first_non_empty]);
  if (!StartsWith(first_line, "You are AI.EXE") &&
      !StartsWith(first_line, "<|im_start|>system")) {
    return Trim(raw);
  }

  const auto cut_after_marker = [&](const std::string &marker) {
    const auto pos = raw.rfind(marker);
    if (pos == std::string::npos) {
      return std::string();
    }
    return Trim(raw.substr(pos + marker.size()));
  };

  const std::vector<std::string> prompt_trailer_markers = {
      "... (truncated)",
      "...(truncated)",
  };
  for (const auto &marker : prompt_trailer_markers) {
    const std::string suffix = cut_after_marker(marker);
    if (!suffix.empty()) {
      return suffix;
    }
  }

  bool skipping = true;
  bool in_known_section = false;
  std::string out;
  for (const auto &current : lines) {
    const std::string trimmed = Trim(current);
    std::string lower(trimmed);
    std::transform(
        lower.begin(), lower.end(), lower.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

    if (!skipping) {
      if (!out.empty()) {
        out.push_back('\n');
      }
      out += current;
      continue;
    }

    if (trimmed.empty()) {
      continue;
    }

    if (StartsWith(trimmed, "<|im_start|>") ||
        StartsWith(trimmed, "<|im_end|>") ||
        StartsWith(trimmed, "You are AI.EXE") ||
        lower == "identity:" || lower == "core capabilities:" ||
        lower == "response style:" || lower == "safety:" ||
        StartsWith(lower, "current_user:") ||
        lower == "mandatory output prefix for this response:" ||
        StartsWith(lower, "title rules:") ||
        StartsWith(lower, "think_mode:") ||
        StartsWith(lower, "canvas_mode:")) {
      in_known_section = true;
      continue;
    }

    if (in_known_section && StartsWith(trimmed, "- ")) {
      continue;
    }

    if (in_known_section && !trimmed.empty() &&
        std::isdigit(static_cast<unsigned char>(trimmed.front())) &&
        trimmed.size() > 1 && trimmed[1] == '.') {
      continue;
    }

    skipping = false;
    if (!out.empty()) {
      out.push_back('\n');
    }
    out += current;
  }

  return Trim(out);
}

std::string NormalizeStreamingPreview(std::string raw,
                                      const std::string &prompt) {
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
  } else {
    raw = StripLeadingEngineNoise(raw);
    raw = StripLeadingPromptLeak(raw);
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
      while (!raw.empty() &&
             (raw.front() == ' ' || raw.front() == '\n' ||
              raw.front() == '\r')) {
        raw.erase(raw.begin());
      }
      break;
    }
  }

  return raw;
}

std::string ExtractAssistantOutput(const std::string &raw_output) {
  std::string text;
  text.reserve(raw_output.size());
  for (char ch : raw_output) {
    if (ch != '\r') {
      text.push_back(ch);
    }
  }

  std::size_t prompt_anchor = text.rfind("\n> ");
  if (prompt_anchor == std::string::npos && StartsWith(text, "> ")) {
    prompt_anchor = 0;
  }

  std::string payload = text;
  if (prompt_anchor != std::string::npos) {
    const std::size_t line_end =
        text.find('\n', prompt_anchor + (prompt_anchor == 0 ? 0 : 1));
    if (line_end != std::string::npos && line_end + 1 < text.size()) {
      payload = text.substr(line_end + 1);
    }
  }

  std::istringstream in(payload);
  std::string line;
  std::string out;
  bool started = false;

  while (std::getline(in, line)) {
    const std::string trimmed = Trim(line);
    if (!started && trimmed.empty()) {
      continue;
    }

    if (StartsWith(trimmed, "[ Prompt:") || StartsWith(trimmed, "Exiting...") ||
        StartsWith(trimmed, "llama_memory_breakdown_print:")) {
      break;
    }

    if (!out.empty()) {
      out.push_back('\n');
    }
    out += line;
    started = true;
  }

  std::string cleaned = Trim(out);
  if (cleaned.empty()) {
    cleaned = Trim(text);
  }

  const std::vector<std::string> cut_markers = {
      "llama_memory_breakdown_print:",
      "[ Prompt:",
      "Exiting...",
  };
  for (const auto &marker : cut_markers) {
    const auto pos = cleaned.find(marker);
    if (pos != std::string::npos) {
      cleaned = Trim(cleaned.substr(0, pos));
    }
  }

  const std::vector<std::string> response_markers = {
      "AI_EXE_RESPONSE:",
      "Assistant response:",
      "Assistant:",
  };
  for (const auto &marker : response_markers) {
    const auto pos = cleaned.rfind(marker);
    if (pos != std::string::npos) {
      const std::size_t begin = pos + marker.size();
      if (begin < cleaned.size()) {
        cleaned = Trim(cleaned.substr(begin));
      }
      break;
    }
  }

  cleaned = StripLeadingEngineNoise(cleaned);
  cleaned = StripLeadingPromptLeak(cleaned);
  return Trim(cleaned);
}

bool IsTruthyEnv(const char *value) {
  if (!value || value[0] == '\0') {
    return false;
  }

  std::string normalized(value);
  std::transform(
      normalized.begin(), normalized.end(), normalized.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return normalized == "1" || normalized == "true" || normalized == "yes" ||
         normalized == "on";
}

#ifdef _WIN32
std::wstring Utf8ToWide(const std::string &s) {
  if (s.empty()) {
    return std::wstring();
  }

  const int needed = MultiByteToWideChar(
      CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) {
    return std::wstring();
  }

  std::wstring out(static_cast<std::size_t>(needed), L'\0');
  const int written = MultiByteToWideChar(
      CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), needed);
  if (written <= 0) {
    return std::wstring();
  }

  return out;
}

std::string WideToUtf8(const std::wstring &s) {
  if (s.empty()) {
    return std::string();
  }

  const int needed =
      WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                          nullptr, 0, nullptr, nullptr);
  if (needed <= 0) {
    return std::string();
  }

  std::string out(static_cast<std::size_t>(needed), '\0');
  const int written =
      WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                          out.data(), needed, nullptr, nullptr);
  if (written <= 0) {
    return std::string();
  }

  return out;
}

std::string QuoteWindowsArg(const std::wstring &arg) {
  if (arg.empty()) {
    return "\"\"";
  }

  bool needs_quotes = false;
  for (wchar_t c : arg) {
    if (c == L' ' || c == L'\t' || c == L'"') {
      needs_quotes = true;
      break;
    }
  }

  if (!needs_quotes) {
    return WideToUtf8(arg);
  }

  std::string out;
  out.push_back('"');
  std::size_t backslashes = 0;

  for (wchar_t c : arg) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }

    if (c == L'"') {
      out.append(backslashes * 2 + 1, '\\');
      out.push_back('"');
      backslashes = 0;
      continue;
    }

    if (backslashes > 0) {
      out.append(backslashes, '\\');
      backslashes = 0;
    }

    char mb[4]{};
    const int wrote = WideCharToMultiByte(
        CP_UTF8, 0, &c, 1, mb, static_cast<int>(sizeof(mb)), nullptr, nullptr);
    if (wrote > 0) {
      out.append(mb, mb + wrote);
    }
  }

  if (backslashes > 0) {
    out.append(backslashes * 2, '\\');
  }

  out.push_back('"');
  return out;
}
#endif

bool RunProcessCapture(const std::filesystem::path &executable,
                       const std::vector<std::string> &args,
                       const std::function<void(const std::string &)> *on_output_chunk,
                       std::string *output, int *exit_code, std::string *err) {
  if (!output || !exit_code || !err) {
    return false;
  }

  output->clear();
  *exit_code = -1;

#ifdef _WIN32
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE read_pipe = nullptr;
  HANDLE write_pipe = nullptr;
  if (!CreatePipe(&read_pipe, &write_pipe, &sa, 0)) {
    *err = "failed to create output pipe";
    return false;
  }

  if (!SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0)) {
    CloseHandle(read_pipe);
    CloseHandle(write_pipe);
    *err = "failed to configure output pipe";
    return false;
  }

  std::string cmd_utf8 = QuoteWindowsArg(executable.wstring());
  for (const auto &arg : args) {
    cmd_utf8.push_back(' ');
    cmd_utf8 += QuoteWindowsArg(Utf8ToWide(arg));
  }
  std::wstring cmdline = Utf8ToWide(cmd_utf8);
  std::vector<wchar_t> cmdline_buf(cmdline.begin(), cmdline.end());
  cmdline_buf.push_back(L'\0');

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = write_pipe;
  si.hStdError = write_pipe;

  PROCESS_INFORMATION pi{};
  const std::wstring run_dir = executable.parent_path().wstring();
  const BOOL created = CreateProcessW(
      executable.wstring().c_str(), cmdline_buf.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW, nullptr, run_dir.c_str(), &si, &pi);

  CloseHandle(write_pipe);
  if (!created) {
    CloseHandle(read_pipe);
    *err = "process launch failed with code " + std::to_string(GetLastError());
    return false;
  }

  char buffer[4096];
  for (;;) {
    DWORD bytes_read = 0;
    const BOOL ok =
        ReadFile(read_pipe, buffer, sizeof(buffer), &bytes_read, nullptr);
    if (!ok || bytes_read == 0) {
      break;
    }
    output->append(buffer, buffer + bytes_read);
    if (on_output_chunk && *on_output_chunk) {
      (*on_output_chunk)(std::string(buffer, buffer + bytes_read));
    }
  }

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  if (GetExitCodeProcess(pi.hProcess, &code)) {
    *exit_code = static_cast<int>(code);
  } else {
    *exit_code = 1;
  }

  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  CloseHandle(read_pipe);
  return true;
#else
  int pipefd[2];
  if (pipe(pipefd) != 0) {
    *err = "failed to create output pipe";
    return false;
  }

  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    *err = "fork failed";
    return false;
  }

  if (pid == 0) {
    close(pipefd[0]);

    if (dup2(pipefd[1], STDOUT_FILENO) < 0 ||
        dup2(pipefd[1], STDERR_FILENO) < 0) {
      _exit(126);
    }
    close(pipefd[1]);

    const std::string exe = executable.string();
    std::vector<std::string> owned;
    owned.reserve(args.size() + 1);
    owned.push_back(exe);
    for (const auto &arg : args) {
      owned.push_back(arg);
    }

    std::vector<char *> argv;
    argv.reserve(owned.size() + 1);
    for (auto &s : owned) {
      argv.push_back(s.data());
    }
    argv.push_back(nullptr);

    execv(exe.c_str(), argv.data());
    _exit(127);
  }

  close(pipefd[1]);

  int flags = fcntl(pipefd[0], F_GETFL, 0);
  if (flags >= 0) {
    (void)fcntl(pipefd[0], F_SETFL, flags | O_NONBLOCK);
  }

  int status = 0;
  bool done = false;
  char buffer[4096];
  while (!done) {
    for (;;) {
      const ssize_t n = read(pipefd[0], buffer, sizeof(buffer));
      if (n > 0) {
        output->append(buffer, buffer + n);
        if (on_output_chunk && *on_output_chunk) {
          (*on_output_chunk)(std::string(buffer, buffer + n));
        }
        continue;
      }
      if (n == 0) {
        break;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        break;
      }
      break;
    }

    const pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid) {
      done = true;
    } else if (w < 0) {
      close(pipefd[0]);
      *err = "waitpid failed";
      return false;
    } else {
      usleep(20 * 1000);
    }
  }

  for (;;) {
    const ssize_t n = read(pipefd[0], buffer, sizeof(buffer));
    if (n > 0) {
      output->append(buffer, buffer + n);
      if (on_output_chunk && *on_output_chunk) {
        (*on_output_chunk)(std::string(buffer, buffer + n));
      }
      continue;
    }
    break;
  }
  close(pipefd[0]);

  if (WIFEXITED(status)) {
    *exit_code = WEXITSTATUS(status);
  } else if (WIFSIGNALED(status)) {
    *exit_code = 128 + WTERMSIG(status);
  } else {
    *exit_code = 1;
  }

  return true;
#endif
}

bool OutputIndicatesAccelerator(const std::string &output) {
  std::string normalized(output);
  std::transform(
      normalized.begin(), normalized.end(), normalized.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

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
  std::string output;
  int exit_code = -1;
  std::string err;
  if (!RunProcessCapture(engine, {"--list-devices"}, nullptr, &output,
                         &exit_code, &err)) {
    return true;
  }
  if (exit_code != 0) {
    return true;
  }
  return OutputIndicatesAccelerator(output);
}

std::filesystem::path ResolveBackendSelfPath(const char *argv0) {
  if (!argv0 || argv0[0] == '\0') {
    return {};
  }
  std::error_code ec;
  const std::filesystem::path raw(argv0);
  const auto canonical = std::filesystem::weakly_canonical(raw, ec);
  if (!ec) {
    return canonical;
  }
  return raw;
}

std::filesystem::path ResolveEnginePath(const std::filesystem::path &self_path,
                                        const std::string &explicit_engine) {
  auto check_candidate =
      [](const std::filesystem::path &candidate) -> std::filesystem::path {
    std::error_code ec;
    const auto canonical = std::filesystem::weakly_canonical(candidate, ec);
    if (!ec && std::filesystem::exists(canonical)) {
      return canonical;
    }
    if (std::filesystem::exists(candidate)) {
      return candidate;
    }
    return {};
  };

  if (!explicit_engine.empty()) {
    const auto found = check_candidate(std::filesystem::path(explicit_engine));
    if (!found.empty()) {
      return found;
    }
  }

  const char *env_engine = std::getenv("AI_EXE_LLM_ENGINE_PATH");
  if (env_engine && env_engine[0] != '\0') {
    const auto found = check_candidate(std::filesystem::path(env_engine));
    if (!found.empty()) {
      return found;
    }
  }

  const auto base_dir = self_path.empty() ? std::filesystem::current_path()
                                          : self_path.parent_path();
#ifdef _WIN32
  const std::vector<std::string> names = {"llama-cli.exe", "llama_main.exe",
                                          "main.exe"};
#else
  const std::vector<std::string> names = {"llama-cli", "llama_main", "main"};
#endif

  for (const auto &name : names) {
    const auto candidate = base_dir / name;
    const auto found = check_candidate(candidate);
    if (!found.empty()) {
      return found;
    }
  }

  return {};
}

} // namespace

int main(int argc, char **argv) {
  std::string model_path;
  std::string prompt;
  std::string engine_path;
  std::string grammar;
  bool self_test = false;
  bool version = false;
  int max_tokens = 1024;
  int ctx_size = 8192;
  double temperature = 0.6;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--self-test") {
      self_test = true;
      continue;
    }

    if (arg == "--version") {
      version = true;
      continue;
    }

    if (arg == "--model" && i + 1 < argc) {
      model_path = argv[++i];
      continue;
    }

    if (arg == "--prompt" && i + 1 < argc) {
      prompt = argv[++i];
      continue;
    }

    if (arg == "--grammar" && i + 1 < argc) {
      grammar = argv[++i];
      continue;
    }

    if (arg == "--engine" && i + 1 < argc) {
      engine_path = argv[++i];
      continue;
    }

    if (arg == "--max-tokens" && i + 1 < argc) {
      try {
        max_tokens = std::stoi(argv[++i]);
      } catch (...) {
        std::cerr << "invalid --max-tokens";
        return 5;
      }
      continue;
    }

    if (arg == "--ctx-size" && i + 1 < argc) {
      try {
        ctx_size = std::stoi(argv[++i]);
      } catch (...) {
        std::cerr << "invalid --ctx-size";
        return 6;
      }
      continue;
    }

    if (arg == "--temp" && i + 1 < argc) {
      try {
        temperature = std::stod(argv[++i]);
      } catch (...) {
        std::cerr << "invalid --temp";
        return 7;
      }
      continue;
    }
  }

  const auto self_path = ResolveBackendSelfPath((argc > 0) ? argv[0] : nullptr);
  const auto resolved_engine = ResolveEnginePath(self_path, engine_path);

  if (self_test) {
    if (resolved_engine.empty()) {
      std::cerr
          << "missing local engine (expected llama-cli in runtime folder)";
      return 9;
    }
    std::cout << "SELF_TEST_OK";
    return 0;
  }

  if (version) {
    std::cout << "BACKEND_LOCAL_ADAPTER_V2";
    return 0;
  }

  if (model_path.empty()) {
    std::cerr << "missing --model";
    return 2;
  }

  if (prompt.empty()) {
    std::cerr << "missing --prompt";
    return 3;
  }

  if (max_tokens <= 0 || max_tokens > 4096) {
    std::cerr << "max-tokens out of range";
    return 10;
  }

  if (ctx_size <= 256 || ctx_size > 32768) {
    std::cerr << "ctx-size out of range";
    return 11;
  }

  if (temperature < 0.0 || temperature > 2.0) {
    std::cerr << "temp out of range";
    return 12;
  }

  const auto model = std::filesystem::path(model_path);
  if (!ValidateGguf(model)) {
    std::cerr << "invalid model";
    return 4;
  }

  if (resolved_engine.empty()) {
    std::cerr << "missing local engine: place llama-cli next to infer_backend "
                 "executable "
                 "or set AI_EXE_LLM_ENGINE_PATH";
    return 13;
  }

  std::vector<std::string> engine_args = {
      "-m",
      model.string(),
      "-p",
      prompt,
      "-n",
      std::to_string(max_tokens),
      "--ctx-size",
      std::to_string(ctx_size),
      "--temp",
      std::to_string(temperature),
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
      "--no-show-timings",
      "--no-display-prompt",
      "--simple-io",
      "--single-turn",
      "--no-warmup",
  };
  if (!grammar.empty()) {
    engine_args.push_back("--grammar");
    engine_args.push_back(grammar);
  }

  // Dev fallback for non-NVIDIA machines (e.g. macOS laptop previews).
  const bool force_cpu =
      IsTruthyEnv(std::getenv("AI_EXE_FORCE_CPU")) ||
      !EngineHasAccelerator(resolved_engine);
  if (force_cpu) {
    engine_args.push_back("--device");
    engine_args.push_back("none");
    engine_args.push_back("--n-gpu-layers");
    engine_args.push_back("0");
  } else {
    engine_args.push_back("--n-gpu-layers");
    engine_args.push_back("99");
  }

  std::string output;
  int exit_code = -1;
  std::string run_err;
  std::string streamed_raw;
  std::string streamed_preview;
  const std::function<void(const std::string &)> on_output_chunk =
      [&](const std::string &chunk) {
        if (chunk.empty()) {
          return;
        }
        streamed_raw.append(chunk);
        const std::string preview =
            NormalizeStreamingPreview(streamed_raw, prompt);
        if (preview.size() <= streamed_preview.size()) {
          return;
        }
        const std::string delta = preview.substr(streamed_preview.size());
        streamed_preview = preview;
        std::cout.write(delta.data(),
                        static_cast<std::streamsize>(delta.size()));
        std::cout.flush();
      };
  if (!RunProcessCapture(resolved_engine, engine_args, &on_output_chunk,
                         &output, &exit_code, &run_err)) {
    std::cerr << "engine launch failed: " << run_err;
    return 14;
  }

  output = TrimTrailingNewline(output);
  if (exit_code != 0) {
    std::cerr << "engine exit_code=" << exit_code;
    if (!output.empty()) {
      std::cerr << " output=" << Truncate(output, 1200);
    }
    return (exit_code > 0 && exit_code < 255) ? exit_code : 15;
  }

  output = ExtractAssistantOutput(output);

  if (output.empty()) {
    std::cerr << "engine produced empty output";
    return 16;
  }

  std::size_t common_prefix = 0;
  const std::size_t max_common =
      std::min(streamed_preview.size(), output.size());
  while (common_prefix < max_common &&
         streamed_preview[common_prefix] == output[common_prefix]) {
    ++common_prefix;
  }
  if (common_prefix < output.size()) {
    const std::string tail = output.substr(common_prefix);
    std::cout.write(tail.data(), static_cast<std::streamsize>(tail.size()));
    std::cout.flush();
  }
  return 0;
}
