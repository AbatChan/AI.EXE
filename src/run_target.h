#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

// Decide what "Run" should do for an open project. Web projects are served over
// localhost; Python projects are launched with the user's installed interpreter.
// Detection is shallow (project root only) — matches how the agent lays out the
// generated projects this targets.

enum class RunTargetKind { kNone, kWeb, kViteWeb, kNextWeb, kPython };

struct RunTarget {
  RunTargetKind kind = RunTargetKind::kNone;
  // For web: the HTML entry (so the URL can point at it). For Python: the .py
  // entry to run. Always an absolute path inside the project root.
  std::filesystem::path entry;
};

inline int StableVitePortForRoot(const std::filesystem::path& root) {
  std::string key = root.lexically_normal().generic_string();
  std::uint32_t h = 2166136261u;
  for (unsigned char c : key) {
    h ^= c;
    h *= 16777619u;
  }
  return 5173 + static_cast<int>(h % 1000u);
}

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
  auto file_contains_ci = [](const fs::path& p, const std::string& needle) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return false;
    std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    std::transform(body.begin(), body.end(), body.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    std::string n = needle;
    std::transform(n.begin(), n.end(), n.begin(),
                   [](unsigned char c) { return static_cast<char>(::tolower(c)); });
    return body.find(n) != std::string::npos;
  };

  // Next.js has no root index.html: App Router projects start from app/page.tsx
  // (usually src/app/page.tsx). Detect the package/config before looking for
  // standalone HTML or Python entry points.
  if (fs::exists(root / "package.json", ec)) {
    const bool package_has_next = file_contains_ci(root / "package.json", "\"next\"")
      || file_contains_ci(root / "package.json", "next dev");
    const bool package_has_vite = file_contains_ci(root / "package.json", "\"vite\"")
      || file_contains_ci(root / "package.json", "vite --");
    const bool has_next_config = fs::exists(root / "next.config.ts", ec)
      || fs::exists(root / "next.config.js", ec)
      || fs::exists(root / "next.config.mjs", ec);
    // The package manifest is authoritative when a stale/misnamed Next config
    // sits beside an explicitly Vite project.
    const bool next_project = package_has_next || (has_next_config && !package_has_vite);
    if (next_project) {
      target.kind = RunTargetKind::kNextWeb;
      target.entry = root / "package.json";
      return target;
    }
  }

  // A Vite manifest is unambiguous and wins immediately. Plain index.html is
  // not: a generator may leave one beside a Python desktop entry point, so defer
  // plain HTML until Python has been considered.
  if (fs::exists(root / "index.html", ec)) {
    const bool vite_project = fs::exists(root / "package.json", ec)
      && (fs::exists(root / "vite.config.ts", ec)
        || fs::exists(root / "vite.config.js", ec)
        || file_contains_ci(root / "package.json", "\"vite\""));
    if (vite_project) {
      target.kind = RunTargetKind::kViteWeb;
      target.entry = root / "index.html";
      return target;
    }
  }

  fs::path first_html;
  fs::path main_py, app_py, entry_py;  // entry_py = __main__.py
  fs::path newest_py;                  // absolute fallback when every script is tooling
  fs::path newest_app_py;              // newest script that is not build/test/setup tooling
  fs::file_time_type newest_time{}, newest_app_time{};
  bool have_newest = false, have_newest_app = false;
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
      const bool tooling = name == "setup.py" || name == "build.py"
        || name.rfind("build_", 0) == 0 || name.rfind("build-", 0) == 0
        || name.rfind("test_", 0) == 0 || name.rfind("test-", 0) == 0
        || name.rfind("install_", 0) == 0 || name.rfind("package_", 0) == 0
        || name.rfind("helper", 0) == 0 || name.rfind("util", 0) == 0;
      if (!tooling && !te && (!have_newest_app || t > newest_app_time)) {
        newest_app_time = t;
        newest_app_py = e.path();
        have_newest_app = true;
      }
    }
  }

  if (have_newest) {
    // Conventional entry points win; otherwise run whatever was edited most
    // recently — i.e. the script the user just built/worked on.
    target.kind = RunTargetKind::kPython;
    target.entry = !main_py.empty() ? main_py
                   : !app_py.empty() ? app_py
                   : !entry_py.empty() ? entry_py
                   : have_newest_app ? newest_app_py
                                     : newest_py;
    return target;
  }
  if (!first_html.empty()) {
    target.kind = RunTargetKind::kWeb;
    target.entry = first_html;
    return target;
  }
  return target;
}
