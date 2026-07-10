#ifdef __APPLE__

#import <AVFoundation/AVFoundation.h>
#import <Cocoa/Cocoa.h>
#import <Speech/Speech.h>
#import <WebKit/WebKit.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <dispatch/dispatch.h>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <vector>

#include "command_runner.h"
#include "dev_server_manager.h"
#include "local_app_server.h"
#include "run_target.h"
#include "ui_constants.h"
#include "web_runtime_bridge.h"

namespace {

bool FileExists(const std::filesystem::path &p) {
  std::error_code ec;
  return std::filesystem::exists(p, ec) &&
         std::filesystem::is_regular_file(p, ec);
}

// WebKit file-URL storage can be tied to a replaced bundle path. Keep a compact
// mirror of UI state in Application Support, which survives an in-place update.
std::filesystem::path UiStateBackupPath() {
  NSArray<NSURL *> *locations = [[NSFileManager defaultManager]
      URLsForDirectory:NSApplicationSupportDirectory
             inDomains:NSUserDomainMask];
  NSURL *base_url = locations.firstObject;
  if (!base_url || !base_url.path.length) {
    return {};
  }
  return std::filesystem::path([base_url.path UTF8String]) / "AI.EXE" /
         "ui-storage-v1.json";
}

bool ReadUiStateBackup(std::string *output, std::string *err) {
  if (!output) return false;
  output->clear();
  const auto path = UiStateBackupPath();
  if (path.empty()) return true;
  std::error_code ec;
  if (!std::filesystem::exists(path, ec)) return true;
  const auto size = std::filesystem::file_size(path, ec);
  if (ec || size > 12 * 1024 * 1024) {
    if (err) *err = "Saved UI state is unavailable or too large.";
    return false;
  }
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    if (err) *err = "Could not read saved UI state.";
    return false;
  }
  output->assign(std::istreambuf_iterator<char>(input),
                 std::istreambuf_iterator<char>());
  return true;
}

bool WriteUiStateBackup(const std::string &payload, std::string *err) {
  if (payload.size() > 12 * 1024 * 1024) {
    if (err) *err = "Saved UI state is too large.";
    return false;
  }
  const auto path = UiStateBackupPath();
  if (path.empty()) {
    if (err) *err = "Application Support is unavailable.";
    return false;
  }
  std::error_code ec;
  std::filesystem::create_directories(path.parent_path(), ec);
  if (ec) {
    if (err) *err = "Could not create the AI.EXE data folder.";
    return false;
  }
  const auto temporary = path.string() + ".tmp";
  {
    std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
    if (!out) {
      if (err) *err = "Could not write saved UI state.";
      return false;
    }
    out.write(payload.data(), static_cast<std::streamsize>(payload.size()));
    if (!out) {
      if (err) *err = "Could not finish writing saved UI state.";
      return false;
    }
  }
  chmod(temporary.c_str(), S_IRUSR | S_IWUSR);
  std::filesystem::rename(temporary, path, ec);
  if (ec) {
    std::filesystem::remove(path, ec);
    ec.clear();
    std::filesystem::rename(temporary, path, ec);
  }
  if (ec) {
    if (err) *err = "Could not replace saved UI state.";
    return false;
  }
  chmod(path.c_str(), S_IRUSR | S_IWUSR);
  return true;
}

bool IsTruthyEnv(const char *value) {
  if (!value || value[0] == '\0') {
    return false;
  }

  std::string normalized(value);
  std::transform(
      normalized.begin(), normalized.end(), normalized.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return normalized == "1" || normalized == "true" || normalized == "yes" ||
         normalized == "on";
}

bool LooksLikeProjectRoot(const std::filesystem::path &p) {
  std::error_code ec_html;
  const bool has_ui =
      std::filesystem::exists(p / "ui" / "ai-exe.html", ec_html);

  std::error_code ec_cmake;
  const bool has_cmake =
      std::filesystem::exists(p / "CMakeLists.txt", ec_cmake);
  return has_ui || has_cmake;
}

std::filesystem::path FindProjectRootFrom(std::filesystem::path start) {
  if (start.empty()) {
    return {};
  }

  std::error_code ec;
  if (!std::filesystem::is_directory(start, ec)) {
    start = start.parent_path();
  }

  for (auto p = start; !p.empty(); p = p.parent_path()) {
    if (LooksLikeProjectRoot(p)) {
      return p;
    }
    if (p == p.root_path()) {
      break;
    }
  }

  return {};
}

std::filesystem::path FindRuntimeRootFrom(std::filesystem::path start) {
  if (start.empty()) {
    return {};
  }

  std::error_code ec;
  if (!std::filesystem::is_directory(start, ec)) {
    start = start.parent_path();
  }

  for (auto p = start; !p.empty(); p = p.parent_path()) {
    const bool has_data_model =
        std::filesystem::exists(p / "data" / "model", ec);
    const bool has_data_runtime =
        std::filesystem::exists(p / "data" / "runtime", ec);
    if (has_data_model || has_data_runtime) {
      return p;
    }
    if (LooksLikeProjectRoot(p)) {
      return p;
    }
    if (p == p.root_path()) {
      break;
    }
  }

  return {};
}

std::filesystem::path ResolveFallbackHtmlPath() {
  std::error_code ec;
  const auto cwd = std::filesystem::current_path(ec);
  if (!ec) {
    const auto root = FindProjectRootFrom(cwd);
    if (!root.empty()) {
      const auto candidate = root / "ui" / "ai-exe.html";
      if (FileExists(candidate)) {
        return candidate;
      }
    }
  }

  NSString *bundleExecPath = [[NSBundle mainBundle] executablePath];
  if (bundleExecPath) {
    const char *utf8 = [bundleExecPath UTF8String];
    if (utf8) {
      const auto root = FindProjectRootFrom(std::filesystem::path(utf8));
      if (!root.empty()) {
        const auto candidate = root / "ui" / "ai-exe.html";
        if (FileExists(candidate)) {
          return candidate;
        }
      }
    }
  }

  const char *home = std::getenv("HOME");
  if (home && home[0] != '\0') {
    const auto candidate =
        std::filesystem::path(home) / "Downloads" / "ai-exe.html";
    if (FileExists(candidate)) {
      return candidate;
    }
  }

  return {};
}

std::filesystem::path
ResolveRuntimeRoot(const std::filesystem::path &loaded_html) {
  std::error_code ec;
  if (!loaded_html.empty()) {
    const auto root_from_html = FindRuntimeRootFrom(loaded_html);
    if (!root_from_html.empty()) {
      return root_from_html;
    }

    const auto project_from_html = FindProjectRootFrom(loaded_html);
    if (!project_from_html.empty()) {
      return project_from_html;
    }
  }

  const auto cwd = std::filesystem::current_path(ec);
  if (!ec) {
    const auto root_from_cwd = FindRuntimeRootFrom(cwd);
    if (!root_from_cwd.empty()) {
      return root_from_cwd;
    }
  }

  NSString *bundleExecPath = [[NSBundle mainBundle] executablePath];
  if (bundleExecPath) {
    const char *utf8 = [bundleExecPath UTF8String];
    if (utf8) {
      const std::filesystem::path exec_path(utf8);
      const auto root_from_exec = FindRuntimeRootFrom(exec_path);
      if (!root_from_exec.empty()) {
        return root_from_exec;
      }
    }
  }

  const char *home = std::getenv("HOME");
  if (home && home[0] != '\0') {
    const auto fallback = std::filesystem::path(home) / "Downloads" / "AI EXE";
    const auto root_from_home = FindRuntimeRootFrom(fallback);
    if (!root_from_home.empty()) {
      return root_from_home;
    }
  }

  return cwd;
}

NSString *ErrorHtml(NSString *path) {
  NSString *escapedPath = path ? path : @"(not found)";
  return
      [NSString stringWithFormat:
                    @"<!doctype html><html><head><meta "
                    @"charset='utf-8'><style>body{font-family:-apple-system,"
                    @"system-ui;background:#0f1117;color:#e2e8f0;padding:28px}"
                     "h1{font-size:20px;margin:0 0 "
                     "10px}p{color:#94a3b8;line-height:1.6}code{background:#"
                     "13161f;border:1px solid #252b3d;padding:2px "
                     "6px;border-radius:6px}</style></head><body>"
                     "<h1>AI.EXE UI file not found</h1><p>Expected bundled "
                     "resource <code>ai-exe.html</code>.</p>"
                     "<p>Checked fallback path: <code>%@</code></p>"
                     "</body></html>",
                    escapedPath];
}

std::string EscapeJson(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 16);
  for (char c : s) {
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

std::string ExtractJsonStringField(const std::string &line,
                                   const std::string &key) {
  const std::string marker = "\"" + key + "\":\"";
  const auto start = line.find(marker);
  if (start == std::string::npos) {
    return std::string();
  }

  std::string out;
  bool escaped = false;
  for (std::size_t i = start + marker.size(); i < line.size(); ++i) {
    const char c = line[i];
    if (escaped) {
      switch (c) {
      case 'n':
        out.push_back('\n');
        break;
      case 'r':
        out.push_back('\r');
        break;
      case 't':
        out.push_back('\t');
        break;
      default:
        out.push_back(c);
        break;
      }
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') {
      break;
    }
    out.push_back(c);
  }
  return out;
}

int ExtractJsonIntField(const std::string &line, const std::string &key,
                        int fallback = 0) {
  const std::string marker = "\"" + key + "\":";
  const auto start = line.find(marker);
  if (start == std::string::npos) {
    return fallback;
  }

  auto is_ws = [](char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
  };

  std::size_t i = start + marker.size();
  while (i < line.size() && is_ws(line[i])) {
    ++i;
  }
  bool quoted = false;
  if (i < line.size() && line[i] == '"') {
    quoted = true;
    ++i;
  }
  if (i >= line.size()) {
    return fallback;
  }

  const char *begin = line.c_str() + i;
  char *end = nullptr;
  const long parsed = std::strtol(begin, &end, 10);
  if (begin == end) {
    return fallback;
  }
  if (quoted && (*end != '"')) {
    return fallback;
  }
  if (parsed <= 0) {
    return fallback;
  }
  return static_cast<int>(parsed);
}

std::string TrimCopy(const std::string &text) {
  std::size_t start = 0;
  while (start < text.size() &&
         std::isspace(static_cast<unsigned char>(text[start]))) {
    ++start;
  }
  std::size_t end = text.size();
  while (end > start &&
         std::isspace(static_cast<unsigned char>(text[end - 1]))) {
    --end;
  }
  return text.substr(start, end - start);
}

bool PostJsonHttp(const std::string &endpoint_url,
                  const std::string &auth_header,
                  const std::string &request_body, int timeout_ms,
                  long *status_code, std::string *response_body,
                  std::string *err) {
  if (status_code) {
    *status_code = 0;
  }
  if (response_body) {
    response_body->clear();
  }

  NSString *url_string =
      [NSString stringWithUTF8String:endpoint_url.c_str()];
  if (!url_string || url_string.length == 0) {
    if (err)
      *err = "Endpoint URL is empty.";
    return false;
  }

  NSURL *url = [NSURL URLWithString:url_string];
  if (!url) {
    if (err)
      *err = "Invalid endpoint URL.";
    return false;
  }

  NSMutableURLRequest *request =
      [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.timeoutInterval =
      std::max(1.0, static_cast<double>(timeout_ms > 0 ? timeout_ms : 120000) /
                        1000.0);
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  if (!auth_header.empty()) {
    NSString *header_value =
        [NSString stringWithUTF8String:auth_header.c_str()];
    if (header_value) {
      [request setValue:header_value forHTTPHeaderField:@"Authorization"];
    }
  }

  NSData *body = [NSData dataWithBytes:request_body.data()
                                length:request_body.size()];
  request.HTTPBody = body;

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSData *resp_data = nil;
  __block NSURLResponse *resp = nil;
  __block NSError *ns_error = nil;

  NSURLSessionDataTask *task = [[NSURLSession sharedSession]
      dataTaskWithRequest:request
        completionHandler:^(NSData *_Nullable data, NSURLResponse *_Nullable response,
                            NSError *_Nullable error) {
          resp_data = data;
          resp = response;
          ns_error = error;
          dispatch_semaphore_signal(sem);
        }];
  [task resume];
  dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

  if (ns_error) {
    if (err) {
      NSString *desc = [ns_error localizedDescription];
      *err = desc ? std::string([desc UTF8String]) : "Network request failed.";
    }
    return false;
  }

  if (resp_data && response_body) {
    response_body->assign(static_cast<const char *>([resp_data bytes]),
                          static_cast<std::size_t>([resp_data length]));
  }

  if ([resp isKindOfClass:[NSHTTPURLResponse class]]) {
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)resp;
    if (status_code) {
      *status_code = static_cast<long>(http.statusCode);
    }
  }

  return true;
}

std::string NormalizeWorkspaceRelativePath(const std::string &raw,
                                           std::string *err) {
  std::string input = TrimCopy(raw);
  std::replace(input.begin(), input.end(), '\\', '/');
  while (!input.empty() && input.front() == '/') {
    input.erase(input.begin());
  }
  if (input.empty() || input == ".") {
    return std::string();
  }

  std::filesystem::path rel(input);
  if (rel.is_absolute()) {
    if (err)
      *err = "Workspace path must be relative.";
    return std::string();
  }

  std::filesystem::path clean;
  for (const auto &part : rel) {
    const std::string token = part.string();
    if (token.empty() || token == ".") {
      continue;
    }
    if (token == "..") {
      if (err)
        *err = "Path traversal is not allowed.";
      return std::string();
    }
    clean /= part;
  }
  return clean.generic_string();
}

std::mutex s_workspace_root_mu;
std::optional<std::filesystem::path> s_workspace_root_override;

std::filesystem::path WorkspaceRoot(const WebRuntimeBridge &runtime) {
  std::error_code ec;
  const auto default_root = runtime.Config().sandbox_root / "workspace";
  std::filesystem::create_directories(default_root, ec);

  std::filesystem::path root = default_root;
  {
    std::lock_guard<std::mutex> lock(s_workspace_root_mu);
    if (s_workspace_root_override.has_value()) {
      const auto &override_root = *s_workspace_root_override;
      std::error_code check_ec;
      if (std::filesystem::exists(override_root, check_ec) &&
          std::filesystem::is_directory(override_root, check_ec)) {
        root = override_root;
      } else {
        s_workspace_root_override.reset();
      }
    }
  }
  std::filesystem::create_directories(root, ec);
  return root;
}

std::filesystem::path WorkspaceRootOrEmpty() {
  std::lock_guard<std::mutex> lock(s_workspace_root_mu);
  if (s_workspace_root_override.has_value()) {
    std::error_code check_ec;
    if (std::filesystem::exists(*s_workspace_root_override, check_ec) &&
        std::filesystem::is_directory(*s_workspace_root_override, check_ec)) {
      return *s_workspace_root_override;
    }
  }
  return std::filesystem::path();
}

bool SetWorkspaceRootOverride(const std::filesystem::path &raw_path,
                              std::string *err) {
  if (raw_path.empty()) {
    if (err)
      *err = "Folder selection cancelled.";
    return false;
  }
  std::error_code ec;
  std::filesystem::path resolved =
      std::filesystem::weakly_canonical(raw_path, ec);
  if (ec) {
    ec.clear();
    resolved = std::filesystem::absolute(raw_path, ec);
  }
  if (ec || resolved.empty()) {
    if (err)
      *err = "Failed to resolve selected folder.";
    return false;
  }
  if (!std::filesystem::exists(resolved, ec) ||
      !std::filesystem::is_directory(resolved, ec)) {
    if (err)
      *err = "Selected path is not a folder.";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(s_workspace_root_mu);
    s_workspace_root_override = resolved;
  }
  return true;
}

void ClearWorkspaceRootOverride() {
  std::lock_guard<std::mutex> lock(s_workspace_root_mu);
  s_workspace_root_override.reset();
}

bool RequestSpeechAndMicPermissions(std::string *err) {
  __block SFSpeechRecognizerAuthorizationStatus speech_auth =
      [SFSpeechRecognizer authorizationStatus];
  if (speech_auth == SFSpeechRecognizerAuthorizationStatusNotDetermined) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SFSpeechRecognizer
        requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
          speech_auth = status;
          dispatch_semaphore_signal(sem);
        }];
    (void)dispatch_semaphore_wait(
        sem, dispatch_time(DISPATCH_TIME_NOW, 5LL * NSEC_PER_SEC));
  }
  if (speech_auth != SFSpeechRecognizerAuthorizationStatusAuthorized) {
    if (err)
      *err = "Speech recognition permission is not granted.";
    return false;
  }

  __block AVAuthorizationStatus mic_auth =
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (mic_auth == AVAuthorizationStatusNotDetermined) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
                               mic_auth = granted
                                              ? AVAuthorizationStatusAuthorized
                                              : AVAuthorizationStatusDenied;
                               dispatch_semaphore_signal(sem);
                             }];
    (void)dispatch_semaphore_wait(
        sem, dispatch_time(DISPATCH_TIME_NOW, 5LL * NSEC_PER_SEC));
  }
  if (mic_auth != AVAuthorizationStatusAuthorized) {
    if (err)
      *err = "Microphone permission is not granted.";
    return false;
  }
  return true;
}

