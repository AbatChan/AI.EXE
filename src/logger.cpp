#include "logger.h"

#include <chrono>
#include <fstream>
#include <iomanip>
#include <sstream>

Logger::Logger(std::filesystem::path log_file) : log_file_(std::move(log_file)) {}

bool Logger::Initialize() {
  std::error_code ec;
  std::filesystem::create_directories(log_file_.parent_path(), ec);
  if (ec) {
    return false;
  }

  std::ofstream out(log_file_, std::ios::app);
  return out.good();
}

void Logger::Info(const std::string& event, const std::string& message) {
  Write("INFO", event, message);
}

void Logger::Error(const std::string& event, const std::string& message) {
  Write("ERROR", event, message);
}

void Logger::Write(const std::string& level, const std::string& event, const std::string& message) {
  std::lock_guard<std::mutex> lock(mu_);
  std::ofstream out(log_file_, std::ios::app);
  if (!out.good()) {
    return;
  }

  out << "{"
      << "\"ts\":\"" << TimestampIsoUtc() << "\","
      << "\"level\":\"" << EscapeJson(level) << "\","
      << "\"event\":\"" << EscapeJson(event) << "\","
      << "\"message\":\"" << EscapeJson(message) << "\""
      << "}" << '\n';
}

std::string Logger::EscapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size());

  for (char c : value) {
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

std::string Logger::TimestampIsoUtc() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t tt = std::chrono::system_clock::to_time_t(now);

  std::tm tm{};
#ifdef _WIN32
  gmtime_s(&tm, &tt);
#else
  gmtime_r(&tt, &tm);
#endif

  std::ostringstream oss;
  oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
  return oss.str();
}
