# Lannent — Bug Fix Log

Every error found and fixed on the `bug-fixes` branch, grouped by where it came from.
Each entry says what was wrong, what changed, and where (paths are relative to the repo root).

**How it was verified**

| Check | Result |
|---|---|
| Backend typecheck — `cd back-end && npx tsc --noEmit -p tsconfig.json` | clean |
| Backend unit tests — `npm test` | 17 / 17 pass |
| Backend end-to-end tests — `npm run test:e2e` | 90 / 90 pass (24 new in round 4; bidding tests replaced in round 5; 1 new in round 6) |
| Frontend production build — `cd frontend-react && npx vite build` | builds |
| ESLint on `frontend-react/src` | no undefined variables or parse errors (2 reports are only a missing `react-hooks` plugin definition in the lint config) |

One e2e test replays the reported case end to end: budget $500, audit fee $300, dispute fee $1,200. It checks that every fee goes into escrow, that the revenue report lists audit and dispute money separately, and that escrow is empty when the project completes.

**How to run**

- Development: `npm run start:dev` in `back-end/` and `npm run dev` in `frontend-react/`.
- Single server: run `npm run build` in `frontend-react/`, start the backend, then open `http://localhost:3000`.
- Demo logins are listed on the login page. All data is kept in memory and goes back to the seed data on every restart, which is intended.

---

## 1. Problems reported by the project owner

| # | Problem | Fix | Main files |
|---|---|---|---|
| R1 | The **project budget was not taken from the client's wallet** when a project was created. Only the audit fee moved. | The budget moves into project escrow as soon as the project is posted. Marketplace and contract fees are charged at hire, and any shortfall on older projects is topped up then. Editing the budget adjusts escrow, but never below the milestone total. Cancelling or deleting refunds every bucket. On completion, unused budget is returned. | `back-end/src/modules/ledger/ledger.service.ts` (`fundProjectBudget`, `chargeContractFees`, `adjustProjectBudget`, `refundRemaining`), `tasks/tasks.service.ts` |
| R2 | **Audit and dispute amounts were not shown in escrow.** | Escrow has three separate buckets: project, audit and dispute. New endpoints are `GET /ledger/my-escrow` and `GET /ledger/escrow/:taskId` (parties only). The client wallet shows real per-bucket escrow from the server instead of estimating it from milestones. | `ledger.service.ts`, `ledger.controller.ts`, `frontend-react/src/pages/ClientWallet.jsx` |
| R3 | **The $1,200 dispute fee stayed in escrow** after the project completed. | The dispute verdict now pays the reviewer out of the dispute bucket (`dispute-fee-release`). A reviewer can only give a verdict once their fee has been agreed, funded and accepted. An operations override refunds the fee to whoever paid it. | `disputes/disputes.service.ts`, `audit-requests/audit-requests.service.ts` (`settleDispute`, `closeForDispute`) |
| R4 | **The revenue admin page lumped audit and dispute money together** in "client paid". | Dispute money now has its own lines: money into dispute escrow, worker paid, dispute reviewer payouts, dispute money still held, and "Paid to reviewers (disputes)" in the distribution chart. | `back-end/src/modules/revenue/*`, `frontend-react/src/pages/AdminRevenue.jsx` |
| R5 | **The reviewer fee could not be set** when raising a dispute, and the field was labelled "(optional)". | The fee is required and the "(optional)" label is gone. *(Updated in section 6: only clients raise disputes, so the client always pays this fee; the worker Dispute Fees page was removed.)* | `disputes/dto`, `audit-requests.service.ts` (`payerId`), `pages/Dispute.jsx`, `ClientAuditOffers.jsx` (`/audit-offers`) |
| R6 | **The dispute page showed audit actions** when only "Resolve this dispute" belongs there. | Dispute engagements show only the resolve action, plus the dispute details, desired outcome and payer. | `frontend-react/src/pages/ExpertAuditPreview.jsx`, `ExpertDisputeCases.jsx`, `ResolveDispute.jsx` |
| R7 | **Report PDF download did nothing.** | Added a real PDF generator (A4, multi-page, wrapped text). The dispute report, audit report and milestone report pages each download a `.pdf`. | `frontend-react/src/utils/pdf.js`, `ExpertReportDispute.jsx`, `ExpertReportAudit.jsx`, `MilestoneReports.jsx` |
| R8 | **Account settings did not save.** | The server accepts every field the settings pages send: email (must be unique), phone, bio, company details, job title, experience, hourly rate, languages, portfolio, availability, and expert domains (checked against the category list). The client, worker, expert and staff settings pages save for real and show the server's error message. Each has a **Change password** card, and the fake "Upload photo" was replaced by an avatar colour picker. | `users/dto/update-user.dto.ts`, `users.service.ts`, `ProfileSettings.jsx`, `WorkerSettings.jsx`, `ExpertSettings.jsx`, `StaffSettings.jsx`, `components/ChangePasswordCard.jsx`, `components/AvatarColorPicker.jsx` |
| R9 | **Notifications did not work.** | The server creates notifications for every key event (proposal, hire, submit, approve, revision, dispute, audit, payment, message). Each notification has a link and can be marked read with `PATCH /notifications/:id/read`. The bell checks for new ones every 15 seconds, and clicking one opens the related page. The fake client-side notifications were removed. | `notifications/*`, `components/NotificationDropdown.jsx`, `context/StoreContext.jsx` |
| R10 | **Experts had no wallet.** | New Expert Wallet page showing earnings, fees held in escrow, transactions and withdrawals, using a shared `EarningsWallet` component. The worker wallet uses the same component. | `pages/ExpertWallet.jsx`, `components/EarningsWallet.jsx`, `pages/WorkerWallet.jsx` |
| R11 | **The profile page did not work.** | New `/profile` page that shows your own profile, or anyone's public profile with `?id=`. Other people's email, phone and wallet are hidden. | `pages/Profile.jsx`, `users.service.ts` (public view) |
| R12 | **"Quick Demo Access" was on the home page.** | Removed, along with the `?demo=` login prefill. The login page keeps its demo-credentials box, as agreed. | `pages/Home.jsx`, `pages/Login.jsx` |
| R13 | **Forgot password** | Removed completely, as requested: backend endpoints, request queue and test, the page, its route and links, the Superuser Users panel, and the CSS. *(Round 4: the superuser password reset was removed too — see section 7.)* | `auth/*`, `App.jsx`, `pages/SuperuserUsers.jsx` |

