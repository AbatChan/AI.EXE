#include "process_runner.h"

#include <chrono>
#include <filesystem>
#include <thread>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

#ifdef _WIN32
std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) {
    return std::wstring();
  }

  const int needed = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) {
    return std::wstring();
  }

  std::wstring out(static_cast<std::size_t>(needed), L'\0');
  const int written =
      MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), needed);
  if (written <= 0) {
    return std::wstring();
  }

  return out;
}

std::string WideToUtf8(const std::wstring& s) {
  if (s.empty()) {
    return std::string();
  }

  const int needed = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0, nullptr,
                                         nullptr);
  if (needed <= 0) {
    return std::string();
  }

  std::string out(static_cast<std::size_t>(needed), '\0');
  const int written =
      WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), needed, nullptr, nullptr);
  if (written <= 0) {
    return std::string();
  }

  return out;
}

std::string QuoteWindowsArg(const std::wstring& arg) {
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

  const std::string utf8 = WideToUtf8(arg);
  if (!needs_quotes) {
    return utf8;
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
    const int wrote = WideCharToMultiByte(CP_UTF8, 0, &c, 1, mb, sizeof(mb), nullptr, nullptr);
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

std::wstring BuildCommandLine(const std::filesystem::path& executable, const std::vector<std::string>& args) {
  std::string cmd_utf8 = QuoteWindowsArg(executable.wstring());

  for (const auto& arg : args) {
    cmd_utf8.push_back(' ');
    cmd_utf8 += QuoteWindowsArg(Utf8ToWide(arg));
  }

  return Utf8ToWide(cmd_utf8);
}

bool ReadPipeChunk(HANDLE handle,
                   std::string* output,
                   std::uint32_t max_bytes,
                   const std::function<void(const std::string&)>* on_output_chunk) {
  if (output->size() >= max_bytes) {
    return true;
  }

  DWORD available = 0;
  if (!PeekNamedPipe(handle, nullptr, 0, nullptr, &available, nullptr)) {
    return false;
  }

  if (available == 0) {
    return true;
  }

  DWORD to_read = available;
  const auto remaining = static_cast<DWORD>(max_bytes - output->size());
  if (to_read > remaining) {
    to_read = remaining;
  }

  std::string buffer(static_cast<std::size_t>(to_read), '\0');
  DWORD bytes_read = 0;
  if (!ReadFile(handle, buffer.data(), to_read, &bytes_read, nullptr)) {
    return false;
  }

  if (bytes_read > 0) {
    output->append(buffer.data(), buffer.data() + bytes_read);
    if (on_output_chunk && *on_output_chunk) {
      (*on_output_chunk)(std::string(buffer.data(), buffer.data() + bytes_read));
    }
  }

  return true;
}
#endif

}  // namespace

bool ProcessRunner::RunExe(const std::filesystem::path& executable,
                           const std::vector<std::string>& args,
                           const std::filesystem::path& working_dir,
                           const ProcessLimits& limits,
                           ProcessResult* result,
                           const std::function<void(const std::string&)>* on_output_chunk,
                           std::string* err) {
  if (!err) {
    return false;
  }

  if (!result) {
    *err = "Process result pointer is null.";
    return false;
  }

  *result = ProcessResult{};

  std::error_code ec;
  const auto canonical_exec = std::filesystem::weakly_canonical(executable, ec);
  if (ec || !std::filesystem::exists(canonical_exec)) {
    *err = "Executable not found.";
    return false;
  }

#ifdef _WIN32
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE read_pipe = nullptr;
  HANDLE write_pipe = nullptr;
  if (!CreatePipe(&read_pipe, &write_pipe, &sa, 0)) {
    *err = "Failed to create output capture pipe.";
    return false;
  }

  if (!SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0)) {
    CloseHandle(read_pipe);
    CloseHandle(write_pipe);
    *err = "Failed to configure output capture pipe.";
    return false;
  }

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = write_pipe;
  si.hStdError = write_pipe;

  PROCESS_INFORMATION pi{};

  std::wstring cmdline = BuildCommandLine(canonical_exec, args);
  std::wstring run_dir = working_dir.empty() ? canonical_exec.parent_path().wstring()
                                              : std::filesystem::path(working_dir).wstring();

  BOOL created = FALSE;
  HANDLE process_token = nullptr;
  HANDLE restricted_token = nullptr;

  if (limits.try_restricted_token &&
      OpenProcessToken(GetCurrentProcess(),
                       TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT |
                           TOKEN_ADJUST_SESSIONID,
                       &process_token)) {
    if (CreateRestrictedToken(process_token, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 0, nullptr,
                              &restricted_token)) {
      std::vector<wchar_t> cmdline_buf(cmdline.begin(), cmdline.end());
      cmdline_buf.push_back(L'\0');
      created = CreateProcessAsUserW(restricted_token,
                                     canonical_exec.c_str(),
                                     cmdline_buf.data(),
                                     nullptr,
                                     nullptr,
                                     TRUE,
                                     CREATE_NO_WINDOW,
                                     nullptr,
                                     run_dir.c_str(),
                                     &si,
                                     &pi);
      if (created) {
        result->used_restricted_token = true;
      }
    }
  }

  if (!created) {
    std::vector<wchar_t> cmdline_buf(cmdline.begin(), cmdline.end());
    cmdline_buf.push_back(L'\0');
    created = CreateProcessW(canonical_exec.c_str(),
                             cmdline_buf.data(),
                             nullptr,
                             nullptr,
                             TRUE,
                             CREATE_NO_WINDOW,
                             nullptr,
                             run_dir.c_str(),
                             &si,
                             &pi);
  }

  CloseHandle(write_pipe);
  if (restricted_token) {
    CloseHandle(restricted_token);
  }
  if (process_token) {
    CloseHandle(process_token);
  }

  if (!created) {
    CloseHandle(read_pipe);
    *err = "Process launch failed with code " + std::to_string(GetLastError()) + ".";
    return false;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(read_pipe);
    *err = "Failed to create job object.";
    return false;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits_info{};
  limits_info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

  if (limits.max_active_processes > 0) {
    limits_info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits_info.BasicLimitInformation.ActiveProcessLimit = limits.max_active_processes;
  }

  if (limits.memory_limit_bytes > 0) {
    limits_info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits_info.ProcessMemoryLimit = static_cast<SIZE_T>(limits.memory_limit_bytes);
  }

  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits_info, sizeof(limits_info))) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(job);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(read_pipe);
    *err = "Failed to configure job object limits.";
    return false;
  }

  if (limits.cpu_rate_percent > 0 && limits.cpu_rate_percent <= 100) {
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu_info{};
    cpu_info.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
    cpu_info.CpuRate = limits.cpu_rate_percent * 100;
    if (SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu_info, sizeof(cpu_info))) {
      result->cpu_rate_limited = true;
    }
  }

  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(job);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(read_pipe);
    *err = "Failed to assign process to job object.";
    return false;
  }

  result->launched = true;

  const DWORD timeout_ms = static_cast<DWORD>(limits.timeout_seconds) * 1000U;
  DWORD elapsed = 0;
  const DWORD tick_ms = 100;

  for (;;) {
    (void)ReadPipeChunk(read_pipe, &result->output, limits.output_limit_bytes, on_output_chunk);

    DWORD wait = WaitForSingleObject(pi.hProcess, tick_ms);
    if (wait == WAIT_OBJECT_0) {
      break;
    }

    if (wait == WAIT_FAILED) {
      TerminateJobObject(job, 1);
      CloseHandle(job);
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      CloseHandle(read_pipe);
      *err = "WaitForSingleObject failed.";
      return false;
    }

    elapsed += tick_ms;
    if (elapsed >= timeout_ms) {
      result->timed_out = true;
      TerminateJobObject(job, 124);
      break;
    }
  }

  for (;;) {
    if (!ReadPipeChunk(read_pipe, &result->output, limits.output_limit_bytes, on_output_chunk)) {
      break;
    }

    DWORD available = 0;
    if (!PeekNamedPipe(read_pipe, nullptr, 0, nullptr, &available, nullptr) || available == 0) {
      break;
    }
  }

  DWORD exit_code = 1;
  if (!GetExitCodeProcess(pi.hProcess, &exit_code)) {
    result->exit_code = 1;
  } else {
    result->exit_code = static_cast<int>(exit_code);
  }

  CloseHandle(job);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  CloseHandle(read_pipe);
  return true;