struct DictationSessionState {
  std::mutex mu;
  bool active = false;
  bool finished = false;
  AVAudioEngine *audio_engine = nil;
  AVAudioInputNode *input_node = nil;
  SFSpeechAudioBufferRecognitionRequest *request = nil;
  SFSpeechRecognitionTask *task = nil;
  dispatch_semaphore_t sem = nil;
  std::string best_text;
  std::string last_error;
  double level_rms = 0.0;
};

DictationSessionState &DictationSession() {
  static DictationSessionState state;
  return state;
}

void ResetDictationSessionLocked(DictationSessionState &st, bool cancel_task) {
  if (st.input_node) {
    [st.input_node removeTapOnBus:0];
  }
  if (st.audio_engine) {
    [st.audio_engine stop];
  }
  if (st.request) {
    [st.request endAudio];
  }
  if (st.task && cancel_task) {
    [st.task cancel];
  }
  st.audio_engine = nil;
  st.input_node = nil;
  st.request = nil;
  st.task = nil;
  st.sem = nil;
  st.active = false;
  st.finished = false;
  st.best_text.clear();
  st.last_error.clear();
  st.level_rms = 0.0;
}

bool StartOfflineDictationSessionOnMac(const std::string &locale_hint,
                                       std::string *err) {
  if (!RequestSpeechAndMicPermissions(err)) {
    return false;
  }
  if (@available(macOS 10.15, *)) {
    // Supported.
  } else {
    if (err)
      *err = "Offline dictation requires macOS 10.15 or newer.";
    return false;
  }

  auto &st = DictationSession();
  std::lock_guard<std::mutex> lock(st.mu);
  ResetDictationSessionLocked(st, true);

  NSString *locale_id = nil;
  if (!locale_hint.empty()) {
    locale_id = [NSString stringWithUTF8String:locale_hint.c_str()];
  }
  if (!locale_id || locale_id.length == 0) {
    locale_id = [[NSLocale currentLocale] localeIdentifier];
  }

  NSLocale *locale = [NSLocale localeWithLocaleIdentifier:locale_id];
  SFSpeechRecognizer *recognizer =
      [[SFSpeechRecognizer alloc] initWithLocale:locale];
  if (!recognizer) {
    recognizer =
        [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale currentLocale]];
  }
  if (!recognizer) {
    if (err)
      *err = "Failed to initialize speech recognizer.";
    return false;
  }
  if (@available(macOS 13.0, *)) {
    if (!recognizer.supportsOnDeviceRecognition) {
      if (err)
        *err =
            "On-device dictation is unavailable for this locale on this Mac.";
      return false;
    }
  }

  st.audio_engine = [[AVAudioEngine alloc] init];
  st.input_node = [st.audio_engine inputNode];
  if (!st.input_node) {
    if (err)
      *err = "Microphone input node unavailable.";
    ResetDictationSessionLocked(st, true);
    return false;
  }

  st.request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
  st.request.shouldReportPartialResults = YES;
  if (@available(macOS 13.0, *)) {
    st.request.requiresOnDeviceRecognition = YES;
  }
  st.sem = dispatch_semaphore_create(0);
  st.finished = false;
  st.best_text.clear();
  st.last_error.clear();
  st.level_rms = 0.0;

  st.task = [recognizer
      recognitionTaskWithRequest:st.request
                   resultHandler:^(SFSpeechRecognitionResult *result,
                                   NSError *rec_error) {
                     auto &cb = DictationSession();
                     std::lock_guard<std::mutex> cb_lock(cb.mu);
                     if (result &&
                         result.bestTranscription.formattedString.length > 0) {
                       cb.best_text =
                           std::string([result.bestTranscription
                                            .formattedString UTF8String]);
                     }
                     if (rec_error) {
                       NSString *msg = [rec_error localizedDescription];
                       cb.last_error =
                           msg ? std::string([msg UTF8String])
                               : std::string("Offline dictation failed.");
                     }
                     if (!cb.finished &&
                         (rec_error || (result && result.isFinal))) {
                       cb.finished = true;
                       if (cb.sem) {
                         dispatch_semaphore_signal(cb.sem);
                       }
                     }
                   }];

  AVAudioFormat *format = [st.input_node outputFormatForBus:0];
  [st.input_node removeTapOnBus:0];
  [st.input_node
      installTapOnBus:0
           bufferSize:1024
               format:format
                block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                  (void)when;
                  auto &tap = DictationSession();
                  std::lock_guard<std::mutex> tap_lock(tap.mu);
                  if (tap.request) {
                    [tap.request appendAudioPCMBuffer:buffer];
                  }
                  double rms = 0.0;
                  const UInt32 frames = buffer ? buffer.frameLength : 0;
                  if (frames > 0 && buffer.floatChannelData &&
                      buffer.floatChannelData[0]) {
                    const float *samples = buffer.floatChannelData[0];
                    double sum = 0.0;
                    for (UInt32 i = 0; i < frames; ++i) {
                      const double s = static_cast<double>(samples[i]);
                      sum += s * s;
                    }
                    rms = std::sqrt(sum / static_cast<double>(frames));
                  }
                  tap.level_rms = std::clamp(
                      (tap.level_rms * 0.72) + (rms * 0.28), 0.0, 1.0);
                }];

  NSError *start_error = nil;
  [st.audio_engine prepare];
  if (![st.audio_engine startAndReturnError:&start_error]) {
    if (err) {
      NSString *msg = start_error ? [start_error localizedDescription]
                                  : @"Unknown microphone error.";
      *err = std::string("Failed to start microphone capture: ") +
             (msg ? [msg UTF8String] : "error");
    }
    ResetDictationSessionLocked(st, true);
    return false;
  }

  st.active = true;
  return true;
}

