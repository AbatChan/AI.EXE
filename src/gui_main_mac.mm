#ifdef __APPLE__

#import <Cocoa/Cocoa.h>

#include "app_config.h"
#include "diagnostics.h"
#include "inference_engine.h"
#include "logger.h"
#include "memory_store.h"
#include "rollback.h"
#include "sandbox.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::string DiagnosticsText(const DiagnosticReport& d) {
  std::ostringstream oss;
  oss << "=== Hardware Diagnostics ===\n";
  oss << "GPU present: " << (d.gpu_present ? "yes" : "no") << '\n';
  oss << "GPU name: " << (d.gpu_name.empty() ? "(unknown)" : d.gpu_name) << '\n';
  oss << "VRAM: " << Diagnostics::FormatBytes(d.vram_bytes) << '\n';
  oss << "System RAM: " << Diagnostics::FormatBytes(d.ram_bytes) << '\n';
  oss << "Free storage: " << Diagnostics::FormatBytes(d.free_storage_bytes) << '\n';
  oss << "CUDA driver: " << (d.cuda_driver_detected ? "detected" : "not detected") << '\n';
  if (d.cuda_driver_detected) {
    oss << "CUDA driver version: " << d.cuda_driver_version_text << " (raw " << d.cuda_driver_version << ")\n";
  }

  for (const auto& w : d.warnings) {
    oss << "[warn] " << w << '\n';
  }

  for (const auto& e : d.errors) {
    oss << "[error] " << e << '\n';
  }

  oss << "Diagnostics status: " << (d.ok ? "PASS" : "FAIL") << "\n";
  return oss.str();
}

std::string TrimLeft(const std::string& s) {
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) {
    ++i;
  }
  return s.substr(i);
}

std::vector<std::string> TailFileLines(const std::filesystem::path& file, std::size_t n) {
  std::vector<std::string> lines;
  if (n == 0) {
    return lines;
  }

  std::ifstream in(file);
  if (!in.good()) {
    return lines;
  }

  std::string line;
  while (std::getline(in, line)) {
    lines.push_back(line);
  }

  if (lines.size() <= n) {
    return lines;
  }

  return std::vector<std::string>(lines.end() - static_cast<std::ptrdiff_t>(n), lines.end());
}

