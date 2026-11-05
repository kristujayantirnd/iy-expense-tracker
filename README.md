# iy-expense-tracker

Team & category expense allocation tracker, with a Payouts module and a launcher (header button, Admin and Management) for the separate Project Tracker at https://simis-project-tracker.vercel.app/. It opens inside this app (`/projects.html`, module switcher in every header showing only the modules each person may use) and signs people in there (single sign-on, `PT_SSO_SECRET` set on both apps): Admin and Management get the full tracker; others, once linked to an owner in Settings → Project Tracker owners, get their own and assigned stages, can mark them complete and add log entries, all recorded under their name. Linked employees land on the Project Tracker after signing in. Its password still works as a backup. Static page (`public/index.html`) + Vercel functions (`api/`) + Neon Postgres.

Live: https://iy-expense-tracker.vercel.app — pushing to `main` deploys to production.

## Local setup

```
vercel env pull .env.local   # DATABASE_URL, SESSION_SECRET
npm install
npm run setup-db             # create tables (safe to re-run)
npm test                     # password/session self-check
```

## Users

There is no sign-up page. Anyone can change their own password with the key button on the Payouts page; admins can set a new password for anyone (Logins & Salaries → Edit). Admins add logins (and set salaries) on **Payouts → Logins & Salaries**, or from the command line:

```
npm run add-user -- someone@example.com 'their-password' [admin|employee|management]   # role defaults to admin
```

Every login is an employee: it has a salary and profile, raises its own invoices, and appears in the tracker's Employee Directory and the payout register. The role only adds access:

| Role | Extra access |
|---|---|
| Admin | Everything: expense tracker, employer details, logins & salaries, approve/reject invoices, payout register |
| Management | Lands on the expense tracker after signing in. Views all invoices, the payout register and Employees Salary (salary history); exports CSV/PDF |
| Employee | None: Payouts page only, own profile and invoices |

**Salary revisions:** changing a login's salary asks for the date it takes effect (and an optional note) and is kept in **Salary History** (the **Employees Salary** tab, for Admin and Management). Salary invoices use the salary in effect on the invoice date; the tracker and the logins list show today's salary (with any upcoming one). Each login gets a starting record the first time `setup-db` runs.

**Extra roles:** a login can hold extra roles on top of its main Role (Logins & Salaries → Edit). **Project Tracker admin** gives full admin rights in the Project Tracker (no owner link needed); every other module still follows the main Role.

Each login is **Active** or **Inactive** (Logins & Salaries → Edit). An inactive login can't sign in, and anyone already signed in is locked out on their next click. Their invoices are kept. Admins can't deactivate themselves.

## Payouts (`/payouts.html`)

- Employees raise **salary invoices** (pick a date; amount = salary set by admin; one per month) and **reimbursements**. Reimbursements collect on **one open invoice per employee**: each submission adds rows stamped with the day they were entered, and the invoice date is the latest row's date. Numbers run in two company-wide sequences: `SAL-0001…` (given on submission) and `RMB-0001…` (given on approval, so no gaps). After approval the next submission starts a new invoice.
- Every reimbursement row needs a **bill PDF**: uploaded (max 2 MB, stored privately in Vercel Blob) or a Google Drive link shared as *Anyone with the link can view*. The invoice's **PDF** button gives one file: invoice page + all bill pages in row order.
- Admin → *Settings* (gear icon) → **Bill Storage** shows Blob usage (free plan: 1 GB) and deletes uploaded bills older than 3 months. Their invoices' PDFs then show a "bill deleted" page; Drive bills are untouched.
- Admin approves (invoice is then locked) or rejects with a reason (employee can edit and resubmit).
- Each reimbursement row can carry an optional **expense category** (the tracker's categories). The admin approves through **Review**, which shows each row's bill and lets them change each row's category. The admin can also raise salary invoices for any employee.
- **Cancel** an approved invoice (worst cases) in *Settings*, with a reason: it leaves the payout register, keeps its number, frees that salary month, deletes its uploaded bill files (unless another live invoice uses them) and moves its Drive copy to Drive's trash. Cancelled invoices are hidden from the list unless the Cancelled filter is picked.
- The Expense Tracker's **Direct Expenses** tab lists categorised reimbursement rows (pending, approved, submitted, paid) in a date range, current month by default. They are listed only, not added to the tracker's totals or budgets.
- **Receivables** module (`/receivables.html`, Admin and Management): the company's invoice & receivables Google Sheet, read through its Apps Script (`getDashboardData`) via a key-protected data link (Settings → Receivables). The sheet stays the backend.
- The invoice list shows 8 per page, with one search box for invoice number, type or employee name.
- After approval the admin sets **Submitted** → **Payment Completed** (dropdown on the invoice; still counts as approved).
- **Google Drive copy:** on approval the invoice PDF (with bills) is saved to the Drive folder set in *Settings* (gear icon), through a small Google Apps Script the admin deploys once (code and steps are on that page). If the copy fails, approval still stands and the invoice shows the error with **Retry**.
- **Payout register** (approved invoices only), per employee per month: gross salary − 10% TDS + reimbursements. Exports to CSV, or PDF via the browser's print dialog.
- **Google Sheet:** Admin → *Settings* (gear icon) shows an `=IMPORTDATA(...)` formula to paste into a sheet. It refreshes about hourly. The link's secret comes from `SESSION_SECRET`, so changing that secret changes the link.

Commits must be authored as mary@invincibleyou.world, or Vercel (Hobby plan) blocks the deploy.
