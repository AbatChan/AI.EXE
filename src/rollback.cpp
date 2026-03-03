#include "rollback.h"

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <sstream>

RollbackManager::RollbackManager(std::filesystem::path snapshot_dir)
    : snapshot_dir_(std::move(snapshot_dir)) {}

bool RollbackManager::EnsureDirectory(std::string* err) const {
  std::error_code ec;
  std::filesystem::create_directories(snapshot_dir_, ec);
  if (ec) {
    *err = "Failed to create snapshot directory.";
    return false;
  }
  return true;
}

std::optional<std::filesystem::path> RollbackManager::CreateSnapshot(
    const std::filesystem::path& target,
    std::string* err) const {
  if (!std::filesystem::exists(target)) {
    *err = "Target for snapshot does not exist.";
    return std::nullopt;
  }

  if (!EnsureDirectory(err)) {
    return std::nullopt;
  }

  const auto filename = target.filename().string() + "." + TimestampCompactUtc() + ".bak";
  const auto snapshot_path = snapshot_dir_ / filename;

  std::error_code ec;
  std::filesystem::copy_file(target, snapshot_path, std::filesystem::copy_options::overwrite_existing, ec);
  if (ec) {
    *err = "Failed to create snapshot copy.";
    return std::nullopt;
  }

  return snapshot_path;
}

bool RollbackManager::RestoreSnapshot(
    const std::filesystem::path& snapshot_file,
    const std::filesystem::path& target,
    std::string* err) const {
  if (!std::filesystem::exists(snapshot_file)) {
    *err = "Snapshot file not found.";
    return false;
  }

  std::error_code ec;
  std::filesystem::copy_file(snapshot_file, target, std::filesystem::copy_options::overwrite_existing, ec);
  if (ec) {
    *err = "Restore copy failed.";
    return false;
  }

  return true;
}

std::vector<std::filesystem::path> RollbackManager::ListSnapshots() const {
  std::vector<std::filesystem::path> out;
  std::error_code ec;

  if (!std::filesystem::exists(snapshot_dir_, ec)) {
    return out;
  }

  for (const auto& entry : std::filesystem::directory_iterator(snapshot_dir_, ec)) {
    if (ec) {
      break;
    }

    if (entry.is_regular_file()) {
      out.push_back(entry.path());
    }
  }

  std::sort(out.begin(), out.end());
  return out;
}

std::string RollbackManager::TimestampCompactUtc() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t tt = std::chrono::system_clock::to_time_t(now);

  std::tm tm{};
#ifdef _WIN32
  gmtime_s(&tm, &tt);
#else
  gmtime_r(&tt, &tm);
#endif

  std::ostringstream oss;
  oss << std::put_time(&tm, "%Y%m%dT%H%M%SZ");
  return oss.str();
}