std::string ExtractJsonStringField(const std::string& line, const std::string& key) {
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

NSString* ToNSString(const std::string& text) {
  NSString* out = [NSString stringWithUTF8String:text.c_str()];
  return out ? out : @"";
}

NSDictionary<NSAttributedStringKey, id>* OutputAttributes() {
  NSFont* font = [NSFont userFixedPitchFontOfSize:12.0];
  if (!font) {
    font = [NSFont monospacedSystemFontOfSize:12.0 weight:NSFontWeightRegular];
  }

  return @{
    NSForegroundColorAttributeName : [NSColor labelColor],
    NSFontAttributeName : font
  };
}

NSColor* ThemeColor(CGFloat r, CGFloat g, CGFloat b, CGFloat a = 1.0) {
  return [NSColor colorWithCalibratedRed:r / 255.0 green:g / 255.0 blue:b / 255.0 alpha:a];
}

void StyleCard(NSView* view, NSColor* bg, NSColor* border, CGFloat radius) {
  [view setWantsLayer:YES];
  view.layer.backgroundColor = bg.CGColor;
  view.layer.cornerRadius = radius;
  view.layer.borderWidth = 1.0;
  view.layer.borderColor = border.CGColor;
}

NSTextField* MakeLabel(NSString* text, CGFloat size, NSFontWeight weight, NSColor* color) {
  NSTextField* label = [[NSTextField alloc] initWithFrame:NSZeroRect];
  [label setBezeled:NO];
  [label setDrawsBackground:NO];
  [label setEditable:NO];
  [label setSelectable:NO];
  [label setStringValue:text ? text : @""];
  [label setTextColor:color ? color : [NSColor labelColor]];
  [label setFont:[NSFont systemFontOfSize:size weight:weight]];
  return label;
}

std::string FromNSString(NSString* text) {
  if (!text) {
    return std::string();
  }

  const char* utf8 = [text UTF8String];
  return utf8 ? std::string(utf8) : std::string();
}

bool LooksLikeProjectRoot(const std::filesystem::path& p) {
  std::error_code ec_data;
  const bool has_data = std::filesystem::exists(p / "data", ec_data);

  std::error_code ec_cmake;
  const bool has_cmake = std::filesystem::exists(p / "CMakeLists.txt", ec_cmake);
  return has_data || has_cmake;
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

std::filesystem::path ResolveRuntimeRoot() {
  std::error_code ec;
  const auto cwd = std::filesystem::current_path(ec);
  if (!ec) {
    const auto found = FindProjectRootFrom(cwd);
    if (!found.empty()) {
      return found;
    }
  }

  NSString* exec_path = [[NSBundle mainBundle] executablePath];
  if (exec_path) {
    const char* utf8 = [exec_path UTF8String];
    if (utf8) {
      const auto found = FindProjectRootFrom(std::filesystem::path(utf8));
      if (!found.empty()) {
        return found;
      }
    }
  }

  const char* home = std::getenv("HOME");
  if (home && home[0] != '\0') {
    return std::filesystem::path(home) / "AI_EXE_Preview";
  }

  return std::filesystem::temp_directory_path(ec);
}

class RuntimeController {
 public:
  RuntimeController() : cfg_(BuildDefaultConfig(ResolveRuntimeRoot())), logger_(cfg_.log_path) {}

  bool Initialize(std::string* out) {
    std::error_code ec;
    std::filesystem::create_directories(cfg_.model_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.runtime_backend_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.log_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.memory_path.parent_path(), ec);
    std::filesystem::create_directories(cfg_.snapshot_dir, ec);
    std::filesystem::create_directories(cfg_.sandbox_root, ec);

    if (!logger_.Initialize()) {
      *out = "Logger initialization failed.\n";
      return false;
    }

    logger_.Info("startup", "AI.EXE macOS GUI boot sequence started");

    startup_diag_ = Diagnostics::Run(cfg_);
    std::string message = DiagnosticsText(startup_diag_) + "\n";
    const bool diagnostics_ok = startup_diag_.ok;

    if (!diagnostics_ok) {
      logger_.Error("diagnostics", "Startup diagnostics failed (macOS GUI)");
      message += "System requirements not satisfied for production runtime on this machine.\n";
      message += "Preview mode enabled: UI remains interactive for development-only validation.\n";
    }

    memory_ = std::make_unique<MemoryStore>(cfg_.memory_path);
    std::string err;
    if (!memory_->Load(&err)) {
      logger_.Error("memory", err);
      *out = message + "Memory load failed: " + err + "\n";
      ready_ = false;
      return false;
    }

    rollback_ = std::make_unique<RollbackManager>(cfg_.snapshot_dir);
    if (!rollback_->EnsureDirectory(&err)) {
      logger_.Error("rollback", err);
      *out = message + "Rollback init failed: " + err + "\n";
      ready_ = false;
      return false;
    }

    sandbox_ = std::make_unique<Sandbox>(SandboxPolicy{{cfg_.sandbox_root, cfg_.memory_path.parent_path()},
                                                       cfg_.max_prompt_chars,
                                                       cfg_.max_runtime_seconds,
                                                       cfg_.max_child_memory_bytes,
                                                       cfg_.max_exec_output_bytes,
                                                       cfg_.max_child_cpu_percent});

    if (!inference_.LoadModel(cfg_.model_path, &err)) {
      logger_.Error("model", err);
      message += "Model load failed: " + err + "\n";
      if (diagnostics_ok) {
        *out = message;
        ready_ = false;
        return false;
      }
      message += "Preview mode: prompt responses will be limited until a valid local model is present.\n";
    } else {
      model_info_ = inference_.GetModelInfo();
      ConfigureBackend();
      logger_.Info("model", "Model loaded successfully (macOS GUI)");
    }
    ready_ = true;

    std::ostringstream oss;
    oss << message;
    if (inference_.IsLoaded()) {
      oss << "Model loaded: " << model_info_.path.string() << "\n"
          << "Model format: " << model_info_.format << "\n"
          << "Model size: " << Diagnostics::FormatBytes(model_info_.size_bytes) << "\n";
    } else {
      oss << "Model path: " << cfg_.model_path.string() << "\n"
          << "Model status: not loaded\n";
    }

    oss << "Backend: " << (inference_.IsBackendConfigured() ? inference_.BackendPath() : "unconfigured")
        << (backend_version_.empty() ? "" : " (" + backend_version_ + ")") << "\n"
        << "macOS preview dashboard ready.\n";

    *out = oss.str();
    return true;
  }

  std::string Prompt(const std::string& prompt) {
    if (!ready_) {
      return "Runtime is not ready on this machine.\n";
    }

    std::string err;
    if (!sandbox_->ValidatePrompt(prompt, &err)) {
      logger_.Error("prompt_blocked", err);
      return "Prompt blocked: " + err + "\n";
    }

    logger_.Info("inference", "Prompt received (macOS GUI)");
    return inference_.Generate(prompt) + "\n";
  }

  std::string Status() const {
    std::ostringstream oss;
    oss << "=== Runtime Status ===\n";
    oss << "Ready: " << (ready_ ? "yes" : "no") << "\n";
    oss << "Root: " << cfg_.root.string() << "\n";
    if (inference_.IsLoaded()) {
      oss << "Model: " << model_info_.path.string() << "\n";
      oss << "Model format: " << model_info_.format << "\n";
      oss << "Model size: " << Diagnostics::FormatBytes(model_info_.size_bytes) << "\n";
    } else {
      oss << "Model: not loaded (" << cfg_.model_path.string() << ")\n";
    }
    oss << "Backend path: " << (inference_.IsBackendConfigured() ? inference_.BackendPath() : "unconfigured")
        << "\n";
    oss << "Backend version: " << (backend_version_.empty() ? "unknown" : backend_version_) << "\n";
    oss << "Backend self-test: "
        << (backend_selftest_ok_ ? "OK" : (backend_selftest_details_.empty() ? "UNKNOWN" : "FAILED")) << "\n";
    if (!backend_selftest_ok_ && !backend_selftest_details_.empty()) {
      oss << "Backend detail: " << backend_selftest_details_ << "\n";
    }

    if (memory_) {
      oss << "Memory entries: " << memory_->All().size() << "\n";
    }
    if (rollback_) {
      oss << "Snapshots: " << rollback_->ListSnapshots().size() << "\n";
    }

    oss << "Sandbox root: " << cfg_.sandbox_root.string() << "\n";
    oss << "Log file: " << cfg_.log_path.string() << "\n";
    return oss.str();
  }

  std::string RerunDiagnostics() {
    startup_diag_ = Diagnostics::Run(cfg_);
    logger_.Info("diagnostics", startup_diag_.ok ? "Manual diagnostics pass (macOS GUI)"
                                                  : "Manual diagnostics fail (macOS GUI)");
    return DiagnosticsText(startup_diag_) + "\n";
  }

  std::string BackendStatus() const {
    std::ostringstream oss;
    if (inference_.IsBackendConfigured()) {
      oss << "configured: " << inference_.BackendPath() << "\n";
      oss << "version: " << (backend_version_.empty() ? "unknown" : backend_version_) << "\n";
      oss << "self-test: " << (backend_selftest_ok_ ? "OK" : "UNKNOWN/FAILED") << "\n";
    } else {
      oss << "not configured (placeholder inference active)\n";
      if (!backend_selftest_details_.empty()) {
        oss << "reason: " << backend_selftest_details_ << "\n";
      }
    }
    return oss.str();
  }

  std::string BackendSelfTest() {
    if (!inference_.IsBackendConfigured()) {
      std::ostringstream oss;
      oss << "backend is not configured\n";
      if (!backend_selftest_details_.empty()) {
        oss << "reason: " << backend_selftest_details_ << "\n";
      }
      return oss.str();
    }

    std::string details;
    if (inference_.RunBackendSelfTest(&details)) {
      backend_selftest_ok_ = true;
      backend_selftest_details_ = details;
      std::string version;
      if (inference_.QueryBackendVersion(&version)) {
        backend_version_ = version;
      }
      logger_.Info("backend", "Manual self-test passed (macOS GUI)");
      return "backend self-test OK: " + details +
             " (version: " + (backend_version_.empty() ? "unknown" : backend_version_) + ")\n";
    }

    inference_.DisableBackend();
    backend_selftest_ok_ = false;
    backend_version_.clear();
    backend_selftest_details_ = details;
    logger_.Error("backend", "Manual self-test failed (macOS GUI): " + details);
    return "backend self-test FAILED: " + details + " (backend disabled)\n";
  }

  std::string BackendReload() {
    ConfigureBackend();
    if (inference_.IsBackendConfigured() && backend_selftest_ok_) {
      return "backend reloaded: " + inference_.BackendPath() +
             " (self-test: OK, version: " + (backend_version_.empty() ? "unknown" : backend_version_) + ")\n";
    }

    return "backend reload failed: " + backend_selftest_details_ + "\n";
  }

  std::string Timeline(std::size_t count) const {
    const auto lines = TailFileLines(cfg_.log_path, count);
    if (lines.empty()) {
      return "(no timeline entries)\n";
    }

    std::ostringstream oss;
    for (const auto& entry : lines) {
      const auto ts = ExtractJsonStringField(entry, "ts");
      const auto level = ExtractJsonStringField(entry, "level");
      const auto event = ExtractJsonStringField(entry, "event");
      const auto message = ExtractJsonStringField(entry, "message");
      if (ts.empty() && event.empty()) {
        oss << entry << '\n';
      } else {
        oss << ts << " [" << level << "] " << event << " :: " << message << '\n';
      }
    }

    return oss.str();
  }

  bool IsReady() const { return ready_; }
  bool IsDiagnosticsOk() const { return startup_diag_.ok; }
  bool IsModelLoaded() const { return inference_.IsLoaded(); }
  bool IsBackendConfigured() const { return inference_.IsBackendConfigured(); }
  std::string RootPath() const { return cfg_.root.string(); }

 private:
  void ConfigureBackend() {
    InferenceBackendConfig backend_cfg;
    backend_cfg.executable = cfg_.runtime_backend_path;
    backend_cfg.timeout_seconds = cfg_.max_runtime_seconds;
    backend_cfg.memory_limit_bytes = cfg_.max_child_memory_bytes;
    backend_cfg.output_limit_bytes = cfg_.max_exec_output_bytes;
    backend_cfg.cpu_rate_percent = cfg_.max_child_cpu_percent;

    std::string backend_err;
    if (inference_.ConfigureBackend(backend_cfg, &backend_err)) {
      if (inference_.RunBackendSelfTest(&backend_selftest_details_)) {
        backend_selftest_ok_ = true;
        std::string version_text;
        if (inference_.QueryBackendVersion(&version_text)) {
          backend_version_ = version_text;
        } else {
          backend_version_ = "unknown";
        }
        logger_.Info("backend", "Local backend configured and healthy (macOS GUI): " + inference_.BackendPath());
        return;
      }

      backend_selftest_ok_ = false;
      backend_version_.clear();
      logger_.Error("backend", "Backend self-test failed (macOS GUI): " + backend_selftest_details_);
      inference_.DisableBackend();
      return;
    }

    backend_selftest_ok_ = false;
    backend_version_.clear();
    backend_selftest_details_ = backend_err;
    logger_.Info("backend", "Local backend not configured (macOS GUI): " + backend_err);
  }

  AppConfig cfg_;
  Logger logger_;
  InferenceEngine inference_;
  ModelInfo model_info_;
  DiagnosticReport startup_diag_;
  std::unique_ptr<Sandbox> sandbox_;
  std::unique_ptr<MemoryStore> memory_;
  std::unique_ptr<RollbackManager> rollback_;
  bool ready_ = false;
  bool backend_selftest_ok_ = false;
  std::string backend_selftest_details_;
  std::string backend_version_;
};

}  // namespace

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@end

@implementation AppDelegate {
  NSWindow* _window;
  NSView* _root;
  NSView* _topbar;
  NSTextField* _logoLabel;
  NSTextField* _logoVer;
  NSSearchField* _topSearch;
  NSButton* _topAdd;
  NSButton* _avatarBtn;
  NSVisualEffectView* _sidebar;
  NSView* _main;
  NSView* _rightSidebar;
  NSView* _rsHeader;
  NSView* _rsFiles;
  NSView* _rsBottom;
  NSTextField* _rsTitle;
  NSTextField* _rsBanner;
  NSButton* _rsNewProject;
  NSScrollView* _fileListScroll;
  NSTextView* _fileListView;
  NSTextField* _projInput;
  NSPopUpButton* _projType;
  NSButton* _projGenerate;
  NSView* _headerCard;
  NSView* _metricsCard;
  NSView* _composerCard;
  NSView* _consoleCard;
  NSTextField* _sidebarTitle;
  NSTextField* _sidebarSubtitle;
  NSTextField* _headerTitle;
  NSTextField* _headerSubtitle;
  NSTextField* _metricReadyValue;
  NSTextField* _metricModelValue;
  NSTextField* _metricBackendValue;
  NSTextField* _metricDiagValue;
  NSButton* _navDashboard;
  NSButton* _navDiag;
  NSButton* _navTimeline;
  NSButton* _navSettings;
  NSTextView* _output;
  NSScrollView* _outputScroll;
  NSTextField* _input;
  NSButton* _send;
  NSButton* _btnStatus;
  NSButton* _btnDiag;
  NSButton* _btnBackendStatus;
  NSButton* _btnBackendSelf;
  NSButton* _btnBackendReload;
  NSButton* _btnTimeline;
  NSButton* _btnClear;
  NSWindow* _settingsSheet;
  NSTextField* _timelineField;
  NSStepper* _timelineStepper;
  NSButton* _animationCheckbox;
  NSInteger _timelineDefaultLines;
  BOOL _animationsEnabled;
  NSInteger _projectCount;
  RuntimeController _runtime;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
  (void)sender;
  return YES;
}

- (NSButton*)makeSidebarButton:(NSString*)title action:(SEL)action {
  NSButton* btn = [NSButton buttonWithTitle:title target:self action:action];
  [btn setBezelStyle:NSBezelStyleRegularSquare];
  [btn setBordered:NO];
  [btn setWantsLayer:YES];
  btn.layer.backgroundColor = ThemeColor(32, 35, 45).CGColor;
  btn.layer.cornerRadius = 10.0;
  btn.layer.borderWidth = 1.0;
  btn.layer.borderColor = ThemeColor(56, 62, 80).CGColor;
  [btn setContentTintColor:ThemeColor(229, 231, 236)];
  [btn setFont:[NSFont systemFontOfSize:14 weight:NSFontWeightMedium]];
  return btn;
}

- (NSButton*)makeActionButton:(NSString*)title action:(SEL)action {
  NSButton* btn = [NSButton buttonWithTitle:title target:self action:action];
  [btn setBezelStyle:NSBezelStyleRegularSquare];
  [btn setBordered:NO];
  [btn setWantsLayer:YES];
  btn.layer.backgroundColor = ThemeColor(28, 34, 49).CGColor;
  btn.layer.cornerRadius = 10.0;
  btn.layer.borderWidth = 1.0;
  btn.layer.borderColor = ThemeColor(64, 74, 101).CGColor;
  [btn setContentTintColor:ThemeColor(224, 228, 238)];
  [btn setFont:[NSFont systemFontOfSize:13 weight:NSFontWeightSemibold]];
  return btn;
}

- (NSButton*)makeOutlineButton:(NSString*)title action:(SEL)action {
  NSButton* btn = [NSButton buttonWithTitle:title target:self action:action];
  [btn setBezelStyle:NSBezelStyleRegularSquare];
  [btn setBordered:NO];
  [btn setWantsLayer:YES];
  btn.layer.backgroundColor = ThemeColor(19, 23, 33).CGColor;
  btn.layer.cornerRadius = 8.0;
  btn.layer.borderWidth = 1.0;
  btn.layer.borderColor = ThemeColor(54, 62, 83).CGColor;
  [btn setContentTintColor:ThemeColor(216, 222, 236)];
  [btn setFont:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]];
  return btn;
}