---

## 2. The 21 problems found in the first code review

### Money and workflow

| # | Problem | Fix |
|---|---|---|
| 1 | A client-favour verdict refunded the milestone but reopened it as revision-needed. Approving it later spent escrow that belonged to other milestones, so the last milestone could never be paid. | *(Superseded in section 6.)* There are now exactly two verdicts. A client-favour verdict sends the milestone back to the worker's To Do list with the reviewer's notes and leaves its escrow held, so nothing is ever approved without money behind it. `disputes.service.ts` |
| 2 | Resolving a dispute never paid the reviewer, and a reviewer could rule before their fee was funded. | The verdict pays the reviewer from dispute escrow. It is refused until the engagement is `in-progress`. |
| 3 | A dispute with no reviewer could never be resolved. Seed dispute `d1` had none, and the superuser disputes page redirected superusers away. | A reviewer and fee are required to raise a dispute. Seed `d1` was given a reviewer. Superusers can override-resolve from **Superuser Disputes**, and the reviewer fee is refunded when they do. |
| 4 | "Find another reviewer" created an audit with no reviewer, which no expert could see. | New endpoint `POST /audit-requests/:id/reassign {expertId, openingOffer}`. The page offers a reviewer picker that excludes the expert who declined. `ClientAuditOffers.jsx`, `components/ExpertPicker.jsx` |
| 5 | The client's review page showed the first audit report on the project, not the one for the milestone under review. | Reports are matched by milestone. `ReviewDeliverable.jsx` |

### Data silently dropped, or success shown when nothing happened

| # | Problem | Fix |
|---|---|---|
| 6 | The dispute's "details" and "desired outcome" were stripped by validation. | Both are now in the request schema (`CreateDisputeDto`), stored, and shown to the reviewer. |
| 7 | Settings fields were dropped but the page still said "saved". | See R8. |
| 8 | The "Request Changes" comment was never sent. | Stored on the milestone as `revisionNote` and shown to the worker on Submit Deliverable. |
| 9 | Fake success messages: Save Draft, Resolve Dispute with no ID, Workroom attach, dispute PDF, forgot password. | Save Draft removed. Resolve Dispute requires a dispute ID. Workroom attachments upload for real. PDF is real (R7). Forgot password removed (R13). |
| 10 | The Expert Messages page was hard-coded demo data. | Removed, with a redirect to the real `/messages`. |
| 11 | Withdraw (Client Wallet) and Save (Admin Fee Config) crashed when the server refused. | Both catch the error and show the server's message. |

### Mismatches and dead pages

| # | Problem | Fix |
|---|---|---|
| 12 | Deliverable upload accepted 50 MB and code/archive types the server rejects. | The frontend allowlist and 10 MB limit now match the server. `SubmitDeliverable.jsx` |
| 13 | Intake admin could not open applicant résumés. | Intake admin may view application files. `files.service.ts` |
| 14 | The compliance "Export CSV" link was a plain link with no login token, so it returned 401. | Now an authenticated download. `ComplianceDashboard.jsx` |
| 15 | Experts had no conversations on `/messages`. | Messages were rewritten as one conversation per project and person, covering experts, file attachments, polling and search. `pages/Messages.jsx`, `messages/*` |
| 16 | Fee previews were hard-coded and went stale when the revenue admin changed the rates. | Rates come from `GET /ledger/fee-rates`. |
| 17 | Superuser Disputes and Create Task sent superusers away. Superuser Expert Applications could not load. | Disputes and Create Task work, and both are in the sidebar. The duplicate Expert Applications page was removed; the intake desk owns that page. |

### Security and other

| # | Problem | Fix |
|---|---|---|
| 18 | Suspended users kept working tokens. | The auth middleware rejects tokens belonging to suspended or deleted accounts. |
| 19 | Any signed-in user could list every milestone (with deliverables), every proposal, every wallet balance and any project's escrow. | Reads are scoped. Other users see only an open project's plan, or proposal stubs. Escrow is visible to the parties only. Contact details and wallets are hidden. |
| 20 | Seed reset did not clear messages. | It does now. |
| 21 | Placeholder numbers: "22 days remaining", invented ratings, success rates and hourly rates. | Replaced with real figures throughout. Section 4 lists the ones caught in the final pass. |

