Modern UI rules. Follow these for every HTML/CSS file unless the user overrides them.

- Build the real product first. First screen = usable app/tool/page, not generic marketing, unless requested.
- Decide screen type, primary user task, and ONE primary action. Make hierarchy obvious with type, spacing, and alignment.
- Layout: mobile-first; no overlap/clipping; touch targets >=44px; constrain broad content to 1100-1280px and prose to <=65ch.
- Avoid dated UI: nested cards, huge generic gradients, glass/neumorphism, bouncy effects, heavy shadows, random radii, tiny grey text.
- Color: neutral base + ONE accent. No pure #fff/#000. Use semantic red/green/amber only for status. Body contrast >=4.5:1.
- Type: one font; sizes 12/14/16/20/24/30/38/48; body 16px, never below 14px; weights 400/600/700; no negative letter spacing.
- Space/depth: 8px scale (4,8,12,16,24,32,48,64,96); radius 6/10/14/pill; 1px borders; soft shadows only for real elevation.
- Components need hover, active, disabled/loading, empty/error, selected, and visible :focus-visible states where relevant.
- Multi-page sites need source-of-truth files: shared CSS plus a shared classic components script for repeated header/nav/logo/footer/CTA. Do not rebuild those inline per page.
- Icons: use inline SVG (clean line/solid icons), never emoji as UI icons — emoji look dated and render inconsistently across systems.
- Use real/relevant imagery for inspectable subjects (product, place, person, food, portfolio, object). Do not use abstract gradients as the subject.
- Motion: 120-250ms, ease-out/ease-in-out, opacity/transform only, consistent, honor prefers-reduced-motion.
- Scale styling to scope: a small/single-page build gets a COMPACT stylesheet (style only what the page actually uses; no exhaustive design system, no rules for components that don't exist).
- Every `var(--x)` you reference MUST be defined in this file's `:root` (use the defaults below or your own) — never use an undefined token.

Default tokens:
```css
:root{color-scheme:light;--bg:#f8fafc;--surface:#fff;--surface-2:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;--accent:#2563eb;--accent-strong:#1d4ed8;--accent-soft:#dbeafe;--accent-contrast:#fff;--danger:#dc2626;--success:#16a34a;--warning:#d97706;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--r-sm:6px;--r:10px;--r-lg:14px;--shadow:0 8px 24px rgba(15,23,42,.08);--focus:0 0 0 3px rgba(37,99,235,.24);--ease:cubic-bezier(.2,0,0,1);--dur:180ms}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b1020;--surface:#111827;--surface-2:#172033;--border:#273449;--text:#e5e7eb;--muted:#9ca3af;--accent:#60a5fa;--accent-strong:#93c5fd;--accent-soft:rgba(96,165,250,.16);--accent-contrast:#08111f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:16px;line-height:1.5}:focus-visible{outline:none;box-shadow:var(--focus)}
```
