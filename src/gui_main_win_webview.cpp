#ifdef _WIN32

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
// windows.h must come first — the shell/common-dialog headers below depend on
// its base types (CALLBACK, HWND, …); including them first breaks prsht.h.
#include <windows.h>
#include <commctrl.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "ui_constants.h"
#include "web_runtime_bridge.h"

#if __has_include(<WebView2.h>)
#define AI_EXE_HAVE_WEBVIEW2_HEADER 1
#include <WebView2.h>
#include <wrl.h>
#endif

namespace {

constexpr UINT kMsgShowError = WM_APP + 1;
constexpr UINT kMsgPostWebResponse = WM_APP + 2;
constexpr LONG kMinWindowWidth = static_cast<LONG>(kUiMinWindowWidth);
constexpr LONG kMinWindowHeight = static_cast<LONG>(kUiMinWindowHeight);

std::filesystem::path ExecutableDir() {
  wchar_t buf[MAX_PATH] = {};
  const DWORD len = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return std::filesystem::current_path();
  }
  return std::filesystem::path(buf).parent_path();
}

bool FileExists(const std::filesystem::path &p) {
  std::error_code ec;
  return std::filesystem::exists(p, ec) &&
         std::filesystem::is_regular_file(p, ec);
}

std::filesystem::path WindowStateIniPath() {
  wchar_t buf[MAX_PATH] = {};
  const DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
  std::filesystem::path base;
  if (len > 0 && len < MAX_PATH) {
    base = std::filesystem::path(buf);
  } else {
    base = ExecutableDir();
  }
  const auto dir = base / "AI_EXE";
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  return dir / "window_state.ini";
}

// WebView2 stores localStorage (chats, API keys, settings) in this folder. Keep it
// in %LOCALAPPDATA% — OUTSIDE the app folder — so it survives the app folder being
// replaced by an update. (Default would put it next to the exe, where an update
// wipes it.) One-time migration copies any pre-existing app-folder store over.
std::filesystem::path WebView2UserDataDir() {
  wchar_t buf[MAX_PATH] = {};
  const DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
  const std::filesystem::path base =
      (len > 0 && len < MAX_PATH) ? std::filesystem::path(buf) : ExecutableDir();
  const auto dir = base / "AI_EXE" / "WebView2";
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);

  bool new_empty = true;
  for (auto it = std::filesystem::directory_iterator(dir, ec);
       it != std::filesystem::directory_iterator(); ++it) {
    new_empty = false;
    break;
  }
  if (new_empty) {
    const auto exe_dir = ExecutableDir();
    for (auto it = std::filesystem::directory_iterator(exe_dir, ec);
         it != std::filesystem::directory_iterator(); ++it) {
      if (it->is_directory(ec) && it->path().extension() == L".WebView2") {
        std::error_code copy_ec;
        std::filesystem::copy(it->path(), dir,
                              std::filesystem::copy_options::recursive |
                                  std::filesystem::copy_options::overwrite_existing,
                              copy_ec);
        break;
      }
    }
  }
  return dir;
}

bool LoadWindowPlacementFromIni(RECT *out_rect) {
  if (!out_rect)
    return false;
  const auto ini = WindowStateIniPath();
  const wchar_t *path = ini.c_str();
  const int sentinel = std::numeric_limits<int>::min();
  const int left = GetPrivateProfileIntW(L"window", L"left", sentinel, path);
  const int top = GetPrivateProfileIntW(L"window", L"top", sentinel, path);
  const int right = GetPrivateProfileIntW(L"window", L"right", sentinel, path);
  const int bottom =
      GetPrivateProfileIntW(L"window", L"bottom", sentinel, path);
  if (left == sentinel || top == sentinel || right == sentinel ||
      bottom == sentinel) {
    return false;
  }
  if (right - left < kMinWindowWidth || bottom - top < kMinWindowHeight) {
    return false;
  }
  out_rect->left = left;
  out_rect->top = top;
  out_rect->right = right;
  out_rect->bottom = bottom;
  return true;
}

void SaveWindowPlacementToIni(HWND hwnd) {
  if (!hwnd)
    return;
  WINDOWPLACEMENT wp{};
  wp.length = sizeof(wp);
  if (!GetWindowPlacement(hwnd, &wp)) {
    return;
  }
  const RECT rc = wp.rcNormalPosition;
  if ((rc.right - rc.left) < kMinWindowWidth ||
      (rc.bottom - rc.top) < kMinWindowHeight) {
    return;
  }
  const auto ini = WindowStateIniPath();
  const wchar_t *path = ini.c_str();
  WritePrivateProfileStringW(L"window", L"left",
                             std::to_wstring(rc.left).c_str(), path);
  WritePrivateProfileStringW(L"window", L"top", std::to_wstring(rc.top).c_str(),
                             path);
  WritePrivateProfileStringW(L"window", L"right",
                             std::to_wstring(rc.right).c_str(), path);
  WritePrivateProfileStringW(L"window", L"bottom",
                             std::to_wstring(rc.bottom).c_str(), path);
}

std::filesystem::path FindRuntimeRootFrom(std::filesystem::path start) {
  if (start.empty()) {
    return {};
  }

  std::error_code ec;
  if (!std::filesystem::is_directory(start, ec)) {
    start = start.parent_path();
  }

  for (auto p = start; !p.empty(); p = p.parent_path()) {
    const bool has_data_model =
        std::filesystem::exists(p / "data" / "model", ec);
    const bool has_data_runtime =
        std::filesystem::exists(p / "data" / "runtime", ec);
    const bool has_ui = std::filesystem::exists(p / "ui" / "ai-exe.html", ec);
    if (has_data_model || has_data_runtime || has_ui) {
      return p;
    }
    if (p == p.root_path()) {
      break;
    }
  }

  return {};
}

std::filesystem::path ResolveUiHtmlPath() {
  const auto exe_dir = ExecutableDir();

  std::vector<std::filesystem::path> candidates = {
      exe_dir / "ui" / "ai-exe.html",
      exe_dir.parent_path() / "ui" / "ai-exe.html",
      exe_dir.parent_path().parent_path() / "ui" / "ai-exe.html",
      std::filesystem::current_path() / "ui" / "ai-exe.html",
  };

  for (const auto &c : candidates) {
    if (FileExists(c)) {
      std::error_code ec;
      const auto abs = std::filesystem::weakly_canonical(c, ec);
      return ec ? c : abs;
    }
  }

  return {};
}

std::wstring ToFileUrl(const std::filesystem::path &p) {
  std::error_code ec;
  const auto abs = std::filesystem::weakly_canonical(p, ec);
  const std::wstring input = (ec ? p : abs).wstring();

  std::wstring out(4096, L'\0');
  DWORD cch = static_cast<DWORD>(out.size());
  if (SUCCEEDED(UrlCreateFromPathW(input.c_str(), out.data(), &cch, 0)) &&
      cch > 0) {
    out.resize(cch);
    if (!out.empty() && out.back() == L'\0') {
      out.pop_back();
    }
    return out;
  }

  std::wstring fallback = L"file:///";
  fallback += input;
  for (wchar_t &ch : fallback) {
    if (ch == L'\\') {
      ch = L'/';
    }
  }
  return fallback;
}