bool FinalizeOfflineDictationSessionOnMac(int timeout_ms,
                                          std::string *transcript,
                                          std::string *err) {
  if (transcript)
    transcript->clear();
  auto &st = DictationSession();
  dispatch_semaphore_t sem = nil;
  {
    std::lock_guard<std::mutex> lock(st.mu);
    if (!st.active) {
      if (err)
        *err = "No active dictation session.";
      return false;
    }
    if (st.request) {
      [st.request endAudio];
    }
    if (st.input_node) {
      [st.input_node removeTapOnBus:0];
    }
    if (st.audio_engine) {
      [st.audio_engine stop];
    }
    sem = st.sem;
  }

  const int bounded_timeout_ms = std::clamp(timeout_ms, 2000, 20000);
  const long long wait_ns =
      static_cast<long long>(bounded_timeout_ms) * 1000000LL;
  const long wait_rc = sem ? dispatch_semaphore_wait(
                                 sem, dispatch_time(DISPATCH_TIME_NOW, wait_ns))
                           : 0;

  std::lock_guard<std::mutex> lock(st.mu);
  const std::string trimmed = TrimCopy(st.best_text);
  if (st.task) {
    [st.task cancel];
  }
  if (!trimmed.empty()) {
    if (transcript)
      *transcript = trimmed;
    ResetDictationSessionLocked(st, false);
    return true;
  }
  if (!st.last_error.empty()) {
    if (err)
      *err = st.last_error;
    ResetDictationSessionLocked(st, false);
    return false;
  }
  if (wait_rc != 0) {
    if (err)
      *err = "No speech detected before timeout.";
    ResetDictationSessionLocked(st, false);
    return false;
  }
  if (err)
    *err = "No transcript captured.";
  ResetDictationSessionLocked(st, false);
  return false;
}

void CancelOfflineDictationSessionOnMac() {
  auto &st = DictationSession();
  std::lock_guard<std::mutex> lock(st.mu);
  ResetDictationSessionLocked(st, true);
}

double GetOfflineDictationLevelOnMac() {
  auto &st = DictationSession();
  std::lock_guard<std::mutex> lock(st.mu);
  const double level = std::clamp(st.level_rms * 5.5, 0.0, 1.0);
  return level;
}

bool RunOfflineDictationOnMac(const std::string &locale_hint, int timeout_ms,
                              std::string *transcript, std::string *err) {
  if (!StartOfflineDictationSessionOnMac(locale_hint, err)) {
    return false;
  }
  return FinalizeOfflineDictationSessionOnMac(timeout_ms, transcript, err);
}

