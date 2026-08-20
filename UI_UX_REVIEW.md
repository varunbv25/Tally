# Tally — UI/UX design review

**Date:** 2026-08-20 · **Scope:** the whole web app (`index.html`, `styles.css`, `app.js`, `components/`)

**Method:** code read-through plus a live pass — the app was run with seeded demo data
(5 people across 2 groups, mixed currencies, an interest rule, a scheduled debt) and
screenshotted at phone (390×844) and desktop (1280×900) sizes, in both light and dark
themes, across every view: ledger, groups, group detail, history (+ calendar), settings,
account, drawer, and the person / split / indirect modals.

---

## What's working well

The overall craft level is high — several things here are better than most production apps:

- **A real token system.** Type scale, spacing, radii, motion and every colour live in
  `:root` (`styles.css:8-79`), and components reference tokens, never raw values. The
  dark theme is a pure token override (`styles.css:90-120`) with `color-scheme` flipped
  so native controls follow — and it holds up: every view stays legible and on-palette
  in dark mode.
- **Deliberate accessibility of colour.** Tokens carry comments like *"darkened for AA
  contrast on cream"* (`--ink-soft`, `--amber`, `--gold`). Spot-checks confirm body and
  secondary text clear WCAG AA in both themes, and dark mode adds weight to small muted
  text so it doesn't wash out (`styles.css:124-129`).
- **Mobile fundamentals are done properly.** 16px inputs to stop iOS focus-zoom (gated
  on `pointer: coarse` *and* the width breakpoint, with a comment explaining why —
  `styles.css:1214-1226`), 44px touch targets, `100dvh`, safe-area insets, a sticky
  masthead justified in a comment by how the core loop actually works, and tables that
  collapse into genuinely well-designed cards rather than squeezed columns.
- **Money-shaped safety.** Live previews before anything is recorded (split, indirect),
  confirm overlays for every destructive act with plain-language consequences, the
  quick-add buttons staying "disarmed" until an amount is typed (`styles.css:653-657`),
  and Settle rendered as a deliberate ghost button rather than a casual control.
- **Good words.** Empty states onboard instead of showing a blank `<main>`; the groups
  view warns that overlapping group nets aren't additive; Settings sections read as a
  scannable index (icon tile + name + one-line summary). Microcopy consistently explains
  *consequences*, not just labels.
- **No-flash theme boot**, history/back integration, body scroll-locking under popups,
  and an offline badge that reassures rather than alarms.

The findings below are relative to that high bar.

---

## Findings

### High

**H1 — Modals have no keyboard dismissal and no focus management.**
`Escape` only closes the drawer (`app.js:2894`); every modal (person, split, indirect,
share, confirms) ignores it. Focus is never moved into a dialog on open, never trapped,
and never restored on close; the markup has no `role="dialog"` / `aria-modal`
(`components/modal.js`), so screen readers and keyboard users can tab straight through
the overlay into the inert page behind it. Click-on-scrim works, but that's mouse/touch
only.
*Fix:* one shared `keydown` handler that routes `Escape` to the same `goBack()` the
scrims use; add `role="dialog" aria-modal="true"` + `aria-labelledby` to `Modal()`;
focus the dialog (or its first field) on open and restore the invoker's focus on close.
A minimal focus trap (wrap Tab at the edges) completes it.

**H2 — Destructive multi-select is long-press-only.**
Deleting history entries, ledger people, or group members requires a long-press
(`app.js:2899-2926`, pointer-events only) to enter selection mode. There is no keyboard
path at all, and on desktop "click and hold" is an undiscoverable gesture that only the
intro prose reveals. History rows have no per-row delete outside the person modal.
*Fix:* add a visible entry point to selection mode (e.g. a small "Select" button beside
the entry count / above the lists) — it can stay quiet; keyboard users then get the
whole flow for free since rows toggle on click. Keep long-press as the fast path.