std::wstring HResultText(HRESULT hr) {
  wchar_t *msg = nullptr;
  const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER |
                      FORMAT_MESSAGE_FROM_SYSTEM |
                      FORMAT_MESSAGE_IGNORE_INSERTS;
  const DWORD len = FormatMessageW(flags, nullptr, static_cast<DWORD>(hr), 0,
                                   reinterpret_cast<LPWSTR>(&msg), 0, nullptr);
  std::wstring out;
  if (len > 0 && msg) {
    out.assign(msg, msg + len);
    while (!out.empty() &&
           (out.back() == L'\r' || out.back() == L'\n' || out.back() == L' ')) {
      out.pop_back();
    }
    LocalFree(msg);
  } else {
    out = L"HRESULT=" + std::to_wstring(static_cast<unsigned long>(hr));
  }
  return out;
}

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

std::string EscapeJson(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 16);
  for (char c : s) {
    switch (c) {
    case '\\':
      out += "\\\\";
      break;
    case '"':
      out += "\\\"";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\r':
      out += "\\r";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      out.push_back(c);
      break;
    }
  }
  return out;
}

std::string ExtractJsonStringField(const std::string &line,
                                   const std::string &key) {
  const std::string marker = "\"" + key + "\":\"";
  const auto start = line.find(marker);
  if (start == std::string::npos) {
    return std::string();
  }

  std::string out;
  bool escaped = false;
  for (std::size_t i = start + marker.size(); i < line.size(); ++i) {
    const char c = line[i];
    if (escaped) {
      switch (c) {
      case 'n':
        out.push_back('\n');
        break;
      case 'r':
        out.push_back('\r');
        break;
      case 't':
        out.push_back('\t');
        break;
      default:
        out.push_back(c);
        break;
      }
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') {
      break;
    }
    out.push_back(c);
  }
  return out;
}

int ExtractJsonIntField(const std::string &line, const std::string &key,
                        int fallback = 0) {
  const std::string marker = "\"" + key + "\":";
  const auto start = line.find(marker);
  if (start == std::string::npos) {
    return fallback;
  }

  auto is_ws = [](char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
  };

  std::size_t i = start + marker.size();
  while (i < line.size() && is_ws(line[i])) {
    ++i;
  }
  bool quoted = false;
  if (i < line.size() && line[i] == '"') {
    quoted = true;
    ++i;
  }
  if (i >= line.size()) {
    return fallback;
  }

  const char *begin = line.c_str() + i;
  char *end = nullptr;
  const long parsed = std::strtol(begin, &end, 10);
  if (begin == end) {
    return fallback;
  }
  if (quoted && (*end != '"')) {
    return fallback;
  }
  if (parsed <= 0) {
    return fallback;
  }
  return static_cast<int>(parsed);
}

std::filesystem::path ResolveRuntimeRoot(const std::filesystem::path &ui_html) {
  if (!ui_html.empty()) {
    const auto root = FindRuntimeRootFrom(ui_html);
    if (!root.empty()) {
      return root;
    }
  }

  const auto exe_dir = ExecutableDir();
  {
    const auto root = FindRuntimeRootFrom(exe_dir);
    if (!root.empty()) {
      return root;
    }
  }

  std::error_code ec;
  const std::vector<std::filesystem::path> candidates = {
      exe_dir,
      exe_dir.parent_path(),
      std::filesystem::current_path(),
  };

  for (const auto &c : candidates) {
    if (std::filesystem::exists(c / "data" / "runtime", ec) ||
        std::filesystem::exists(c / "ui" / "ai-exe.html", ec)) {
      return c;
    }
  }

  return exe_dir;
}

std::string TrimCopy(const std::string &text) {
  std::size_t start = 0;
  while (start < text.size() &&
         std::isspace(static_cast<unsigned char>(text[start]))) {
    ++start;
  }
  std::size_t end = text.size();
  while (end > start &&
         std::isspace(static_cast<unsigned char>(text[end - 1]))) {
    --end;
  }
  return text.substr(start, end - start);
}

std::string NormalizeWorkspaceRelativePath(const std::string &raw,
                                           std::string *err) {
  std::string input = TrimCopy(raw);
  std::replace(input.begin(), input.end(), '\\', '/');
  while (!input.empty() && input.front() == '/') {
    input.erase(input.begin());
  }
  if (input.empty() || input == ".") {
    return std::string();
  }

  std::filesystem::path rel(input);
  if (rel.is_absolute()) {
    if (err)
      *err = "Workspace path must be relative.";
    return std::string();
  }

  std::filesystem::path clean;
  for (const auto &part : rel) {
    const std::string token = part.string();
    if (token.empty() || token == ".") {
      continue;
    }
    if (token == "..") {
      if (err)
        *err = "Path traversal is not allowed.";
      return std::string();
    }
    clean /= part;
  }
  return clean.generic_string();
}

std::mutex s_workspace_root_mu;
std::optional<std::filesystem::path> s_workspace_root_override;

std::filesystem::path DefaultWorkspaceRoot(const WebRuntimeBridge &runtime) {
  // Generated projects go to the user's Downloads (easy to find), not buried in
  // the app folder next to AI.EXE.exe. Falls back to the app data dir if needed.
  wchar_t buf[MAX_PATH] = {};
  const DWORD len = GetEnvironmentVariableW(L"USERPROFILE", buf, MAX_PATH);
  if (len > 0 && len < MAX_PATH) {
    std::error_code ec;
    const auto downloads = std::filesystem::path(buf) / L"Downloads";
    if (std::filesystem::exists(downloads, ec)) {
      return downloads / L"AI.EXE Projects";
    }
  }
  return runtime.Config().sandbox_root / "workspace";
}

std::filesystem::path WorkspaceRoot(const WebRuntimeBridge &runtime) {
  std::error_code ec;
  const auto default_root = DefaultWorkspaceRoot(runtime);
  std::filesystem::create_directories(default_root, ec);

  std::filesystem::path root = default_root;
  {
    std::lock_guard<std::mutex> lock(s_workspace_root_mu);
    if (s_workspace_root_override.has_value()) {
      const auto &override_root = *s_workspace_root_override;
      std::error_code check_ec;
      if (std::filesystem::exists(override_root, check_ec) &&
          std::filesystem::is_directory(override_root, check_ec)) {
        root = override_root;
      } else {
        s_workspace_root_override.reset();
      }
    }
  }
  std::filesystem::create_directories(root, ec);
  return root;
}