---

## 3. Additional errors found and fixed during the work

**Security**
- Toast and confirm dialogs rendered message text as HTML, so content from a project or user name could inject script (XSS). They now render plain text, and the double-escaping workaround was removed.
- The server did not enforce the password strength the signup form promised (upper case, lower case, digit, symbol). It now does, including on expert applications.
- Superuser accounts could be suspended, which would lock everyone out of administration. That is now refused.
- Files on a project were readable by anyone with the link, and anyone could upload to any project. Files are now visible to the project's contacts, and only participants may upload.
- The proposal "hire" dialog said the full budget would be charged when only the fees are charged at hire. The text is corrected.

**Money and workflow**
- Milestones could add up to more than the project budget. That is now refused.
- Work could be approved before it was submitted, and submitted from any state. Both now follow the milestone lifecycle.
- Cancelling an open project left its reviewer engagements live and its proposals open. Both are now closed, and the money is refunded.
- Deleting a project left its milestones and proposals behind. They are now removed, and escrow is refunded first.
- Users with active projects or a wallet balance could be deleted. That is now refused; suspend them instead.
- Experts marked "Unavailable" were still offered to clients. They are now excluded from new cases.
- The audit report was accepted for milestones that had not been submitted. The milestone is now required and must be submitted first.
- Draft projects were visible to everyone. They are now visible to their owner (and their reviewer) only.

**Frontend**
- The backend served the outdated static site in `front-end/` instead of the React app. `main.ts` now serves `frontend-react/dist` with a single-page-app fallback.
- Social login buttons and a "SOC 2" badge advertised features that do not exist. Removed. Leftover "GigBoard" branding was renamed to Lannent.
- Post Task now explains that the budget is held at posting and lists the Security category.
- Status labels for refunded and revision-needed milestones and closed or withdrawn proposals were missing on the boards and proposal pages.
- Dashboards (client, worker, expert, superuser) showed invented totals. They now show real figures.
- The Workroom showed a fake "Live" indicator and kept milestone data in localStorage. Both removed.
- Expert signup carried on when the résumé upload failed. It now stops and says why.
- Task Details let non-workers press Apply. Only workers can apply, and they see "Proposal submitted" once they have.
- Unit test config could not load `@nestjs/jwt`. Fixed in the Jest transform settings.

---

## 4. Final review pass

These were found in a fresh review after everything above was done.

### Backend

| Problem | Fix | File |
|---|---|---|
| When a project completed, an unfinished technical audit kept the reviewer's fee in escrow indefinitely. | On completion, the reviewer is paid for the share of the budget they audited, the rest goes back to the client, and later reports are refused. | `audit-requests.service.ts` (`closeProjectAudit`), `tasks.service.ts` (`setProgress`) |
| A worker could be hired onto a project with no milestones, which could never be paid or completed. | Hiring is refused until the project has milestones. | `proposals.service.ts` |
| An audit report's project, milestone and worker names came from the request body, so a report could name a different project or worker. | The server fills these from the records. | `audit-reports.service.ts`, `audit-reports.module.ts` |
| Cancelling a draft changed the status on an in-memory object instead of saving it through the repository, so it only worked by accident. | Saved through `tasksRepository.update`. | `tasks.service.ts` (`cancelDraft`) |

### Frontend

