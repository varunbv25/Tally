# Tally — UX Specification

A comprehensive UX spec for Tally as an expense-sharing app, written from the
perspective of a principal UX designer. It documents the information
architecture, the low-friction add-expense flow, edge-case handling, and
accessibility rules — and maps each of them to how the shipped app implements
them on both phone and desktop.

Visual language: **clean white (default) and dark slate (#121212) themes; emerald green
= money coming to you, coral-orange = money you owe.** The same two hues carry
the same meaning in every view, in both themes.

---

## 1. Information Architecture

Four core views. On the phone they live in a bottom navigation bar (thumb
reach), with a raised emerald **+** FAB at its centre; on desktop they live in
a top tab bar with header actions.

- **Dashboard (Ledger)** — the default view, answers "where do I stand?" in one glance
  - Total Balance hero card: net position, split into *You are owed* (emerald) and *You owe* (coral)
  - Per-person balance tiles: principal, interest, total; inline quick entry (amount → *+ lent* / *− repaid*). Uniform tiles — one height, one column for each of the name, the *Settle* button and each figure — so the list scans as a stack, not a ragged one. Group membership isn't a column here; it's on the person's own card.
  - Search field (filters only) with a **+** button beside it that opens the add-a-person panel: name plus an optional opening amount
  - Long-press any tile → multi-select mode (share / delete from the top bar)
- **Groups**
  - Group cards: name, member count, members, per-currency net for the group
  - Group detail: members, group history, share, rename, add/remove members
  - Note that per-group nets overlap and are not additive (one payment shows in every group)
- **Add Expense (the centre FAB — a flow, not a place)**
  - Split an expense: *Paid by* and *Split between* are the same list of name tiles, each folded into a dropdown (one radio pick, several ticks); equal or custom shares; a payer other than Me records the shares as indirect payments
  - Quick entry on any person tile (the one-line "spreadsheet row" path)
- **Activity (History)**
  - Reverse-chronological register across everyone: lent / repaid / interest / split / indirect
  - Search (person, reason, amount, date) + collapsible calendar filter with entry-dot markers
  - Long-press an entry → multi-select for deletion
- Secondary, one corner each — two separate menus, no shared drawer:
  **Account** (cloud sync) behind the user button in the masthead's top-right
  corner, and **Settings** (theme, currency, interest rules, alerts, data
  backup) behind the gear in the bottom-right corner — the last slot of the
  bottom bar on the phone, a floating button on wider screens.

## 2. Frictionless "Add Expense" Flow

Goal: from **+** to a recorded bill in under 10 seconds, with at most one
required number.

1. **Tap *÷ Split expense*** in the Ledger header. The modal opens with focus managed, on an opaque backdrop — the page behind is frozen and out of sight, not showing through.
2. **Pick who shared the bill.** Everyone is a large tappable tile with a tick circle — the whole tile is the target, not the checkbox. "Me" is pinned first.
3. **Only people you already have.** The picker lists the Ledger, and nothing else: people are created on the Ledger, so the split flow stays one decision wide. With nobody on the Ledger yet, the picker says so and points there.
4. **Enter the total** — one number field, numeric keypad on mobile (16px input so iOS never zoom-jumps). Date defaults to today; reason is optional.
5. **Live share preview.** Every keystroke re-renders "each person's share" — the maths is always visible *before* committing, never a surprise after.
6. **Uneven shares without mode-switching:** long-press a person's tile to give them a custom amount; everyone else automatically re-splits the remainder. A tag on their tile shows who left the equal split, and a second long-press puts them back.
7. **Record split.** One tap writes one transaction per debtor, the modal closes, the ledger re-renders, and a toast confirms. The OS back gesture cancels at any step (navigation is history-backed).

Friction removed by design: no required category, no payer-picker when it's
you, no confirmation screen — the preview *was* the confirmation.

## 3. Edge Cases & Error Handling

- **Uneven cents.** Shares are computed in integer cents; the remainder after floor-division is distributed one cent at a time so the shares always sum *exactly* to the bill (₹100 ÷ 3 → 33.34 + 33.33 + 33.33). Property-tested in `tests/split.test.js` — no cent is ever lost or invented.
- **Settling up offline.** Tally is local-first: every view renders from local storage and every action (settle included) commits locally and instantly. A quiet "Offline · showing saved data" pill appears in the header — reassurance, not an alarm — and cloud sync (if enabled) reconciles when connectivity returns. The user is never blocked from recording money because of the network.
- **Adding a non-group member to a group bill.** The split flow accepts anyone on the Ledger, group member or not: the visiting friend is added on the Ledger once, then ticked in the picker like everybody else — without polluting the group's membership. The debt lands on their personal ledger; the group's own history stays scoped to members.
- **Empty states as onboarding.** A new account never sees a blank screen: the ledger shows a friendly card ("Your ledger is empty") with a single primary action, and explains the privacy model ("everything stays in this browser"). A search with no matches points at the **+** beside the box instead of a dead end.
- **Destructive actions.** Deletes and settlements always pass through a confirmation card stating the consequence ("removed along with ALL of their transactions… cannot be undone"), with the safe action available and the OS back gesture as a cancel.
- **Accidental gestures.** A long-press that moves >10px is cancelled (it was a scroll); a completed long-press swallows the ghost click behind it; one long-press produces exactly one haptic pulse.

## 4. Accessibility (a11y) Guidelines

**Color & contrast for financial figures**
- Money is never color-alone: sign (＋/−), wording ("you lent" / "you borrowed", "owed to you" / "you owe") and position always accompany the hue, so red-green color-blind users read the same story.
- All small money text meets WCAG AA 4.5:1 in both themes: emerald `#058a68` and coral `#c2410c` on white; emerald `#2fd6a0` and pastel coral `#ff9b7a` on `#1c1f1e` slate. Secondary text is darkened/brightened per theme to hold ≥4.5:1.
- Money uses a tabular-figures monospace so columns of amounts align and magnitudes scan correctly; amounts never line-break mid-figure.
- Focus is always visible: a 2px emerald ring on every keyboard-reachable control, in both themes.

**Screen-reader logic for debts**
- Read debts as a sentence, not a signed number: "Aarav owes you ₹1,250" / "You owe Meera ₹480" — direction first, then amount. A bare "−480" is meaningless by ear.
- Balances carry their as-of moment ("Balances as of 21 Aug, 3:01 pm") because interest is time-based; the ledger exposes it as text, not just visual context. It appears only while interest is switched on — with no rule running, a balance changes only when someone records an entry, and an as-of stamp would be answering a question nobody asked.
- Selection state is real state: pick-tiles keep a hidden native checkbox that carries focus and `checked`, so SRs announce "checked/unchecked", while the visual tick is `aria-hidden`.
- Modals: focus moves into the dialog on open, Tab is trapped inside, Escape/back closes; the page behind is inert (scroll-locked and covered by an opaque scrim).
- Touch targets ≥44px on touch devices; `prefers-reduced-motion` collapses all transitions/animations without changing any end state.
- Navigation is semantic: `<nav aria-label="Primary">`, `aria-current="page"` on the active tab, and status text (offline pill, toasts) in live regions.

## 5. Responsive Rules (phone ⇄ desktop)

| Aspect | Phone (≤680px) | Desktop |
|---|---|---|
| Navigation | Bottom bar (Settings in its last slot) + Account button in the header | Top tabs + Account top-right of the header, Settings gear at its bottom-right |
| Ledger | Stacked cards, one per person | True table with aligned money columns |
| Header | Sticky, opaque, safe-area aware | Sticky, opaque, max-width 1000px |
| Add expense | FAB → full-height modal, keypad-friendly | Header button → centered 700px modal |
| Touch | 44px minimum targets, 16px inputs (no iOS zoom) | Hover states, keyboard focus rings |