bool SetWorkspaceRootOverride(const std::filesystem::path &raw_path,
                              std::string *err) {
  if (raw_path.empty()) {
    if (err)
      *err = "Folder selection cancelled.";
    return false;
  }
  std::error_code ec;
  std::filesystem::path resolved =
      std::filesystem::weakly_canonical(raw_path, ec);
  if (ec) {
    ec.clear();
    resolved = std::filesystem::absolute(raw_path, ec);
  }
  if (ec || resolved.empty()) {
    if (err)
      *err = "Failed to resolve selected folder.";
    return false;
  }
  if (!std::filesystem::exists(resolved, ec) ||
      !std::filesystem::is_directory(resolved, ec)) {
    if (err)
      *err = "Selected path is not a folder.";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(s_workspace_root_mu);
    s_workspace_root_override = resolved;
  }
  return true;
}

void ClearWorkspaceRootOverride() {
  std::lock_guard<std::mutex> lock(s_workspace_root_mu);
  s_workspace_root_override.reset();
}

// The OPEN workspace root: the override if one is set, otherwise EMPTY (no project
// open). Status reports this so closing a project actually stays closed instead of
// falling back to the always-present default and re-opening on the next poll.
std::filesystem::path WorkspaceRootOrEmpty() {
  std::lock_guard<std::mutex> lock(s_workspace_root_mu);
  if (s_workspace_root_override.has_value()) {
    std::error_code check_ec;
    if (std::filesystem::exists(*s_workspace_root_override, check_ec) &&
        std::filesystem::is_directory(*s_workspace_root_override, check_ec)) {
      return *s_workspace_root_override;
    }
  }
  return std::filesystem::path();
}

std::optional<std::filesystem::path>
ResolveWorkspacePath(const WebRuntimeBridge &runtime,
                     const std::string &raw_path, std::string *err) {
  std::string norm_err;
  const std::string rel = NormalizeWorkspaceRelativePath(raw_path, &norm_err);
  if (!norm_err.empty()) {
    if (err)
      *err = norm_err;
    return std::nullopt;
  }
  return rel.empty() ? WorkspaceRoot(runtime)
                     : (WorkspaceRoot(runtime) / std::filesystem::path(rel));
}

std::uint64_t FileTimeToUnixMs(std::filesystem::file_time_type ft) {
  using namespace std::chrono;
  const auto now_file = std::filesystem::file_time_type::clock::now();
  const auto now_sys = system_clock::now();
  const auto sys_time = now_sys + (ft - now_file);
  const auto ms =
      duration_cast<milliseconds>(sys_time.time_since_epoch()).count();
  return ms > 0 ? static_cast<std::uint64_t>(ms) : 0ULL;
}

struct WorkspaceEntryInfo {
  std::string name;
  std::string kind;
  std::string path;
  std::uint64_t size_bytes = 0;
  std::uint64_t updated_at_ms = 0;
  std::uint64_t child_count = 0;
};

bool BuildWorkspaceListOutput(const WebRuntimeBridge &runtime,
                              const std::string &raw_path, std::string *output,
                              std::string *err) {
  if (!output)
    return false;
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  const auto root = WorkspaceRoot(runtime);
  const auto target = *resolved;

  std::error_code ec;
  if (!std::filesystem::exists(target, ec)) {
    if (target == root) {
      std::filesystem::create_directories(root, ec);
    } else {
      if (err)
        *err = "Folder not found.";
      return false;
    }
  }
  if (!std::filesystem::is_directory(target, ec)) {
    if (err)
      *err = "Workspace path is not a folder.";
    return false;
  }

  std::vector<WorkspaceEntryInfo> entries;
  for (std::filesystem::directory_iterator it(target, ec), end;
       !ec && it != end; it.increment(ec)) {
    const auto &p = it->path();
    const bool is_dir = it->is_directory(ec);
    const bool is_file = !is_dir && it->is_regular_file(ec);
    if (!is_dir && !is_file)
      continue;

    WorkspaceEntryInfo info;
    info.name = p.filename().string();
    info.kind = is_dir ? "folder" : "file";
    const auto rel = std::filesystem::relative(p, root, ec);
    const std::string rel_path = ec ? info.name : rel.generic_string();
    info.path = rel_path.empty() ? "/" : ("/" + rel_path);
    if (is_file) {
      info.size_bytes = static_cast<std::uint64_t>(it->file_size(ec));
    } else {
      std::uint64_t count = 0;
      for (std::filesystem::directory_iterator child(p, ec), child_end;
           !ec && child != child_end; child.increment(ec)) {
        ++count;
      }
      info.child_count = count;
    }
    info.updated_at_ms = FileTimeToUnixMs(it->last_write_time(ec));
    entries.push_back(std::move(info));
  }

  std::sort(
      entries.begin(), entries.end(),
      [](const WorkspaceEntryInfo &a, const WorkspaceEntryInfo &b) {
        if (a.kind != b.kind)
          return a.kind == "folder";
        std::string an = a.name;
        std::string bn = b.name;
        std::transform(an.begin(), an.end(), an.begin(), [](unsigned char c) {
          return static_cast<char>(std::tolower(c));
        });
        std::transform(bn.begin(), bn.end(), bn.begin(), [](unsigned char c) {
          return static_cast<char>(std::tolower(c));
        });
        return an < bn;
      });

  const auto rel_target = std::filesystem::relative(target, root, ec);
  const std::string rel_target_path =
      ec ? std::string() : rel_target.generic_string();
  const std::string view_path =
      rel_target_path.empty() ? "/" : ("/" + rel_target_path);

  std::ostringstream oss;
  oss << "{"
      << "\"path\":\"" << EscapeJson(view_path) << "\","
      << "\"entries\":[";
  for (std::size_t i = 0; i < entries.size(); ++i) {
    const auto &e = entries[i];
    if (i > 0)
      oss << ",";
    oss << "{"
        << "\"name\":\"" << EscapeJson(e.name) << "\","
        << "\"kind\":\"" << EscapeJson(e.kind) << "\","
        << "\"path\":\"" << EscapeJson(e.path) << "\","
        << "\"sizeBytes\":" << e.size_bytes << ","
        << "\"updatedAt\":" << e.updated_at_ms << ","
        << "\"childCount\":" << e.child_count << "}";
  }
  oss << "]}";
  *output = oss.str();
  return true;
}

bool WorkspaceMakeDirectory(const WebRuntimeBridge &runtime,
                            const std::string &raw_path, std::string *err) {
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  std::error_code ec;
  if (std::filesystem::exists(*resolved, ec)) {
    if (std::filesystem::is_directory(*resolved, ec))
      return true;
    if (err)
      *err = "A file already exists at this path.";
    return false;
  }
  std::filesystem::create_directories(*resolved, ec);
  if (ec) {
    if (err)
      *err = "Failed to create folder: " + ec.message();
    return false;
  }
  return true;
}

bool WorkspaceWriteFile(const WebRuntimeBridge &runtime,
                        const std::string &raw_path, const std::string &content,
                        std::string *err) {
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  std::error_code ec;
  if (std::filesystem::exists(*resolved, ec) &&
      std::filesystem::is_directory(*resolved, ec)) {
    if (err)
      *err = "Cannot write file: target is a folder.";
    return false;
  }
  std::filesystem::create_directories(resolved->parent_path(), ec);
  std::ofstream out(*resolved, std::ios::binary | std::ios::trunc);
  if (!out.is_open()) {
    if (err)
      *err = "Failed to open file for write.";
    return false;
  }
  out.write(content.data(), static_cast<std::streamsize>(content.size()));
  if (!out.good()) {
    if (err)
      *err = "Failed to write file.";
    return false;
  }
  return true;
}