- (void)appendFileEntry:(NSString*)line {
  if (!line || !_fileListView) {
    return;
  }
  NSString* withBreak = [line stringByAppendingString:@"\n"];
  NSAttributedString* attr = [[NSAttributedString alloc] initWithString:withBreak
                                                              attributes:@{
                                                                NSForegroundColorAttributeName : ThemeColor(214, 219, 231),
                                                                NSFontAttributeName : [NSFont systemFontOfSize:12 weight:NSFontWeightMedium]
                                                              }];
  [[_fileListView textStorage] appendAttributedString:attr];
  NSRange end = NSMakeRange([[_fileListView string] length], 0);
  [_fileListView scrollRangeToVisible:end];
}

- (void)refreshFilePanelHeader {
  if (_projectCount == 0) {
    [_rsBanner setStringValue:@"No projects yet. Generated files will appear here."];
  } else {
    NSString* msg = [NSString stringWithFormat:@"%ld project artifacts ready for local testing.",
                                               static_cast<long>(_projectCount)];
    [_rsBanner setStringValue:msg];
  }
}

- (void)refreshMetrics {
  [_metricReadyValue setStringValue:_runtime.IsReady() ? @"ONLINE" : @"OFFLINE"];
  [_metricModelValue setStringValue:_runtime.IsModelLoaded() ? @"LOADED" : @"MISSING"];
  [_metricBackendValue setStringValue:_runtime.IsBackendConfigured() ? @"CONFIGURED" : @"PLACEHOLDER"];
  [_metricDiagValue setStringValue:_runtime.IsDiagnosticsOk() ? @"PASS" : @"PREVIEW MODE"];

  [_metricReadyValue setTextColor:_runtime.IsReady() ? ThemeColor(102, 255, 173) : ThemeColor(255, 136, 136)];
  [_metricModelValue setTextColor:_runtime.IsModelLoaded() ? ThemeColor(102, 255, 173) : ThemeColor(255, 204, 128)];
  [_metricBackendValue setTextColor:_runtime.IsBackendConfigured() ? ThemeColor(102, 255, 173) : ThemeColor(255, 204, 128)];
  [_metricDiagValue setTextColor:_runtime.IsDiagnosticsOk() ? ThemeColor(102, 255, 173) : ThemeColor(255, 204, 128)];
}

