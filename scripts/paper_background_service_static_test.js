const fs = require('fs');
const assert = require('assert');

const ui = fs.readFileSync('ui/ai-exe.js', 'utf8');
const css = fs.readFileSync('ui/ai-exe.css', 'utf8');
const mac = fs.readFileSync('src/gui_main_mac_web.mm', 'utf8');
const windows = fs.readFileSync('src/gui_main_win_webview.cpp', 'utf8');
const launcher = fs.readFileSync('backend/launcher.py', 'utf8');

assert.match(ui, /Keep paper testing active in the background/);
assert.match(ui, /Paper simulation only\. It cannot place or confirm live orders/);
assert.match(ui, /nativeBridge\.invoke\('paperBackgroundService'/);
assert.match(ui, /nativeBridge\.invoke\('paperTestCloseGuard'/);
assert.match(ui, /isDesktopNativeUi\(\)/);
assert.match(ui, /system tray/);
assert.match(css, /\.paper-background-service/);
assert.match(mac, /com\.aiexe\.paper-background/);
assert.match(mac, /NSPropertyListSerialization/);
assert.match(mac, /@"KeepAlive": @YES/);
assert.match(mac, /action == "paperBackgroundService"/);
assert.match(mac, /NSStatusBar systemStatusBar/);
assert.match(mac, /windowShouldClose/);
assert.match(mac, /Paper testing is still running/);
assert.match(windows, /action == "paperBackgroundService"/);
assert.match(windows, /Shell_NotifyIconW/);
assert.match(windows, /kMsgPaperTrayIcon/);
assert.match(windows, /ConfirmQuitWithActivePaperTest/);
assert.match(windows, /HKEY_CURRENT_USER/);
assert.match(windows, /CurrentVersion\\\\Run/);
assert.match(windows, /CREATE_BREAKAWAY_FROM_JOB/);
assert.match(windows, /StartBackgroundBundledBackend/);
assert.match(windows, /StopOwnedBackendLocked/);
assert.match(windows, /RemoveStalePaperBackgroundServiceWindows/);
assert.match(launcher, /"--background" in sys\.argv\[1:\]/);
assert.match(launcher, /os\.environ\.pop\("AIEXE_PARENT_WATCH", None\)/);

console.log('paper background service static test: ok');
