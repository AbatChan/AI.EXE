#include "local_app_server.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
static const socket_t kInvalidSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
static const socket_t kInvalidSocket = -1;
#endif

namespace {

void CloseSocket(socket_t s) {
#ifdef _WIN32
  closesocket(s);
#else
  close(s);
#endif
}

void EnsureSocketsReady() {
#ifdef _WIN32
  static std::once_flag once;
  std::call_once(once, [] {
    WSADATA data;
    WSAStartup(MAKEWORD(2, 2), &data);
  });
#endif
}

void SetRecvTimeout(socket_t s, int seconds) {
#ifdef _WIN32
  DWORD ms = static_cast<DWORD>(seconds) * 1000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&ms),
             sizeof(ms));
#else
  struct timeval tv;
  tv.tv_sec = seconds;
  tv.tv_usec = 0;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
}

std::string MimeTypeForPath(const std::filesystem::path& p) {
  std::string ext = p.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(),
                 [](unsigned char c) { return static_cast<char>(::tolower(c)); });
  static const std::map<std::string, std::string> kTypes = {
      {".html", "text/html; charset=utf-8"},
      {".htm", "text/html; charset=utf-8"},
      {".css", "text/css; charset=utf-8"},
      {".js", "text/javascript; charset=utf-8"},
      {".mjs", "text/javascript; charset=utf-8"},
      {".json", "application/json; charset=utf-8"},
      {".map", "application/json; charset=utf-8"},
      {".svg", "image/svg+xml"},
      {".png", "image/png"},
      {".jpg", "image/jpeg"},
      {".jpeg", "image/jpeg"},
      {".gif", "image/gif"},
      {".webp", "image/webp"},
      {".ico", "image/x-icon"},
      {".bmp", "image/bmp"},
      {".txt", "text/plain; charset=utf-8"},
      {".csv", "text/csv; charset=utf-8"},
      {".xml", "application/xml; charset=utf-8"},
      {".wasm", "application/wasm"},
      {".woff", "font/woff"},
      {".woff2", "font/woff2"},
      {".ttf", "font/ttf"},
      {".otf", "font/otf"},
      {".mp3", "audio/mpeg"},
      {".wav", "audio/wav"},
      {".ogg", "audio/ogg"},
      {".mp4", "video/mp4"},
      {".webm", "video/webm"},
      {".pdf", "application/pdf"},
  };
  auto it = kTypes.find(ext);
  return it != kTypes.end() ? it->second : "application/octet-stream";
}

std::string UrlDecode(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] == '%' && i + 2 < in.size()) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      int hi = hex(in[i + 1]);
      int lo = hex(in[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    if (in[i] == '+') {
      out.push_back(' ');
    } else {
      out.push_back(in[i]);
    }
  }
  return out;
}

void SendAll(socket_t s, const char* data, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    int n = send(s, data + sent, static_cast<int>(len - sent), 0);
    if (n <= 0) return;
    sent += static_cast<size_t>(n);
  }
}

void SendSimpleStatus(socket_t s, const char* status_line, const char* body) {
  std::string b = body ? body : "";
  std::string head = std::string("HTTP/1.1 ") + status_line + "\r\n" +
                     "Content-Type: text/plain; charset=utf-8\r\n" +
                     "Content-Length: " + std::to_string(b.size()) + "\r\n" +
                     "Connection: close\r\n\r\n";
  SendAll(s, head.data(), head.size());
  SendAll(s, b.data(), b.size());
}

// Resolve a request path to a file inside `root`, rejecting traversal. Returns
// empty path on a bad/escaping request.
std::filesystem::path ResolveRequestPath(const std::filesystem::path& root,
                                         const std::string& raw_path) {
  std::string path = raw_path;
  // Strip query/fragment.
  size_t cut = path.find_first_of("?#");
  if (cut != std::string::npos) path = path.substr(0, cut);
  path = UrlDecode(path);
  if (path.empty() || path == "/") path = "/index.html";
  // Treat a trailing slash as a directory request -> its index.html.
  if (!path.empty() && path.back() == '/') path += "index.html";
  // Drop the leading slash so it appends under root.
  while (!path.empty() && path.front() == '/') path.erase(path.begin());

  std::error_code ec;
  std::filesystem::path candidate =
      (root / std::filesystem::path(path)).lexically_normal();
  std::filesystem::path root_norm = root.lexically_normal();
  // Confinement: candidate must be at or below root.
  std::string c = candidate.generic_string();
  std::string r = root_norm.generic_string();
  if (!r.empty() && r.back() == '/') r.pop_back();
  if (c != r && c.compare(0, r.size() + 1, r + "/") != 0) {
    return {};
  }
  if (std::filesystem::is_directory(candidate, ec)) {
    candidate /= "index.html";
  }
  return candidate;
}