bool IsBackendReachable() {
  NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:8765/health"];
  if (!url) {
    return false;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"GET";
  request.timeoutInterval = 0.8;
  __block BOOL ok = NO;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  NSURLSessionDataTask *task = [[NSURLSession sharedSession]
      dataTaskWithRequest:request
        completionHandler:^(NSData *_Nullable data, NSURLResponse *_Nullable response,
                            NSError *_Nullable error) {
          (void)data;
          if (!error && [response isKindOfClass:[NSHTTPURLResponse class]]) {
            NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
            ok = http.statusCode >= 200 && http.statusCode < 300;
          }
          dispatch_semaphore_signal(sem);
        }];
  [task resume];
  dispatch_semaphore_wait(
      sem, dispatch_time(DISPATCH_TIME_NOW, 900LL * NSEC_PER_MSEC));
  if (!ok) {
    [task cancel];
  }
  return ok;
}

NSTask *StartFastApiBackend(const std::filesystem::path &runtime_root) {
  if (IsBackendReachable()) {
    return nil;
  }
  const auto backend_dir = runtime_root / "backend";
  const auto python_path = backend_dir / ".venv" / "bin" / "python";
  const auto main_path = backend_dir / "app" / "main.py";
  if (!FileExists(python_path) || !FileExists(main_path)) {
    return nil;
  }

  std::error_code ec;
  const auto data_dir = backend_dir / ".data";
  std::filesystem::create_directories(data_dir, ec);
  const auto log_path = data_dir / "backend.log";

  NSTask *task = [[NSTask alloc] init];
  task.executableURL =
      [NSURL fileURLWithPath:[NSString stringWithUTF8String:python_path.c_str()]];
  task.currentDirectoryURL =
      [NSURL fileURLWithPath:[NSString stringWithUTF8String:backend_dir.c_str()]];
  task.arguments = @[
    @"-m", @"uvicorn", @"app.main:app", @"--host", @"127.0.0.1", @"--port",
    @"8765"
  ];

  NSMutableDictionary<NSString *, NSString *> *env =
      [[[NSProcessInfo processInfo] environment] mutableCopy];
  env[@"AIEXE_PARENT_WATCH"] = @"1";
  env[@"AIEXE_BACKEND_DATA_DIR"] =
      [NSString stringWithUTF8String:data_dir.c_str()];
  task.environment = env;

  NSString *logString = [NSString stringWithUTF8String:log_path.c_str()];
  [[NSFileManager defaultManager] createFileAtPath:logString contents:nil
                                        attributes:nil];
  NSFileHandle *logHandle = [NSFileHandle fileHandleForWritingAtPath:logString];
  [logHandle seekToEndOfFile];
  task.standardOutput = logHandle;
  task.standardError = logHandle;

  NSError *error = nil;
  if (![task launchAndReturnError:&error]) {
    return nil;
  }
  return task;
}

std::optional<std::filesystem::path>
ResolveWorkspacePath(const WebRuntimeBridge &runtime,
                     const std::string &raw_path, std::string *err) {
  std::string norm_err;
  const std::string rel = NormalizeWorkspaceRelativePath(raw_path, &norm_err);
  if (!norm_err.empty()) {
    if (err)
      *err = norm_err;
    return std::nullopt;
  }
  return rel.empty() ? WorkspaceRoot(runtime)
                     : (WorkspaceRoot(runtime) / std::filesystem::path(rel));
}

std::uint64_t FileTimeToUnixMs(std::filesystem::file_time_type ft) {
  using namespace std::chrono;
  const auto now_file = std::filesystem::file_time_type::clock::now();
  const auto now_sys = system_clock::now();
  const auto sys_time = now_sys + (ft - now_file);
  const auto ms =
      duration_cast<milliseconds>(sys_time.time_since_epoch()).count();
  return ms > 0 ? static_cast<std::uint64_t>(ms) : 0ULL;
}

struct WorkspaceEntryInfo {
  std::string name;
  std::string kind;
  std::string path;
  std::uint64_t size_bytes = 0;
  std::uint64_t updated_at_ms = 0;
  std::uint64_t child_count = 0;
};

bool BuildWorkspaceListOutput(const WebRuntimeBridge &runtime,
                              const std::string &raw_path, std::string *output,
                              std::string *err) {
  if (!output)
    return false;
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  const auto root = WorkspaceRoot(runtime);
  const auto target = *resolved;

  std::error_code ec;
  if (!std::filesystem::exists(target, ec)) {
    if (target == root) {
      std::filesystem::create_directories(root, ec);
    } else {
      if (err)
        *err = "Folder not found.";
      return false;
    }
  }
  if (!std::filesystem::is_directory(target, ec)) {
    if (err)
      *err = "Workspace path is not a folder.";
    return false;
  }

  std::vector<WorkspaceEntryInfo> entries;
  for (std::filesystem::directory_iterator it(target, ec), end;
       !ec && it != end; it.increment(ec)) {
    const auto &p = it->path();
    const bool is_dir = it->is_directory(ec);
    const bool is_file = !is_dir && it->is_regular_file(ec);
    if (!is_dir && !is_file)
      continue;

    WorkspaceEntryInfo info;
    info.name = p.filename().string();
    info.kind = is_dir ? "folder" : "file";
    const auto rel = std::filesystem::relative(p, root, ec);
    const std::string rel_path = ec ? info.name : rel.generic_string();
    info.path = rel_path.empty() ? "/" : ("/" + rel_path);
    if (is_file) {
      info.size_bytes = static_cast<std::uint64_t>(it->file_size(ec));
    } else {
      std::uint64_t count = 0;
      for (std::filesystem::directory_iterator child(p, ec), child_end;
           !ec && child != child_end; child.increment(ec)) {
        ++count;
      }
      info.child_count = count;
    }
    info.updated_at_ms = FileTimeToUnixMs(it->last_write_time(ec));
    entries.push_back(std::move(info));
  }

  std::sort(
      entries.begin(), entries.end(),
      [](const WorkspaceEntryInfo &a, const WorkspaceEntryInfo &b) {
        if (a.kind != b.kind)
          return a.kind == "folder";
        std::string an = a.name;
        std::string bn = b.name;
        std::transform(an.begin(), an.end(), an.begin(), [](unsigned char c) {
          return static_cast<char>(std::tolower(c));
        });
        std::transform(bn.begin(), bn.end(), bn.begin(), [](unsigned char c) {
          return static_cast<char>(std::tolower(c));
        });
        return an < bn;
      });

  const auto rel_target = std::filesystem::relative(target, root, ec);
  const std::string rel_target_path =
      ec ? std::string() : rel_target.generic_string();
  const std::string view_path =
      rel_target_path.empty() ? "/" : ("/" + rel_target_path);

  std::ostringstream oss;
  oss << "{"
      << "\"path\":\"" << EscapeJson(view_path) << "\","
      << "\"entries\":[";
  for (std::size_t i = 0; i < entries.size(); ++i) {
    const auto &e = entries[i];
    if (i > 0)
      oss << ",";
    oss << "{"
        << "\"name\":\"" << EscapeJson(e.name) << "\","
        << "\"kind\":\"" << EscapeJson(e.kind) << "\","
        << "\"path\":\"" << EscapeJson(e.path) << "\","
        << "\"sizeBytes\":" << e.size_bytes << ","
        << "\"updatedAt\":" << e.updated_at_ms << ","
        << "\"childCount\":" << e.child_count << "}";
  }
  oss << "]}";
  *output = oss.str();
  return true;
}

bool WorkspaceMakeDirectory(const WebRuntimeBridge &runtime,
                            const std::string &raw_path, std::string *err) {
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  std::error_code ec;
  if (std::filesystem::exists(*resolved, ec)) {
    if (std::filesystem::is_directory(*resolved, ec))
      return true;
    if (err)
      *err = "A file already exists at this path.";
    return false;
  }
  std::filesystem::create_directories(*resolved, ec);
  if (ec) {
    if (err)
      *err = "Failed to create folder: " + ec.message();
    return false;
  }
  return true;
}

bool WorkspaceWriteFile(const WebRuntimeBridge &runtime,
                        const std::string &raw_path, const std::string &content,
                        std::string *err) {
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  std::error_code ec;
  if (std::filesystem::exists(*resolved, ec) &&
      std::filesystem::is_directory(*resolved, ec)) {
    if (err)
      *err = "Cannot write file: target is a folder.";
    return false;
  }
  std::filesystem::create_directories(resolved->parent_path(), ec);
  std::ofstream out(*resolved, std::ios::binary | std::ios::trunc);
  if (!out.is_open()) {
    if (err)
      *err = "Failed to open file for write.";
    return false;
  }
  out.write(content.data(), static_cast<std::streamsize>(content.size()));
  if (!out.good()) {
    if (err)
      *err = "Failed to write file.";
    return false;
  }
  return true;
}

bool WorkspaceReadFile(const WebRuntimeBridge &runtime,
                       const std::string &raw_path, std::string *output,
                       std::string *err) {
  if (!output)
    return false;
  const auto resolved = ResolveWorkspacePath(runtime, raw_path, err);
  if (!resolved)
    return false;
  std::error_code ec;
  if (!std::filesystem::exists(*resolved, ec) ||
      !std::filesystem::is_regular_file(*resolved, ec)) {
    if (err)
      *err = "File not found.";
    return false;
  }
  const auto size = std::filesystem::file_size(*resolved, ec);
  if (size > 2ULL * 1024ULL * 1024ULL) {
    if (err)
      *err = "File is too large to load in UI.";
    return false;
  }
  std::ifstream in(*resolved, std::ios::binary);
  if (!in.is_open()) {
    if (err)
      *err = "Failed to open file for read.";
    return false;
  }
  std::ostringstream buffer;
  buffer << in.rdbuf();
  *output = buffer.str();
  return true;
}

bool WorkspaceMoveEntry(const WebRuntimeBridge &runtime,
                        const std::string &raw_src_path,
                        const std::string &raw_dst_path, std::string *err) {
  const auto src = ResolveWorkspacePath(runtime, raw_src_path, err);
  if (!src)
    return false;
  const auto dst = ResolveWorkspacePath(runtime, raw_dst_path, err);
  if (!dst)
    return false;

  const auto root = WorkspaceRoot(runtime);
  if (*src == root) {
    if (err)
      *err = "Cannot move workspace root.";
    return false;
  }

  std::error_code ec;
  if (!std::filesystem::exists(*src, ec)) {
    if (err)
      *err = "Source path not found.";
    return false;
  }
  if (std::filesystem::exists(*dst, ec)) {
    if (err)
      *err = "Destination already exists.";
    return false;
  }
  const auto src_parent = src->parent_path();
  const auto dst_parent = dst->parent_path();
  if (src_parent != dst_parent) {
    std::filesystem::create_directories(dst_parent, ec);
    if (ec) {
      if (err)
        *err = "Failed to prepare destination: " + ec.message();
      return false;
    }
  }
  const bool src_is_dir = std::filesystem::is_directory(*src, ec);
  if (src_is_dir) {
    const std::string src_prefix = src->generic_string() + "/";
    const std::string dst_value = dst->generic_string();
    if (dst_value.rfind(src_prefix, 0) == 0) {
      if (err)
        *err = "Cannot move a folder into itself.";
      return false;
    }
  }

  std::filesystem::rename(*src, *dst, ec);
  if (ec) {
    if (err)
      *err = "Failed to move item: " + ec.message();
    return false;
  }
  return true;
}

bool WorkspaceTrashEntry(const WebRuntimeBridge &runtime,
                         const std::string &raw_path, std::string *err) {
  const auto target = ResolveWorkspacePath(runtime, raw_path, err);
  if (!target)
    return false;
  const auto root = WorkspaceRoot(runtime);
  if (*target == root) {
    if (err)
      *err = "Cannot delete workspace root.";
    return false;
  }
  std::error_code ec;
  if (!std::filesystem::exists(*target, ec)) {
    if (err)
      *err = "Path not found.";
    return false;
  }

  NSString *path = [NSString stringWithUTF8String:target->string().c_str()];
  if (!path) {
    if (err)
      *err = "Invalid path.";
    return false;
  }
  NSURL *url = [NSURL fileURLWithPath:path];
  NSError *nsErr = nil;
  NSURL *trashed = nil;
  const BOOL ok = [[NSFileManager defaultManager] trashItemAtURL:url
                                                resultingItemURL:&trashed
                                                           error:&nsErr];
  if (!ok) {
    if (err) {
      NSString *desc =
          nsErr.localizedDescription ?: @"Failed to move item to Trash.";
      *err = std::string([desc UTF8String] ? [desc UTF8String]
                                           : "Failed to move item to Trash.");
    }
    return false;
  }
  return true;
}

bool WorkspaceRevealEntry(const WebRuntimeBridge &runtime,
                          const std::string &raw_path, std::string *err) {
  const auto target = ResolveWorkspacePath(runtime, raw_path, err);
  if (!target)
    return false;
  const auto root = WorkspaceRoot(runtime);
  std::error_code ec;
  if (!std::filesystem::exists(*target, ec)) {
    if (*target == root) {
      std::filesystem::create_directories(root, ec);
    } else {
      if (err)
        *err = "Path not found.";
      return false;
    }
  }

  NSString *path = [NSString stringWithUTF8String:target->string().c_str()];
  if (!path) {
    if (err)
      *err = "Invalid path.";
    return false;
  }
  NSURL *url = [NSURL fileURLWithPath:path];
  if (!url) {
    if (err)
      *err = "Invalid URL.";
    return false;
  }

  if (std::filesystem::is_directory(*target, ec)) {
    const BOOL opened = [[NSWorkspace sharedWorkspace] openURL:url];
    if (!opened) {
      if (err)
        *err = "Failed to open workspace folder in Finder.";
      return false;
    }
    return true;
  }

  [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[ url ]];
  return true;
}

// Runs a Python project in a visible Terminal window using whatever interpreter
// is on the user's machine — nothing is bundled (matches the no-install scope).
// Writes a temp .command that prefers python3, falls back to python, and prints
// an install hint if neither exists, then opens it (Terminal runs .command files).
bool LaunchPythonConsoleMac(const std::filesystem::path &root,
                            const std::string &entry_filename,
                            std::string *err) {
  auto sh_quote = [](const std::string &s) {
    // Single-quote for the shell: close, escaped-quote, reopen.
    std::string out = "'";
    for (char c : s) {
      if (c == '\'') out += "'\\''";
      else out += c;
    }
    out += "'";
    return out;
  };

  // Run inside a project-local .venv so `pip install` works (a venv is not the
  // "externally-managed" system Python — no PEP 668 error) and nothing pollutes
  // the user's machine. requirements.txt (if the project ships one) is installed
  // into the venv before the entry runs.
  std::ostringstream script;
  script << "#!/bin/bash\n"
         << "cd " << sh_quote(root.string()) << " || exit 1\n"
         << "PY=\"\"\n"
         << "if command -v python3 >/dev/null 2>&1; then PY=python3\n"
         << "elif command -v python >/dev/null 2>&1; then PY=python\n"
         << "fi\n"
         << "if [ -z \"$PY\" ]; then\n"
         << "  echo 'Python is not installed. Install it from https://python.org'\n"
         << "else\n"
         << "  if [ ! -d .venv ]; then echo 'Setting up a virtual environment (.venv)...'; \"$PY\" -m venv .venv; fi\n"
         << "  VPY=.venv/bin/python\n"
         << "  if [ ! -x \"$VPY\" ]; then VPY=\"$PY\"; fi\n"
         << "  if [ -f requirements.txt ]; then echo 'Installing dependencies...'; \"$VPY\" -m pip install --quiet --disable-pip-version-check -r requirements.txt; fi\n"
         << "  \"$VPY\" " << sh_quote(entry_filename) << "\n"
         << "fi\n"
         << "echo\n"
         << "read -n 1 -s -r -p 'Press any key to close this window...'\n";

  NSString *tmpDir = NSTemporaryDirectory();
  NSString *scriptPath = [tmpDir stringByAppendingPathComponent:
      [NSString stringWithFormat:@"aiexe-run-%u.command",
          (unsigned)[[NSProcessInfo processInfo] processIdentifier]]];
  NSString *contents = [NSString stringWithUTF8String:script.str().c_str()];
  NSError *writeErr = nil;
  if (![contents writeToFile:scriptPath
                  atomically:YES
                    encoding:NSUTF8StringEncoding
                       error:&writeErr]) {
    if (err) *err = "Could not prepare the Python launcher.";
    return false;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm setAttributes:@{NSFilePosixPermissions : @(0755)}
       ofItemAtPath:scriptPath
              error:nil];
  NSURL *url = [NSURL fileURLWithPath:scriptPath];
  if (!url || ![[NSWorkspace sharedWorkspace] openURL:url]) {
    if (err) *err = "Could not open a Terminal to run the project.";
    return false;
  }
  return true;
}

bool LaunchViteDevServerMac(const std::filesystem::path &root, int port,
                            std::string *err) {
  auto sh_quote = [](const std::string &s) {
    std::string out = "'";
    for (char c : s) {
      if (c == '\'') out += "'\\''";
      else out += c;
    }
    out += "'";
    return out;
  };

  const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/";
  std::ostringstream script;
  script << "#!/bin/bash\n"
         << "cd " << sh_quote(root.string()) << " || exit 1\n"
         << "if ! command -v npm >/dev/null 2>&1; then\n"
         << "  echo 'Node.js/npm is required to run this Vite project. Install Node.js, then run again.'\n"
         << "  read -n 1 -s -r -p 'Press any key to close this window...'\n"
         << "  exit 1\n"
         << "fi\n"
         << "if [ ! -d node_modules ]; then\n"
         << "  echo 'Installing npm dependencies...'\n"
         << "  npm install || {\n"
         << "    echo 'Dependency conflict detected - retrying with --legacy-peer-deps...'\n"
         << "    npm install --legacy-peer-deps || { read -n 1 -s -r -p 'Install failed. Press any key to close...'; exit 1; }\n"
         << "  }\n"
         << "fi\n"
         << "( sleep 2; open " << sh_quote(url) << " ) >/dev/null 2>&1 &\n"
         << "echo 'Starting Vite dev server at " << url << "'\n"
         << "npm run dev -- --host 127.0.0.1 --port " << port << " --strictPort\n";

  NSString *tmpDir = NSTemporaryDirectory();
  NSString *scriptPath = [tmpDir stringByAppendingPathComponent:
      [NSString stringWithFormat:@"aiexe-vite-%u.command",
          (unsigned)[[NSProcessInfo processInfo] processIdentifier]]];
  NSString *contents = [NSString stringWithUTF8String:script.str().c_str()];
  NSError *writeErr = nil;
  if (![contents writeToFile:scriptPath
                  atomically:YES
                    encoding:NSUTF8StringEncoding
                       error:&writeErr]) {
    if (err) *err = "Could not prepare the Vite launcher.";
    return false;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm setAttributes:@{NSFilePosixPermissions : @(0755)}
       ofItemAtPath:scriptPath
              error:nil];
  NSURL *launcher = [NSURL fileURLWithPath:scriptPath];
  if (!launcher || ![[NSWorkspace sharedWorkspace] openURL:launcher]) {
    if (err) *err = "Could not open a Terminal to run the Vite project.";
    return false;
  }
  return true;
}

std::string StatusToJson(const WebRuntimeStatus &s) {
  std::ostringstream oss;
  oss << "{"
      << "\"rootPath\":\"" << EscapeJson(s.root_path) << "\","
      << "\"modelPath\":\"" << EscapeJson(s.model_path) << "\","
      << "\"modelExists\":" << (s.model_exists ? "true" : "false") << ","
      << "\"modelLoaded\":" << (s.model_loaded ? "true" : "false") << ","
      << "\"modelSizeBytes\":" << s.model_size_bytes << ","
      << "\"modelFormat\":\"" << EscapeJson(s.model_format) << "\","
      << "\"modelSha256\":\"" << EscapeJson(s.model_sha256) << "\","
      << "\"backendPath\":\"" << EscapeJson(s.backend_path) << "\","
      << "\"backendConfigured\":" << (s.backend_configured ? "true" : "false")
      << ","
      << "\"backendSelfTestOk\":" << (s.backend_selftest_ok ? "true" : "false")
      << ","
      << "\"backendSelfTest\":\"" << EscapeJson(s.backend_selftest_details)
      << "\","
      << "\"backendVersion\":\"" << EscapeJson(s.backend_version) << "\","
      << "\"lastError\":\"" << EscapeJson(s.last_error) << "\","
      << "\"lastInferenceRoute\":\"" << EscapeJson(s.last_inference_route)
      << "\","
      << "\"lastPersistentError\":\"" << EscapeJson(s.last_persistent_error)
      << "\","
      << "\"lastCompletionStatus\":\"" << EscapeJson(s.last_completion_status)
      << "\","
      << "\"lastCompletionLikelyTruncated\":"
      << (s.last_completion_likely_truncated ? "true" : "false") << ","
      << "\"lastCompletionMaxTokens\":" << s.last_completion_max_tokens
      << "}";
  return oss.str();
}

std::string BuildResponse(const std::string &id, const std::string &action,
                          bool ok, const std::string &message,
                          const std::string &output,
                          const WebRuntimeStatus &status) {
  std::ostringstream oss;
  oss << "{"
      << "\"id\":\"" << EscapeJson(id) << "\","
      << "\"action\":\"" << EscapeJson(action) << "\","
      << "\"ok\":" << (ok ? "true" : "false") << ","
      << "\"message\":\"" << EscapeJson(message) << "\","
      << "\"output\":\"" << EscapeJson(output) << "\","
      << "\"status\":" << StatusToJson(status) << "}";
  return oss.str();
}

std::string BuildStreamEvent(const std::string &id, bool done,
                             const std::string &delta, bool ok,
                             const std::string &message,
                             const std::string &output,
                             const WebRuntimeStatus &status) {
  std::ostringstream oss;
  oss << "{"
      << "\"id\":\"" << EscapeJson(id) << "\","
      << "\"action\":\"inferStream\","
      << "\"stream\":true,"
      << "\"done\":" << (done ? "true" : "false") << ","
      << "\"delta\":\"" << EscapeJson(delta) << "\","
      << "\"ok\":" << (ok ? "true" : "false") << ","
      << "\"message\":\"" << EscapeJson(message) << "\","
      << "\"output\":\"" << EscapeJson(output) << "\","
      << "\"status\":" << StatusToJson(status) << "}";
  return oss.str();
}

} // namespace

