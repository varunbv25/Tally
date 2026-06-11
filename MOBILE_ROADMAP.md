# From web app to mobile app — the roadmap

Tally was deliberately built to make this cheap: the entire business logic
(`store.js` — balances, interest engine, rules, currencies) has zero DOM or
framework dependencies, so it ports to every option below unchanged.

There are three viable routes, in increasing order of effort. The smart play
is to do them **in order** — each phase ships something usable.

---

## Phase 1 — PWA (Progressive Web App) · ~1–2 days

Make the existing app installable on phones with no app store at all.

1. Add `manifest.json` (name, icons, theme color `#1e5b3f`, `display:
   standalone`).
2. Add a service worker that precaches `index.html`, `styles.css`,
   `app.js`, `store.js` and the fonts → the app works fully offline
   (it already has no server dependency).
3. Generate icons (512/192/180px + maskable) and iOS meta tags
   (`apple-mobile-web-app-capable`, `apple-touch-icon`).
4. Host it anywhere static (GitHub Pages, Netlify, Cloudflare Pages —
   free). HTTPS is required for service workers.
5. Users hit "Add to Home Screen" on Android (real install prompt) or iOS
   (Share → Add to Home Screen). It launches full-screen like a native app.

**Mobile-UX polish to do in this phase:**
- Collapse the ledger table into stacked cards under ~480px.
- Bottom tab bar instead of top tabs (thumb reach).
- `inputmode="decimal"` on amount fields for the numeric keypad.
- Larger touch targets (44px minimum) on the +/− buttons.

**Limitations:** no app-store presence, no push notifications on older iOS,
data still trapped in one browser's localStorage.

---

## Phase 2 — Native wrapper with Capacitor · ~1 week

Put the same code in the App Store / Play Store.

1. `npm init` the project, add `@capacitor/core @capacitor/cli`, then
   `npx cap add ios android`. The web app becomes the app's WebView content
   — **zero rewrite**.
2. Swap `localStorage` for the **Capacitor Preferences/SQLite plugin**
   (localStorage can be evicted by the OS; SQLite is durable). This is a
   ~30-line change isolated in `store.js` (`loadState`/`saveState`).
3. Add native niceties via plugins:
   - **Local notifications** — "Rohan's debt just crossed ₹2,500" or weekly
     "interest accrued" summaries (the rule engine already computes this).
   - **Share sheet** — send someone a settlement summary on WhatsApp.
   - **Haptics** on settle-up, **biometric lock** (Face ID) for privacy.
4. App-store mechanics: Apple Developer account ($99/yr), Google Play
   ($25 one-time), privacy policy URL, screenshots, review process
   (budget a week for Apple review round-trips).

---

## Phase 3 — Backend + sync = the real Splitwise competitor · ~4–8 weeks

Everything so far is single-device, single-user. To let the *other* person
see what they owe (Splitwise's core trick), you need a backend.

1. **Stack:** Supabase (Postgres + auth + realtime) or Firebase. Supabase
   fits better — the data model is already relational (people, groups,
   transactions, rules).
2. **Schema:** mirrors `store.js` state, plus `users`, `invites`, and
   `audit_log` tables. Balances stay derived from transactions (never
   stored), exactly as the web app does — this is what makes cross-group
   consistency automatic.
3. **Auth & invites:** phone/email magic links; an invite link attaches a
   real user account to a "person" row, so debtors see their own balance
   (and watch the interest tick, which is excellent psychological warfare).
4. **Sync strategy:** offline-first — keep the local store as the source of
   truth, queue mutations, reconcile via server timestamps. Transactions
   are append-only which makes conflicts rare and merges trivial.
5. **Interest fairness:** move accrual computation to a single place
   (server-side function or shared JS package) so both parties see
   identical numbers; pin each rule's parameters at the time a debt is
   incurred so retroactive rule edits can't rewrite history.
6. **Currencies:** pull daily FX rates from a free API (e.g.
   exchangerate.host) instead of manual entry.

**Optional Phase 4 — full native rewrite (React Native + Expo)** only if the
WebView feel becomes a limitation: reuse `store.js` as-is (it's pure JS),
rebuild views in RN components, share the backend from Phase 3. ~6+ weeks.

---

## Recommendation

Ship **Phase 1 this week** (it's nearly free), do **Phase 2** when you want
store presence, and commit to **Phase 3** only once other people actually
ask to see their balances — that's the point where this stops being a
personal ledger and becomes a product.
