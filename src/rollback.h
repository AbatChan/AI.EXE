#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

class RollbackManager {
 public:
  explicit RollbackManager(std::filesystem::path snapshot_dir);

  bool EnsureDirectory(std::string* err) const;
  std::optional<std::filesystem::path> CreateSnapshot(const std::filesystem::path& target, std::string* err) const;
  bool RestoreSnapshot(const std::filesystem::path& snapshot_file, const std::filesystem::path& target, std::string* err) const;
  std::vector<std::filesystem::path> ListSnapshots() const;

 private:
  std::filesystem::path snapshot_dir_;
  static std::string TimestampCompactUtc();
};