// The web view fills the transparent titlebar. Let AppKit own dragging in the
// top titlebar band so dragging never selects page text or depends on JS.
@interface AiExeWebView : WKWebView
@end

@implementation AiExeWebView
- (void)mouseDown:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if (point.y >= NSHeight(self.bounds) - 38.0) {
    [self.window performWindowDragWithEvent:event];
    return;
  }
  [super mouseDown:event];
}
@end

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate,
                                   WKScriptMessageHandler, WKUIDelegate>
@end

@implementation AppDelegate {
  NSWindow *_window;
  WKWebView *_webView;
  NSTask *_backendTask;
  std::filesystem::path _loadedHtmlPath;
  WebRuntimeBridge _runtime;
  std::string _runtimeInitError;
}

- (void)dealloc {
  if (_webView) {
    [[_webView configuration].userContentController
        removeScriptMessageHandlerForName:@"aiexe"];
  }
}

- (void)installMainMenu {
  NSMenu *main_menu = [[NSMenu alloc] initWithTitle:@""];

  NSMenuItem *app_item = [[NSMenuItem alloc] initWithTitle:@""
                                                    action:nil
                                             keyEquivalent:@""];
  [main_menu addItem:app_item];
  NSMenu *app_menu = [[NSMenu alloc] initWithTitle:@"AI.EXE"];
  NSString *app_name = [[NSProcessInfo processInfo] processName];
  NSMenuItem *quit_item = [[NSMenuItem alloc]
      initWithTitle:[@"Quit " stringByAppendingString:app_name]
             action:@selector(terminate:)
      keyEquivalent:@"q"];
  [app_menu addItem:quit_item];
  [app_item setSubmenu:app_menu];

  NSMenuItem *edit_item = [[NSMenuItem alloc] initWithTitle:@""
                                                     action:nil
                                              keyEquivalent:@""];
  [main_menu addItem:edit_item];
  NSMenu *edit_menu = [[NSMenu alloc] initWithTitle:@"Edit"];
  [edit_menu addItem:[[NSMenuItem alloc] initWithTitle:@"Undo"
                                                action:@selector(undo:)
                                         keyEquivalent:@"z"]];
  NSMenuItem *redo = [[NSMenuItem alloc] initWithTitle:@"Redo"
                                                action:@selector(redo:)
                                         keyEquivalent:@"z"];
  [redo setKeyEquivalentModifierMask:(NSEventModifierFlagCommand |
                                      NSEventModifierFlagShift)];
  [edit_menu addItem:redo];
  [edit_menu addItem:[NSMenuItem separatorItem]];
  [edit_menu addItem:[[NSMenuItem alloc] initWithTitle:@"Cut"
                                                action:@selector(cut:)
                                         keyEquivalent:@"x"]];
  [edit_menu addItem:[[NSMenuItem alloc] initWithTitle:@"Copy"
                                                action:@selector(copy:)
                                         keyEquivalent:@"c"]];
  [edit_menu addItem:[[NSMenuItem alloc] initWithTitle:@"Paste"
                                                action:@selector(paste:)
                                         keyEquivalent:@"v"]];
  [edit_menu addItem:[[NSMenuItem alloc] initWithTitle:@"Select All"
                                                action:@selector(selectAll:)
                                         keyEquivalent:@"a"]];
  [edit_item setSubmenu:edit_menu];

  [NSApp setMainMenu:main_menu];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:
    (NSApplication *)sender {
  (void)sender;
  return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  DevServerManager::Instance().StopAll();
  if (_backendTask && [_backendTask isRunning]) {
    [_backendTask terminate];
  }
  _backendTask = nil;
}

- (void)loadUiHtml {
  NSString *bundledPath = [[NSBundle mainBundle] pathForResource:@"ai-exe"
                                                          ofType:@"html"];
  if (bundledPath.length > 0) {
    _loadedHtmlPath = std::filesystem::path(
        [[bundledPath stringByStandardizingPath] UTF8String]);
    NSURL *fileUrl = [NSURL fileURLWithPath:bundledPath];
    NSURL *readScope = [fileUrl URLByDeletingLastPathComponent];
    [_webView loadFileURL:fileUrl allowingReadAccessToURL:readScope];
    return;
  }

  const auto fallback = ResolveFallbackHtmlPath();
  if (!fallback.empty()) {
    _loadedHtmlPath = fallback;
    NSString *fallbackPath =
        [NSString stringWithUTF8String:fallback.string().c_str()];
    NSURL *fileUrl = [NSURL fileURLWithPath:fallbackPath];
    NSURL *readScope = [fileUrl URLByDeletingLastPathComponent];
    [_webView loadFileURL:fileUrl allowingReadAccessToURL:readScope];
    return;
  }

  [_webView
      loadHTMLString:ErrorHtml(@"/Users/macbookair2020/Downloads/ai-exe.html")
             baseURL:nil];
}

- (void)initializeRuntime {
  std::string runtime_err;
  const bool force_cpu =
      IsTruthyEnv(std::getenv("AI_EXE_FORCE_CPU"));
  _runtime.Initialize(ResolveRuntimeRoot(_loadedHtmlPath), force_cpu,
                      &runtime_err);
  _runtimeInitError = runtime_err;
}

- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
  (void)webView;
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"AI.EXE";
  alert.informativeText = message ? message : @"";
  [alert addButtonWithTitle:@"OK"];
  if (_window) {
    [alert beginSheetModalForWindow:_window
                  completionHandler:^(__unused NSModalResponse response) {
                    if (completionHandler)
                      completionHandler();
                  }];
    return;
  }
  [alert runModal];
  if (completionHandler)
    completionHandler();
}

- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:(void (^)(BOOL))completionHandler {
  (void)webView;
  (void)frame;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"AI.EXE";
  alert.informativeText = message ? message : @"";
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];
  if (_window) {
    [alert beginSheetModalForWindow:_window
                  completionHandler:^(NSModalResponse response) {
                    if (completionHandler)
                      completionHandler(response == NSAlertFirstButtonReturn);
                  }];
    return;
  }
  const NSModalResponse response = [alert runModal];
  if (completionHandler)
    completionHandler(response == NSAlertFirstButtonReturn);
}

- (void)webView:(WKWebView *)webView
    runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
                              defaultText:(NSString *)defaultText
                         initiatedByFrame:(WKFrameInfo *)frame
                        completionHandler:(void (^)(NSString *_Nullable result))
                                              completionHandler {
  (void)webView;
  (void)frame;

  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"AI.EXE";
  alert.informativeText = prompt ? prompt : @"";
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];

  NSTextField *input =
      [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 360, 24)];
  input.stringValue = defaultText ? defaultText : @"";
  alert.accessoryView = input;

  if (_window) {
    [alert beginSheetModalForWindow:_window
                  completionHandler:^(NSModalResponse response) {
                    if (!completionHandler)
                      return;
                    if (response == NSAlertFirstButtonReturn) {
                      completionHandler(input.stringValue ? input.stringValue
                                                          : @"");
                    } else {
                      completionHandler(nil);
                    }
                  }];
    return;
  }

  const NSModalResponse response = [alert runModal];
  if (!completionHandler)
    return;
  if (response == NSAlertFirstButtonReturn) {
    completionHandler(input.stringValue ? input.stringValue : @"");
  } else {
    completionHandler(nil);
  }
}

- (std::filesystem::path)promptModelImportPath {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  [panel setCanChooseFiles:YES];
  [panel setCanChooseDirectories:NO];
  [panel setAllowsMultipleSelection:NO];
  [panel setAllowedFileTypes:@[ @"gguf" ]];
  const NSInteger result = [panel runModal];
  if (result != NSModalResponseOK) {
    return {};
  }
  NSURL *url = [[panel URLs] firstObject];
  if (!url) {
    return {};
  }
  NSString *path = [url path];
  if (!path) {
    return {};
  }
  return std::filesystem::path([path UTF8String]);
}

- (std::filesystem::path)promptWorkspaceFolderPath {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  [panel setCanChooseFiles:NO];
  [panel setCanChooseDirectories:YES];
  [panel setAllowsMultipleSelection:NO];
  const NSInteger result = [panel runModal];
  if (result != NSModalResponseOK) {
    return {};
  }
  NSURL *url = [[panel URLs] firstObject];
  if (!url) {
    return {};
  }
  NSString *path = [url path];
  if (!path) {
    return {};
  }
  return std::filesystem::path([path UTF8String]);
}