| Page | Problem | Fix |
|---|---|---|
| Browse Tasks | The **category filter never matched**: it compared `web` with the stored `webdevelopment`. The budget range, skill chips and audit switch did nothing. Every task showed a made-up "Intermediate / Fixed" level, and the level filter filtered on it. | Category uses the real category list. Budget range, skill chips (taken from the open tasks) and the audit-only switch all filter. Added a "Clear filters" button. The fake level filter was replaced by sorting (newest, budget, deadline). Cards show category and milestone count. `pages/BrowseTasks.jsx` |
| Expert Audit Requests | **Typing in search crashed the page.** Project audits have no `worker` field, so the code called `undefined.toLowerCase()`. The "Awaiting" filter missed the negotiating, agreed and ready-to-start states, and declined or cancelled requests could only be found under "All". | Worker and milestone names are looked up from the records. Filters cover groups of statuses, with a new Declined / Cancelled filter. Partly audited projects link to the reports filed so far. `pages/ExpertAuditRequests.jsx` |
| Expert Reports | "Conditional" audit verdicts showed as "Pending". "Revision" dispute verdicts showed as "Split". Disputes settled by an operations override were listed as the expert's own reports. The worker column showed only the party the dispute was raised against. Links ignored the milestone. When a search matched nothing, the previous results stayed on screen. | Correct verdict labels, override cases excluded, both parties shown, links go to the right milestone report, search covers more fields, and an empty state appears when nothing matches. `pages/ExpertReports.jsx` |
| Worker My Projects | "Earned" added up milestone budgets instead of what was actually paid, before the service fee. Cancelled projects were counted as "Active" and showed the raw status text. | Earned is the net payouts for that project. A Cancelled tab and badge were added. `pages/WorkerMyProjects.jsx` |
| Performance Analytics (worker) | Hard-coded numbers: "4.9 Average", proposal chart fixed at 46 accepted and 14 rejected (77% / 23%), and the same rating repeated on every project. The velocity chart's y-axis was fixed at 3–7 days, which hid real values. Months were matched by name only, so last year's March counted as this year's. | Proposal chart and legend use real accepted / not selected / pending counts. The fake rating was removed. The axis starts at zero. Months are matched by year and month. Added an empty state and a cancelled badge. `pages/PerformanceAnalytics.jsx` |
| Analytics (client) | Every newly started project was flagged "High Risk", because health was simply the completion percentage. "On-time delivery" repeated the success rate. Months were matched by name only. | Health starts at 100 and drops for open disputes, overdue milestones or deadlines, and revision requests. On-time delivery compares submission dates with due dates. Months are matched by year and month. `pages/Analytics.jsx` |
| Superuser Tasks | The Worker column printed raw `<span …>Unassigned</span>` markup as text. Progress read a field that could be missing ("undefined%"). The filter had no Draft or Cancelled option. The delete dialog did not mention the refund. Only open projects could be deleted, though the server also allows drafts and cancelled projects. | All fixed. The dialog says the escrow is returned to the client. `pages/SuperuserTasks.jsx` |
| Superuser Create Task | A milestone with no description showed raw `<em>` markup as text. | Renders as real markup. `pages/SuperuserCreateTask.jsx` |
| Task Details | A cover letter of only spaces could be submitted. Milestone labels missed the revision-requested, refunded and in-review states. The timeline only offered 3–6 weeks. Non-open statuses used a badge class that does not exist. | The cover letter must have at least 30 characters, with a live counter. Labels cover every status. Timeline runs from under 1 week to more than 2 months. Badges are valid. `pages/TaskDetails.jsx` |

### Checked and found correct

- Every in-app link and `navigate()` target matches a route in `App.jsx`.
- Every badge class used on a page exists in the stylesheet.
- Password rules match on the signup form, the expert signup form and the server.
- Search boxes no longer call string methods on fields that may be missing.
- Login, Expert Login and Signup: suspended accounts, pending or rejected expert applications, and duplicate emails each show the right message.

---

## 5. New automated tests

34 end-to-end tests were added to `back-end/test/app.e2e-spec.ts` (the full list for the latest round is in section 6). Among them:

- holds the budget at posting, charges fees at hire, and leaves nothing in escrow at the end
- runs the reported scenario (budget 500, audit 300, dispute 1200) through to an empty escrow
- pays the dispute reviewer from dispute escrow when they give the verdict
- sends the milestone back to the worker when the client wins, without moving money
- accepts only the worker-favour and client-favour verdicts
- lets operations settle a stuck dispute and returns the reviewer fee
- lets the payer choose another reviewer after a decline
- closes an unfinished audit when the project completes, paying only for what was audited
- refuses to hire on a project with no milestones
- names an audit report after the real project, milestone and worker
- cancels a draft project for good and returns its money
- requires a reviewer and a fee to raise a dispute
- stops honouring the token of a suspended account
- hides other people's contact details and balances
- refuses to delete a user who still has projects or money
- saves every profile field the settings pages send, and changes a password
- lets the intake desk open an applicant résumé
- delivers messages and notifications within a project

---

## 6. Round 3 — rule changes requested by the project owner, and a second loophole review

### 6.1 Dispute verdicts: only "worker" or "client"

| Before | Now |
|---|---|
| Four verdicts: worker-favour, client-favour (refund and close), split 50/50, send back for revision. | **Two verdicts.** *Worker-favour*: the milestone is accepted and its escrow paid to the worker. *Client-favour*: the milestone goes back to the worker's **To Do** column with the reviewer's notes, exactly like "Request changes". Its escrow stays held until the reworked submission is approved. |

The split and revision verdicts were removed from the API validation, the service, the Resolve Dispute page, the superuser override buttons and dialog, and every report and label. The `refunded` milestone status, which only a client-favour verdict produced, was also removed.
Files: `disputes/dto/resolve-dispute.dto.ts`, `disputes.service.ts`, `milestones.service.ts` (`SETTLED`), `ResolveDispute.jsx`, `SuperuserDisputes.jsx`, `ExpertReportDispute.jsx`, `ExpertReports.jsx`, `MilestoneReports.jsx`, both milestone boards, `Workroom.jsx`, `ReviewDeliverable.jsx`, `TaskDetails.jsx`.

### 6.2 Workers cannot raise disputes

- The server refuses a dispute from anyone but the project's client (403). It also refuses a dispute on a milestone the worker has not submitted yet.
- The client always pays the reviewer. The payer is no longer taken from whoever raised the dispute, and the worker side was removed from fee negotiation, funding and reassignment.
- Removed for workers: the Raise Dispute button in the workroom, the `/dispute` route, the **Dispute Fees** sidebar entry and the `/audit-offers` route.
- The revenue breakdown's "paid in by the worker" line was removed. Seed dispute `d2`, which had been raised by a worker, now records the client as the raiser.

