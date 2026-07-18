#pragma once

// Tracked long-running dev servers (npm run dev, vite, http.server, ...):
// pid, combined-output log tail, exit code, and a real Stop — so the agent can
// start a server, read its startup output, and the UI can kill it. Processes
// die with the app (StopAll in the app-quit path; Windows uses a
// kill-on-close Job object).

#include <atomic>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

struct DevServerInfo {
  int id = 0;
  long long pid = -1;
  std::string command;   // display string, e.g. "npm run dev"
  std::string cwd;
  bool running = false;
  int exit_code = -1;
  std::string log_tail;  // last chunk of combined stdout+stderr
};

class DevServerManager {
 public:
  static DevServerManager& Instance() {
    static DevServerManager mgr;
    return mgr;
  }

  // Spawns `exe args...` in `cwd` detached but tracked. Returns id (>0) or 0.
  int Start(const std::filesystem::path& exe,
            const std::vector<std::string>& args,
            const std::filesystem::path& cwd,
            const std::string& display_command,
            std::string* err) {
    auto entry = std::make_shared<Entry>();
    entry->command = display_command;
    entry->cwd = cwd.string();
#ifdef _WIN32
    if (!SpawnWindows(exe, args, cwd, entry, err)) return 0;
#else
    if (!SpawnPosix(exe, args, cwd, entry, err)) return 0;
#endif
    std::lock_guard<std::mutex> lock(mutex_);
    const int id = next_id_++;
    entry->id = id;
    entries_[id] = entry;
    return id;
  }

  bool Stop(int id) {
    std::shared_ptr<Entry> entry = Find(id);
    if (!entry) return false;
    StopEntry(entry);
    return true;
  }

  void StopAll() {
    std::vector<std::shared_ptr<Entry>> all;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (auto& kv : entries_) all.push_back(kv.second);
    }
    for (auto& e : all) StopEntry(e);
  }

  bool Status(int id, DevServerInfo* out) {
    std::shared_ptr<Entry> entry = Find(id);
    if (!entry) return false;
    if (out) *out = Snapshot(*entry);
    return true;
  }

  std::vector<DevServerInfo> List() {
    std::vector<DevServerInfo> out;
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& kv : entries_) out.push_back(Snapshot(*kv.second));
    return out;
  }

 private:
  struct Entry {
    int id = 0;
    std::string command;
    std::string cwd;
    std::atomic<bool> running{false};
    std::atomic<int> exit_code{-1};
    std::atomic<long long> pid{-1};
    std::mutex log_mutex;
    std::string log;
#ifdef _WIN32
    HANDLE process = nullptr;
    HANDLE job = nullptr;
#endif
  };

  static constexpr size_t kLogCap = 32 * 1024;

  std::mutex mutex_;
  std::map<int, std::shared_ptr<Entry>> entries_;
  int next_id_ = 1;

  std::shared_ptr<Entry> Find(int id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = entries_.find(id);
    return it == entries_.end() ? nullptr : it->second;
  }

  static DevServerInfo Snapshot(Entry& e) {
    DevServerInfo info;
    info.id = e.id;
    info.pid = e.pid.load();
    info.command = e.command;
    info.cwd = e.cwd;
    info.running = e.running.load();
    info.exit_code = e.exit_code.load();
    {
      std::lock_guard<std::mutex> lock(e.log_mutex);
      info.log_tail = e.log;
    }
    return info;
  }

  static void AppendLog(const std::shared_ptr<Entry>& entry, const char* data, size_t len) {
    std::lock_guard<std::mutex> lock(entry->log_mutex);
    entry->log.append(data, len);
    if (entry->log.size() > kLogCap) {
      entry->log.erase(0, entry->log.size() - kLogCap);
    }
  }

