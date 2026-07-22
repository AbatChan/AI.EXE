# Model Picker Design QA

- Source visual truth: `/Users/macbookair2020/Downloads/Projects and Code/AI EXE/design-reference.png`
- Implementation screenshot: `/Users/macbookair2020/Downloads/Projects and Code/AI EXE/design-implementation-compact.png`
- Combined comparison: `/Users/macbookair2020/Downloads/Projects and Code/AI EXE/design-comparison-compact.png`
- Focused search state: `/Users/macbookair2020/Downloads/Projects and Code/AI EXE/design-focused-search.jpeg`
- Viewport/state: desktop dark-mode Mac preview, 1050 × 760 implementation viewport, model picker open with live Venice catalog.
- Source pixels: 1104 × 720. Implementation pixels: 1050 × 760. The source was proportionally resized and centered on a 1050 × 760 canvas for the combined comparison; density was treated as 1× for layout comparison.

## Findings

No actionable P0/P1/P2 differences remain.

- Typography: the implementation preserves the source hierarchy, optical weight, compact labels, and truncation behavior using the app's existing sans-serif tokens.
- Spacing and layout: centered 520px modal, compact header/search/control divisions, 18px frame radius, 58px row rhythm, and responsive height match the requested smaller direction.
- Colors and tokens: near-black panel, cyan focus/selection, muted blue-gray borders, green Free badges, and amber Pay-per-use badges match the reference.
- Image and icon quality: no raster artwork is required. Existing app SVG controls are used for search and close; model identity is rendered as a compact text monogram because the live scraper does not provide provider artwork.
- Copy and content: title, supporting copy, search prompt, and pricing filters match the selected design direction. The confirmation footer, sort control, recommendations, and synthetic capability descriptions were intentionally omitted because the user requested immediate click-to-select and a simpler flow.

## Full-view Comparison Evidence

`design-comparison-compact.png` places the supplied reference on the left and the live Mac implementation on the right. Modal composition, color hierarchy, search focus, tabs, selected state, badges, and background treatment visibly align. The intentional compact variant preserves the source hierarchy while fitting seven live catalog rows in the native viewport.

## Focused Region Evidence

`design-focused-search.jpeg` verifies the search region and live result rows at readable scale. Live follow-up checks verified Kimi K3 and all three `GLM 5.2` rows (Private Free, Private Pay-per-use, and TEE Free), including persistence across a complete adapter restart.

## Comparison History

1. Initial implementation matched the modal structure but exposed raw `:latest` suffixes and used one-letter provider initials.
2. Fixed display normalization and model-derived two-letter monograms (`NV`, `QW`, `GL`, `CL`, `KI`).
3. Rebuilt and restarted the Mac preview, then recaptured the same state. The revised implementation has no remaining P0/P1/P2 mismatch.
4. Tightened the dialog from 680px to 520px, the search field from 50px to 40px, and model rows from 76px to 58px in response to the compact-size request; rebuilt and verified the live catalog again.

## Primary Interactions Tested

- Open and close the modal.
- Search live models.
- Clear search state.
- All / Free / Pay-per-use / Uncensored live counts.
- Immediate click-to-select and modal close.
- New-chat `hello` smoke test returned a normal conversational reply; preflight routing JSON did not appear.

## Follow-up Polish

- P3: provider logo artwork could replace monograms later if the live model API supplies trustworthy assets.

final result: passed