bool WorkspaceReadFile(const WebRuntimeBridge &runtime,
                       const std::string &raw_path, std::string *output,
                       std::string *err) {
  if (!output)
    return false;
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  std::error_code ec;
  if (!std::filesystem::exists(*resolved, ec) ||
      !std::filesystem::is_regular_file(*resolved, ec)) {
    if (err)
      *err = "File not found.";
    return false;
  }
  const auto size = std::filesystem::file_size(*resolved, ec);
  if (size > 2ULL * 1024ULL * 1024ULL) {
    if (err)
      *err = "File is too large to load in UI.";
    return false;
  }
  std::ifstream in(*resolved, std::ios::binary);
  if (!in.is_open()) {
    if (err)
      *err = "Failed to open file for read.";
    return false;
  }
  std::ostringstream buffer;
  buffer << in.rdbuf();
  *output = buffer.str();
  return true;
}

bool WorkspaceMoveEntry(const WebRuntimeBridge &runtime,
                        const std::string &raw_src_path,
                        const std::string &raw_dst_path, std::string *err) {
  const auto src = ResolveWorkspacePath(runtime, raw_src_path, err);
  if (!src)
    return false;
  const auto dst = ResolveWorkspacePath(runtime, raw_dst_path, err);
  if (!dst)
    return false;

  const auto root = WorkspaceRoot(runtime);
  if (*src == root) {
    if (err)
      *err = "Cannot move workspace root.";
    return false;
  }

  std::error_code ec;
  if (!std::filesystem::exists(*src, ec)) {
    if (err)
      *err = "Source path not found.";
    return false;
  }
  if (std::filesystem::exists(*dst, ec)) {
    if (err)
      *err = "Destination already exists.";
    return false;
  }

  const auto src_parent = src->parent_path();
  const auto dst_parent = dst->parent_path();
  if (src_parent != dst_parent) {
    std::filesystem::create_directories(dst_parent, ec);
    if (ec) {
      if (err)
        *err = "Failed to prepare destination: " + ec.message();
      return false;
    }
  }
  const bool src_is_dir = std::filesystem::is_directory(*src, ec);
  if (src_is_dir) {
    const std::string src_prefix = src->generic_string() + "/";
    const std::string dst_value = dst->generic_string();
    if (dst_value.rfind(src_prefix, 0) == 0) {
      if (err)
        *err = "Cannot move a folder into itself.";
      return false;
    }
  }

  std::filesystem::rename(*src, *dst, ec);
  if (ec) {
    if (err)
      *err = "Failed to move item: " + ec.message();
    return false;
  }
  return true;
}

bool WorkspaceTrashEntry(const WebRuntimeBridge &runtime,
                         const std::string &raw_path, std::string *err) {
  const auto target = ResolveWorkspacePath(runtime, raw_path, err);
  if (!target)
    return false;
  const auto root = WorkspaceRoot(runtime);
  if (*target == root) {
    if (err)
      *err = "Cannot delete workspace root.";
    return false;
  }
  std::error_code ec;
  if (!std::filesystem::exists(*target, ec)) {
    if (err)
      *err = "Path not found.";
    return false;
  }

  std::wstring from = target->wstring();
  from.push_back(L'\0');
  from.push_back(L'\0');

  SHFILEOPSTRUCTW op{};
  op.wFunc = FO_DELETE;
  op.pFrom = from.c_str();
  op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
  const int result = SHFileOperationW(&op);
  if (result != 0 || op.fAnyOperationsAborted) {
    if (err)
      *err = "Failed to move item to Recycle Bin.";
    return false;
  }
  return true;
}

bool WorkspaceRevealEntry(const WebRuntimeBridge &runtime,
                          const std::string &raw_path, std::string *err) {
  const auto target = ResolveWorkspacePath(runtime, raw_path, err);
  if (!target)
    return false;
  const auto root = WorkspaceRoot(runtime);
  std::error_code ec;
  if (!std::filesystem::exists(*target, ec)) {
    if (*target == root) {
      std::filesystem::create_directories(root, ec);
    } else {
      if (err)
        *err = "Path not found.";
      return false;
    }
  }

  const bool is_dir = std::filesystem::is_directory(*target, ec);
  HINSTANCE result = nullptr;
  if (is_dir) {
    result = ShellExecuteW(nullptr, L"open", target->wstring().c_str(), nullptr,
                           nullptr, SW_SHOWNORMAL);
  } else {
    std::wstring args = L"/select,\"";
    args += target->wstring();
    args += L"\"";
    result = ShellExecuteW(nullptr, L"open", L"explorer.exe", args.c_str(),
                           nullptr, SW_SHOWNORMAL);
  }
  if (reinterpret_cast<INT_PTR>(result) <= 32) {
    if (err)
      *err = "Failed to open workspace in Explorer.";
    return false;
  }
  return true;
}

std::string StatusToJson(const WebRuntimeStatus &s) {
  std::ostringstream oss;
  oss << "{"
      << "\"rootPath\":\"" << EscapeJson(s.root_path) << "\","
      << "\"modelPath\":\"" << EscapeJson(s.model_path) << "\","
      << "\"modelExists\":" << (s.model_exists ? "true" : "false") << ","
      << "\"modelLoaded\":" << (s.model_loaded ? "true" : "false") << ","
      << "\"modelSizeBytes\":" << s.model_size_bytes << ","
      << "\"modelFormat\":\"" << EscapeJson(s.model_format) << "\","
      << "\"modelSha256\":\"" << EscapeJson(s.model_sha256) << "\","
      << "\"backendPath\":\"" << EscapeJson(s.backend_path) << "\","
      << "\"backendConfigured\":" << (s.backend_configured ? "true" : "false")
      << ","
      << "\"backendSelfTestOk\":" << (s.backend_selftest_ok ? "true" : "false")
      << ","
      << "\"backendSelfTest\":\"" << EscapeJson(s.backend_selftest_details)
      << "\","
      << "\"backendVersion\":\"" << EscapeJson(s.backend_version) << "\","
      << "\"lastError\":\"" << EscapeJson(s.last_error) << "\","
      << "\"lastInferenceRoute\":\"" << EscapeJson(s.last_inference_route)
      << "\","
      << "\"lastPersistentError\":\"" << EscapeJson(s.last_persistent_error)
      << "\","
      << "\"lastCompletionStatus\":\"" << EscapeJson(s.last_completion_status)
      << "\","
      << "\"lastCompletionLikelyTruncated\":"
      << (s.last_completion_likely_truncated ? "true" : "false") << ","
      << "\"lastCompletionMaxTokens\":" << s.last_completion_max_tokens
      << "}";
  return oss.str();
}