Files: `disputes.service.ts`, `audit-requests.service.ts`, `audit-requests.controller.ts`, `revenue.service.ts`, `seed.data.ts`, `App.jsx`, `Sidebar.jsx`, `Workroom.jsx`, `Dispute.jsx`, `ClientAuditOffers.jsx`, `ExpertAuditPreview.jsx`, `AdminRevenue.jsx`.

### 6.3 Cancelling a project

**Rules now enforced by the server**

- **Once a worker is hired, the project cannot be cancelled, deleted or refunded.** The cancel option disappears, and the API returns *"A worker has been hired, so this project can no longer be cancelled or refunded."*
- **Before a worker is hired, the client can cancel and gets the money back, less a time-based cancellation fee.** The fee applies to the project budget only.
- **Technical-audit escrow and dispute-reviewer escrow are always refunded in full.**
- A draft (an audited project still waiting for its reviewer) has never been visible to workers, so cancelling it is free.
- Deleting a live project costs the same as cancelling it, so deleting cannot be used to dodge the fee. A superuser removing a project for moderation refunds everything.
- The fee is worked out from the **highest budget the project ever had**. A client cannot lower the budget to $1 just before cancelling to shrink the fee.
- The fee goes to platform revenue as `cancellation`. It appears on the revenue page, in the money-flow chart, in the per-project breakdown and in the client's wallet history.

**Default schedule (all four numbers can be changed on Fee Configuration)**

| Time since the project went live | Fee on the project budget |
|---|---|
| Less than 24 hours | 0% (free) |
| 24 hours to 7 days | 2% |
| More than 7 days | 5% |
| Audit and dispute escrow, at any time | refunded in full |

The client sees the exact quote before confirming, from `GET /api/tasks/:id/cancellation-quote`: fee, rate, how long the project has been live, and what each escrow bucket refunds.

**The project owner approved this default schedule.** The revenue admin can still adjust the four numbers on the Fee Configuration page.

Files: `ledger/fee-config.ts` (`cancellation`, `cancellationRate`), `ledger.service.ts` (`chargeCancellationFee`), `ledger.repository.ts`, `tasks.service.ts` (`cancellationQuote`, `settleCancellation`, `publishedAt`, `peakBudget`), `tasks.controller.ts`, `revenue.service.ts`, `revenue/dto/update-fee-config.dto.ts`, `ClientMyProjects.jsx`, `AdminFeeConfig.jsx`, `AdminRevenue.jsx`, `ClientWallet.jsx`, `SuperuserEscrow.jsx`, `utils/transactions.js`, `StoreContext.jsx`.

### 6.4 The superuser cannot create projects

`POST /tasks` is now client-only, so nobody can post a project that spends another person's wallet. The Superuser Create Task page, route and sidebar entry were removed, and the old link redirects to Manage Tasks. A superuser also can no longer edit a client's project (`PATCH /tasks/:id`).

### 6.5 No notification bell for the superuser

The superuser is not a party to any project, so the bell (and its 15-second polling) is not shown for that role. `TopNavbar.jsx`

### 6.6 Profile figures (the hiring profile card) — no ratings

Lannent has no review system yet, so **every rating was removed**. Nothing on the platform shows a star rating or a review count.

| Figure on the card | What it was | Now |
|---|---|---|
| Rating 4.8 | A number typed into the seed data. Nobody could rate anyone. | **Removed everywhere**: the hire panel and cards, the "Minimum rating" filter, proposals, Profile, Task Details (client rating), the expert's audit preview and client Analytics. The worker Performance page's empty "Client Feedback" card was removed too. |
| "Projects 23" | Typed into the seed data. | Removed. Replaced by **Completed on Lannent**, counted from completed projects. |
| "Projects on Lannent 1" | Counted every project ever assigned, including ones in progress. | Split into **Completed on Lannent** and **In progress now**. |
| $500/hr | The worker's own setting. | Kept, and labelled **Stated hourly rate**. |
| Full-time / Mid-Level | The settings form pre-filled these, so any worker who saved once showed exactly these values. | The form starts at "Not set", and the chips only show once the worker picks a value. |
| 📍 Remote | Shown whenever no location was set. | "Location not set". |

Project counts are no longer stored. The server works them out from projects on every read, so nobody, superuser included, can type them in. The same applies to an expert's "reviews done", now counted from paid engagements. Removed from the seed data: the typed-in numbers (4.8 / 23, 4.9 / 89, and expert counts 47 / 22 / 15) and the profile figures copied onto bids (rating, review count, success rate, response time, location). `rating` can no longer be written through `PATCH /users/:id` or on a bid.
Files: `tasks.service.ts` (`statsFor`), `users.repository.ts` (stats provider), `users.service.ts`, `users.controller.ts`, `update-user.dto.ts`, `proposals.service.ts` and DTO, `audit-requests.service.ts` (`paidReviewCount`), `seed.data.ts`, `HireGigWorkers.jsx`, `WorkerApplications.jsx`, `Profile.jsx`, `TaskDetails.jsx`, `Analytics.jsx`, `PerformanceAnalytics.jsx`, `ExpertAuditPreview.jsx`, `WorkerSettings.jsx`.

### 6.7 Superuser and admin pages: static vs live data

