#pragma once

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <string>

// Decide what "Run" should do for an open project. Web projects are served over
// localhost; Python projects are launched with the user's installed interpreter.
// Detection is shallow (project root only) — matches how the agent lays out the
// generated projects this targets.

enum class RunTargetKind { kNone, kWeb, kPython };

struct RunTarget {
  RunTargetKind kind = RunTargetKind::kNone;
  // For web: the HTML entry (so the URL can point at it). For Python: the .py
  // entry to run. Always an absolute path inside the project root.
  std::filesystem::path entry;
};

inline RunTarget DetectRunTarget(const std::filesystem::path& root) {
  namespace fs = std::filesystem;
  std::error_code ec;
  RunTarget target;
  if (!fs::is_directory(root, ec)) return target;

  auto lower_ext = [](const fs::path& p) {
    std::string ext = p.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    return ext;
  };
  auto lower_name = [](const fs::path& p) {
    std::string name = p.filename().string();
    std::transform(name.begin(), name.end(), name.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    return name;
  };

  // Web wins when there is an HTML entry — that is the case the localhost server
  // handles and the one generated web apps use.
  if (fs::exists(root / "index.html", ec)) {
    target.kind = RunTargetKind::kWeb;
    target.entry = root / "index.html";
    return target;
  }

  fs::path first_html;
  fs::path main_py, app_py, entry_py;  // entry_py = __main__.py
  fs::path newest_py;                  // fallback: most-recently-modified .py
  fs::file_time_type newest_time{};
  bool have_newest = false;
  for (const auto& e : fs::directory_iterator(root, ec)) {
    if (!e.is_regular_file(ec)) continue;
    const std::string ext = lower_ext(e.path());
    if ((ext == ".html" || ext == ".htm") && first_html.empty()) {
      first_html = e.path();
    } else if (ext == ".py") {
      const std::string name = lower_name(e.path());
      if (name == "main.py") main_py = e.path();
      else if (name == "app.py") app_py = e.path();
      else if (name == "__main__.py") entry_py = e.path();
      std::error_code te;
      const auto t = fs::last_write_time(e.path(), te);
      if (!te && (!have_newest || t > newest_time)) {
        newest_time = t;
        newest_py = e.path();
        have_newest = true;
      }
    }
  }

  if (!first_html.empty()) {
    target.kind = RunTargetKind::kWeb;
    target.entry = first_html;
    return target;
  }
  if (have_newest) {
    // Conventional entry points win; otherwise run whatever was edited most
    // recently — i.e. the script the user just built/worked on.
    target.kind = RunTargetKind::kPython;
    target.entry = !main_py.empty() ? main_py
                   : !app_py.empty() ? app_py
                   : !entry_py.empty() ? entry_py
                                       : newest_py;
    return target;
  }
  return target;
}
