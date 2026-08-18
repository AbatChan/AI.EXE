# Dictation reference benchmark

Reference: Codex recorder screenshot captured 18 August 2026 at `0:08`.
Image: `Screenshot 2026-08-18 at 11.49.05 AM.png` (`1160 x 128`, 144 ppi).

## Measured from the reference

| Property | Measurement |
| --- | --- |
| Recorder surface | `1160 x 128 px`; sampled background `#2A2A2A` |
| Content centre line | `y = 79.5 px` |
| Waveform lane | approximately `x = 76–904 px` (`828 px`) |
| Silence baseline | `2 px` high, sampled `#BFBFBF` |
| Speech bars | mostly `4–5 px` wide; `8 px` visual pitch |
| Maximum visible speech height | `56 px` |
| Dynamic height range | `2–56 px` (`28:1`) |
| Send control | `56 x 56 px`; white `#FFFFFF`; arrow about `20 x 22 px` |
| Stop control | approximately `56 x 56 px`; background `#353535`; square `18 x 18 px` |
| Plus control | approximately `24 x 24 px`; sampled grey `#7F7F7F` |
| Timer shown | `0:08`; located between waveform and stop control |

At eight seconds, the visible history spans nearly the full waveform lane. Quiet
segments collapse to a two-pixel dotted baseline while speech remains as discrete
white clusters. The display does not replace silence with decorative movement.

## Behaviour inferred from the still image

- The rendered waveform uses an envelope/history view, not a raw audio trace.
- Roughly one visual bar appears every eight pixels.
- Word groups remain visible after they are spoken instead of scrolling away in a
  few seconds.
- A noise floor suppresses low-level input to the baseline between speech clusters.

## Not measurable from a still image

- Microphone activation latency.
- Audio sample rate or analyser refresh rate.
- Exact noise-floor level in dB.
- Whether rejection comes from WebRTC processing, OS voice processing, or a custom
  gate.
- Transcription completion latency and recognition accuracy.

Codex blocks automated control of its own window, so these live values require a
manual timed recording. No unmeasured value should be treated as confirmed.

## Manual live-test script

1. Start recording and measure time to the first timer change and first visible bar.
2. Record five seconds of room silence.
3. Play speech at quiet, normal, and loud levels for three seconds each, separated
   by two-second pauses.
4. Add steady fan/noise audio, then repeat normal speech.
5. Stop at 30 seconds and measure transcription completion time.
6. Record which speech clusters remain visible at 8, 15, and 30 seconds.