| Page | Finding | Fix |
|---|---|---|
| Superuser Dashboard | Live data, but staff accounts were missing from the user breakdown, there was no dispute count, and drafts showed the wrong badge. | Full role breakdown with suspended count, open tasks, an Open Disputes tile and the correct draft badge. |
| Escrow & Finance | **"Total Volume" added up every ledger row, so each escrowed dollar was counted twice** (once locked, once released). Cancellation fees were unrecognised. The ledger accounts `escrow` and `platform` showed as user names. A milestone payout showed only the net amount, with a +/− sign that implied money entered or left the platform. | Replaced with real totals: held, paid to workers, paid to reviewers, refunded, deposits, withdrawals and revenue. Account names are readable. Each row shows gross, fee and net. Newest rows first. |
| Manage Users | Suspend and Delete were offered on superuser accounts (the server refuses to suspend one, but **would delete one**). | The server now refuses to delete a superuser, and the buttons are hidden on those rows. |
| Fee Configuration | The empty-state link pointed to a route that only redirects. Percentages above 100 were accepted until the server refused them. | Fixed, with a new **Cancelling a project** card and worked example. |
| Revenue | All live. | Added cancellation fees to the fee table, the money-flow chart (with a 7th series colour) and the project breakdown. |
| Audit Log (compliance) | The "N events matching" line ignored the active filter, and actors showed as raw ids. | The summary follows the filter, and actors show by name. |
| Expert Applications | **The compliance desk saw Approve and Reject buttons**, but its access is read-only and the server returns 403. | The buttons are only shown to the intake desk. |
| `AdminDashboard.jsx` | 100+ lines of an unreachable "overview" with its own stylesheet. | Reduced to the redirect it actually performs; the dead CSS was deleted. |

### 6.8 Static content across the app

| Where | What was fake | Now |
|---|---|---|
| Home page | "Trusted by 2,000+ builders", "Loved by 10,000+ builders", and metrics of 12,500+ freelancers, 45,000+ projects, $24M escrow and 98.5% satisfaction. **Three testimonials from people who don't exist.** | A new public endpoint, `GET /api/stats/public`, gives live counts: members, workers, projects completed or in progress, escrow held, and amount paid to workers. It returns aggregates only. The invented testimonials and the satisfaction figure were removed. |
| Home and Expert pages: product mock-ups | Branded "gigboard.app" with a pulsing "Live" badge. | Rebranded `lannent.app` and labelled **Example**. The earnings card says "Example month · sample figures". |
| Expert landing page | "Trusted by 500+ Expert Reviewers", 12,000+ audits, 3,400+ disputes, 4.9/5 rating, three invented testimonials, "Earn $80–$150 per audit", "reviewed within 48 hours". | Live reviewer, audit and dispute counts and "paid to reviewers". The invented testimonials were removed. Copy now matches how the platform works: you set your own fee per case, and applications are reviewed by the intake team. |
| Home: disputes copy | "Average case closed in under 48 hours." | Describes the actual two outcomes. |
| `DashboardLayout.jsx` | When no session was available, the top bar showed invented people ("James Client", "Dr. Jane S."). | Shows a neutral role label instead. |

### 6.9 Loopholes closed in this round

| Loophole | Fix |
|---|---|
| **A superuser could deposit into, or withdraw from, any user's wallet**: money from nowhere, or a balance sent to an outside account. | Wallets are strictly self-service (`canMoveAnyWallet` is always false; wallet routes are client/worker/expert only). |
| **A client could cut a hired worker's pay**: lower a pending milestone from $500 to $1, and the difference was refunded to the client when the project completed. | After hire, a milestone amount can be raised but never lowered. |
| **A superuser could file an audit report**, which pays the reviewer, or approve a milestone or edit a client's plan. | Only the assigned reviewer files reports. Only the client edits milestones or approves work. A superuser's only money-moving power is the dispute override, which refunds the reviewer fee. |
| A superuser could accept or decline a reviewer engagement on the expert's behalf, or open an audit on a client's project (charging the client). | Only the expert accepts or declines, and only the client requests an audit. |
| Workers still held offer, accept, fund and reassign powers on reviewer fees. | Removed; only clients pay reviewers. |
| A superuser could create an Expert Reviewer account directly, skipping the intake review (and with no domains, so unusable). | Experts join only through an approved application. |
| A superuser could delete another superuser. | Refused. |
| A client could avoid the cancellation fee by deleting instead of cancelling, or by lowering the budget first. | Both closed (see 6.3). |
| A rating, project count or reviews-done could be set through `PATCH /users/:id` by a moderator, or claimed on a bid. | Ratings no longer exist; project counts and reviews-done are derived and can no longer be written. |

### 6.10 New tests in this round (13 — two replace removed split/refund tests)

- does not let a worker raise a dispute
- only allows a dispute on submitted work
- sends the milestone back to the worker when the client wins, without moving money
- accepts only the worker-favour and client-favour verdicts
- charges a cancellation fee by how long a project was live, and refunds reviewer escrow in full
- does not let a client cancel or delete once a worker is hired
- charges the same fee when a live project is deleted instead of cancelled
- does not let a superuser post a project for a client
- does not let a superuser move money in or out of someone else's wallet
- keeps operations accounts and expert onboarding out of the staff shortcuts
- does not let a client cut a hired worker's milestone pay
- does not let a superuser approve work or file a report that pays someone
- serves live, anonymous platform figures to the landing pages

