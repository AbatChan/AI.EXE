#include "memory_store.h"

#include <fstream>

MemoryStore::MemoryStore(std::filesystem::path path) : path_(std::move(path)) {}

bool MemoryStore::Load(std::string* err) {
  kv_.clear();

  std::error_code ec;
  std::filesystem::create_directories(path_.parent_path(), ec);
  if (ec) {
    *err = "Failed to create memory directory.";
    return false;
  }

  if (!std::filesystem::exists(path_)) {
    return true;
  }

  std::ifstream in(path_);
  if (!in.good()) {
    *err = "Failed to open memory file.";
    return false;
  }

  std::string line;
  while (std::getline(in, line)) {
    const auto pos = line.find('=');
    if (pos == std::string::npos) {
      continue;
    }

    const std::string key = Unescape(line.substr(0, pos));
    const std::string value = Unescape(line.substr(pos + 1));
    kv_[key] = value;
  }

  return true;
}

bool MemoryStore::Save(std::string* err) const {
  std::error_code ec;
  std::filesystem::create_directories(path_.parent_path(), ec);
  if (ec) {
    *err = "Failed to ensure memory directory.";
    return false;
  }

  const auto temp = path_.string() + ".tmp";
  {
    std::ofstream out(temp, std::ios::trunc);
    if (!out.good()) {
      *err = "Failed to write temporary memory file.";
      return false;
    }

    for (const auto& [k, v] : kv_) {
      out << Escape(k) << '=' << Escape(v) << '\n';
    }
  }

  std::filesystem::rename(temp, path_, ec);
  if (ec) {
    std::filesystem::remove(path_, ec);
    ec.clear();
    std::filesystem::rename(temp, path_, ec);
    if (ec) {
      *err = "Failed to replace memory file.";
      return false;
    }
  }

  return true;
}

void MemoryStore::Set(const std::string& key, const std::string& value) {
  kv_[key] = value;
}

std::optional<std::string> MemoryStore::Get(const std::string& key) const {
  const auto it = kv_.find(key);
  if (it == kv_.end()) {
    return std::nullopt;
  }
  return it->second;
}

const std::unordered_map<std::string, std::string>& MemoryStore::All() const {
  return kv_;
}

std::string MemoryStore::Escape(const std::string& text) {
  std::string out;
  out.reserve(text.size());

  for (char c : text) {
    if (c == '\\' || c == '=' || c == '\n' || c == '\r') {
      out.push_back('\\');
    }

    if (c == '\n') {
      out.push_back('n');
    } else if (c == '\r') {
      out.push_back('r');
    } else {
      out.push_back(c);
    }
  }

  return out;
}

std::string MemoryStore::Unescape(const std::string& text) {
  std::string out;
  out.reserve(text.size());

  bool escaped = false;
  for (char c : text) {
    if (!escaped) {
      if (c == '\\') {
        escaped = true;
      } else {
        out.push_back(c);
      }
      continue;
    }

    if (c == 'n') {
      out.push_back('\n');
    } else if (c == 'r') {
      out.push_back('\r');
    } else {
      out.push_back(c);
    }
    escaped = false;
  }

  if (escaped) {
    out.push_back('\\');
  }

  return out;
}