- (void)appendOutput:(const std::string&)text {
  NSString* ns = ToNSString(text);
  NSAttributedString* attr = [[NSAttributedString alloc] initWithString:ns attributes:OutputAttributes()];
  [[_output textStorage] appendAttributedString:attr];
  NSRange end = NSMakeRange([[_output string] length], 0);
  [_output scrollRangeToVisible:end];
}

- (void)animateEntranceIfNeeded {
  if (!_animationsEnabled) {
    return;
  }

  NSArray<NSView*>* views = @[_topbar, _sidebar, _rightSidebar, _headerCard, _metricsCard, _composerCard, _consoleCard];
  for (NSView* view in views) {
    [view setAlphaValue:0.0];
  }

  [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
    [context setDuration:0.28];
    for (NSView* view in views) {
      [[view animator] setAlphaValue:1.0];
    }
  } completionHandler:^{}];
}

- (void)layoutUI {
  NSRect bounds = [_root bounds];

  const CGFloat outer = 12.0;
  const CGFloat gap = 12.0;
  const CGFloat topbarH = 56.0;
  const CGFloat sidebarWidth = 220.0;
  const CGFloat rightWidth = 300.0;

  [_topbar setFrame:NSMakeRect(outer, bounds.size.height - outer - topbarH, bounds.size.width - outer * 2.0, topbarH)];

  NSRect topbar = [_topbar bounds];
  [_logoLabel setFrame:NSMakeRect(16, topbar.size.height - 34, 120, 24)];
  [_logoVer setFrame:NSMakeRect(16, 8, 150, 12)];
  [_topSearch setFrame:NSMakeRect(176, 12, std::max<CGFloat>(220.0, topbar.size.width - 176 - 120), 32)];
  [_topAdd setFrame:NSMakeRect(topbar.size.width - 96, 12, 32, 32)];
  [_avatarBtn setFrame:NSMakeRect(topbar.size.width - 52, 12, 32, 32)];

  const CGFloat contentH = bounds.size.height - outer * 2.0 - topbarH - gap;
  const CGFloat contentY = outer;

  [_sidebar setFrame:NSMakeRect(outer, contentY, sidebarWidth, contentH)];
  [_rightSidebar setFrame:NSMakeRect(bounds.size.width - outer - rightWidth, contentY, rightWidth, contentH)];
  [_main setFrame:NSMakeRect(outer + sidebarWidth + gap, contentY,
                             bounds.size.width - (outer * 2.0) - sidebarWidth - rightWidth - gap * 2.0,
                             contentH)];

  NSRect side = [_sidebar bounds];
  [_sidebarTitle setFrame:NSMakeRect(18, side.size.height - 48, side.size.width - 36, 24)];
  [_sidebarSubtitle setFrame:NSMakeRect(18, side.size.height - 70, side.size.width - 36, 18)];

  const CGFloat navH = 34.0;
  const CGFloat navGap = 10.0;
  CGFloat navY = side.size.height - 120.0;
  [_navDashboard setFrame:NSMakeRect(18, navY, side.size.width - 36, navH)];
  navY -= (navH + navGap);
  [_navDiag setFrame:NSMakeRect(18, navY, side.size.width - 36, navH)];
  navY -= (navH + navGap);
  [_navTimeline setFrame:NSMakeRect(18, navY, side.size.width - 36, navH)];
  [_navSettings setFrame:NSMakeRect(18, 18, side.size.width - 36, navH)];

  NSRect right = [_rightSidebar bounds];
  const CGFloat rsGap = 10.0;
  const CGFloat rsHeaderH = 150.0;
  const CGFloat rsBottomH = 170.0;
  [_rsHeader setFrame:NSMakeRect(0, right.size.height - rsHeaderH, right.size.width, rsHeaderH)];
  [_rsBottom setFrame:NSMakeRect(0, 0, right.size.width, rsBottomH)];
  [_rsFiles setFrame:NSMakeRect(0, rsBottomH + rsGap, right.size.width, right.size.height - rsHeaderH - rsBottomH - rsGap * 2.0)];

  NSRect rsh = [_rsHeader bounds];
  [_rsTitle setFrame:NSMakeRect(12, rsh.size.height - 30, rsh.size.width - 24, 18)];
  [_rsBanner setFrame:NSMakeRect(12, 12, rsh.size.width - 24, rsh.size.height - 48)];

  NSRect rsf = [_rsFiles bounds];
  [_rsNewProject setFrame:NSMakeRect(12, rsf.size.height - 40, rsf.size.width - 24, 28)];
  [_fileListScroll setFrame:NSMakeRect(12, 12, rsf.size.width - 24, rsf.size.height - 56)];

  NSRect rsb = [_rsBottom bounds];
  [_projInput setFrame:NSMakeRect(12, rsb.size.height - 44, rsb.size.width - 24, 30)];
  [_projType setFrame:NSMakeRect(12, 14, 130, 28)];
  [_projGenerate setFrame:NSMakeRect(rsb.size.width - 12 - 140, 14, 140, 28)];

  NSRect main = [_main bounds];
  const CGFloat cardGap = 10.0;
  const CGFloat headerH = 86.0;
  const CGFloat metricsH = 74.0;
  const CGFloat composerH = 56.0;

  CGFloat y = main.size.height;
  y -= headerH;
  [_headerCard setFrame:NSMakeRect(0, y, main.size.width, headerH)];
  y -= cardGap + metricsH;
  [_metricsCard setFrame:NSMakeRect(0, y, main.size.width, metricsH)];
  y -= cardGap + composerH;
  [_composerCard setFrame:NSMakeRect(0, y, main.size.width, composerH)];
  y -= cardGap;
  [_consoleCard setFrame:NSMakeRect(0, 0, main.size.width, y)];

  NSRect header = [_headerCard bounds];
  [_headerTitle setFrame:NSMakeRect(14, header.size.height - 34, 340, 20)];
  [_headerSubtitle setFrame:NSMakeRect(14, header.size.height - 56, 620, 18)];
  NSArray<NSButton*>* topButtons = @[_btnStatus, _btnDiag, _btnBackendStatus, _btnBackendSelf,
                                      _btnBackendReload, _btnTimeline, _btnClear];
  const CGFloat btnGap = 8.0;
  const CGFloat btnH = 30.0;
  const CGFloat btnW = std::max<CGFloat>(108.0, (header.size.width - 14 * 2.0 - btnGap * 6.0) / 7.0);
  CGFloat x = 14.0;
  for (NSButton* b in topButtons) {
    [b setFrame:NSMakeRect(x, 12.0, btnW, btnH)];
    x += btnW + btnGap;
  }

  NSRect metrics = [_metricsCard bounds];
  CGFloat tileGap = 10.0;
  CGFloat tileW = (metrics.size.width - 18.0 * 2.0 - tileGap * 3.0) / 4.0;
  NSArray<NSTextField*>* valueLabels = @[_metricReadyValue, _metricModelValue, _metricBackendValue, _metricDiagValue];
  NSArray<NSString*>* titles = @[@"Runtime", @"Model", @"Backend", @"Diagnostics"];
  CGFloat tileX = 18.0;
  for (NSUInteger i = 0; i < valueLabels.count; ++i) {
    NSTextField* title = (NSTextField*)[[_metricsCard subviews] objectAtIndex:i * 2];
    NSTextField* value = valueLabels[i];
    [title setStringValue:titles[i]];
    [title setFrame:NSMakeRect(tileX + 10, metrics.size.height - 28, tileW - 20, 16)];
    [value setFrame:NSMakeRect(tileX + 10, 14, tileW - 20, 20)];
    tileX += tileW + tileGap;
  }

  NSRect composer = [_composerCard bounds];
  [_input setFrame:NSMakeRect(14, 12, composer.size.width - 14 * 3.0 - 130.0, 32)];
  [_send setFrame:NSMakeRect(composer.size.width - 14 - 130.0, 12, 130.0, 32)];

  NSRect console = [_consoleCard bounds];
  [_outputScroll setFrame:NSMakeRect(12, 12, console.size.width - 24, console.size.height - 24)];
  NSRect docBounds = [[_outputScroll contentView] bounds];
  [_output setFrame:NSMakeRect(0, 0, docBounds.size.width, docBounds.size.height)];
  [[_output textContainer] setContainerSize:NSMakeSize(docBounds.size.width, CGFLOAT_MAX)];
}