#else
  int pipefd[2];
  if (pipe(pipefd) != 0) {
    *err = "Failed to create output capture pipe.";
    return false;
  }

  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    *err = "fork() failed.";
    return false;
  }

  if (pid == 0) {
    close(pipefd[0]);

    if (!working_dir.empty()) {
      const std::string wd = working_dir.string();
      if (chdir(wd.c_str()) != 0) {
        _exit(125);
      }
    }

    if (dup2(pipefd[1], STDOUT_FILENO) < 0 || dup2(pipefd[1], STDERR_FILENO) < 0) {
      _exit(126);
    }
    close(pipefd[1]);

    std::vector<std::string> owned;
    owned.reserve(args.size() + 1);
    owned.push_back(canonical_exec.string());
    for (const auto& arg : args) {
      owned.push_back(arg);
    }

    std::vector<char*> argv;
    argv.reserve(owned.size() + 1);
    for (auto& token : owned) {
      argv.push_back(token.data());
    }
    argv.push_back(nullptr);

    execv(canonical_exec.string().c_str(), argv.data());
    _exit(127);
  }

  close(pipefd[1]);
  result->launched = true;

  int flags = fcntl(pipefd[0], F_GETFL, 0);
  if (flags >= 0) {
    (void)fcntl(pipefd[0], F_SETFL, flags | O_NONBLOCK);
  }

  const auto start = std::chrono::steady_clock::now();
  const auto timeout = std::chrono::seconds(limits.timeout_seconds);
  int status = 0;
  bool exited = false;
  char buffer[4096];

  while (!exited) {
    for (;;) {
      const ssize_t n = read(pipefd[0], buffer, sizeof(buffer));
      if (n > 0) {
        const std::size_t remaining =
            (limits.output_limit_bytes > result->output.size())
                ? (limits.output_limit_bytes - result->output.size())
                : 0U;
        if (remaining == 0) {
          break;
        }
        const std::size_t to_copy = static_cast<std::size_t>(n) < remaining ? static_cast<std::size_t>(n) : remaining;
        result->output.append(buffer, to_copy);
        if (on_output_chunk && *on_output_chunk && to_copy > 0) {
          (*on_output_chunk)(std::string(buffer, buffer + to_copy));
        }
        continue;
      }

      if (n == 0 || errno == EAGAIN || errno == EWOULDBLOCK) {
        break;
      }
      break;
    }

    const pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid) {
      exited = true;
      break;
    }
    if (w < 0) {
      close(pipefd[0]);
      *err = "waitpid() failed.";
      return false;
    }

    if (std::chrono::steady_clock::now() - start >= timeout) {
      result->timed_out = true;
      (void)kill(pid, SIGKILL);
      (void)waitpid(pid, &status, 0);
      exited = true;
      break;
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }

  for (;;) {
    const ssize_t n = read(pipefd[0], buffer, sizeof(buffer));
    if (n <= 0) {
      break;
    }
    const std::size_t remaining =
        (limits.output_limit_bytes > result->output.size())
            ? (limits.output_limit_bytes - result->output.size())
            : 0U;
    if (remaining == 0) {
      break;
    }
    const std::size_t to_copy = static_cast<std::size_t>(n) < remaining ? static_cast<std::size_t>(n) : remaining;
    result->output.append(buffer, to_copy);
    if (on_output_chunk && *on_output_chunk && to_copy > 0) {
      (*on_output_chunk)(std::string(buffer, buffer + to_copy));
    }
  }

  close(pipefd[0]);

  if (WIFEXITED(status)) {
    result->exit_code = WEXITSTATUS(status);
  } else if (WIFSIGNALED(status)) {
    result->exit_code = 128 + WTERMSIG(status);
  } else {
    result->exit_code = 1;
  }

  return true;
#endif
}
