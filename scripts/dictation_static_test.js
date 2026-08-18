const assert = require('assert');
const fs = require('fs');

const js = fs.readFileSync('ui/ai-exe.js', 'utf8');
const html = fs.readFileSync('ui/ai-exe.html', 'utf8');
const css = fs.readFileSync('ui/ai-exe.css', 'utf8');
const mac = fs.readFileSync('src/gui_main_mac_web.mm', 'utf8');
const plist = fs.readFileSync('src/Info.plist.in', 'utf8');

assert.ok(html.includes('id="dictationTimer"'), 'dictation timer must be present');
assert.ok(!html.includes('dictation-plus-ghost'), 'recorder must not keep a decorative plus control');
assert.ok(html.indexOf('id="dictationCancelBtn"') < html.indexOf('id="dictationWave"'), 'cancel must lead the recorder row');
assert.ok(js.includes('function startDictationTimer()'), 'timer must start with recording');
assert.ok(js.includes('const sampleIntervalMs = 150'), 'waveform must keep its deliberate cadence');
assert.ok(js.includes('const barStepCss = 6.5'), 'waveform must keep tight reference spacing');
assert.ok(js.includes('const flowOffset = sampleProgress * step'), 'waveform must flow between samples');
assert.ok(js.includes('dictationWaveNoiseFloor + 0.010'), 'waveform must adapt to room noise');
assert.ok(!js.includes('dictationWaveFallbackPhase'), 'silence must not use fake movement');
assert.ok(css.includes('.dictation-time'), 'timer styling must be present');
assert.ok(css.includes('.dictation-bar {') && css.includes('order: 2;'), 'recorder must sit below input text');
assert.ok(mac.includes('UpdateDictationTranscriptSegments'), 'Mac must retain partial speech across pauses');
assert.ok(mac.includes('CommitCurrentDictationPhrase(cb)'), 'Mac must commit completed phrases');
assert.ok(mac.includes('StartDictationRecognitionTaskLocked(cb)'), 'Mac must continue recognition after pauses');
assert.ok(plist.includes('NSSpeechRecognitionUsageDescription'), 'Mac must declare speech recognition usage');
assert.ok(plist.includes('NSMicrophoneUsageDescription'), 'Mac must declare microphone usage');

console.log('dictation static test: ok');