**H3 — The history calendar balloons on desktop.**
`.cal-cell { aspect-ratio: 1/1 }` (`styles.css:963`) inside the 1000px content column
makes each day ~130px square, so the opened calendar is a ~900px-tall grid of empty
cells with 4px event dots, pushing the register it filters entirely below the fold. The
hollow amber "scheduled" ring is nearly invisible at that scale. (On the phone it's
excellent — compact and clear.)
*Fix:* cap the calendar's width (e.g. `.cal { max-width: 440px }`) or give cells a
fixed height on wide screens; scale the dots with the cell.

### Medium

**M1 — Direction words are ambiguous: "paid" means both directions.**
The quick-entry buttons are **+ paid** / **− repaid**; history tags render positive
entries as `PAID` and negative as `REPAID` (`app.js:978` — and the CSS class for the
positive tag is `.lent`, betraying the older, clearer word); the History intro says
"lent, paid, and interest". A `PAID` chip on a ₹12,000 loan you made reads like money
that came *in*. The hover `title`s clarify, but titles don't exist on touch.
*Fix:* pick one vocabulary and use it everywhere — `LENT` / `REPAID` for the tags is the
smallest change (the class name already agrees), and the buttons read fine as
**+ lent** / **− repaid** (or keep "+ paid" but retitle the tag).

**M2 — Interest rows say "accrued" three times.**
In History, a virtual-interest row renders Type `INTEREST`, Group `accrued`, Reason
"accrued, not yet capitalized" — and the person modal shows "Interest accrued
*INTEREST* (not yet capitalized)". On the phone this redundancy costs a second line on
every interest row. The italic + gold tinting already carries the "projection, not
committed" signal beautifully.
*Fix:* let the tag carry the type and the reason carry only the qualifier — e.g. Type
`INTEREST`, Group `—`, Reason "not yet capitalized".

**M3 — The drawer is ~80% empty.**
It holds exactly two items, pinned to the *bottom* (`index.html:80-91`,
`.drawer-section-end`), so opening it shows a tall blank panel with Settings/Account at
the floor — it reads as broken, and the items sit maximally far from the hamburger the
thumb just tapped (top-left).
*Fix:* until the drawer earns more content, put the two items at the top; or give the
top section content that pays rent (theme toggle, backup shortcut, the app version /
"about" line).

**M4 — Account view shows a divider to nothing when Google sign-in isn't configured.**
With `GOOGLE_CLIENT_ID` empty (the out-of-the-box state), the view reserves a blank
40px row (`.google-signin`, `styles.css:708`) and still renders the "── or use email ──"
divider — but there's nothing above it to be an alternative *to*.
*Fix:* when no client ID is configured, skip the placeholder and the divider and let the
email form lead.

**M5 — Amounts can wrap mid-figure.**
`.money` has no `white-space: nowrap`; in the seeded desktop ledger, Dev's accrued
interest rendered as `+` on one line and `₹1,302.50` on the next inside the Interest
column. A money figure should never break internally.
*Fix:* `.money { white-space: nowrap }` (and audit `.rule-ear`-style numerics — that one
already has it).

**M6 — The masthead net stamp silently ignores other currencies.**
"Owed to you · ₹17,721.90" is the INR-only net; the seeded USD and GBP balances are
invisible in the header with no cue that anything was excluded. The behaviour is by
design (no conversion — good), but the presentation implies a grand total.
*Fix:* either render one small stamp per currency with a nonzero net, or qualify the
single stamp (e.g. "Owed to you (INR)" / a `title` explaining other currencies live per
person).

**M7 — Scrollable checklists give no scroll cue.**
The split/indirect/share people lists scroll inside the modal (`.split-scroll`,
`.share-scroll`) while the amount fields stay fixed — the right pattern — but at phone
sizes the cut can land exactly on a row boundary, so nothing signals more names below
(the seeded 6-row list showed 4–5 with the last cleanly clipped).
*Fix:* a bottom fade (mask-image or a gradient overlay) on the scroll region, or
`overscroll` padding that leaves a half-row peeking.

