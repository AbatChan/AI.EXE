# Modern UI design guide (apply to every UI you build)

Build interfaces that feel current, useful, and composed. A modern product is not
defined by a trend pack; it is defined by clear hierarchy, useful defaults,
strong interaction states, responsive behavior, and restraint. The result should
look like a polished 2026 product: direct, readable, fast, and intentional.

Use this as a design lesson and execution checklist, not just a token dump.

## 1. Start With The Product Job

Before choosing colors or layout, identify the job of the screen.

- Who is here, and what are they trying to finish?
- What is the one primary action or decision?
- What information must be visible before the user acts?
- Is this a workflow, dashboard, editor, marketplace, marketing page, or content
  page? Each needs a different density and rhythm.

Modern design is task-first. Do not build a decorative landing page when the user
asked for an app, tool, dashboard, game, or workflow. The first viewport should
contain the usable product unless a landing page is explicitly requested.

## 2. Current Visual Direction

Aim for quiet confidence:

- Content leads; chrome supports.
- Surfaces are subtle and purposeful, not stacked into nested cards.
- Color is semantic and controlled, not sprayed across the interface.
- Typography creates hierarchy before color or decoration does.
- Motion confirms state changes; it does not perform for attention.
- Layout is responsive by construction, not patched after desktop is done.

Good modern UI often feels simpler than older UI because fewer elements are
competing. Simpler does not mean empty. It means every visible element earns its
place.

## 3. Replace Dated Patterns

Avoid old defaults and replace them with sharper modern choices.

- Instead of big gradient hero blocks everywhere: use a clear product surface,
  useful first-screen content, and one controlled accent.
- Instead of cards inside cards: use section spacing, dividers, table rows, tabs,
  or grouped lists.
- Instead of heavy shadows: use 1px borders, tonal surfaces, and one soft shadow
  only where elevation matters.
- Instead of random rounded corners: use a small radius scale and keep it stable.
- Instead of centered paragraphs and generic hero copy: use scannable headings,
  concise body text, and direct actions.
- Instead of decorative icons everywhere: use icons for recognition, status, or
  compact controls.
- Instead of glassmorphism, neumorphism, bouncy effects, and loud blobs: use
  contrast, alignment, type, whitespace, and real imagery when imagery matters.
- Instead of huge empty dashboards: show useful summary metrics, recent activity,
  filters, empty states, and the next likely action.

## 4. Layout And Composition

Use layout to make the next action obvious.

- Constrain readable content: `max-width` around 1100-1280px for broad layouts and
  `60-75ch` for prose.
- Use full-width bands or clean constrained sections. Do not wrap every section in
  a floating card.
- Prefer one dominant layout idea per screen: sidebar app shell, split editor,
  dashboard grid, feed/list, form flow, or focused canvas.
- Keep mobile first: one column on phones, then expand with `grid`,
  `minmax()`, `clamp()`, and sensible breakpoints.
- Use stable geometry: aspect ratios for media, fixed control heights, predictable
  grid tracks, and enough gutter space.
- Touch targets should be at least 44px. Interactive rows need clear hover, active,
  selected, disabled, loading, and focus states.
- Avoid overlap, clipping, horizontal scrolling, and viewport-scaled text that
  becomes huge or tiny.

If the screen is operational, make it dense and scannable. If it is expressive,
such as a game or promotional visual, keep the expression attached to the actual
subject and interaction.

## 5. Color

Use a neutral system plus one accent by default.

- 60% base: off-white or near-black background, never pure `#fff` or `#000`.
- 30% support: surfaces, borders, muted text, dividers, and inactive controls.
- 10% accent: primary actions, links, focus rings, selected states, and key data.
- Use a neutral ramp with 5-8 steps. Do not invent new greys per component.
- Use semantic colors only for meaning: success, warning, danger, info.
- Body text contrast must be at least 4.5:1. Large text and UI strokes must be at
  least 3:1.
- Dark mode should use dark grey bases, not pure black, with raised surfaces only
  slightly lighter.

Avoid one-hue purple/blue gradient pages unless the brand or prompt specifically
calls for it. Modern color is precise: one accent, neutral structure, semantic
signals.

## 6. Typography

Typography should carry most of the hierarchy.

