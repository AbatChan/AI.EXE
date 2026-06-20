Make the UI clean and modern (2026). Restraint reads premium; busy reads amateur.

- Color: 60/30/10 — near-neutral bg, ONE accent, neutral text. No pure #000/#fff. Body text ≥4.5:1 contrast.
- Type: ONE font; sizes 12/14/16/20/25/31/39 (body 16); weights 400 + 600/700; line-height 1.5 (1.2 headings); paragraphs ≤65ch.
- Space: 8px grid (4,8,12,16,24,32,48,64,96); generous whitespace; padding inside ≤ gap between.
- Shape: radius 8–12 (consistent); soft low-opacity shadows only; 1px hairline borders.
- Layout: centered max-width ~1100–1280; flex/grid with gaps; mobile-first; touch targets ≥44px.
- Motion: only hover/feedback/entrances; 150–250ms; ease-out (never linear); animate opacity/transform; honor prefers-reduced-motion; visible :focus-visible.
- One clear primary action per screen; consistent components (one primary button style, one card style).

Drop these tokens in :root and USE them everywhere:
```css
:root{
  --bg:#fafafa;--surface:#fff;--border:#e7e7ea;--text:#1a1a1a;--muted:#6b7280;--accent:#4f46e5;--accent-contrast:#fff;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-6:24px;--s-8:32px;--s-12:48px;--s-16:64px;
  --radius:12px;--radius-sm:8px;--shadow:0 1px 2px rgba(0,0,0,.06),0 4px 12px rgba(0,0,0,.08);
  --ease:cubic-bezier(0.2,0,0,1);--dur:200ms;
}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--border:#262a33;--text:#e8eaed;--muted:#9aa3b2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.5}
```

Avoid: pure black on white, many fonts/colors, off-grid spacing, heavy dark shadows, linear/bouncy motion, tiny (<14px) or low-contrast text, decorative clutter.
