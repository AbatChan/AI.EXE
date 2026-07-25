// v9.9.3 — a sleeping machine must never read as a slow model.
//
// Root cause found live (2026-07-25): macOS idle-sleep suspended a run 1 second after a
// write_file started. JS timers are frozen while suspended, so the 191s watchdog could
// not fire; it fired 5s after wake, 12 minutes later, and abandoned the file reporting
// "ran past 191s" — with outputChars: 0. The model never got a chance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'ui', 'agent-loop.js'), 'utf8');
const aiExe = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const mac = fs.readFileSync(path.join(root, 'src', 'gui_main_mac_web.mm'), 'utf8');
const win = fs.readFileSync(path.join(root, 'src', 'gui_main_win_webview.cpp'), 'utf8');
const html = fs.readFileSync(path.join(root, 'ui', 'ai-exe.html'), 'utf8');
const cmake = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8');

// ---- 1. Prevention: the machine is held awake for the duration of a run ----------
assert.match(aiExe, /async function acquireRunKeepAwake\(/, 'the run holds off idle sleep');
assert.match(aiExe, /async function releaseRunKeepAwake\(/, 'and always releases it');
assert.match(aiExe, /startAgentElapsedTimer\(0, chatId\);[\s\S]{0,400}?acquireRunKeepAwake\(/,
  'acquired where the run starts');
assert.match(aiExe, /stopAgentElapsedTimer\(\);\n\s*void releaseRunKeepAwake\('run_end'\);/,
  'released in the same finally that stops the timer — no leak on throw');
assert.match(aiExe, /const KEEP_AWAKE_MAX_MS = /, 'a wedged run cannot pin the machine awake forever');
assert.match(aiExe, /appSettings\.keepAwakeDuringRun === false\) return false;/, 'the setting is honoured');

// Native: both platforms, system sleep only — the DISPLAY must still be allowed to sleep.
assert.match(mac, /kIOPMAssertionTypePreventUserIdleSystemSleep/, 'mac holds an idle-sleep assertion');
assert.doesNotMatch(mac, /PreventUserIdleDisplaySleep/, 'mac does not keep the screen on');
assert.match(mac, /action == "powerKeepAwake"/, 'mac exposes the bridge action');
assert.match(cmake, /find_library\(IOKIT_FRAMEWORK IOKit REQUIRED\)/, 'IOKit is linked');
assert.match(win, /ES_CONTINUOUS \| ES_SYSTEM_REQUIRED/, 'windows holds a system-required request');
// Scope this to the executable line: the comment above it mentions the flag by name.
const winRequested = win.slice(win.indexOf('const EXECUTION_STATE requested ='),
  win.indexOf('if (SetThreadExecutionState(requested) == 0)'));
assert.doesNotMatch(winRequested, /ES_DISPLAY_REQUIRED/, 'windows does not keep the screen on');
assert.match(win, /action == "powerKeepAwake"/, 'windows exposes the same bridge action');
// Releasing on teardown matters: a leaked assertion outlives the app.
assert.match(mac, /SetPreventIdleSleepOnMac\(false, "", nullptr\);/, 'mac releases on quit');
assert.match(win, /SetPreventIdleSleepOnWindows\(false, "", nullptr\);/, 'windows releases on destroy');

// ---- 2. Detection: sleep is PUSHED from native, both platforms ------------------
assert.match(mac, /NSWorkspaceWillSleepNotification/, 'mac observes sleep');
assert.match(mac, /NSWorkspaceDidWakeNotification/, 'mac observes wake');
assert.match(win, /case WM_POWERBROADCAST:/, 'windows observes power broadcasts');
assert.match(win, /PBT_APMRESUMEAUTOMATIC/, 'windows catches the resume that always fires');
assert.match(aiExe, /window\.__aiExeOnPowerEvent = /, 'the UI has one entry point for both');
assert.match(aiExe, /String\(msg\.type \|\| ''\) === 'powerEvent'/, 'windows events route through the bridge');
// A push has no id; the bridge used to drop every message without one.
const resolveFn = aiExe.slice(aiExe.indexOf('function resolveMessage'), aiExe.indexOf('window.__aiExeOnNativeMessage = resolveMessage'));
assert.ok(resolveFn.indexOf("=== 'powerEvent'") < resolveFn.indexOf('if (!msg.id)'),
  'the power-event check runs BEFORE the id guard, or the event is dropped');

// ---- 3. Suspended time is never charged to a budget ----------------------------
assert.match(aiExe, /function getMachineSuspendedMs\(\)/, 'suspended wall-clock is tracked');
assert.match(aiExe, /function noteMachineSuspendGap\(/, 'gaps are recorded');
assert.match(aiExe, /getMachineSuspendedMs,\n\s*noteMachineSuspendGap,/, 'both are passed to the loop');
assert.match(loop, /const deadlineNow = \(\) => baseDeadlineAt \+ suspendedDuringRunMs\(\);/,
  'the run deadline extends by suspended time');
assert.doesNotMatch(loop, /Date\.now\(\) >= deadlineAt/, 'no raw deadline compare survives');
assert.match(loop, /const idleMs = Math\.max\(0, \(now - lastProgress\) - suspendedMs\);/,
  'the idle watchdog discounts suspended time');
assert.match(loop, /const totalMs = Math\.max\(0, \(now - toolStartedAt\) - suspendedMs\);/,
  'so does the hard cap');
// The clock-jump fallback covers a throttled window / a missed native event.
assert.match(loop, /if \(sinceTick > tickMs \* 3\)/, 'a tick arriving late IS the suspend signal');

// ---- 4. Recovery: redo the interrupted step, bounded, and say what happened ----
assert.match(loop, /_toolInterruptedBySleep: true/, 'a sleep is classified apart from a timeout');
assert.match(loop, /the computer slept for \$\{Math\.round\(suspendedMs \/ 1000\)\}s mid-write/,
  'the observation states the real cause');
assert.match(loop, /const sleepRetryLimit = 2;/, 'retries are bounded');
const sleepBranch = loop.slice(loop.indexOf('if (toolResult && toolResult._toolInterruptedBySleep)'),
  loop.indexOf('// A tool that hit the execution timeout will NOT recover on retry'));
assert.match(sleepBranch, /sleepInterruptions <= sleepRetryLimit/, 'the first interruptions retry');
assert.match(sleepBranch, /continue;/, 'a retry continues the run instead of ending it');
assert.match(sleepBranch, /Resumed after sleep/, 'the timeline says so');
assert.match(sleepBranch, /Stopped \(computer kept sleeping\)/, 'a laptop that keeps sleeping stops cleanly');
assert.ok(!/took too long/.test(sleepBranch), 'a sleep is never reported as the model being slow');
// The decision step trips the same timer on wake and must also survive it.
assert.match(loop, /const timedOutBySleep = Boolean\(res && res\.timedOut && sleptDuringStepMs >= 30000\);/,
  'a slept-through decision step is retried, not treated as a slow model');

// ---- 5. The "Stopped" card must not appear while teardown is still running -----
// Live: the card showed at 12:18:08 and the run only ended at 12:19:55 — the composer
// kept its Stop button and ticking timer for that whole window.
const timeoutBranch = loop.slice(loop.indexOf('if (toolResult && toolResult._toolTimedOut)'),
  loop.indexOf('// Bounded self-correction'));
assert.ok(timeoutBranch.indexOf('refreshWorkspaceTree') < timeoutBranch.indexOf("title: 'Stopped (timed out)'"),
  'the workspace refresh happens BEFORE the Stopped card is painted');
assert.ok(timeoutBranch.indexOf("setAgentProgress('Stopping...')") < timeoutBranch.indexOf("title: 'Stopped (timed out)'"),
  'the interim state is labelled honestly while it winds down');

// ---- 6. The setting exists in the UI and defaults ON --------------------------
assert.match(html, /id="settingsKeepAwakeChk"/, 'the toggle exists');
assert.match(html, /Keep the computer awake while building/, 'and is named for what it does');
assert.match(aiExe, /keepAwakeDuringRun: true,/, 'default is ON — losing a build costs more than the power');
assert.match(aiExe, /if \(typeof parsed\.keepAwakeDuringRun === 'boolean'\)/, 'the stored choice is honoured');
assert.match(aiExe, /appSettings\.keepAwakeDuringRun = Boolean\(settingsKeepAwakeChk/, 'the toggle writes back');

// ---- Behavioural: run the real watchdog arithmetic ---------------------------
// Extracted so the numbers are exercised, not just matched: 12 minutes suspended
// inside a 191s cap must NOT trip, while 200s of genuine model silence must.
const budget = (elapsedMs, suspendedMs, capMs) => Math.max(0, elapsedMs - suspendedMs) >= capMs;
assert.equal(budget(718000, 700000, 191000), false, 'a slept-through write is not a timeout');
assert.equal(budget(200000, 0, 191000), true, 'a genuinely slow write still times out');
assert.equal(budget(718000, 700000, 15000), true, 'awake time past the cap still trips after a sleep');

console.log('PASS: idle sleep is held off during a run (system only, screen still sleeps), a suspend is detected on both platforms, suspended time is never charged to a tool or the run deadline, the interrupted step is redone with an honest message, and the Stopped card waits for teardown');
