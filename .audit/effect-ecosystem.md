# Effect ecosystem: Foldkit web app, Alchemy infra

Goal: move Fama onto the Effect ecosystem. The web app moves to Foldkit. Alchemy manages the Cloudflare infra when the infra next changes.

Done when: the Foldkit web app passes the verify-fama web recipes, and every role and accessible name matches the React baseline (or a stated reason covers each difference). Web tests and the repo typecheck pass. React is gone from apps/web.

Rigor: medium-high. The web rewrite is reversible (a branch). The Alchemy first deploy is one way, so it waits.

## Units

- [x] U0 effect 4.1.3 to 4.1.4 (5534925). Typecheck green in 4 packages, 31 API tests green.
- [x] U1 baseline of the React app's handles: `~/Developer/fama-shots/verify/20261120-113627/baseline/handles.md`, states 01 to 15. It found 9 drifts between the app and the verify-fama handle tables. Fix the skill after U2 lands, to avoid a merge conflict with the port branch.
- [x] U2 Foldkit port: branch `t3/web-foldkit-rewrite`, head 4b82404 (3 commits, not signed: the 1Password agent had no identities). Web 15 tests, API 31 tests and the repo typecheck pass. Only effect@4.1.4 is in the lockfile. Six verify recipes ran live (evidence 20261120-115312). No role or name differs from the baseline. Source went from 1,751 to 2,865 lines. update.ts has 607 lines and subscription.ts has 311.
- [x] U3 own verify-fama run plus a review from another model family
  - own run 20261120-120729, VERIFIED: the first-run dialog opened with `Try again` behind it, as in the baseline. Save worked. The Icelandic link `grein.html` was added through the add bar and became Ready (piper steinn, 30.2 s). The position moved from 751 to 3674 ms in 3 s. Pause worked. The bundle is index-CudW1f38.js, the same as the agent's.
  - Codex review 1 (gpt-6.2-sol): CHANGES REQUESTED, 7 findings: the ended state is lost after Forward 30, the raw token is in the DevTools history, a stale feed response, the Safari file picker gesture, a stale Copied timer, storage events between tabs, menu type-ahead. A fix agent is working on them. The React app has the same repeated-401 gap, so it is out of scope.
  - Fix round: 8 commits 4b82404..38a9847, not signed. 29 web tests pass and typecheck is green. Live run 20261120-122528: findings 1, 4, 5, 6 and 7 VERIFIED. Findings 2 and 3 are covered by tests only. Gap left: storage events for voice, speed and rate.
  - Codex review 2: all 7 round-1 fixes confirmed (each regression test fails when its fix is removed). CHANGES REQUESTED, 5 findings: storage events for voice, speed and rate; Space inside a type-ahead prefix; an unmatched key keeps the prefix; a stale saved position across tabs; a late 401 from the old connection. Fix round 2 is running.
  - Fix round 2: 5 commits 38a9847..161e8d8, signed. 37 web tests pass and typecheck is green. Live run 20261120-124219: findings 1 to 4 VERIFIED, with two tabs for 1 and 4. Finding 5 is covered by a test only. Fast key sequences were sent by script, because the preview tool sends keys about 900 ms apart.
  - Codex review 3: the round-2 fixes are confirmed. CHANGES REQUESTED with 5 small findings: a missing saved position should start at 0; type-ahead s,s,k; type-ahead on the chapter number; a pending Play beaten by a later Pause; a stale reply after switching A to B to A. Fix round 3 is running, with a connection generation counter to close the class of stale replies.
  - Next review bar: block only for a bug a user hits that the React app did not have (worker.md).
  - Fix round 3: 5 signed commits 161e8d8..8a9c07c. 42 web tests pass and typecheck is green. Live run 20261120-130447: findings 1, 2 and 3 plus the smoke test VERIFIED (DOM reads; the hidden window gave no screenshots). Findings 4 and 5 are covered by tests only.
  - Codex review 4: the round-3 fixes are confirmed. CHANGES REQUESTED with 4 blocking findings: a late feed failure after a reopen, a menu that does not flip, the player-bar backdrop held inside the footer (backdrop-filter makes a containing block), and a slider that cannot reach the end.
  - Round 4, fixed in-thread (small): 3242f20 feed request number, ad6bd20 slider last step = end, 83924ef blur on its own layer, 94bc964 pickerSide flip, 4138cb2 a stronger doubled-letter test. 46 web tests pass and typecheck is green. The feed and slider tests fail without their fix. Live run 20261120-131930: with Chapters open, a click on a library row hits the backdrop, the menu closes and no other episode starts. With the old footer filter put back by script, the click reached the row.
  - Codex review 5: the feed, flip, backdrop (desktop and mobile, overlay, dialog, safe area) and test fixes are confirmed by revert checks. CHANGES REQUESTED for one item: the slider mapped 46,000 to the end. Fix 74be8a4: the max rounds up to a whole step, so 46,000 stays a stop and the extra 47,000 stop is the end. 47 tests pass, and the new test fails on the old fix.
  - Codex review 6: the end stop is confirmed (46,000 resumes there; the end shows 100% fill, the right clock and aria-valuenow 46525, and the next Play starts from the top; exact whole-second lengths have no extra stop). It requested 2 keyboard changes. I judged both non-blocking: Home or End do nothing only within 0.5 s of the target, because the range rounds to whole seconds. PageUp near the end jumps to the end, which is Chrome's native page step; React's 10 ms step was a base-ui quirk.
  - Re-signed all 27 rewrite commits (tree unchanged). Fast-forwarded `web-foldkit` to 3cbe48f. In the main checkout: typecheck green in 4 packages, 31 API tests and 47 web tests pass.
  - a14ca82: the verify-fama handles now match the app, including the 9 drifts from U1 and the Foldkit frame timing.
