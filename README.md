# TALLY — the ledger that keeps score

A Splitwise-style debt tracker with the parts Splitwise won't give you: an
Excel-like quick-entry ledger, configurable **simple & compound interest**,
**conditional formatting**, shared people across **multiple groups**, and
**multi-currency** support. No build step, no account, no server — your data
lives in your browser's `localStorage`.

## Run it

Either:

- Open `index.html` directly in any modern browser, **or**
- `node serve.js` → http://localhost:4173

## Features

### The Ledger (Excel-like)
- One row per person; type an amount and hit **+ lent** / **− paid** to
  append entries, exactly like adding to a running spreadsheet column.
- Positive balance = they owe you. Negative = you owe them.
- Click a name for full history: backdated entries, per-group tagging,
  notes, deletes, settle up, capitalize interest.

### Groups
- People are **global**; groups only reference them. The same person can be
  in any number of groups, and a payment recorded in one group instantly
  changes their balance everywhere — there is exactly one source of truth.
- Group activity feed shows entries tagged to that group.
- Deleting a group keeps people and balances; only the grouping disappears.

### Interest rules (all variables are variable)
Build rules as sentences: *if balance `>` `1000`, charge `5`% `compound`
interest per `month`, capped at `N` periods (optional).*

- Condition: any of `>` `>=` `<` `<=` `=` against any threshold.
- Scope: everyone, or only members of a chosen group (per-group rules).
- Type: simple (charges on principal) or compound (charges on principal
  plus accrued interest).
- Period: day / week / month / year. Optional total-duration cap (the
  "time period T").
- Interest lands in full-period steps: the first charge arrives at the
  start of the next calendar day (the device's local midnight) after a
  rule's condition is met, then one charge per period after that.
  The engine walks each person's real transaction timeline, so partial
  repayments immediately shrink the base.
- Timing follows the device's timezone, recorded as it changes. If you
  travel, interest already charged stays exactly as it was; only the
  charges dated after the move re-phase to the new local midnight.

Interest never accrues on money *you* owe (negative or zero balances earn
nothing), people can be marked "interest exempt", rules are evaluated
top-down with first match winning, and capitalizing or settling moves the
accrual anchor so past time is never billed twice. Accrued interest only
shows as its own column while the balance still meets a rule's condition;
once a repayment drops it below, the interest is rolled into the principal
and the column goes blank — so the next time the balance crosses a
condition, fresh interest accrues on that larger principal.

### Split an expense
Paid for something shared? From the **Ledger**, hit **÷ Split expense**,
tick everyone who's in on it, and enter the total (with an optional reason
and date). Tick **Me** to count yourself as one of the sharers — your share
shrinks everyone else's but is never recorded as a debt. Need someone who
isn't in your list yet? Type their name under the people and hit **+ Add**
to create them, already ticked, without leaving the popup. Tally divides the
total equally and records each other person's share as money they owe you —
one entry per person, tagged **SPLIT** in History. Shares are rounded to
whole cents with the remainder spread one cent at a time (you, the payer,
absorb the leftover when you're in the split), so they always sum back to
the exact total. A live preview shows precisely what each person will owe
before you commit; mixed currencies are applied in each person's own
currency, never converted.

### Indirect payments
When someone who owes you (the **lender**) is themselves owed by a third
person (the **receiver**), route the debt onto your ledger from the
**Indirect** tab: the lender's balance with you drops, and the receiver
who owed them now owes you instead. Your overall position is unchanged —
the debt just moves to whoever can actually pay. A live preview shows the
exact before/after for both people, and each transfer is recorded as two
linked entries (tagged **INDIRECT**, with a *via* label) so it shows in
History and can be undone in one step, reverting both balances.

### History
A dedicated tab listing every entry across everyone — lent, paid, and
interest — newest first. Search filters by person, reason, amount, or
date in one box. Tap a name to open that person's full record.

### Currencies
12 currencies; each person has their own. The header shows a net position
per currency — amounts are never converted between currencies.

### Data
Export/import a CSV spreadsheet from Settings (one row per entry, opens in
Excel/Sheets/Numbers). Importing rebuilds people, groups and entries;
interest rules and settings stay on the device. Nothing ever leaves the
browser unless you export it.

## Architecture

| File | Role |
|---|---|
| `store.js` | State, persistence, CRUD, the interest engine, currency math |
| `app.js` | Rendering (vanilla JS, full re-render) and delegated event handling |
| `styles.css` | Banker's-ledger theme (Fraunces + IBM Plex, cream paper, green ink); type/spacing/radii driven by design tokens in `:root` |
| `serve.js` | Optional zero-dependency dev server |

The data layer (`store.js`) has no DOM dependencies — it is deliberately
portable so it can be reused verbatim in a mobile app. See
`MOBILE_ROADMAP.md` for the path from this web app to the app stores.