std::string BuildResponse(const std::string &id, const std::string &action,
                          bool ok, const std::string &message,
                          const std::string &output,
                          const WebRuntimeStatus &status) {
  std::ostringstream oss;
  oss << "{"
      << "\"id\":\"" << EscapeJson(id) << "\","
      << "\"action\":\"" << EscapeJson(action) << "\","
      << "\"ok\":" << (ok ? "true" : "false") << ","
      << "\"message\":\"" << EscapeJson(message) << "\","
      << "\"output\":\"" << EscapeJson(output) << "\","
      << "\"status\":" << StatusToJson(status) << "}";
  return oss.str();
}

std::string BuildStreamEvent(const std::string &id, bool done,
                             const std::string &delta, bool ok,
                             const std::string &message,
                             const std::string &output,
                             const WebRuntimeStatus &status) {
  std::ostringstream oss;
  oss << "{"
      << "\"id\":\"" << EscapeJson(id) << "\","
      << "\"action\":\"inferStream\","
      << "\"stream\":true,"
      << "\"done\":" << (done ? "true" : "false") << ","
      << "\"delta\":\"" << EscapeJson(delta) << "\","
      << "\"ok\":" << (ok ? "true" : "false") << ","
      << "\"message\":\"" << EscapeJson(message) << "\","
      << "\"output\":\"" << EscapeJson(output) << "\","
      << "\"status\":" << StatusToJson(status) << "}";
  return oss.str();
}

#if AI_EXE_HAVE_WEBVIEW2_HEADER
using CreateWebView2EnvironmentWithOptionsFn = HRESULT(STDAPICALLTYPE *)(
    PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);

CreateWebView2EnvironmentWithOptionsFn LoadCreateEnvironmentFn() {
  const auto exe_dir = ExecutableDir();
  const std::vector<std::wstring> loaders = {
      (exe_dir / L"WebView2Loader.dll").wstring(),
      L"WebView2Loader.dll",
  };

  for (const auto &name : loaders) {
    HMODULE m = LoadLibraryW(name.c_str());
    if (!m) {
      continue;
    }

    auto fn = reinterpret_cast<CreateWebView2EnvironmentWithOptionsFn>(
        GetProcAddress(m, "CreateCoreWebView2EnvironmentWithOptions"));
    if (fn) {
      return fn;
    }
  }

  return nullptr;
}
#endif

// Auto-updater: write a PowerShell script that waits for THIS process to exit, then
// downloads the new build, extracts it over the app folder, and relaunches. The app
// quits right after launching it. User data lives in %LOCALAPPDATA% and projects in
// Downloads, so replacing the app folder is safe.
bool LaunchUpdater(const std::string &url, std::string *err) {
  wchar_t exe_buf[MAX_PATH] = {};
  if (GetModuleFileNameW(nullptr, exe_buf, MAX_PATH) == 0) {
    if (err) *err = "Could not resolve the app path.";
    return false;
  }
  const std::filesystem::path exe_path(exe_buf);
  const std::filesystem::path app_dir = exe_path.parent_path();
  const DWORD pid = GetCurrentProcessId();

  wchar_t tmp_buf[MAX_PATH] = {};
  const DWORD tlen = GetTempPathW(MAX_PATH, tmp_buf);
  const std::filesystem::path tmp_dir =
      (tlen > 0 && tlen < MAX_PATH) ? std::filesystem::path(tmp_buf) : app_dir;
  const auto script_path = tmp_dir / L"ai_exe_update.ps1";

  auto psq = [](const std::wstring &s) {
    std::wstring out;
    for (wchar_t c : s) { if (c == L'\'') out += L"''"; else out += c; }
    return out;
  };
  std::wstringstream ss;
  ss << L"$ErrorActionPreference='SilentlyContinue'\r\n"
     << L"try { Wait-Process -Id " << pid << L" -Timeout 120 } catch {}\r\n"
     << L"Start-Sleep -Seconds 1\r\n"
     << L"$u='" << psq(Utf8ToWide(url)) << L"'\r\n"
     << L"$app='" << psq(app_dir.wstring()) << L"'\r\n"
     << L"$exe='" << psq(exe_path.wstring()) << L"'\r\n"
     << L"$t=Join-Path $env:TEMP ('aiexe_up_'+[guid]::NewGuid().ToString('N'))\r\n"
     << L"New-Item -ItemType Directory -Force $t | Out-Null\r\n"
     << L"$zip=Join-Path $t 'u.zip'\r\n"
     << L"curl.exe -L -o $zip $u\r\n"
     << L"$x=Join-Path $t 'x'\r\n"
     << L"Expand-Archive -Path $zip -DestinationPath $x -Force\r\n"
     << L"Copy-Item -Path (Join-Path $x '*') -Destination $app -Recurse -Force\r\n"
     << L"Start-Process -FilePath $exe -WorkingDirectory $app\r\n"
     << L"Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue\r\n";

  std::ofstream of(script_path, std::ios::binary);
  if (!of) {
    if (err) *err = "Could not write the updater script.";
    return false;
  }
  const std::string utf8 = WideToUtf8(ss.str());
  const unsigned char bom[3] = {0xEF, 0xBB, 0xBF};
  of.write(reinterpret_cast<const char *>(bom), 3);
  of.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
  of.close();

  std::wstring args =
      L"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"";
  args += script_path.wstring();
  args += L"\"";
  const HINSTANCE r =
      ShellExecuteW(nullptr, L"open", L"powershell.exe", args.c_str(),
                    app_dir.wstring().c_str(), SW_HIDE);
  if (reinterpret_cast<INT_PTR>(r) <= 32) {
    if (err) *err = "Could not launch the updater.";
    return false;
  }
  return true;
}

class AppWindow {
public:
  bool Create(HINSTANCE instance) {
    const wchar_t *cls = L"AI_EXE_WEBVIEW_WINDOW";

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &AppWindow::WndProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    wc.lpszClassName = cls;

    if (!RegisterClassExW(&wc)) {
      return false;
    }

    RECT restored{};
    const bool has_restored = LoadWindowPlacementFromIni(&restored);
    const int x = has_restored ? restored.left : CW_USEDEFAULT;
    const int y = has_restored ? restored.top : CW_USEDEFAULT;
    const int w =
        has_restored ? (restored.right - restored.left) : kUiDefaultWindowWidth;
    const int h = has_restored ? (restored.bottom - restored.top)
                               : kUiDefaultWindowHeight;

    hwnd_ = CreateWindowExW(
        0, cls, L"AI.EXE Phase 1 Dashboard (Windows Web Preview)",
        WS_OVERLAPPEDWINDOW, x, y, w, h, nullptr, nullptr, instance, this);

    if (!hwnd_) {
      return false;
    }

    ShowWindow(hwnd_, SW_SHOW);
    UpdateWindow(hwnd_);

    ui_html_ = ResolveUiHtmlPath();
    if (ui_html_.empty()) {
      ShowFallback(L"ui\\ai-exe.html was not found next to AI_GUI.exe.\r\n"
                   L"Expected path: .\\ui\\ai-exe.html");
      return true;
    }

    std::string runtime_err;
    runtime_.Initialize(ResolveRuntimeRoot(ui_html_), false, &runtime_err);
    if (!runtime_err.empty()) {
      runtime_init_error_ = runtime_err;
    }

#if AI_EXE_HAVE_WEBVIEW2_HEADER
    InitializeWebView();
#else
    ShowFallback(L"WebView2 SDK header not available at build time.\r\n"
                 L"Rebuild on Windows with WebView2 SDK installed to enable "
                 L"HTML UI preview.");
#endif

    return true;
  }

