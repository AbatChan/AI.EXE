Build a modern 2026 UI: task-first, readable, responsive, and restrained. The first screen should contain the usable product/app/tool unless a landing page is explicitly requested.

- Product job: identify the user task, one primary action, required context, and screen type (app, dashboard, editor, form, marketplace, content, marketing).
- Hierarchy: typography and spacing do most of the work. One clear primary action; chrome stays quiet.
- Layout: use a clean app shell/section/grid appropriate to the task. Avoid nested cards. Constrain content (1100-1280px; prose <=65ch). Mobile-first, no clipping/overlap, touch targets >=44px.
- Color: neutral system + one accent. No pure #fff/#000, no rainbow palettes. Semantic colors only for meaning. Body contrast >=4.5:1; UI/large text >=3:1.
- Type: one font family; sizes 12/14/16/20/24/30/38/48; body 16px minimum 14px; weights mostly 400 and 600/700; no negative letter spacing.
- Space: 8px scale (4,8,12,16,24,32,48,64,96). Use whitespace for grouping; repeated components use repeated gaps.
- Shape/depth: radius scale 4/8/12-16/pill; subtle 1px borders; soft shadows only when elevation matters.
- Components: include hover, active, selected, disabled, loading, empty/error, and visible :focus-visible states where relevant.
- Imagery: if the subject is a product/place/person/food/portfolio/object, show clear relevant bitmap imagery; do not use abstract gradients as the subject.
- Motion: 120-250ms, ease-out/ease-in-out, opacity/transform, consistent, never gratuitous, honor prefers-reduced-motion.
- Avoid dated UI: huge generic gradient heroes, glassmorphism/neumorphism, bouncy effects, heavy dark shadows, random radii, tiny grey text, centered long paragraphs, decorative clutter.

Use these tokens as the default system:
```css
:root{
  color-scheme:light;
  --bg:#f8fafc;--surface:#fff;--surface-2:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;
  --accent:#2563eb;--accent-strong:#1d4ed8;--accent-soft:#dbeafe;--accent-contrast:#fff;
  --danger:#dc2626;--success:#16a34a;--warning:#d97706;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --text-xs:12px;--text-sm:14px;--text-md:16px;--text-lg:20px;--text-xl:24px;--text-2xl:30px;--text-3xl:38px;--text-4xl:48px;
  --s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-6:24px;--s-8:32px;--s-12:48px;--s-16:64px;--s-24:96px;
  --radius-sm:6px;--radius:10px;--radius-lg:14px;--radius-pill:9999px;
  --shadow-sm:0 1px 2px rgba(15,23,42,.06);--shadow-md:0 8px 24px rgba(15,23,42,.08);--focus:0 0 0 3px rgba(37,99,235,.24);
  --ease:cubic-bezier(.2,0,0,1);--ease-move:cubic-bezier(.4,0,.2,1);--dur:180ms;
}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b1020;--surface:#111827;--surface-2:#172033;--border:#273449;--text:#e5e7eb;--muted:#9ca3af;--accent:#60a5fa;--accent-strong:#93c5fd;--accent-soft:rgba(96,165,250,.16);--accent-contrast:#08111f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:var(--text-md);line-height:1.5}:focus-visible{outline:none;box-shadow:var(--focus)}
```