#ifdef _WIN32
  static std::wstring QuoteArgWin(const std::wstring& arg) {
    if (!arg.empty() && arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
    std::wstring out = L"\"";
    for (wchar_t c : arg) {
      if (c == L'"') out += L"\\\"";
      else out += c;
    }
    out += L"\"";
    return out;
  }

  static std::wstring Widen(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    return w;
  }

  bool SpawnWindows(const std::filesystem::path& exe,
                    const std::vector<std::string>& args,
                    const std::filesystem::path& cwd,
                    const std::shared_ptr<Entry>& entry,
                    std::string* err) {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE read_pipe = nullptr;
    HANDLE write_pipe = nullptr;
    if (!CreatePipe(&read_pipe, &write_pipe, &sa, 0)) {
      if (err) *err = "Could not create an output pipe for the dev server.";
      return false;
    }
    SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0);

    // Batch launchers (npm.cmd etc.) can't be spawned directly — run via cmd /c.
    std::wstring ext = exe.extension().wstring();
    for (auto& c : ext) c = static_cast<wchar_t>(towlower(c));
    std::wstring cmdline;
    if (ext == L".cmd" || ext == L".bat") {
      wchar_t comspec[MAX_PATH] = L"cmd.exe";
      GetEnvironmentVariableW(L"ComSpec", comspec, MAX_PATH);
      cmdline = QuoteArgWin(comspec) + L" /c " + QuoteArgWin(exe.wstring());
    } else {
      cmdline = QuoteArgWin(exe.wstring());
    }
    for (const auto& a : args) {
      cmdline += L" ";
      cmdline += QuoteArgWin(Widen(a));
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = write_pipe;
    si.hStdError = write_pipe;
    si.hStdInput = INVALID_HANDLE_VALUE;

    PROCESS_INFORMATION pi{};
    std::wstring mutable_cmd = cmdline;
    // Vite/CRA honor BROWSER=none — the app opens the URL itself (inherited env).
    SetEnvironmentVariableW(L"BROWSER", L"none");
    const BOOL created = CreateProcessW(
        nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
        cwd.wstring().c_str(), &si, &pi);
    CloseHandle(write_pipe);
    if (!created) {
      CloseHandle(read_pipe);
      if (err) *err = "Could not start the dev server process.";
      return false;
    }

    // Kill-on-close job: the server (and its children) die with the app even
    // if StopAll never runs.
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
      AssignProcessToJobObject(job, pi.hProcess);
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    entry->process = pi.hProcess;
    entry->job = job;
    entry->pid.store(static_cast<long long>(pi.dwProcessId));
    entry->running.store(true);

    std::thread([entry, read_pipe]() {
      char buf[4096];
      DWORD got = 0;
      while (ReadFile(read_pipe, buf, sizeof(buf), &got, nullptr) && got > 0) {
        AppendLog(entry, buf, static_cast<size_t>(got));
      }
      CloseHandle(read_pipe);
      WaitForSingleObject(entry->process, 5000);
      DWORD code = 0;
      if (GetExitCodeProcess(entry->process, &code)) {
        entry->exit_code.store(static_cast<int>(code));
      }
      entry->running.store(false);
    }).detach();
    return true;
  }

  static void StopEntry(const std::shared_ptr<Entry>& entry) {
    if (!entry->running.load()) return;
    if (entry->job) {
      TerminateJobObject(entry->job, 1);
    } else if (entry->process) {
      TerminateProcess(entry->process, 1);
    }
  }
#else
  bool SpawnPosix(const std::filesystem::path& exe,
                  const std::vector<std::string>& args,
                  const std::filesystem::path& cwd,
                  const std::shared_ptr<Entry>& entry,
                  std::string* err) {
    int fds[2] = {-1, -1};
    if (pipe(fds) != 0) {
      if (err) *err = "Could not create an output pipe for the dev server.";
      return false;
    }
    const pid_t app_pid = getpid();
    const pid_t pid = fork();
    if (pid < 0) {
      close(fds[0]);
      close(fds[1]);
      if (err) *err = "Could not start the dev server process.";
      return false;
    }
    if (pid == 0) {
      // Child: own process group so Stop can signal the whole server tree.
      setsid();
      // Vite/CRA honor BROWSER=none: the app opens the URL itself, and a dev
      // server self-open can land in the wrong Chrome instance (the adapter's).
      setenv("BROWSER", "none", 1);
      dup2(fds[1], STDOUT_FILENO);
      dup2(fds[1], STDERR_FILENO);
      close(fds[0]);
      close(fds[1]);
      if (chdir(cwd.string().c_str()) != 0) _exit(127);
      // No kill-on-close job on POSIX: run the command under a supervisor
      // that group-kills everything if the app process disappears (a hard
      // kill skips StopAll and would otherwise orphan the server).
      // The watcher must drop the inherited log pipe (exec >/dev/null) —
      // holding it open starves the reader thread of EOF after the server
      // dies, so the entry would stay "running" forever. It also watches
      // the server child so it never outlives a crashed server.
      const std::string app = std::to_string(app_pid);
      std::string script =
          std::string("\"$@\" & CHILD=$!; ")
          + "( exec >/dev/null 2>&1; while kill -0 " + app
          + " 2>/dev/null && kill -0 $CHILD 2>/dev/null; do sleep 2; done; "
          + "kill -0 " + app + " 2>/dev/null || kill -- -$$ 2>/dev/null ) & WATCH=$!; "
          + "wait $CHILD; CODE=$?; kill $WATCH 2>/dev/null; exit $CODE";
      std::string sh = "/bin/sh";
      std::string dash_c = "-c";
      std::string arg0 = "aiexe-devserver";
      std::vector<char*> argv;
      argv.push_back(sh.data());
      argv.push_back(dash_c.data());
      argv.push_back(script.data());
      argv.push_back(arg0.data());
      std::string exe_str = exe.string();
      argv.push_back(exe_str.data());
      std::vector<std::string> owned(args);
      for (auto& a : owned) argv.push_back(a.data());
      argv.push_back(nullptr);
      execv(sh.c_str(), argv.data());
      _exit(127);
    }
    close(fds[1]);
    entry->pid.store(static_cast<long long>(pid));
    entry->running.store(true);

    const int read_fd = fds[0];
    std::thread([entry, read_fd, pid]() {
      char buf[4096];
      ssize_t got = 0;
      while ((got = read(read_fd, buf, sizeof(buf))) > 0) {
        AppendLog(entry, buf, static_cast<size_t>(got));
      }
      close(read_fd);
      int status = 0;
      if (waitpid(pid, &status, 0) == pid) {
        if (WIFEXITED(status)) entry->exit_code.store(WEXITSTATUS(status));
        else if (WIFSIGNALED(status)) entry->exit_code.store(128 + WTERMSIG(status));
      }
      entry->running.store(false);
    }).detach();
    return true;
  }

  static void StopEntry(const std::shared_ptr<Entry>& entry) {
    if (!entry->running.load()) return;
    const long long pid = entry->pid.load();
    if (pid <= 0) return;
    // Signal the whole process group; escalate if it ignores SIGTERM.
    kill(-static_cast<pid_t>(pid), SIGTERM);
    for (int i = 0; i < 30 && entry->running.load(); ++i) {
      usleep(100 * 1000);
    }
    if (entry->running.load()) {
      kill(-static_cast<pid_t>(pid), SIGKILL);
    }
  }
#endif
};
