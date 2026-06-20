# Design foundation (apply to every UI you build)

You are building UIs that should look like a clean, modern 2026 product: calm,
confident, uncluttered, with a tasteful color accent and subtle motion. When in
doubt, do LESS. Restraint reads as premium; busy reads as amateur. Follow these
defaults unless the user asks for something specific.

## 1. Core philosophy
- **Less, but better.** Few colors, one font family, generous space. "Barely-there"
  UI — the content is the hero, the chrome is quiet.
- **Whitespace is structural, not leftover.** Give content room to breathe; group
  related things with closeness and separate unrelated things with space.
- **Consistency over variety.** One spacing scale, one type scale, one radius, one
  accent, one motion timing — reused everywhere. Repetition looks intentional.
- **Hierarchy first.** Every screen has ONE clear primary action and a clear visual
  order (size, weight, color, space) telling the eye where to go.

## 2. Color — 60 / 30 / 10
- **60%** a near-neutral background (off-white or near-black, never pure #fff/#000).
- **30%** secondary surfaces/text (cards, muted text, borders).
- **10%** ONE accent color for primary actions, links, focus, key highlights only.
- Use a **neutral ramp** (5–8 steps from background → text) for surfaces, borders,
  and text instead of arbitrary greys. Body text should be a soft near-black
  (e.g. `#1a1a1a`), not pure black; muted text a mid grey.
- Support **dark mode** when reasonable: dark UIs use a very dark *grey* base
  (`#0f1115`), not pure black, with slightly lighter raised surfaces.
- Accent picks that read modern: a confident blue/indigo, teal, violet, or warm
  amber. Keep saturation tasteful; one accent + neutrals beats a rainbow.
- Ensure **contrast**: body text ≥ 4.5:1 on its background; large text/UI ≥ 3:1.
- Gradients are fine as a subtle accent (one hue family, low contrast) — not as
  loud full-page rainbows.

## 3. Typography
- **One font family.** A clean system/sans stack is a safe, fast, modern default:
  `font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;`
  (A single tasteful Google font is fine too — but only ONE, and self-host/inline if offline.)
- **Type scale** (modular, ~1.25 ratio, 16px base): 12, 14, 16, 20, 25, 31, 39, 49px.
  Body 16px (never below 14). Don't invent in-between sizes.
- **Weights:** mostly 400 (body) and 600/700 (headings/emphasis). Avoid 5+ weights.
- **Line-height:** ~1.5 for body, ~1.2 for large headings.
- **Measure:** limit paragraph width to ~60–75 characters (`max-width: 65ch`).
- Big, confident headings + calm body is the current look. Don't shout everything.

## 4. Spacing — 8px grid
- Use only these steps (px): **4, 8, 12, 16, 24, 32, 48, 64, 96**. Pick from the
  scale; never random values like 7px or 23px.
- **Internal ≤ external:** padding inside a card ≤ the gap between cards, so groups
  stay visually grouped.
- Section vertical rhythm: generous (e.g. 64–96px between major sections on desktop).
- Component padding: comfortable (e.g. buttons ~12px 20px, cards ~24px).

## 5. Shape & depth
- **Radius scale:** 4px (small: inputs/chips), 8px (default: cards/buttons),
  12–16px (large: modals/containers), 9999px (pills/avatars). Pick ONE default
  (8–12px) and stay consistent.
- **Shadows:** soft, low-opacity, layered — for *elevation cues only*, not decoration.
  e.g. `0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.08)`. Avoid hard, dark,
  large drop shadows. On dark UIs prefer subtle borders/lighter surfaces over shadows.
- **Borders:** 1px hairline in a low-contrast neutral to separate surfaces calmly.

## 6. Layout
- Constrain content width (`max-width: ~1100–1280px`, centered) — full-bleed text is
  hard to read. Inner gutters of 16–24px on mobile, more on desktop.
- Use CSS **grid/flex** with consistent gaps. Align to a clear grid; align edges.
- **Mobile-first & responsive:** single column on phones; expand to multi-column with
  media queries / `clamp()` / `minmax()`. Touch targets ≥ 44px.
- Sticky, compact header; clear nav; generous footer. Don't cram.

## 7. Motion (motion minimalism)
- Animate only: hover/press feedback, entrances of meaningful elements, state
  changes (open/close, toggle), and focus. Nothing gratuitous.
- **Duration:** 150–250ms for most UI; up to ~400ms for larger/page transitions.
- **Easing:** never `linear`. Use ease-out for things entering
  (`cubic-bezier(0.2, 0, 0, 1)`), ease-in-out for moving/resizing. Things should
  start a touch fast and settle gently.
- Animate cheap properties (`opacity`, `transform`) — not `width`/`top`/`box-shadow`
  in hot paths. Keep it smooth (60fps).
- Be **consistent**: the same interaction uses the same duration + easing everywhere.
- **Accessibility:** always honor reduced motion:
  `@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }`
- Always give interactive elements a clear hover AND visible `:focus-visible` state.

## 8. Component defaults
- **Buttons:** one solid *primary* (accent bg, white text), one *secondary*
  (subtle/outline), text/ghost for tertiary. Clear hover + active + focus + disabled.
- **Cards:** neutral surface, 1px border or soft shadow (not both heavy), radius 8–12,
  padding ~24, consistent gaps.
- **Inputs:** clear label, comfortable height (~40–44px), visible focus ring in the
  accent, helpful error states.
- **Icons:** consistent stroke-style line icons (e.g. 1.5–2px stroke), sized to text.
  Prefer inline SVG over emoji for UI controls.
- **Images:** consistent aspect ratios, rounded to match the radius, lazy-loaded.

## 9. Starter design tokens (drop into `:root`, then USE them everywhere)
```css
:root{
  /* color */
  --bg:#fafafa; --surface:#ffffff; --border:#e7e7ea;
  --text:#1a1a1a; --muted:#6b7280; --accent:#4f46e5; --accent-contrast:#ffffff;
  /* type */
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  /* spacing (8px grid) */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-6:24px; --s-8:32px; --s-12:48px; --s-16:64px;
  /* shape */
  --radius:12px; --radius-sm:8px;
  --shadow:0 1px 2px rgba(0,0,0,.06),0 4px 12px rgba(0,0,0,.08);
  /* motion */
  --ease:cubic-bezier(0.2,0,0,1); --dur:200ms;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#0f1115; --surface:#171a21; --border:#262a33; --text:#e8eaed; --muted:#9aa3b2; }
}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.5}
```

## 10. Don'ts (these instantly read as low-quality)
- ❌ Pure black text on pure white, or harsh full-saturation colors everywhere.
- ❌ Many fonts, many weights, many accent colors.
- ❌ Random spacing/sizes off the scale; cramped, edge-to-edge content.
- ❌ Heavy dark drop shadows; thick borders; everything rounded differently.
- ❌ Linear or slow (>500ms) animations; bouncy/spinny motion on everything.
- ❌ Centering long paragraphs; tiny (<14px) body text; low-contrast text.
- ❌ Decorative clutter that doesn't serve the content or the primary action.