- (void)handleCommandInput:(NSString*)commandText {
  std::string input = TrimLeft(FromNSString(commandText));
  if (input.empty()) {
    return;
  }

  [self appendOutput:"> " + input + "\n"];

  if (input == ":status") {
    [self appendOutput:_runtime.Status() + "\n"];
    return;
  }

  if (input == ":diag") {
    [self appendOutput:_runtime.RerunDiagnostics() + "\n"];
    return;
  }

  if (input == ":backend-status") {
    [self appendOutput:_runtime.BackendStatus() + "\n"];
    return;
  }

  if (input == ":backend-selftest") {
    [self appendOutput:_runtime.BackendSelfTest() + "\n"];
    return;
  }

  if (input == ":backend-reload") {
    [self appendOutput:_runtime.BackendReload() + "\n"];
    return;
  }

  if (input.rfind(":timeline", 0) == 0) {
    std::size_t n = static_cast<std::size_t>(_timelineDefaultLines);
    if (input.size() > 9) {
      std::istringstream iss(input.substr(9));
      std::size_t parsed = 0;
      if (iss >> parsed) {
        n = parsed;
      }
    }
    [self appendOutput:_runtime.Timeline(n) + "\n"];
    return;
  }

  [self appendOutput:_runtime.Prompt(input)];
}

- (void)onSend:(id)sender {
  (void)sender;
  NSString* input = [_input stringValue];
  [_input setStringValue:@""];
  [self handleCommandInput:input];
}

- (void)onStatus:(id)sender {
  (void)sender;
  [self appendOutput:_runtime.Status() + "\n"];
  [self refreshMetrics];
}

- (void)onDiag:(id)sender {
  (void)sender;
  [self appendOutput:_runtime.RerunDiagnostics() + "\n"];
  [self refreshMetrics];
}

- (void)onBackendStatus:(id)sender {
  (void)sender;
  [self appendOutput:_runtime.BackendStatus() + "\n"];
  [self refreshMetrics];
}

- (void)onBackendSelf:(id)sender {
  (void)sender;
  [self appendOutput:_runtime.BackendSelfTest() + "\n"];
  [self refreshMetrics];
}

- (void)onBackendReload:(id)sender {
  (void)sender;
  [self appendOutput:_runtime.BackendReload() + "\n"];
  [self refreshMetrics];
}

