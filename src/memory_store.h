#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>

class MemoryStore {
 public:
  explicit MemoryStore(std::filesystem::path path);

  bool Load(std::string* err);
  bool Save(std::string* err) const;

  void Set(const std::string& key, const std::string& value);
  std::optional<std::string> Get(const std::string& key) const;
  const std::unordered_map<std::string, std::string>& All() const;

 private:
  std::filesystem::path path_;
  std::unordered_map<std::string, std::string> kv_;

  static std::string Escape(const std::string& text);
  static std::string Unescape(const std::string& text);
};