  int Run() {
    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    return static_cast<int>(msg.wParam);
  }

private:
  static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wparam,
                                  LPARAM lparam) {
    AppWindow *self = nullptr;
    if (msg == WM_NCCREATE) {
      auto *cs = reinterpret_cast<CREATESTRUCTW *>(lparam);
      self = reinterpret_cast<AppWindow *>(cs->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
      if (self) {
        self->hwnd_ = hwnd;
      }
    } else {
      self =
          reinterpret_cast<AppWindow *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    }

    if (!self) {
      return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    switch (msg) {
    case WM_SIZE:
      self->OnResize();
      return 0;
    case WM_GETMINMAXINFO:
      self->OnGetMinMaxInfo(reinterpret_cast<MINMAXINFO *>(lparam));
      return 0;
    case kMsgShowError: {
      auto *ptr = reinterpret_cast<std::wstring *>(lparam);
      if (ptr) {
        self->ShowFallback(*ptr);
        delete ptr;
      }
      return 0;
    }
    case kMsgPostWebResponse: {
      auto *ptr = reinterpret_cast<std::wstring *>(lparam);
#if AI_EXE_HAVE_WEBVIEW2_HEADER
      if (ptr && self->webview_) {
        self->webview_->PostWebMessageAsString(ptr->c_str());
      }
#endif
      if (ptr) {
        delete ptr;
      }
      return 0;
    }
    case WM_DESTROY:
      SaveWindowPlacementToIni(hwnd);
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
  }

  void ShowFallback(const std::wstring &text) {
    if (!fallback_) {
      fallback_ = CreateWindowExW(
          0, L"STATIC", text.c_str(), WS_CHILD | WS_VISIBLE | SS_LEFT, 16, 16,
          900, 200, hwnd_, nullptr, GetModuleHandleW(nullptr), nullptr);
      SendMessageW(fallback_, WM_SETFONT,
                   reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)),
                   TRUE);
    } else {
      SetWindowTextW(fallback_, text.c_str());
      ShowWindow(fallback_, SW_SHOW);
    }
  }

  void OnResize() {
#if AI_EXE_HAVE_WEBVIEW2_HEADER
    if (controller_) {
      RECT bounds{};
      GetClientRect(hwnd_, &bounds);
      controller_->put_Bounds(bounds);
    }
#endif

    if (fallback_) {
      RECT r{};
      GetClientRect(hwnd_, &r);
      MoveWindow(fallback_, 16, 16, (r.right - r.left) - 32, 200, TRUE);
    }
  }

  void OnGetMinMaxInfo(MINMAXINFO *mmi) {
    if (!mmi) {
      return;
    }
    mmi->ptMinTrackSize.x = kMinWindowWidth;
    mmi->ptMinTrackSize.y = kMinWindowHeight;
  }

  std::filesystem::path PromptModelImportPath() {
    wchar_t file_buf[MAX_PATH] = {};
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = hwnd_;
    ofn.lpstrFile = file_buf;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrFilter = L"GGUF Model (*.gguf)\0*.gguf\0All Files (*.*)\0*.*\0";
    ofn.nFilterIndex = 1;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    if (!GetOpenFileNameW(&ofn)) {
      return {};
    }
    return std::filesystem::path(file_buf);
  }

  std::filesystem::path PromptWorkspaceFolderPath() {
    BROWSEINFOW bi{};
    bi.hwndOwner = hwnd_;
    bi.lpszTitle = L"Select project folder";
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
    PIDLIST_ABSOLUTE pidl = SHBrowseForFolderW(&bi);
    if (!pidl) {
      return {};
    }

    wchar_t folder_buf[MAX_PATH] = {};
    const BOOL ok = SHGetPathFromIDListW(pidl, folder_buf);
    CoTaskMemFree(pidl);
    if (!ok || folder_buf[0] == L'\0') {
      return {};
    }
    return std::filesystem::path(folder_buf);
  }

  std::string HandleUiRequestWithImportPath(
      const std::string &request_json, const std::filesystem::path &import_path,
      const std::filesystem::path &workspace_root_path) {
    const std::string id = ExtractJsonStringField(request_json, "id");
    const std::string action = ExtractJsonStringField(request_json, "action");
    const std::string prompt = ExtractJsonStringField(request_json, "prompt");
    const std::string grammar = ExtractJsonStringField(request_json, "grammar");
    const std::string workspace_path =
        ExtractJsonStringField(request_json, "path");
    const std::string workspace_content =
        ExtractJsonStringField(request_json, "content");
    const std::string workspace_src_path =
        ExtractJsonStringField(request_json, "srcPath");
    const std::string workspace_dst_path =
        ExtractJsonStringField(request_json, "dstPath");
    int max_tokens = ExtractJsonIntField(request_json, "maxTokens", 0);
    if (max_tokens <= 0) {
      max_tokens = ExtractJsonIntField(request_json, "max_tokens", 0);
    }

    bool ok = true;
    std::string message;
    std::string output;
    std::string op_err;

    if (action == "status") {
      runtime_.Refresh(&op_err);
    } else if (action == "verifyModel") {
      if (!runtime_.VerifyModel(&op_err)) {
        ok = false;
        message = op_err;
      }
    } else if (action == "importModel") {
      const auto chosen = import_path;
      if (chosen.empty()) {
        ok = false;
        message = "Model import cancelled.";
      } else if (!runtime_.ImportModelFromPath(chosen, &op_err)) {
        ok = false;
        message = op_err;
      } else {
        message = "Model imported successfully.";
      }
    } else if (action == "infer") {
      if (prompt.empty()) {
        ok = false;
        message = "Prompt is empty.";
      } else {
        output = runtime_.Generate(prompt, &op_err, max_tokens, grammar);
        if (!op_err.empty()) {
          ok = false;
          message = op_err;
        }
      }
    } else if (action == "dictateOffline") {
      ok = false;
      message =
          "Offline dictation is not implemented on Windows in this build yet.";
    } else if (action == "dictationStart") {
      ok = false;
      message =
          "Offline dictation is not implemented on Windows in this build yet.";
    } else if (action == "dictationFinalize") {
      ok = false;
      message =
          "Offline dictation is not implemented on Windows in this build yet.";
    } else if (action == "dictationCancel") {
      ok = false;
      message =
          "Offline dictation is not implemented on Windows in this build yet.";
    } else if (action == "dictationLevel") {
      output = "0";
    } else if (action == "workspaceList") {
      if (!BuildWorkspaceListOutput(runtime_, workspace_path, &output,
                                    &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to list workspace." : op_err;
      }
    } else if (action == "workspaceMkdir") {
      if (!WorkspaceMakeDirectory(runtime_, workspace_path, &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to create folder." : op_err;
      } else {
        message = "Folder created.";
      }
    } else if (action == "workspaceWriteFile") {
      if (!WorkspaceWriteFile(runtime_, workspace_path, workspace_content,
                              &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to write file." : op_err;
      } else {
        message = "File saved.";
      }
    } else if (action == "appendDebugLog") {
      const std::string channel =
          ExtractJsonStringField(request_json, "channel");
      const std::string entry_json =
          ExtractJsonStringField(request_json, "entry");
      if (!runtime_.AppendDebugLog(channel, entry_json, &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to append debug log." : op_err;
      } else {
        message = "Debug log appended.";
      }
    } else if (action == "workspaceReadFile") {
      if (!WorkspaceReadFile(runtime_, workspace_path, &output, &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to read file." : op_err;
      }
    } else if (action == "workspaceMove") {
      if (!WorkspaceMoveEntry(runtime_, workspace_src_path, workspace_dst_path,
                              &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to move item." : op_err;
      } else {
        message = "Moved.";
      }
    } else if (action == "workspaceTrash") {
      if (!WorkspaceTrashEntry(runtime_, workspace_path, &op_err)) {
        ok = false;
        message =
            op_err.empty() ? "Failed to move item to Recycle Bin." : op_err;
      } else {
        message = "Moved to Recycle Bin.";
      }
    } else if (action == "workspaceReveal") {
      if (!WorkspaceRevealEntry(runtime_, workspace_path, &op_err)) {
        ok = false;
        message =
            op_err.empty() ? "Failed to open workspace in Explorer." : op_err;
      } else {
        message = "Workspace opened in Explorer.";
      }
    } else if (action == "workspaceOpenRoot") {
      if (workspace_root_path.empty()) {
        ok = false;
        message = "Folder selection cancelled.";
      } else if (!SetWorkspaceRootOverride(workspace_root_path, &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to open selected folder." : op_err;
      } else {
        message = "Project folder opened.";
      }
    } else if (action == "workspaceRestoreRoot") {
      const std::string root_path_str =
          ExtractJsonStringField(request_json, "rootPath");
      if (root_path_str.empty()) {
        ok = false;
        message = "No root path provided.";
      } else if (!SetWorkspaceRootOverride(std::filesystem::path(root_path_str),
                                           &op_err)) {
        ok = false;
        message = op_err.empty() ? "Failed to restore project folder." : op_err;
      } else {
        message = "Project folder restored.";
      }
    } else if (action == "workspaceNewProject") {
      // Create a new project folder in the Downloads directory and set as root.
      std::string requested_name = ExtractJsonStringField(request_json, "name");
      wchar_t *downloads_path = nullptr;
      HRESULT shr =
          SHGetKnownFolderPath(FOLDERID_Downloads, 0, nullptr, &downloads_path);
      if (FAILED(shr) || !downloads_path) {
        ok = false;
        message = "Could not locate Downloads folder.";
        if (downloads_path)
          CoTaskMemFree(downloads_path);
      } else {
        std::filesystem::path dl_dir =
            std::filesystem::path(downloads_path) / "AI.EXE Projects";
        CoTaskMemFree(downloads_path);
        std::error_code mk_ec;
        std::filesystem::create_directories(dl_dir, mk_ec);
        // Build a unique folder name with date.
        auto now = std::chrono::system_clock::now();
        auto tt = std::chrono::system_clock::to_time_t(now);
        struct tm tm_buf;
        localtime_s(&tm_buf, &tt);
        char datebuf[32];
        strftime(datebuf, sizeof(datebuf), "%Y-%m-%d", &tm_buf);
        auto sanitize_name = [](std::string value) {
          std::string out;
          out.reserve(value.size());
          bool last_was_sep = false;
          for (char ch : value) {
            const unsigned char uch = static_cast<unsigned char>(ch);
            if (std::isalnum(uch)) {
              out.push_back(ch);
              last_was_sep = false;
            } else if (ch == ' ' || ch == '-' || ch == '_') {
              if (!out.empty() && !last_was_sep) {
                out.push_back(' ');
                last_was_sep = true;
              }
            }
          }
          while (!out.empty() && out.back() == ' ') out.pop_back();
          while (!out.empty() && out.front() == ' ') out.erase(out.begin());
          if (out.size() > 48) out.resize(48);
          while (!out.empty() && out.back() == ' ') out.pop_back();
          return out;
        };
        const std::string clean_name = sanitize_name(requested_name);
        std::string base_name = clean_name.empty()
            ? std::string("New Project ") + datebuf
            : clean_name;
        std::filesystem::path folder_path = dl_dir / base_name;
        int counter = 1;
        while (std::filesystem::exists(folder_path)) {
          folder_path =
              dl_dir / (base_name + " (" + std::to_string(counter++) + ")");
        }
        std::error_code ec;
        if (!std::filesystem::create_directories(folder_path, ec)) {
          ok = false;
          message = "Failed to create project folder.";
        } else if (!SetWorkspaceRootOverride(folder_path, &op_err)) {
          ok = false;
          message =
              op_err.empty() ? "Created folder but failed to open it." : op_err;
        } else {
          message = "New project created.";
        }
      }
    } else if (action == "workspaceCloseRoot") {
      ClearWorkspaceRootOverride();
      message = "Project closed.";
    } else if (action == "applyUpdate") {
      const std::string url = ExtractJsonStringField(request_json, "url");
      if (url.empty()) {
        ok = false;
        message = "No update URL provided.";
      } else if (!LaunchUpdater(url, &op_err)) {
        ok = false;
        message = op_err.empty() ? "Could not start the updater." : op_err;
      } else {
        message = "Updating — the app will close and reopen on the new version.";
        // Quit so the updater can replace the app files, then it relaunches us.
        PostMessageW(hwnd_, WM_CLOSE, 0, 0);
      }
    } else {
      ok = false;
      message = "Unsupported action.";
    }

    if (!runtime_init_error_.empty() && message.empty()) {
      message = runtime_init_error_;
    }

    WebRuntimeStatus status = runtime_.GetStatus();
    // Report the OPEN workspace (override or empty), not the fixed app dir, so a
    // closed project stays closed instead of being re-opened by the next poll.
    status.root_path = WorkspaceRootOrEmpty().string();
    return BuildResponse(id, action, ok, message, output, status);
  }

  std::string HandleUiRequest(const std::string &request_json) {
    return HandleUiRequestWithImportPath(request_json, std::filesystem::path(),
                                         std::filesystem::path());
  }

  void HandleUiStreamRequest(const std::string &request_json) {
    const std::string id = ExtractJsonStringField(request_json, "id");
    const std::string prompt = ExtractJsonStringField(request_json, "prompt");
    const std::string grammar = ExtractJsonStringField(request_json, "grammar");
    int max_tokens = ExtractJsonIntField(request_json, "maxTokens", 0);
    if (max_tokens <= 0) {
      max_tokens = ExtractJsonIntField(request_json, "max_tokens", 0);
    }
    const WebRuntimeStatus stream_status = runtime_.GetStatus();

    std::string output;
    std::string op_err;
    const bool ok = runtime_.GenerateStream(
        prompt,
        [this, id, stream_status](const std::string &delta) {
          if (delta.empty()) {
            return;
          }
          PostWebResponseAsync(BuildStreamEvent(id, false, delta, true,
                                                std::string(), std::string(),
                                                stream_status));
        },
        &output, &op_err, max_tokens, grammar);

    std::string message = op_err;
    if (!runtime_init_error_.empty() && message.empty()) {
      message = runtime_init_error_;
    }

    const WebRuntimeStatus done_status = runtime_.GetStatus();
    PostWebResponseAsync(BuildStreamEvent(id, true, std::string(), ok, message,
                                          output, done_status));
  }

  void PostWebResponseAsync(const std::string &response_json) {
    auto *msg = new std::wstring(Utf8ToWide(response_json));
    PostMessageW(hwnd_, kMsgPostWebResponse, 0, reinterpret_cast<LPARAM>(msg));
  }

#if AI_EXE_HAVE_WEBVIEW2_HEADER
  void PostInitError(const std::wstring &text) {
    auto *msg = new std::wstring(text);
    PostMessageW(hwnd_, kMsgShowError, 0, reinterpret_cast<LPARAM>(msg));
  }

  void InitializeWebView() {
    auto create_env = LoadCreateEnvironmentFn();
    if (!create_env) {
      ShowFallback(L"WebView2Loader.dll was not found.\r\n"
                   L"Place it next to AI_GUI.exe or install WebView2 runtime.");
      return;
    }

    using Microsoft::WRL::Callback;

    // Persisted outside the app folder so chats/keys/settings survive updates.
    static std::wstring user_data_dir = WebView2UserDataDir().wstring();
    const HRESULT hr = create_env(
        nullptr, user_data_dir.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment *env) -> HRESULT {
              if (FAILED(result) || !env) {
                PostInitError(L"Failed to create WebView2 environment: " +
                              HResultText(result));
                return S_OK;
              }

              return env->CreateCoreWebView2Controller(
                  hwnd_,
                  Callback<
                      ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                      [this](HRESULT result2,
                             ICoreWebView2Controller *controller) -> HRESULT {
                        if (FAILED(result2) || !controller) {
                          PostInitError(
                              L"Failed to create WebView2 controller: " +
                              HResultText(result2));
                          return S_OK;
                        }

                        controller_ = controller;
                        const HRESULT hr_get =
                            controller_->get_CoreWebView2(&webview_);
                        if (FAILED(hr_get) || !webview_) {
                          PostInitError(
                              L"Failed to acquire CoreWebView2 handle: " +
                              HResultText(hr_get));
                          return S_OK;
                        }
#ifdef __ICoreWebView2Settings9_INTERFACE_DEFINED__
                        {
                          Microsoft::WRL::ComPtr<ICoreWebView2Settings>
                              settings;
                          if (SUCCEEDED(webview_->get_Settings(&settings)) &&
                              settings) {
                            Microsoft::WRL::ComPtr<ICoreWebView2Settings9>
                                settings9;
                            if (SUCCEEDED(settings.As(&settings9)) &&
                                settings9) {
                              settings9->put_IsNonClientRegionSupportEnabled(
                                  TRUE);
                            }
                          }
                        }
#endif

                        RECT bounds{};
                        GetClientRect(hwnd_, &bounds);
                        controller_->put_Bounds(bounds);

                        EventRegistrationToken token{};
                        webview_->add_WebMessageReceived(
                            Callback<
                                ICoreWebView2WebMessageReceivedEventHandler>(
                                [this](ICoreWebView2 *,
                                       ICoreWebView2WebMessageReceivedEventArgs
                                           *args) -> HRESULT {
                                  LPWSTR payload_w = nullptr;
                                  std::string payload;
                                  if (SUCCEEDED(args->TryGetWebMessageAsString(
                                          &payload_w)) &&
                                      payload_w) {
                                    payload = WideToUtf8(payload_w);
                                    CoTaskMemFree(payload_w);
                                  }

                                  const std::string action =
                                      ExtractJsonStringField(payload, "action");
                                  if (action == "importModel") {
                                    const auto chosen = PromptModelImportPath();
                                    std::thread([this, payload, chosen]() {
                                      const std::string response =
                                          HandleUiRequestWithImportPath(
                                              payload, chosen,
                                              std::filesystem::path());
                                      PostWebResponseAsync(response);
                                    }).detach();
                                    return S_OK;
                                  }

                                  if (action == "workspaceOpenRoot") {
                                    const auto chosen =
                                        PromptWorkspaceFolderPath();
                                    std::thread([this, payload, chosen]() {
                                      const std::string response =
                                          HandleUiRequestWithImportPath(
                                              payload, std::filesystem::path(),
                                              chosen);
                                      PostWebResponseAsync(response);
                                    }).detach();
                                    return S_OK;
                                  }

                                  if (action == "inferStream") {
                                    std::thread([this, payload]() {
                                      HandleUiStreamRequest(payload);
                                    }).detach();
                                    return S_OK;
                                  }

                                  std::thread([this, payload]() {
                                    const std::string response =
                                        HandleUiRequest(payload);
                                    PostWebResponseAsync(response);
                                  }).detach();
                                  return S_OK;
                                })
                                .Get(),
                            &token);

                        const std::wstring url = ToFileUrl(ui_html_);
                        webview_->Navigate(url.c_str());
                        return S_OK;
                      })
                      .Get());
            })
            .Get());

    if (FAILED(hr)) {
      ShowFallback(L"WebView2 initialization call failed: " + HResultText(hr));
    }
  }
#endif

  HWND hwnd_ = nullptr;
  HWND fallback_ = nullptr;
  std::filesystem::path ui_html_;
  WebRuntimeBridge runtime_;
  std::string runtime_init_error_;

#if AI_EXE_HAVE_WEBVIEW2_HEADER
  Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
  Microsoft::WRL::ComPtr<ICoreWebView2> webview_;
#endif
};

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  const HRESULT com_hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool com_initialized =
      SUCCEEDED(com_hr) || com_hr == RPC_E_CHANGED_MODE;

  AppWindow app;
  if (!app.Create(instance)) {
    MessageBoxW(nullptr, L"Failed to create AI.EXE GUI window.", L"AI.EXE",
                MB_OK | MB_ICONERROR);
    if (com_initialized) {
      CoUninitialize();
    }
    return 1;
  }

  const int code = app.Run();
  if (com_initialized) {
    CoUninitialize();
  }
  return code;
}

#endif