- (void)onTimeline:(id)sender {
  (void)sender;
  [self appendOutput:_runtime.Timeline(static_cast<std::size_t>(_timelineDefaultLines)) + "\n"];
}

- (void)onClear:(id)sender {
  (void)sender;
  [_output setString:@""];
}

- (void)onNewProject:(id)sender {
  (void)sender;
  [_projInput becomeFirstResponder];
}

- (void)onGenerateProject:(id)sender {
  (void)sender;
  std::string desc = TrimLeft(FromNSString([_projInput stringValue]));
  if (desc.empty()) {
    [self appendOutput:"Project generation skipped: enter a description.\n"];
    return;
  }

  ++_projectCount;
  NSString* type = [_projType titleOfSelectedItem];
  NSString* filename = [NSString stringWithFormat:@"%@_%ld.%@",
                                                  [[type lowercaseString] stringByReplacingOccurrencesOfString:@" " withString:@""],
                                                  static_cast<long>(_projectCount),
                                                  [type isEqualToString:@"AI / ML"] ? @"pkl" :
                                                  [type isEqualToString:@"Mobile App"] ? @"apk" :
                                                  [type isEqualToString:@"Platform"] ? @"zip" :
                                                  [type isEqualToString:@"Web API"] ? @"tar.gz" : @"exe"];

  [self appendFileEntry:[NSString stringWithFormat:@"[%@] %@ · ready", type, filename]];
  [self refreshFilePanelHeader];
  [self appendOutput:"Project artifact generated in preview panel.\n"];
  [_projInput setStringValue:@""];
}

- (void)onNavDashboard:(id)sender {
  (void)sender;
  [self onStatus:nil];
}

- (void)onNavDiag:(id)sender {
  (void)sender;
  [self onDiag:nil];
}

- (void)onNavTimeline:(id)sender {
  (void)sender;
  [self onTimeline:nil];
}

- (void)onTimelineStepper:(id)sender {
  (void)sender;
  [_timelineField setIntegerValue:[_timelineStepper integerValue]];
}

- (void)openSettingsSheet {
  if (_settingsSheet) {
    [_window beginSheet:_settingsSheet completionHandler:nil];
    return;
  }

  _settingsSheet = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 460, 260)
                                                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
  [_settingsSheet setTitle:@"Settings"];

  NSView* content = [_settingsSheet contentView];
  StyleCard(content, ThemeColor(20, 23, 30), ThemeColor(58, 64, 82), 12.0);

  NSTextField* title = MakeLabel(@"Preview Settings", 18, NSFontWeightSemibold, ThemeColor(239, 241, 246));
  [title setFrame:NSMakeRect(22, 214, 220, 24)];
  [content addSubview:title];

  NSTextField* desc = MakeLabel(@"Local-only visual options for demo flow", 13, NSFontWeightRegular, ThemeColor(174, 180, 194));
  [desc setFrame:NSMakeRect(22, 194, 300, 18)];
  [content addSubview:desc];

  NSTextField* timelineLabel = MakeLabel(@"Timeline Lines", 13, NSFontWeightMedium, ThemeColor(220, 224, 235));
  [timelineLabel setFrame:NSMakeRect(22, 146, 120, 18)];
  [content addSubview:timelineLabel];

  _timelineField = [[NSTextField alloc] initWithFrame:NSMakeRect(150, 142, 60, 24)];
  [_timelineField setIntegerValue:static_cast<int>(_timelineDefaultLines)];
  [content addSubview:_timelineField];

  _timelineStepper = [[NSStepper alloc] initWithFrame:NSMakeRect(220, 142, 18, 24)];
  [_timelineStepper setMinValue:5];
  [_timelineStepper setMaxValue:200];
  [_timelineStepper setIncrement:1];
  [_timelineStepper setIntegerValue:static_cast<int>(_timelineDefaultLines)];
  [_timelineStepper setTarget:self];
  [_timelineStepper setAction:@selector(onTimelineStepper:)];
  [content addSubview:_timelineStepper];

  _animationCheckbox = [NSButton checkboxWithTitle:@"Enable UI animations" target:nil action:nil];
  [_animationCheckbox setState:_animationsEnabled ? NSControlStateValueOn : NSControlStateValueOff];
  [_animationCheckbox setFrame:NSMakeRect(22, 100, 220, 22)];
  [content addSubview:_animationCheckbox];

  NSButton* save = [self makeActionButton:@"Save" action:@selector(onSettingsSave:)];
  [save setFrame:NSMakeRect(330, 18, 108, 32)];
  [content addSubview:save];

  NSButton* cancel = [self makeActionButton:@"Cancel" action:@selector(onSettingsCancel:)];
  [cancel setFrame:NSMakeRect(212, 18, 108, 32)];
  [content addSubview:cancel];

  [_window beginSheet:_settingsSheet completionHandler:nil];
}

- (void)onNavSettings:(id)sender {
  (void)sender;
  [self openSettingsSheet];
}

- (void)onSettingsSave:(id)sender {
  (void)sender;
  NSInteger lines = [_timelineField integerValue];
  if (lines < 5) {
    lines = 5;
  }
  if (lines > 200) {
    lines = 200;
  }
  _timelineDefaultLines = lines;
  _animationsEnabled = ([_animationCheckbox state] == NSControlStateValueOn);
  [_window endSheet:_settingsSheet];

  std::ostringstream oss;
  oss << "Settings saved: timeline_lines=" << static_cast<int>(_timelineDefaultLines)
      << ", animations=" << (_animationsEnabled ? "on" : "off") << "\n";
  [self appendOutput:oss.str()];
}

- (void)onSettingsCancel:(id)sender {
  (void)sender;
  [_window endSheet:_settingsSheet];
}