- [ ] Alchemy: deferred, see the decision log

## Decision log

| When | Decision | Why |
|---|---|---|
| 2026-11-20 | effect 4.1.4, not 4.1.5 | 4.1.5 was published the same day and pnpm's minimum release age flagged it. 4.1.4 meets Foldkit (~4.1.0) and Alchemy (^4.1.4). |
| 2026-11-20 | Defer Alchemy | No infra change is needed now. The first Alchemy deploy is one way: it adds an `__alchemy_migrations` table to prod D1, switches the bundler to rolldown, and adds the `new_module_registry` flag. Until a real infra change, it would only add a second config next to `wrangler.jsonc`, which local dev and verify-fama still need. |
| 2026-11-20 | Keep the Worker code as is when Alchemy comes | Alchemy deploys `src/worker.ts` unchanged. The `Cloudflare.Worker(Effect)` form is a separate rewrite. |
| 2026-11-20 | Port in place, no parallel app | Outcome-oriented: React leaves in the same change. |
| 2026-11-20 | Own Menu and native range input, not @foldkit/ui Menu and Slider | The @foldkit/ui Menu has no `menuitemradio` or `aria-checked`, and the baseline has both. The baseline slider is a native range input. |
| 2026-11-20 | Review bar from round 4 on: only bugs a user hits that React did not have | Each review round found smaller items. worker.md sets the bar. |
| 2026-11-20 | Decline review 6's Home/End and PageUp items | No realistic user path: Home and End are no-ops only within 0.5 s of the target. PageUp follows Chrome's native step. |
| 2026-11-20 | Keep a hidden `input[type=file]` | `File.select` makes a temporary input and breaks the verify handle. |

## Research

- Foldkit: [foldkit-research.md](foldkit-research.md)
- Alchemy: [alchemy-research.md](alchemy-research.md). First step when adopted: `alchemy plan --stage prod --adopt`. It must show three adopted updates and no create, delete or replace. Fixed names only on the prod stage, plus `RemovalPolicy.protect`.
