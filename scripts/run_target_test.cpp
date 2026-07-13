#include <cassert>
#include <filesystem>
#include <fstream>
#include <string>

#include "../src/run_target.h"

namespace fs = std::filesystem;

static void Write(const fs::path& path, const std::string& body) {
  std::ofstream out(path);
  out << body;
}

int main() {
  const fs::path base = fs::temp_directory_path() / "aiexe-run-target-test";
  std::error_code ec;
  fs::remove_all(base, ec);
  fs::create_directories(base, ec);

  Write(base / "index.html", "<!doctype html>");
  Write(base / "main.py", "print('desktop')\n");
  auto target = DetectRunTarget(base);
  assert(target.kind == RunTargetKind::kPython);
  assert(target.entry.filename() == "main.py");

  fs::remove(base / "main.py", ec);
  target = DetectRunTarget(base);
  assert(target.kind == RunTargetKind::kWeb);

  Write(base / "package.json", "{\"devDependencies\":{\"vite\":\"latest\"}}");
  target = DetectRunTarget(base);
  assert(target.kind == RunTargetKind::kViteWeb);

  fs::remove(base / "index.html", ec);
  Write(base / "package.json", "{\"scripts\":{\"dev\":\"next dev\"},\"dependencies\":{\"next\":\"15.0.0\"}}");
  Write(base / "next.config.ts", "export default {};");
  fs::create_directories(base / "src" / "app", ec);
  Write(base / "src" / "app" / "page.tsx", "export default function Page(){return null;}");
  target = DetectRunTarget(base);
  assert(target.kind == RunTargetKind::kNextWeb);
  assert(target.entry.filename() == "package.json");

  // A stale Next config must not override an explicitly Vite package.
  Write(base / "package.json", "{\"scripts\":{\"dev\":\"vite\"},\"devDependencies\":{\"vite\":\"latest\"}}");
  Write(base / "index.html", "<!doctype html>");
  target = DetectRunTarget(base);
  assert(target.kind == RunTargetKind::kViteWeb);

  fs::remove_all(base, ec);
  return 0;
}