Several older tests were updated for the new rules: disputes on submitted work, a client-paid dispute fee, derived project counts, and no rating anywhere.

---

## 7. Round 4 — workflow and loophole review

Rules chosen by the project owner for this round:

- A submitted milestone is **approved and paid automatically after 7 days** if the client neither approves it, asks for changes, nor disputes it.
- A client can ask for changes **at most 3 times** per milestone; after that they approve or dispute.
- A client can **end a contract for non-delivery**: nothing waiting for review, nothing handed in for 14 days, and 14 days past the deadline (or 30 days after hire / last submission with no deadline). Paid milestones stay paid; undelivered ones are cancelled and refunded. No fee.
- **The worker's bid is the contract price.** Bids are numbers. Hiring brings escrow to the bid (top-up or refund), charges fees on it, and requires the milestones to add up to exactly the bid.
- **No password reset by operations.** The route and the Edit User field are gone.
- The superuser may create every account type **except another superuser** (and experts still join through intake). Every created account must **choose its own password at first sign-in** (the server refuses everything else until then), stores `createdBy`, and is written to the audit trail as `account.create`.
- **Reviewers are paid per milestone.** Each milestone carries a share of the fee in proportion to its budget. The share is paid when the report is filed, or when the client approves within 5 days of submission (report or not). If the client approves after 5 days with no report, the share goes back to the client.
- Disputes: the client chooses any available reviewer for the category, the project's auditor included.

### Money and workflow

| Problem | Fix | Files |
|---|---|---|
| A worker who disappeared after hire locked the client's escrow forever. | End-for-non-delivery (`GET /tasks/:id/non-delivery`, `POST /tasks/:id/end-for-non-delivery`) and a panel on the milestone board. | `tasks.service.ts`, `ProjectMilestoneBoard.jsx` |
| A client could stall a worker forever with endless change requests. | 7-day auto-approval (`reviewDueAt`, swept every minute) and a 3-request cap. Seed milestones submitted before these rules carry no clock. | `milestones.service.ts`, `ReviewDeliverable.jsx` |
| An unfunded $1 dispute froze a milestone forever, and could not be withdrawn. | The client can withdraw a dispute before the reviewer accepts (`POST /disputes/:id/withdraw`). A dispute expires after 7 days without acceptance, or 7 days after acceptance without a verdict; the fee is refunded and the milestone returns to review with 2 days before auto-approval. | `disputes.service.ts`, `ClientAuditOffers.jsx` |
| A funded reviewer engagement the reviewer never accepted held the client's money. | `POST /audit-requests/:id/cancel` (payer, before acceptance). | `audit-requests.service.ts` |
| The bid price was decorative: a $50 bid got the full $1,000 contract; milestones could also sum to less than the budget. | Hire at the bid; milestones must equal it. Task Details asks for a numeric price; Worker Applications quotes the top-up/refund; the board gets a plan editor (amounts, add, remove). | `proposals.service.ts`, `TaskDetails.jsx`, `WorkerApplications.jsx`, `ProjectMilestoneBoard.jsx` |
| A suspended or deleted worker could still be hired. | Status checked at hire/accept; suspending or deleting closes their open bids and invitations. | `proposals.service.ts`, `users.controller.ts` |
| Reviewers were paid only when every milestone had a report, so approving fast cut their pay. | Per-milestone payouts as above. | `audit-requests.service.ts`, `ExpertAuditPreview.jsx` |
| An audit could be bought on a cancelled or finished project and the fee stranded. | Only on open or in-progress projects. | `audit-requests.service.ts` |
| Fee changes reached into contracts already signed. | The worker fee schedule is stored on the task at hire, the reviewer commission on the engagement at funding. | `ledger.service.ts`, `tasks.service.ts` |
| A refused audit report still overwrote the stored one. Empty reports paid the reviewer. | Checks run before the write; a verdict and 50+ characters of findings are required. | `audit-reports.service.ts`, DTO |
| No way to remove a milestone. Hiring relabelled withdrawn bids "rejected". | `DELETE /milestones/:id` (pending, before hire). Only pending bids are turned down. | `milestones.*`, `proposals.repository.ts` |
| Posting a project then its milestones could fail half-way and the rollback delete could charge a cancellation fee. | `POST /tasks` accepts `milestones`, all checked before money moves. | `tasks.service.ts`, `StoreContext.jsx` |
| Projects could be posted in EUR/GBP while every wallet is in dollars. | USD only. | `create-task.dto.ts`, `PostTask.jsx` |

### Accounts and access