- (void)windowDidResize:(NSNotification*)notification {
  (void)notification;
  [self layoutUI];
}

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;

  _timelineDefaultLines = 20;
  _animationsEnabled = YES;
  _projectCount = 0;

  NSRect frame = NSMakeRect(0, 0, 1340, 820);
  _window = [[NSWindow alloc] initWithContentRect:frame
                                         styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                    NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable)
                                           backing:NSBackingStoreBuffered
                                             defer:NO];
  [_window setTitle:@"AI.EXE Phase 1 Dashboard (macOS Preview)"];
  [_window setBackgroundColor:ThemeColor(12, 14, 18)];
  [_window center];
  [_window setDelegate:self];

  _root = [[NSView alloc] initWithFrame:[[_window contentView] bounds]];
  [_root setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
  [_root setWantsLayer:YES];
  _root.layer.backgroundColor = ThemeColor(12, 14, 18).CGColor;
  [_window setContentView:_root];

  _topbar = [[NSView alloc] initWithFrame:NSZeroRect];
  StyleCard(_topbar, ThemeColor(15, 19, 28), ThemeColor(52, 60, 79), 12.0);
  [_root addSubview:_topbar];

  _logoLabel = MakeLabel(@"AI.EXE", 20, NSFontWeightBold, ThemeColor(86, 245, 255));
  [_logoLabel setFont:[NSFont monospacedSystemFontOfSize:20 weight:NSFontWeightBold]];
  _logoVer = MakeLabel(@"v0.9.1-beta", 10, NSFontWeightRegular, ThemeColor(118, 128, 148));
  [_logoVer setFont:[NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightRegular]];
  [_topbar addSubview:_logoLabel];
  [_topbar addSubview:_logoVer];

  _topSearch = [[NSSearchField alloc] initWithFrame:NSZeroRect];
  [_topSearch setPlaceholderString:@"Search chats, files, projects..."];
  [_topSearch setWantsLayer:YES];
  _topSearch.layer.cornerRadius = 8.0;
  _topSearch.layer.borderWidth = 1.0;
  _topSearch.layer.borderColor = ThemeColor(57, 66, 88).CGColor;
  _topSearch.layer.backgroundColor = ThemeColor(17, 22, 32).CGColor;
  [_topbar addSubview:_topSearch];

  _topAdd = [self makeOutlineButton:@"+" action:nil];
  [_topAdd setFont:[NSFont systemFontOfSize:18 weight:NSFontWeightRegular]];
  [_topbar addSubview:_topAdd];

  _avatarBtn = [self makeOutlineButton:@"U" action:nil];
  [_avatarBtn setFont:[NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightBold]];
  [_topbar addSubview:_avatarBtn];

  _sidebar = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
  [_sidebar setMaterial:NSVisualEffectMaterialSidebar];
  [_sidebar setBlendingMode:NSVisualEffectBlendingModeWithinWindow];
  [_sidebar setState:NSVisualEffectStateActive];
  StyleCard(_sidebar, ThemeColor(16, 20, 30, 0.92), ThemeColor(52, 58, 76), 16.0);
  [_root addSubview:_sidebar];

  _main = [[NSView alloc] initWithFrame:NSZeroRect];
  [_main setWantsLayer:YES];
  _main.layer.backgroundColor = ThemeColor(12, 14, 18).CGColor;
  [_root addSubview:_main];

  _rightSidebar = [[NSView alloc] initWithFrame:NSZeroRect];
  StyleCard(_rightSidebar, ThemeColor(16, 20, 30, 0.92), ThemeColor(52, 58, 76), 16.0);
  [_root addSubview:_rightSidebar];

  _rsHeader = [[NSView alloc] initWithFrame:NSZeroRect];
  _rsFiles = [[NSView alloc] initWithFrame:NSZeroRect];
  _rsBottom = [[NSView alloc] initWithFrame:NSZeroRect];
  StyleCard(_rsHeader, ThemeColor(18, 22, 31), ThemeColor(56, 63, 84), 12.0);
  StyleCard(_rsFiles, ThemeColor(18, 22, 31), ThemeColor(56, 63, 84), 12.0);
  StyleCard(_rsBottom, ThemeColor(18, 22, 31), ThemeColor(56, 63, 84), 12.0);
  [_rightSidebar addSubview:_rsHeader];
  [_rightSidebar addSubview:_rsFiles];
  [_rightSidebar addSubview:_rsBottom];

  _rsTitle = MakeLabel(@"FILE SYSTEM", 11, NSFontWeightBold, ThemeColor(164, 172, 192));
  [_rsTitle setFont:[NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightBold]];
  _rsBanner = MakeLabel(@"No projects yet. Generated files will appear here.", 12, NSFontWeightRegular,
                        ThemeColor(142, 151, 171));
  [_rsBanner setLineBreakMode:NSLineBreakByWordWrapping];
  [_rsBanner setMaximumNumberOfLines:0];
  [_rsHeader addSubview:_rsTitle];
  [_rsHeader addSubview:_rsBanner];

  _rsNewProject = [self makeOutlineButton:@"New Project" action:@selector(onNewProject:)];
  [_rsFiles addSubview:_rsNewProject];

  _fileListView = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 280, 200)];
  [_fileListView setEditable:NO];
  [_fileListView setSelectable:YES];
  [_fileListView setRichText:NO];
  [_fileListView setFont:[NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular]];
  [_fileListView setTextColor:ThemeColor(214, 219, 231)];
  [_fileListView setBackgroundColor:ThemeColor(14, 17, 24)];
  [_fileListView setDrawsBackground:YES];

  _fileListScroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  [_fileListScroll setHasVerticalScroller:YES];
  [_fileListScroll setHasHorizontalScroller:NO];
  [_fileListScroll setBorderType:NSNoBorder];
  [_fileListScroll setWantsLayer:YES];
  _fileListScroll.layer.cornerRadius = 8.0;
  _fileListScroll.layer.borderWidth = 1.0;
  _fileListScroll.layer.borderColor = ThemeColor(60, 69, 92).CGColor;
  [_fileListScroll setDocumentView:_fileListView];
  [_rsFiles addSubview:_fileListScroll];

  _projInput = [[NSTextField alloc] initWithFrame:NSZeroRect];
  [_projInput setPlaceholderString:@"Describe software, AI model, mobile app, platform..."];
  [_projInput setWantsLayer:YES];
  _projInput.layer.backgroundColor = ThemeColor(13, 16, 23).CGColor;
  _projInput.layer.borderColor = ThemeColor(59, 68, 90).CGColor;
  _projInput.layer.borderWidth = 1.0;
  _projInput.layer.cornerRadius = 8.0;
  [_projInput setTextColor:ThemeColor(235, 238, 245)];
  [_rsBottom addSubview:_projInput];

  _projType = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
  [_projType addItemsWithTitles:@[@"Software", @"AI / ML", @"Mobile App", @"Platform", @"Web API"]];
  [_rsBottom addSubview:_projType];

  _projGenerate = [self makeActionButton:@"GENERATE.EXE" action:@selector(onGenerateProject:)];
  [_projGenerate setFont:[NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightBold]];
  [_rsBottom addSubview:_projGenerate];

  _sidebarTitle = MakeLabel(@"AI.EXE", 22, NSFontWeightBold, ThemeColor(239, 241, 246));
  _sidebarSubtitle = MakeLabel(@"Offline Control Shell", 13, NSFontWeightRegular, ThemeColor(176, 182, 196));
  [_sidebar addSubview:_sidebarTitle];
  [_sidebar addSubview:_sidebarSubtitle];

  _navDashboard = [self makeSidebarButton:@"Dashboard" action:@selector(onNavDashboard:)];
  _navDiag = [self makeSidebarButton:@"Diagnostics" action:@selector(onNavDiag:)];
  _navTimeline = [self makeSidebarButton:@"Timeline" action:@selector(onNavTimeline:)];
  _navSettings = [self makeSidebarButton:@"Settings" action:@selector(onNavSettings:)];
  [_sidebar addSubview:_navDashboard];
  [_sidebar addSubview:_navDiag];
  [_sidebar addSubview:_navTimeline];
  [_sidebar addSubview:_navSettings];

  _headerCard = [[NSView alloc] initWithFrame:NSZeroRect];
  _metricsCard = [[NSView alloc] initWithFrame:NSZeroRect];
  _composerCard = [[NSView alloc] initWithFrame:NSZeroRect];
  _consoleCard = [[NSView alloc] initWithFrame:NSZeroRect];
  StyleCard(_headerCard, ThemeColor(18, 22, 31), ThemeColor(58, 66, 87), 14.0);
  StyleCard(_metricsCard, ThemeColor(18, 22, 31), ThemeColor(58, 66, 87), 14.0);
  StyleCard(_composerCard, ThemeColor(18, 22, 31), ThemeColor(58, 66, 87), 14.0);
  StyleCard(_consoleCard, ThemeColor(14, 17, 24), ThemeColor(58, 66, 87), 14.0);
  [_main addSubview:_headerCard];
  [_main addSubview:_metricsCard];
  [_main addSubview:_composerCard];
  [_main addSubview:_consoleCard];

  _headerTitle = MakeLabel(@"Phase 1 Runtime Console", 18, NSFontWeightSemibold, ThemeColor(236, 239, 246));
  _headerSubtitle = MakeLabel(@"Sandboxed, offline, local diagnostics and execution controls", 12, NSFontWeightRegular,
                              ThemeColor(164, 171, 187));
  [_headerCard addSubview:_headerTitle];
  [_headerCard addSubview:_headerSubtitle];

  _btnStatus = [self makeActionButton:@"Status" action:@selector(onStatus:)];
  _btnDiag = [self makeActionButton:@"Diagnostics" action:@selector(onDiag:)];
  _btnBackendStatus = [self makeActionButton:@"Backend Status" action:@selector(onBackendStatus:)];
  _btnBackendSelf = [self makeActionButton:@"Backend SelfTest" action:@selector(onBackendSelf:)];
  _btnBackendReload = [self makeActionButton:@"Backend Reload" action:@selector(onBackendReload:)];
  _btnTimeline = [self makeActionButton:@"Timeline" action:@selector(onTimeline:)];
  _btnClear = [self makeActionButton:@"Clear" action:@selector(onClear:)];
  [_headerCard addSubview:_btnStatus];
  [_headerCard addSubview:_btnDiag];
  [_headerCard addSubview:_btnBackendStatus];
  [_headerCard addSubview:_btnBackendSelf];
  [_headerCard addSubview:_btnBackendReload];
  [_headerCard addSubview:_btnTimeline];
  [_headerCard addSubview:_btnClear];

  NSArray<NSString*>* metricTitles = @[@"Runtime", @"Model", @"Backend", @"Diagnostics"];
  NSMutableArray<NSTextField*>* metricValues = [[NSMutableArray alloc] init];
  for (NSString* metricTitle in metricTitles) {
    NSTextField* t = MakeLabel(metricTitle, 12, NSFontWeightMedium, ThemeColor(160, 168, 185));
    NSTextField* v = MakeLabel(@"-", 15, NSFontWeightSemibold, ThemeColor(229, 233, 242));
    [_metricsCard addSubview:t];
    [_metricsCard addSubview:v];
    [metricValues addObject:v];
  }
  _metricReadyValue = metricValues[0];
  _metricModelValue = metricValues[1];
  _metricBackendValue = metricValues[2];
  _metricDiagValue = metricValues[3];

  _input = [[NSTextField alloc] initWithFrame:NSZeroRect];
  [_input setPlaceholderString:@"Type prompt or command (:status, :diag, :timeline 20)"];
  [_input setTarget:self];
  [_input setAction:@selector(onSend:)];
  [_input setWantsLayer:YES];
  _input.layer.backgroundColor = ThemeColor(12, 14, 20).CGColor;
  _input.layer.borderColor = ThemeColor(68, 78, 105).CGColor;
  _input.layer.borderWidth = 1.0;
  _input.layer.cornerRadius = 10.0;
  [_input setTextColor:ThemeColor(235, 238, 245)];
  [_composerCard addSubview:_input];

  _send = [self makeActionButton:@"Send" action:@selector(onSend:)];
  [_composerCard addSubview:_send];

  _output = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 640, 420)];
  [_output setEditable:NO];
  [_output setSelectable:YES];
  [_output setRichText:NO];
  [_output setAutomaticQuoteSubstitutionEnabled:NO];
  [_output setAutomaticTextReplacementEnabled:NO];
  [_output setFont:[NSFont userFixedPitchFontOfSize:12.0]];
  [_output setTextColor:ThemeColor(222, 226, 236)];
  [_output setBackgroundColor:ThemeColor(14, 17, 24)];
  [_output setDrawsBackground:YES];
  [_output setVerticallyResizable:YES];
  [_output setHorizontallyResizable:NO];
  [[_output textContainer] setWidthTracksTextView:YES];
  [[_output textContainer] setContainerSize:NSMakeSize(640, CGFLOAT_MAX)];

  _outputScroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  [_outputScroll setHasVerticalScroller:YES];
  [_outputScroll setHasHorizontalScroller:NO];
  [_outputScroll setBorderType:NSNoBorder];
  [_outputScroll setWantsLayer:YES];
  _outputScroll.layer.cornerRadius = 10.0;
  _outputScroll.layer.borderWidth = 1.0;
  _outputScroll.layer.borderColor = ThemeColor(60, 69, 92).CGColor;
  _outputScroll.layer.backgroundColor = ThemeColor(14, 17, 24).CGColor;
  [_outputScroll setDocumentView:_output];
  [_consoleCard addSubview:_outputScroll];

  [self layoutUI];
  [self refreshFilePanelHeader];

  std::string init;
  const bool ready = _runtime.Initialize(&init);
  [self appendOutput:init + "\n"];
  [self refreshMetrics];

  if (!ready) {
    [_input setEnabled:NO];
    [_send setEnabled:NO];
  }

  [_window makeKeyAndOrderFront:nil];
  [self animateEntranceIfNeeded];
}

@end

int main(int argc, const char* argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication* app = [NSApplication sharedApplication];
    AppDelegate* delegate = [[AppDelegate alloc] init];
    [app setDelegate:delegate];
    [app run];
  }

  return 0;
}

#endif
