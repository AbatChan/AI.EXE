#pragma once

#include <filesystem>
#include <mutex>
#include <string>

class Logger {
 public:
  explicit Logger(std::filesystem::path log_file);

  bool Initialize();
  void Info(const std::string& event, const std::string& message);
  void Error(const std::string& event, const std::string& message);

 private:
  std::filesystem::path log_file_;
  std::mutex mu_;

  void Write(const std::string& level, const std::string& event, const std::string& message);
  static std::string EscapeJson(const std::string& value);
  static std::string TimestampIsoUtc();
};