**M8 — No `prefers-reduced-motion` support.**
Animations are tasteful and short, but the drawer slide, modal rise/fade, toast slide
and panel flash all play regardless of the OS setting.
*Fix:* one media query zeroing the motion tokens:
`@media (prefers-reduced-motion: reduce) { :root { --duration-fast: 0ms; --duration-normal: 0ms; } … }`
plus the few hard-coded transition/animation durations.

**M9 — Desktop ledger rows are mostly air.**
On wide screens the Person and Groups columns take half the width for a name and a
chip, the three money columns huddle in a narrow band, and the three-line quick-entry
stack (amount+buttons / repaid / reason) sets a tall row height — so each row is a large
box that's ~70% empty. The phone layout of the same data is tighter and easier to scan.
*Fix:* on `min-width: 681px`, let quick-entry sit on one line (amount, +, −, reason
inline) and rebalance column widths so the numbers sit nearer the names.

### Low

**L1 — Two theme boot scripts, one dead.** `index.html` carries the FOUC-prevention
script twice (lines 9–23 and 33–47); the first checks `pref === 'system'`, which never
matches (`store.js` uses `'device'`), so it mis-themes a saved-dark-pref-on-light-OS
user for a frame until the second runs. Keep one (the `'device'` version).

**L2 — Toasts are invisible to screen readers.** `showToast` injects a plain div
(`components/toast.js`); give the stack `role="status"` / `aria-live="polite"` so
"Copied", "All square with…" etc. are announced.

**L3 — Tabs lack `aria-current`.** Active state is class-only (`app.js:2099`); add
`aria-current="page"` on the active tab/drawer item for assistive tech.

**L4 — Mobile meta-line separators dangle.** In phone History cards the `·` after
Group renders even when the reason wraps to its own line (seeded Ben row: "Trip to Goa ·"
with the reason below). Consider suppressing the last separator or keeping reason on the
same flex line with `flex-wrap` handling.

**L5 — "Balances as of …" wraps badly on the phone.** The timestamp orphans ("AM" alone
on line two) beside the Share button. Shorten the format on narrow screens (drop the
year or the minutes) or let the line truncate.

**L6 — Group-card multi-currency nets wrap with a leading "·".** "Trip to Goa" shows
`net you owe $42.50 · net owed to you £75.25 · net owed to you ₹14,752.50` as wrapped
inline text, the separator landing at a line start. Render one currency per line
(block spans) — it also makes the amounts scannable.

**L7 — The "no interest" chip crowds the name row.** On phone cards (seeded Ben) the
exempt chip sits between name and Settle on the header line; moving it next to the group
chips keeps the header to name + action.

---

## Suggested order of attack

Cheap, high-value fixes first:

1. `.money { white-space: nowrap }` (M5) — one line.
2. Escape-to-close + `role="dialog"`/`aria-modal` + focus on open/restore on close (H1).
3. Cap the calendar width on desktop (H3) — a few lines of CSS.
4. Drawer items to the top (M3) and Account's dormant-Google cleanup (M4).
5. `prefers-reduced-motion` block (M8), toast `role="status"` (L2), `aria-current` (L3),
   dedupe the theme boot script (L1).
6. Tag vocabulary: `PAID` → `LENT` (M1) and de-duplicate interest-row copy (M2).
7. Visible "Select" entry point for multi-select (H2).
8. Desktop ledger row/quick-entry rebalance (M9) — the biggest layout change, last.

None of the findings undermine the design direction — the banker's-ledger identity,
token discipline and mobile care are exactly right. The work is in keyboard/AT parity
(H1/H2/L2/L3), desktop layout economy (H3/M9), and tightening the words where money
direction and interest state are narrated (M1/M2/M6).