| Problem | Fix |
|---|---|
| A superuser could reset a client's password, sign in as them and withdraw their money; old tokens survived a password change. | Reset removed. Tokens carry a version that every password change bumps; the session that changed it gets a fresh token. |
| A superuser could mint revenue/compliance/superuser accounts with a known password. | See the staff rules above. |
| An expert could give themselves every review domain; an expert with no domains matched every category. | Domains limited to those intake approved (`approvedDomains`); no domains matches nothing; applications need a known expertise. |
| A bcrypt-shaped password skipped the password rules. | Refused. |
| A public endpoint told anyone whether an email had applied. | Removed; an applicant learns their status by signing in with their own password. |
| Rejected bidders stayed project participants forever (files, messages); file ids were sequential. | Participants are the client, the hired worker, pending bidders while open, and engaged reviewers. File ids are random. Deliverable files are visible only once submitted, and cannot be deleted after. Signed-in uploads need a project; 200 MB per user; unclaimed application uploads are cleared after an hour. |
| Anyone who bid could put fake "payment" notifications in the client's bell. | `POST /notifications` removed; only the platform writes notifications. |
| Workers saw the client's escrow, fees and refunds. | Workers see only rows to or from them. |
| The compliance CSV export could carry spreadsheet formulas. | Cells starting with `= + - @` are prefixed with `'`. |
| Amounts had no ceiling ($1e20 deposit) or cent check; titles, categories and dates were not validated. | `@IsMoney()` (cents, ≤ $1,000,000) on every amount; title/description lengths, category list, ISO dates not in the past. |

### Frontend

- Page data loads in parallel without freezing the browser (previously ~12 synchronous requests on every navigation); pages are code-split (first load ~0.3 MB plus the icon set, was 2.1 MB).
- New `/change-password` page for accounts that must choose their own password.
- The workroom chat shows only the client and the hired worker.
- Submit Deliverable: the fake "Save Draft" is gone, removing a file deletes it from the server, and a link alone is accepted.
- `npm run lint` works (its packages were missing). It still reports older React-Compiler warnings in pages not touched in this round.

## 8. Round 5 — bidding removed

Requested by the project owner: the client sets the budget and a worker can only accept or reject it. Owner's decision: **the first worker to accept is hired**. Round 4's "hire at the bid" rule no longer applies.

### How hiring works now

- **Accepting an open project.** A worker opens Task Details and presses *Accept for $X* (`POST /tasks/:id/accept`). They are hired on the spot at the posted budget. The marketplace and initiation fees are charged to the client then; the budget has been in escrow since posting. A second worker who tries is refused.
- **The plan must match.** A project can only be accepted while its milestones add up to exactly the budget. Until then Task Details says the plan is in progress and Browse Tasks shows "Plan in progress". The client can still edit the plan on the milestone board until someone accepts.
- **Client short of the fees.** If the client cannot cover the contract fees, nobody can accept. The worker is told, and the client gets a notification linking to their wallet.
- **Invitations.** A client can still invite a particular worker (`POST /proposals`, `{ taskId, workerId, message }`). The worker accepts (hired, same as above) or declines. A declined worker cannot be invited to that project again, and the client can withdraw an unanswered invitation (`PATCH /proposals/:id` `{ status: 'withdrawn' }`). When anyone is hired, every other pending invitation on the project closes and those workers are told.
- **Removed.** Worker proposals, the bid price, cover letters and timelines, the 3-bids-per-project limit, `POST /proposals/:id/hire`, client rejection of bids, and topping up or refunding escrow to a bid. `contractPrice` is always the posted budget.

### Files

- Backend: `proposals.service.ts` (rewritten), `proposals.controller.ts`, `proposals.repository.ts`, both proposal DTOs, `tasks.controller.ts` (accept route), `tasks.service.ts` (`assignWorker` takes no price), `contacts.service.ts` (only pending invitees count as participants while the project is open), and the seed (the three bids became two invitations: Alex on t3, Sarah on t5).
- Frontend:
  - `TaskDetails.jsx`: an Accept button replaces the bid form.
  - New `ClientInvitations.jsx` (`/sent-invitations`) replaces `WorkerApplications.jsx`.
  - `MyProposals.jsx` is removed; the old URLs redirect.
  - `WorkerInvitations.jsx`, `HireGigWorkers.jsx`, `BrowseTasks.jsx`, both dashboards and Performance Analytics now count invitations instead of proposals.
  - The milestone board's plan text no longer mentions bids, and the sidebars are updated.
  - `StoreContext.jsx` gains `acceptTask`, `sendInvitation`, `withdrawInvitation` and `canBeAccepted`.
- Tests: the bidding tests were replaced by tests for first-to-accept hiring, refusing a project whose plan doesn't add up, refusing when the client can't cover the fees, declining and withdrawing invitations, closing other invitations on hire, and closing invitations on suspension.

## 9. Round 6 — rupees and a fixed budget

Requested by the project owner.

- **Everything is in INR.**
  - Projects carry `currency: 'INR'`; the API refuses any other currency, USD included.
  - Every amount shown, and every server message, notification and transaction description, uses ₹ instead of $, with Indian digit grouping (₹1,00,000).
  - Rupee icons replace dollar icons.
  - The amounts themselves were not converted (owner's choice): seeded wallets, budgets, fee tiers, the flat fees and the ₹10,00,000 per-amount limit keep their old numbers.
- **No currency dropdown.** Post Task showed a disabled dropdown with a single option. It is now a fixed "₹ INR — Indian Rupee" field.
- **The budget cannot change after posting.** `PATCH /tasks/:id` refuses any budget change, with a message saying to delete the project and post it again. The edit dialog in My Projects shows the budget read-only. `ledger.adjustProjectBudget` (which topped up or refunded escrow on a budget edit) is removed. Deleting an open, draft or cancelled project with nobody hired was already available.
- **Disputes:** unchanged. Any matching reviewer can still be chosen, as decided in round 4.