- Use one font family. A strong system stack is the safest default:
  `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- Use a restrained type scale: `12, 14, 16, 20, 24, 30, 38, 48`.
- Body text defaults to 16px. Never use body copy below 14px.
- Use mostly 400 for body and 600/700 for emphasis. Avoid many weights.
- Body line-height: 1.45-1.6. Large heading line-height: 1.05-1.2.
- Do not use negative letter spacing. Keep letter spacing at 0 unless labeling in
  all caps, where a tiny positive value can help.
- Keep paragraphs to about 65ch. Make labels, helper text, and errors short.

Use large type only where it creates a real hierarchy. Product screens usually
need compact, precise headings more than oversized marketing headlines.

## 7. Spacing

Use spacing as structure.

- Use an 8px-based scale: `4, 8, 12, 16, 24, 32, 48, 64, 96`.
- Use consistent gaps for repeated groups. Do not mix arbitrary values.
- Internal padding should usually be less than or equal to the gap between groups.
- Major page sections need more vertical space than related component clusters.
- Dense tools can use tighter spacing, but must still preserve scan lines and
  click targets.

Whitespace is not leftover. It is how users understand grouping, priority, and
flow.

## 8. Shape, Borders, And Depth

Use depth sparingly.

- Radius scale: 4px for small controls, 8px default, 12-16px for larger panels,
  9999px for pills and avatars.
- Cards usually need either a subtle border or a soft shadow. Do not make both
  heavy.
- Shadows should be low-opacity and functional:
  `0 1px 2px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.08)`.
- On dark UI, prefer subtle borders and tonal surface changes over shadows.
- Borders should be 1px hairlines in a low-contrast neutral.

Avoid inflated radii, thick outlines, and dramatic shadows. They make modern
interfaces look toy-like.

## 9. Components

Build complete components, not just their default state.

- Buttons: one primary, one secondary, one ghost/text variant. Include hover,
  active, disabled, loading, and `:focus-visible`.
- Inputs: visible label, helper/error text, clear focus ring, validation state,
  disabled state, and comfortable height around 40-44px.
- Navigation: current page state must be obvious. Icon-only controls need labels,
  tooltips, or accessible names.
- Tables/lists: use aligned columns, sticky headers when useful, row hover,
  selection, empty state, loading state, and filters/search when the data calls
  for them.
- Cards: use for repeated items or bounded objects, not for every section.
- Modals/drawers: include close affordance, focus handling, escape behavior, and
  clear primary/secondary actions.
- Toasts/alerts: concise, semantic, dismissible when appropriate.

Good components are boring in the best way: predictable, complete, and reusable.

## 10. Imagery And Visual Assets

When the subject is inspectable, show it clearly.

- Product, food, place, person, portfolio, object, and hero pages need relevant
  bitmap imagery or real generated imagery. Do not use abstract gradients as the
  main subject.
- Use consistent aspect ratios and object-fit rules so media does not jump or crop
  important details.
- SVG is good for icons, logos, diagrams, and vector games. It is not a substitute
  for product or place imagery when the user needs to inspect the subject.
- Avoid dark, blurred, cropped, generic stock-like visuals unless explicitly asked.

## 11. Motion

Motion should explain state.

- Animate hover/press feedback, entrances of meaningful elements, open/close,
  selection, loading, and focus transitions.
- Duration: 120-250ms for most UI, up to 400ms for large transitions.
- Easing: use ease-out for entering and ease-in-out for moving/resizing. Avoid
  `linear` for interface motion.
- Prefer `opacity` and `transform`. Avoid animating layout-heavy properties in hot
  paths.
- Keep the same interaction using the same duration and easing everywhere.
- Always honor reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 12. Accessibility

Accessibility is part of the visual design, not a later audit.

- Use semantic HTML before ARIA.
- Make focus states visible and high contrast.
- Keep interactive targets at least 44px where possible.
- Do not communicate meaning through color alone.
- Use readable contrast in normal, hover, selected, disabled, and error states.
- Preserve keyboard paths through menus, dialogs, tabs, and forms.
- Use loading, empty, error, and success states with useful text.

## 13. Starter Tokens

Drop these into `:root`, then use them everywhere instead of one-off values.

```css
:root {
  color-scheme: light;

  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-2: #f1f5f9;
  --border: #e2e8f0;
  --text: #0f172a;
  --muted: #64748b;
  --accent: #2563eb;
  --accent-strong: #1d4ed8;
  --accent-soft: #dbeafe;
  --accent-contrast: #ffffff;
  --danger: #dc2626;
  --success: #16a34a;
  --warning: #d97706;

  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

  --text-xs: 12px;
  --text-sm: 14px;
  --text-md: 16px;
  --text-lg: 20px;
  --text-xl: 24px;
  --text-2xl: 30px;
  --text-3xl: 38px;
  --text-4xl: 48px;

  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-6: 24px;
  --s-8: 32px;
  --s-12: 48px;
  --s-16: 64px;
  --s-24: 96px;

  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --radius-pill: 9999px;

  --shadow-sm: 0 1px 2px rgba(15, 23, 42, .06);
  --shadow-md: 0 8px 24px rgba(15, 23, 42, .08);
  --focus: 0 0 0 3px rgba(37, 99, 235, .24);

  --ease: cubic-bezier(.2, 0, 0, 1);
  --ease-move: cubic-bezier(.4, 0, .2, 1);
  --dur: 180ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0b1020;
    --surface: #111827;
    --surface-2: #172033;
    --border: #273449;
    --text: #e5e7eb;
    --muted: #9ca3af;
    --accent: #60a5fa;
    --accent-strong: #93c5fd;
    --accent-soft: rgba(96, 165, 250, .16);
    --accent-contrast: #08111f;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: var(--text-md);
  line-height: 1.5;
}

:focus-visible {
  outline: none;
  box-shadow: var(--focus);
}
```

## 14. Screen Recipes

Use the right recipe for the product type.

- App/tool: start with the working interface, not marketing copy. Provide a clear
  toolbar, primary action, data region, and status feedback.
- Dashboard: show summary cards only if they summarize real values. Pair metrics
  with trend, timeframe, and next action.
- Form flow: group related fields, show progress when multi-step, keep primary
  action visible, and write helpful validation.
- Editor/canvas: dedicate most space to the editable object. Keep tools compact,
  grouped, and close to the thing they affect.
- Marketplace/catalog: prioritize search, filters, sorting, clear product imagery,
  price/status, and comparison-friendly cards.
- Marketing page: first viewport should show the actual product, offer, or subject.
  Keep hero copy compact enough that the next section is hinted below the fold.

## 15. Final Quality Checklist

Before finishing, verify:

- The first screen makes the product or task obvious.
- There is one primary action and a clear visual hierarchy.
- Components have hover, active, selected, disabled, loading, error, empty, and
  focus states where relevant.
- Spacing, type, radius, shadows, and colors come from the system.
- Mobile layout is intentional and no text or controls clip.
- Contrast and focus states are accessible.
- Imagery is specific to the subject when the subject matters.
- The UI avoids dated decoration: random gradients, heavy shadows, nested cards,
  generic stock visuals, tiny grey text, and over-animated effects.
