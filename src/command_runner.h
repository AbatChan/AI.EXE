#pragma once

#include "process_runner.h"

#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

// Lets the agent run an allowlisted project command family
// inside the project root and capture its output — the "run it, see the real
// error, fix, re-run" loop that Codex/Claude Code have. Reuses the hardened
// ProcessRunner (timeout + output/cpu/mem caps + restricted token). No raw shell.

struct CommandRunResult {
  bool launched = false;
  bool timed_out = false;
  int exit_code = -1;
  std::string output;
  std::string err;
};

namespace command_runner_detail {

inline std::filesystem::path VenvPython(const std::filesystem::path& root) {
#ifdef _WIN32
  return root / ".venv" / "Scripts" / "python.exe";
#else
  return root / ".venv" / "bin" / "python";
#endif
}

// First match for any of `names` across the PATH entries.
inline std::filesystem::path FindOnPath(const std::vector<std::string>& names) {
  const char* path_env = std::getenv("PATH");
  if (!path_env) return {};
#ifdef _WIN32
  const char sep = ';';
#else
  const char sep = ':';
#endif
  std::string paths(path_env);
  std::error_code ec;
  size_t start = 0;
  while (start <= paths.size()) {
    size_t end = paths.find(sep, start);
    std::string dir = paths.substr(
        start, end == std::string::npos ? std::string::npos : end - start);
    if (!dir.empty()) {
      for (const auto& n : names) {
        std::filesystem::path cand = std::filesystem::path(dir) / n;
        if (std::filesystem::exists(cand, ec)) return cand;
      }
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return {};
}

inline std::filesystem::path SystemPython() {
#ifdef _WIN32
  return FindOnPath({"python.exe", "py.exe"});
#else
  return FindOnPath({"python3", "python"});
#endif
}

inline void SetHeadlessEnv(bool on) {
  // Run GUI toolkits (pygame/SDL) windowless during agent testing so a window
  // doesn't pop up on every run; the child inherits the parent environment.
  static const char* kVars[] = {"SDL_VIDEODRIVER", "SDL_AUDIODRIVER",
                                "PYGAME_HIDE_SUPPORT_PROMPT"};
  static const char* kVals[] = {"dummy", "dummy", "1"};
  for (int i = 0; i < 3; ++i) {
#ifdef _WIN32
    SetEnvironmentVariableA(kVars[i], on ? kVals[i] : nullptr);
#else
    if (on) setenv(kVars[i], kVals[i], 1);
    else unsetenv(kVars[i]);
#endif
  }
}

}  // namespace command_runner_detail

// Resolves the executable for an allowlisted program (venv-aware python).
// Returns empty and sets err when missing or not allowed.
inline std::filesystem::path ResolveProjectProgramExe(const std::filesystem::path& root,
                                                      const std::string& program,
                                                      std::string* err) {
  using namespace command_runner_detail;
  std::error_code ec;
  if (program == "python" || program == "pip") {
    std::filesystem::path venv = VenvPython(root);
    std::filesystem::path exe = std::filesystem::exists(venv, ec) ? venv : SystemPython();
    if (exe.empty() && err) *err = "Python is not installed. Install it from https://python.org";
    return exe;
  }
  if (program == "node" || program == "npm" || program == "php" || program == "java" ||
      program == "go" || program == "cargo" || program == "dotnet") {
#ifdef _WIN32
    std::filesystem::path exe = FindOnPath({program + ".exe", program + ".cmd", program + ".bat", program});
#else
    std::filesystem::path exe = FindOnPath({program});
#endif
    if (exe.empty() && err) *err = program + " is not installed or not on PATH.";
    return exe;
  }
  if (err) *err = "Command not allowed: " + program;
  return {};
}

// Runs `program args...` in `root`. program is allowlisted and argv-based.
// pip is run as `<python> -m pip ...` inside the project venv (created if
// needed) so installs never hit the system Python (PEP 668).
inline CommandRunResult RunProjectCommand(const std::filesystem::path& root,
                                          const std::string& program,
                                          const std::vector<std::string>& args,
                                          std::uint32_t timeout_seconds) {
  using namespace command_runner_detail;
  CommandRunResult out;
  std::error_code ec;
  if (!std::filesystem::is_directory(root, ec)) {
    out.err = "No project folder is open.";
    return out;
  }

  ProcessLimits limits;
  limits.timeout_seconds = timeout_seconds ? timeout_seconds : 30;
  limits.output_limit_bytes = 64 * 1024;
  limits.try_restricted_token = false;  // python/pip need normal file access

  std::filesystem::path exe;
  std::vector<std::string> full_args;

  if (program == "python" || program == "pip") {
    std::filesystem::path venv = VenvPython(root);
    if (program == "pip" && !std::filesystem::exists(venv, ec)) {
      // Create the venv with the system Python first.
      std::filesystem::path sys_py = SystemPython();
      if (sys_py.empty()) {
        out.err = "Python is not installed. Install it from https://python.org";
        return out;
      }
      ProcessResult mk;
      std::string mk_err;
      ProcessRunner::RunExe(sys_py, {"-m", "venv", ".venv"}, root, limits, &mk,
                            nullptr, &mk_err);
    }
    exe = std::filesystem::exists(venv, ec) ? venv : SystemPython();
    if (exe.empty()) {
      out.err = "Python is not installed. Install it from https://python.org";
      return out;
    }
    if (program == "pip") {
      full_args = {"-m", "pip"};
      full_args.insert(full_args.end(), args.begin(), args.end());
    } else {
      full_args = args;
    }
  } else if (program == "node" || program == "npm" ||
             program == "php" || program == "java" || program == "javac" ||
             program == "gcc" || program == "g++" ||
             program == "clang" || program == "clang++" ||
             program == "go" || program == "rustc" || program == "cargo" ||
             program == "dotnet") {
#ifdef _WIN32
    exe = FindOnPath({program + ".exe", program + ".cmd", program + ".bat", program});
#else
    exe = FindOnPath({program});
#endif
    if (exe.empty()) {
      out.err = program + " is not installed or not on PATH.";
      return out;
    }
    full_args = args;
  } else {
    out.err = "Command not allowed: " + program;
    return out;
  }

  SetHeadlessEnv(true);
  ProcessResult res;
  std::string run_err;
  const bool ok = ProcessRunner::RunExe(exe, full_args, root, limits, &res,
                                        nullptr, &run_err);
  SetHeadlessEnv(false);

  out.launched = res.launched;
  out.timed_out = res.timed_out;
  out.exit_code = res.exit_code;
  out.output = res.output;
  if (!ok && out.output.empty()) out.err = run_err.empty() ? "Failed to run the command." : run_err;
  return out;
}