void HandleConnection(socket_t client, std::filesystem::path root) {
  SetRecvTimeout(client, 10);
  std::string request;
  char buf[4096];
  // Read until end of headers (we only need the request line) or a small cap.
  while (request.find("\r\n\r\n") == std::string::npos &&
         request.size() < 16384) {
    int n = recv(client, buf, sizeof(buf), 0);
    if (n <= 0) break;
    request.append(buf, static_cast<size_t>(n));
  }
  if (request.empty()) {
    CloseSocket(client);
    return;
  }

  // Parse "METHOD PATH HTTP/x".
  size_t sp1 = request.find(' ');
  size_t line_end = request.find("\r\n");
  if (sp1 == std::string::npos || line_end == std::string::npos) {
    SendSimpleStatus(client, "400 Bad Request", "Bad request");
    CloseSocket(client);
    return;
  }
  std::string method = request.substr(0, sp1);
  size_t sp2 = request.find(' ', sp1 + 1);
  if (sp2 == std::string::npos || sp2 > line_end) {
    SendSimpleStatus(client, "400 Bad Request", "Bad request");
    CloseSocket(client);
    return;
  }
  std::string raw_path = request.substr(sp1 + 1, sp2 - sp1 - 1);
  const bool is_head = (method == "HEAD");
  if (method != "GET" && !is_head) {
    SendSimpleStatus(client, "405 Method Not Allowed", "Method not allowed");
    CloseSocket(client);
    return;
  }

  std::filesystem::path file = ResolveRequestPath(root, raw_path);
  std::error_code ec;
  if (file.empty() || !std::filesystem::is_regular_file(file, ec)) {
    SendSimpleStatus(client, "404 Not Found", "Not found");
    CloseSocket(client);
    return;
  }

  std::vector<char> body;
  {
    std::uintmax_t size = std::filesystem::file_size(file, ec);
    FILE* f = nullptr;
#ifdef _WIN32
    _wfopen_s(&f, file.wstring().c_str(), L"rb");
#else
    f = std::fopen(file.string().c_str(), "rb");
#endif
    if (!f) {
      SendSimpleStatus(client, "500 Internal Server Error", "Read error");
      CloseSocket(client);
      return;
    }
    body.resize(static_cast<size_t>(size));
    size_t got = body.empty() ? 0 : std::fread(body.data(), 1, body.size(), f);
    std::fclose(f);
    body.resize(got);
  }

  std::string head =
      std::string("HTTP/1.1 200 OK\r\n") + "Content-Type: " +
      MimeTypeForPath(file) + "\r\n" + "Content-Length: " +
      std::to_string(body.size()) + "\r\n" +
      "Cache-Control: no-store\r\n" + "Connection: close\r\n\r\n";
  SendAll(client, head.data(), head.size());
  if (!is_head && !body.empty()) {
    SendAll(client, body.data(), body.size());
  }
  CloseSocket(client);
}

struct ServerRegistry {
  std::mutex mu;
  std::map<std::string, int> port_by_root;  // canonical root -> port
};

ServerRegistry& Registry() {
  static ServerRegistry reg;
  return reg;
}

// Binds a loopback listener on an ephemeral port and runs the accept loop on a
// detached thread. Returns the chosen port, or -1 on failure.
int StartListener(const std::filesystem::path& root, std::string* err) {
  EnsureSocketsReady();
  socket_t listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener == kInvalidSocket) {
    if (err) *err = "Could not create a local server socket.";
    return -1;
  }
  int yes = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR,
             reinterpret_cast<const char*>(&yes), sizeof(yes));

  sockaddr_in addr;
  std::memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;  // ephemeral
  if (bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    CloseSocket(listener);
    if (err) *err = "Could not bind a local server port.";
    return -1;
  }
  if (listen(listener, 16) != 0) {
    CloseSocket(listener);
    if (err) *err = "Could not start listening for the local server.";
    return -1;
  }
  sockaddr_in bound;
  socklen_t blen = sizeof(bound);
  if (getsockname(listener, reinterpret_cast<sockaddr*>(&bound), &blen) != 0) {
    CloseSocket(listener);
    if (err) *err = "Could not read the local server port.";
    return -1;
  }
  int port = ntohs(bound.sin_port);

  std::thread([listener, root]() {
    for (;;) {
      socket_t client = accept(listener, nullptr, nullptr);
      if (client == kInvalidSocket) continue;
      std::thread(HandleConnection, client, root).detach();
    }
  }).detach();

  return port;
}

}  // namespace

std::string StartLocalAppServer(const std::filesystem::path& root,
                                std::string* err) {
  std::error_code ec;
  std::filesystem::path canonical = std::filesystem::weakly_canonical(root, ec);
  if (ec || canonical.empty()) canonical = root;
  if (!std::filesystem::is_directory(canonical, ec)) {
    if (err) *err = "No project folder is open to run.";
    return {};
  }
  const std::string key = canonical.generic_string();

  auto& reg = Registry();
  std::lock_guard<std::mutex> lock(reg.mu);
  auto it = reg.port_by_root.find(key);
  int port = (it != reg.port_by_root.end()) ? it->second : -1;
  if (port <= 0) {
    port = StartListener(canonical, err);
    if (port <= 0) return {};
    reg.port_by_root[key] = port;
  }
  return "http://127.0.0.1:" + std::to_string(port) + "/";
}