- (std::string)handleUiRequest:(const std::string &)requestJson
                    importPath:(const std::filesystem::path &)importPath
             workspaceRootPath:
                 (const std::filesystem::path &)workspaceRootPath {
  const std::string id = ExtractJsonStringField(requestJson, "id");
  const std::string action = ExtractJsonStringField(requestJson, "action");
  const std::string prompt = ExtractJsonStringField(requestJson, "prompt");
  const std::string grammar = ExtractJsonStringField(requestJson, "grammar");
  const std::string workspace_path =
      ExtractJsonStringField(requestJson, "path");
  const std::string workspace_content =
      ExtractJsonStringField(requestJson, "content");
  const std::string workspace_src_path =
      ExtractJsonStringField(requestJson, "srcPath");
  const std::string workspace_dst_path =
      ExtractJsonStringField(requestJson, "dstPath");
  const std::string endpoint_url =
      ExtractJsonStringField(requestJson, "endpointUrl");
  const std::string auth_header =
      ExtractJsonStringField(requestJson, "authHeader");
  const std::string request_body =
      ExtractJsonStringField(requestJson, "requestBody");
  const std::string window_dx = ExtractJsonStringField(requestJson, "dx");
  const std::string window_dy = ExtractJsonStringField(requestJson, "dy");
  const std::string locale = ExtractJsonStringField(requestJson, "locale");
  const std::string persisted_storage =
      ExtractJsonStringField(requestJson, "storage");
  const std::string storage_key =
      ExtractJsonStringField(requestJson, "storageKey");
  const int storage_offset =
      std::max(0, ExtractJsonIntField(requestJson, "offset", 0));
  const int storage_limit =
      std::clamp(ExtractJsonIntField(requestJson, "limit", 48000), 1024, 64000);
  int max_tokens = ExtractJsonIntField(requestJson, "maxTokens", 0);
  if (max_tokens <= 0) {
    max_tokens = ExtractJsonIntField(requestJson, "max_tokens", 0);
  }
  int timeout_ms = ExtractJsonIntField(requestJson, "timeoutMs", 12000);
  if (timeout_ms <= 0) {
    timeout_ms = 12000;
  }

  bool ok = true;
  std::string message;
  std::string output;
  std::string op_err;

  if (action == "appStorageRead") {
    if (!ReadUiStateBackup(&output, &op_err)) {
      ok = false;
      message = op_err;
    }
  } else if (action == "appStorageReadKey") {
    std::string saved_storage;
    if (!ReadUiStateBackup(&saved_storage, &op_err)) {
      ok = false;
      message = op_err;
    } else if (!storage_key.empty()) {
      output = ExtractJsonStringField(saved_storage, storage_key);
    }
  } else if (action == "appStorageReadKeyChunk") {
    std::string saved_storage;
    if (!ReadUiStateBackup(&saved_storage, &op_err)) {
      ok = false;
      message = op_err;
    } else if (!storage_key.empty()) {
      const std::string value = ExtractJsonStringField(saved_storage, storage_key);
      const size_t start = std::min(static_cast<size_t>(storage_offset), value.size());
      size_t end = std::min(start + static_cast<size_t>(storage_limit), value.size());
      while (end > start && end < value.size() &&
             (static_cast<unsigned char>(value[end]) & 0xC0) == 0x80) {
        --end;
      }
      output = value.substr(start, end - start);
      message = std::to_string(end) + "/" + std::to_string(value.size());
    }
  } else if (action == "appStorageWrite") {
    if (!WriteUiStateBackup(persisted_storage, &op_err)) {
      ok = false;
      message = op_err;
    }
  } else if (action == "status") {
    _runtime.Refresh(&op_err);
  } else if (action == "verifyModel") {
    if (!_runtime.VerifyModel(&op_err)) {
      ok = false;
      message = op_err;
    }
  } else if (action == "importModel") {
    if (importPath.empty()) {
      ok = false;
      message = "Model import cancelled.";
    } else if (!_runtime.ImportModelFromPath(importPath, &op_err)) {
      ok = false;
      message = op_err;
    } else {
      message = "Model imported successfully.";
    }
  } else if (action == "infer") {
    if (prompt.empty()) {
      ok = false;
      message = "Prompt is empty.";
    } else {
      output = _runtime.Generate(prompt, &op_err, max_tokens, grammar);
      if (!op_err.empty()) {
        ok = false;
        message = op_err;
      }
    }
  } else if (action == "openAiCompatibleProxy") {
    if (!IsTruthyEnv(std::getenv("AI_EXE_ENABLE_REMOTE_PROVIDERS"))) {
      ok = false;
      message = "Remote inference providers are disabled in this offline build.";
    } else if (endpoint_url.empty()) {
      ok = false;
      message = "Endpoint URL is empty.";
    } else if (request_body.empty()) {
      ok = false;
      message = "Request body is empty.";
    } else {
      long status_code = 0;
      if (!PostJsonHttp(endpoint_url, auth_header, request_body, timeout_ms,
                        &status_code, &output, &op_err)) {
        ok = false;
        message = op_err.empty() ? "Network request failed." : op_err;
      } else if (status_code < 200 || status_code >= 300) {
        ok = false;
        std::ostringstream msg;
        msg << "HTTP " << status_code;
        const std::string trimmed = TrimCopy(output);
        if (!trimmed.empty()) {
          msg << ": " << trimmed;
        }
        message = msg.str();
      }
    }
  } else if (action == "dictateOffline") {
    if (!RunOfflineDictationOnMac(locale, timeout_ms, &output, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Offline dictation failed." : op_err;
    }
  } else if (action == "dictationStart") {
    if (!StartOfflineDictationSessionOnMac(locale, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to start dictation session." : op_err;
    } else {
      message = "Dictation session started.";
    }
  } else if (action == "dictationFinalize") {
    if (!FinalizeOfflineDictationSessionOnMac(timeout_ms, &output, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Dictation finalize failed." : op_err;
    }
  } else if (action == "dictationCancel") {
    CancelOfflineDictationSessionOnMac();
    message = "Dictation session cancelled.";
  } else if (action == "dictationLevel") {
    output = std::to_string(GetOfflineDictationLevelOnMac());
  } else if (action == "workspaceList") {
    if (!BuildWorkspaceListOutput(_runtime, workspace_path, &output, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to list workspace." : op_err;
    }
  } else if (action == "workspaceMkdir") {
    if (!WorkspaceMakeDirectory(_runtime, workspace_path, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to create folder." : op_err;
    } else {
      message = "Folder created.";
    }
  } else if (action == "workspaceWriteFile") {
    if (!WorkspaceWriteFile(_runtime, workspace_path, workspace_content,
                            &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to write file." : op_err;
    } else {
      message = "File saved.";
    }
  } else if (action == "appendDebugLog") {
    const std::string channel =
        ExtractJsonStringField(requestJson, "channel");
    const std::string entry_json =
        ExtractJsonStringField(requestJson, "entry");
    if (!_runtime.AppendDebugLog(channel, entry_json, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to append debug log." : op_err;
    } else {
      message = "Debug log appended.";
    }
  } else if (action == "readDebugLog") {
    const std::string channel =
        ExtractJsonStringField(requestJson, "channel");
    const std::string max_bytes_str =
        ExtractJsonStringField(requestJson, "maxBytes");
    const long max_bytes = strtol(max_bytes_str.c_str(), nullptr, 10);
    if (!_runtime.ReadDebugLog(channel,
                               max_bytes > 0 ? static_cast<size_t>(max_bytes) : 0,
                               &output, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to read debug log." : op_err;
    }
  } else if (action == "workspaceReadFile") {
    if (!WorkspaceReadFile(_runtime, workspace_path, &output, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to read file." : op_err;
    }
  } else if (action == "workspaceMove") {
    if (!WorkspaceMoveEntry(_runtime, workspace_src_path, workspace_dst_path,
                            &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to move item." : op_err;
    } else {
      message = "Moved.";
    }
  } else if (action == "workspaceTrash") {
    if (!WorkspaceTrashEntry(_runtime, workspace_path, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to move item to Trash." : op_err;
    } else {
      message = "Moved to Trash.";
    }
  } else if (action == "workspaceReveal") {
    if (!WorkspaceRevealEntry(_runtime, workspace_path, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to open workspace in Finder." : op_err;
    } else {
      message = "Workspace opened in Finder.";
    }
  } else if (action == "workspaceOpenRoot") {
    if (workspaceRootPath.empty()) {
      ok = false;
      message = "Folder selection cancelled.";
    } else if (!SetWorkspaceRootOverride(workspaceRootPath, &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to open selected folder." : op_err;
    } else {
      message = "Project folder opened.";
    }
  } else if (action == "workspaceRestoreRoot") {
    const std::string root_path_str =
        ExtractJsonStringField(requestJson, "rootPath");
    if (root_path_str.empty()) {
      ok = false;
      message = "No root path provided.";
    } else if (!SetWorkspaceRootOverride(std::filesystem::path(root_path_str),
                                         &op_err)) {
      ok = false;
      message = op_err.empty() ? "Failed to restore project folder." : op_err;
    } else {
      message = "Project folder restored.";
    }
  } else if (action == "workspaceNewProject") {
    // Create a new project folder in ~/Downloads and set it as root.
    NSString *requestedName =
        [NSString stringWithUTF8String:ExtractJsonStringField(requestJson, "name").c_str()];
    NSString *dlDir = [NSSearchPathForDirectoriesInDomains(
        NSDownloadsDirectory, NSUserDomainMask, YES) firstObject];
    if (!dlDir) {
      ok = false;
      message = "Could not locate Downloads folder.";
    } else {
      // Build a unique folder name.
      NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
      [fmt setDateFormat:@"yyyy-MM-dd"];
      NSString *dateSuffix = [fmt stringFromDate:[NSDate date]];
      NSString *cleanName = @"";
      if (requestedName.length > 0) {
        NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
            @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_"];
        NSMutableString *filtered = [NSMutableString string];
        BOOL lastWasSpace = NO;
        for (NSUInteger i = 0; i < requestedName.length; i++) {
          unichar c = [requestedName characterAtIndex:i];
          if ([allowed characterIsMember:c]) {
            if (c == ' ' || c == '-' || c == '_') {
              if (filtered.length > 0 && !lastWasSpace) {
                [filtered appendString:@" "];
                lastWasSpace = YES;
              }
            } else {
              [filtered appendFormat:@"%C", c];
              lastWasSpace = NO;
            }
          }
        }
        cleanName = [[filtered stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceCharacterSet]] substringToIndex:
            MIN((NSUInteger)48, [[filtered stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceCharacterSet]] length])];
      }
      NSString *baseName =
          cleanName.length > 0
            ? cleanName
            : [NSString stringWithFormat:@"New Project %@", dateSuffix];
      NSString *folderPath = [dlDir stringByAppendingPathComponent:baseName];
      NSFileManager *fm = [NSFileManager defaultManager];
      int counter = 1;
      while ([fm fileExistsAtPath:folderPath]) {
        NSString *numbered =
            [NSString stringWithFormat:@"%@ (%d)", baseName, counter++];
        folderPath = [dlDir stringByAppendingPathComponent:numbered];
      }
      NSError *mkErr = nil;
      if (![fm createDirectoryAtPath:folderPath
              withIntermediateDirectories:YES
                               attributes:nil
                                    error:&mkErr]) {
        ok = false;
        message = std::string("Failed to create project folder: ") +
                  [[mkErr localizedDescription] UTF8String];
      } else {
        // Set this new folder as workspace root.
        std::filesystem::path newRoot([folderPath UTF8String]);
        if (!SetWorkspaceRootOverride(newRoot, &op_err)) {
          ok = false;
          message =
              op_err.empty() ? "Created folder but failed to open it." : op_err;
        } else {
          message = "New project created.";
          // Include the new root path in status for the JS side.
        }
      }
    }
  } else if (action == "workspaceCloseRoot") {
    ClearWorkspaceRootOverride();
    message = "Project closed.";
  } else if (action == "runWorkspaceApp") {
    const std::filesystem::path root = WorkspaceRootOrEmpty();
    if (root.empty()) {
      ok = false;
      message = "No project is open to run.";
    } else {
      const RunTarget target = DetectRunTarget(root);
      if (target.kind == RunTargetKind::kViteWeb) {
        const int port = StableVitePortForRoot(root);
        output = "http://127.0.0.1:" + std::to_string(port) + "/";
        if (IsLoopbackTcpPortOpen(port)) {
          NSURL *appUrl = [NSURL URLWithString:[NSString stringWithUTF8String:output.c_str()]];
          if (appUrl) {
            [[NSWorkspace sharedWorkspace] openURL:appUrl];
          }
          message = "Vite dev server already running.";
        } else if (LaunchViteDevServerMac(root, port, &op_err)) {
          message = "Starting Vite dev server.";
        } else {
          ok = false;
          message = op_err.empty() ? "Could not run the Vite project." : op_err;
        }
      } else if (target.kind == RunTargetKind::kWeb) {
        std::string url = StartLocalAppServer(root, &op_err);
        if (url.empty()) {
          ok = false;
          message = op_err.empty() ? "Could not start the local app server." : op_err;
        } else {
          const std::string rel = target.entry.filename().string();
          if (rel != "index.html") url += rel;  // base URL already ends with '/'
          NSURL *appUrl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
          if (appUrl) {
            [[NSWorkspace sharedWorkspace] openURL:appUrl];
          }
          output = url;
          message = "App running.";
        }
      } else if (target.kind == RunTargetKind::kPython) {
        const std::string entry = target.entry.filename().string();
        if (LaunchPythonConsoleMac(root, entry, &op_err)) {
          output = entry;
          message = std::string("Running ") + entry + " in Terminal.";
        } else {
          ok = false;
          message = op_err.empty() ? "Could not run the Python project." : op_err;
        }
      } else {
        ok = false;
        message = "Nothing to run here — add an index.html (web app) or a .py file (Python).";
      }
    }
  } else if (action == "runCommand") {
    const std::filesystem::path root = WorkspaceRootOrEmpty();
    const std::string program = ExtractJsonStringField(requestJson, "program");
    const std::string args_line = ExtractJsonStringField(requestJson, "argsLine");
    if (root.empty()) {
      ok = false;
      message = "No project is open.";
    } else {
      std::vector<std::string> args;
      std::string token;
      std::istringstream iss(args_line);
      while (std::getline(iss, token, '\n')) {
        if (!token.empty()) args.push_back(token);
      }
      const CommandRunResult cr = RunProjectCommand(root, program, args, 60);
      if (!cr.err.empty()) {
        ok = false;
        message = cr.err;
      } else {
        output = cr.output;
        message = cr.timed_out ? "timed_out" : ("exit_code=" + std::to_string(cr.exit_code));
      }
    }
  } else if (action == "devServerStart") {
    const std::filesystem::path root = WorkspaceRootOrEmpty();
    const std::string program = ExtractJsonStringField(requestJson, "program");
    const std::string args_line = ExtractJsonStringField(requestJson, "argsLine");
    const std::string display = ExtractJsonStringField(requestJson, "display");
    if (root.empty()) {
      ok = false;
      message = "No project is open.";
    } else {
      std::vector<std::string> args;
      std::string token;
      std::istringstream iss(args_line);
      while (std::getline(iss, token, '\n')) {
        if (!token.empty()) args.push_back(token);
      }
      std::string resolve_err;
      const std::filesystem::path exe = ResolveProjectProgramExe(root, program, &resolve_err);
      if (exe.empty()) {
        ok = false;
        message = resolve_err;
      } else {
        std::string start_err;
        const int sid = DevServerManager::Instance().Start(
            exe, args, root, display.empty() ? program : display, &start_err);
        if (sid <= 0) {
          ok = false;
          message = start_err.empty() ? "Could not start the dev server." : start_err;
        } else {
          output = std::to_string(sid);
          message = "started";
        }
      }
    }
  } else if (action == "devServerStatus") {
    const int sid = ExtractJsonIntField(requestJson, "serverId", 0);
    DevServerInfo info;
    if (!DevServerManager::Instance().Status(sid, &info)) {
      ok = false;
      message = "No such dev server.";
    } else {
      output = info.log_tail;
      message = std::string(info.running ? "running" : "exited")
          + " pid=" + std::to_string(info.pid)
          + " exit_code=" + std::to_string(info.exit_code);
    }
  } else if (action == "devServerStop") {
    const int sid = ExtractJsonIntField(requestJson, "serverId", 0);
    if (sid <= 0 || !DevServerManager::Instance().Stop(sid)) {
      ok = false;
      message = "No such dev server.";
    } else {
      message = "stopped";
    }
  } else if (action == "devServerList") {
    std::string lines;
    for (const auto& info : DevServerManager::Instance().List()) {
      lines += std::to_string(info.id) + "\t" + (info.running ? "running" : "exited")
          + "\t" + std::to_string(info.pid) + "\t" + info.command + "\n";
    }
    output = lines;
    message = "ok";
  } else if (action == "windowMoveBy") {
    if (!_window) {
      ok = false;
      message = "Window is unavailable.";
    } else {
      double dx = 0.0;
      double dy = 0.0;
      try {
        dx = window_dx.empty() ? 0.0 : std::stod(window_dx);
      } catch (...) {
        dx = 0.0;
      }
      try {
        dy = window_dy.empty() ? 0.0 : std::stod(window_dy);
      } catch (...) {
        dy = 0.0;
      }
      if (std::abs(dx) > 0.01 || std::abs(dy) > 0.01) {
        auto applyMove = ^{
          NSRect frame = [_window frame];
          NSPoint origin = frame.origin;
          origin.x += static_cast<CGFloat>(dx);
          origin.y -= static_cast<CGFloat>(dy);
          [_window setFrameOrigin:origin];
        };
        if ([NSThread isMainThread]) {
          applyMove();
        } else {
          dispatch_sync(dispatch_get_main_queue(), applyMove);
        }
      }
      message = "Window moved.";
    }
  } else {
    ok = false;
    message = "Unsupported action.";
  }

  if (!_runtimeInitError.empty() && message.empty()) {
    message = _runtimeInitError;
  }

  WebRuntimeStatus current_status = _runtime.GetStatus();
  current_status.root_path = WorkspaceRootOrEmpty().string();
  return BuildResponse(id, action, ok, message, output, current_status);
}

- (std::string)handleUiRequest:(const std::string &)requestJson {
  return [self handleUiRequest:requestJson
                    importPath:std::filesystem::path()
             workspaceRootPath:std::filesystem::path()];
}

- (void)postResponseToWeb:(const std::string &)responseJson {
  if (!_webView) {
    return;
  }
  NSString *json = [NSString stringWithUTF8String:responseJson.c_str()];
  if (!json) {
    return;
  }
  NSString *script =
      [NSString stringWithFormat:@"window.__aiExeOnNativeMessage(%@);", json];
  [_webView evaluateJavaScript:script completionHandler:nil];
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
  (void)userContentController;
  if (![[message name] isEqualToString:@"aiexe"]) {
    return;
  }

  NSString *body = nil;
  if ([[message body] isKindOfClass:[NSString class]]) {
    body = (NSString *)[message body];
  } else {
    body = [[NSString alloc]
        initWithData:[NSJSONSerialization dataWithJSONObject:[message body]
                                                     options:0
                                                       error:nil]
            encoding:NSUTF8StringEncoding];
  }

  if (!body) {
    return;
  }

  const std::string req([body UTF8String]);
  const std::string action = ExtractJsonStringField(req, "action");
  const std::string req_id = ExtractJsonStringField(req, "id");

  if (action == "inferStream") {
    const std::string prompt = ExtractJsonStringField(req, "prompt");
    const std::string grammar = ExtractJsonStringField(req, "grammar");
    int max_tokens = ExtractJsonIntField(req, "maxTokens", 0);
    if (max_tokens <= 0) {
      max_tokens = ExtractJsonIntField(req, "max_tokens", 0);
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      WebRuntimeStatus stream_status = _runtime.GetStatus();
      stream_status.root_path = WorkspaceRootOrEmpty().string();
      std::string final_output;
      std::string op_err;
      const bool ok = _runtime.GenerateStream(
          prompt,
          [self, req_id, stream_status](const std::string &delta) {
            if (delta.empty()) {
              return;
            }
            const std::string chunk =
                BuildStreamEvent(req_id, false, delta, true, std::string(),
                                 std::string(), stream_status);
            dispatch_async(dispatch_get_main_queue(), ^{
              [self postResponseToWeb:chunk];
            });
          },
          &final_output, &op_err, max_tokens, grammar);

      std::string message = op_err;
      if (!_runtimeInitError.empty() && message.empty()) {
        message = _runtimeInitError;
      }
      WebRuntimeStatus final_status = _runtime.GetStatus();
      final_status.root_path = WorkspaceRootOrEmpty().string();
      const std::string done = BuildStreamEvent(
          req_id, true, std::string(), ok, message, final_output, final_status);
      dispatch_async(dispatch_get_main_queue(), ^{
        [self postResponseToWeb:done];
      });
    });
    return;
  }

  if (action == "importModel") {
    const auto chosen = [self promptModelImportPath];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      const std::string response =
          [self handleUiRequest:req
                     importPath:chosen
              workspaceRootPath:std::filesystem::path()];
      dispatch_async(dispatch_get_main_queue(), ^{
        [self postResponseToWeb:response];
      });
    });
    return;
  }

  if (action == "workspaceOpenRoot") {
    const auto chosen = [self promptWorkspaceFolderPath];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      const std::string response = [self handleUiRequest:req
                                              importPath:std::filesystem::path()
                                       workspaceRootPath:chosen];
      dispatch_async(dispatch_get_main_queue(), ^{
        [self postResponseToWeb:response];
      });
    });
    return;
  }

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    const std::string response = [self handleUiRequest:req];
    dispatch_async(dispatch_get_main_queue(), ^{
      [self postResponseToWeb:response];
    });
  });
}

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:
                 (void (^)(NSArray<NSURL *> *_Nullable))completionHandler {
  (void)webView;
  (void)frame;
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  [panel setCanChooseFiles:YES];
  [panel setCanChooseDirectories:parameters.allowsDirectories];
  [panel setAllowsMultipleSelection:parameters.allowsMultipleSelection];
  NSWindow *window = _window;
  [panel beginSheetModalForWindow:window
                completionHandler:^(NSInteger result) {
                  completionHandler(result == NSModalResponseOK ? [panel URLs]
                                                                : nil);
                }];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;

  [self installMainMenu];

  NSRect frame =
      NSMakeRect(0, 0, kUiDefaultWindowWidth, kUiDefaultWindowHeight);
  _window = [[NSWindow alloc]
      initWithContentRect:frame
                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                           NSWindowStyleMaskResizable |
                           NSWindowStyleMaskMiniaturizable |
                           NSWindowStyleMaskFullSizeContentView)
                  backing:NSBackingStoreBuffered
                    defer:NO];
  [_window setTitle:@"AI.EXE"];
  [_window setTitleVisibility:NSWindowTitleHidden];
  [_window setTitlebarAppearsTransparent:YES];
  if ([_window respondsToSelector:@selector(setToolbarStyle:)]) {
    [_window setToolbarStyle:NSWindowToolbarStyleUnifiedCompact];
  }
  [_window setMovableByWindowBackground:YES];
  [_window
      setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
  [_window setBackgroundColor:[NSColor colorWithSRGBRed:0.04
                                                  green:0.05
                                                   blue:0.08
                                                  alpha:1.0]];
  [_window setContentMinSize:NSMakeSize(kUiMinWindowWidth, kUiMinWindowHeight)];
  NSWindowFrameAutosaveName autosaveName = @"AI_EXE_MAIN_WINDOW";
  const BOOL restoredFrame = [_window setFrameUsingName:autosaveName];
  [_window setFrameAutosaveName:autosaveName];
  if (!restoredFrame) {
    [_window center];
  }
  [_window setDelegate:self];

  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
  WKUserContentController *controller = [[WKUserContentController alloc] init];
  std::string saved_ui_state;
  std::string saved_ui_state_err;
  if (ReadUiStateBackup(&saved_ui_state, &saved_ui_state_err) && !saved_ui_state.empty()) {
    NSData *backup_data = [NSData dataWithBytes:saved_ui_state.data()
                                          length:saved_ui_state.size()];
    NSError *backup_error = nil;
    id parsed_backup = [NSJSONSerialization JSONObjectWithData:backup_data
                                                       options:0
                                                         error:&backup_error];
    if (!backup_error && [parsed_backup isKindOfClass:[NSDictionary class]]) {
      NSDictionary *backup = (NSDictionary *)parsed_backup;
      [backup enumerateKeysAndObjectsUsingBlock:^(id raw_key, id raw_value, BOOL *stop) {
        (void)stop;
        if (![raw_key isKindOfClass:[NSString class]] ||
            ![raw_value isKindOfClass:[NSString class]]) return;
        NSString *key = (NSString *)raw_key;
        NSString *value = (NSString *)raw_value;
        NSUInteger offset = 0;
        while (offset < value.length) {
          const NSUInteger wanted = MIN((NSUInteger)24000, value.length - offset);
          NSRange range = [value rangeOfComposedCharacterSequencesForRange:NSMakeRange(offset, wanted)];
          NSString *chunk = [value substringWithRange:range];
          NSData *pair_data = [NSJSONSerialization dataWithJSONObject:@[ key, chunk ] options:0 error:nil];
          NSString *pair_json = [[NSString alloc] initWithData:pair_data encoding:NSUTF8StringEncoding];
          NSString *source = [NSString stringWithFormat:
              @"(function(){var p=%@,s=window.__aiExeStorageRestore||(window.__aiExeStorageRestore={});s[p[0]]=(s[p[0]]||'')+p[1];})();",
              pair_json];
          [controller addUserScript:[[WKUserScript alloc]
              initWithSource:source
               injectionTime:WKUserScriptInjectionTimeAtDocumentStart
            forMainFrameOnly:YES]];
          offset = NSMaxRange(range);
        }
      }];
      NSString *commit_restore =
          @"(function(){try{var s=window.__aiExeStorageRestore||{},changed=false;Object.keys(s).forEach(function(k){if(k.indexOf('ai_exe_')!==0)return;var saved=s[k],current=localStorage.getItem(k);if(k==='ai_exe_auth_v1'){try{var a=JSON.parse(saved||'{}'),b=JSON.parse(current||'{}'),users={},list=[];(a.users||[]).concat(b.users||[]).forEach(function(u){if(u&&u.usernameKey)users[u.usernameKey]=u;});Object.keys(users).forEach(function(id){list.push(users[id]);});var merged={users:list,currentUser:b.currentUser||a.currentUser||null};var next=JSON.stringify(merged);if(next!==current){localStorage.setItem(k,next);changed=true;}return;}catch(e){}}if(k.indexOf('ai_exe_chats_')===0){try{var oldChats=JSON.parse(saved||'[]'),newChats=JSON.parse(current||'[]'),byId={};oldChats.concat(newChats).forEach(function(chat){if(chat&&chat.id)byId[chat.id]=chat;});var mergedChats=Object.keys(byId).map(function(id){return byId[id];});if(mergedChats.length>newChats.length){localStorage.setItem(k,JSON.stringify(mergedChats));changed=true;}return;}catch(e){}}if(current===null){localStorage.setItem(k,saved);changed=true;}});delete window.__aiExeStorageRestore;if(changed&&sessionStorage.getItem('aiExeStorageRestoreReload')!=='1'){sessionStorage.setItem('aiExeStorageRestoreReload','1');location.reload();}}catch(e){}})();";
      [controller addUserScript:[[WKUserScript alloc]
          initWithSource:commit_restore
           injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
        forMainFrameOnly:YES]];
    }
  }
  [controller addScriptMessageHandler:self name:@"aiexe"];
  config.userContentController = controller;

  _webView = [[AiExeWebView alloc] initWithFrame:[[_window contentView] bounds]
                                  configuration:config];
  [_webView setUIDelegate:self];
  [_webView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
  [_webView setAllowsBackForwardNavigationGestures:NO];
  [[_window contentView] addSubview:_webView];

  [_window makeKeyAndOrderFront:nil];
  [_window makeFirstResponder:_webView];
  [self loadUiHtml];
  _backendTask = StartFastApiBackend(ResolveRuntimeRoot(_loadedHtmlPath));
  [self initializeRuntime];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    AppDelegate *delegate = [[AppDelegate alloc] init];
    [app setDelegate:delegate];
    [app run];
  }

  return 0;
}

#endif
