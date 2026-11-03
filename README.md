# iy-expense-tracker

Team & category expense allocation tracker. Static page (`public/index.html`) + Vercel functions (`api/`) + Neon Postgres.

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
| Management | View the expense tracker, all invoices and the payout register; export CSV/PDF |
| Employee | None: Payouts page only, own profile and invoices |

## Payouts (`/payouts.html`)

- Employees raise **salary invoices** (pick a date; amount = salary set by admin; one per month) and **reimbursement invoices** (line items, totals calculated). Numbers run in two company-wide sequences: `SAL-0001…` and `RMB-0001…`.
- Admin approves (invoice is then locked) or rejects with a reason (employee can edit and resubmit).
- **Payout register** (approved invoices only), per employee per month: gross salary − 10% TDS + reimbursements. Exports to CSV, or PDF via the browser's print dialog.
- **Google Sheet:** Admin → *Employer & Sheet* shows an `=IMPORTDATA(...)` formula to paste into a sheet. It refreshes about hourly. The link's secret comes from `SESSION_SECRET`, so changing that secret changes the link.

Commits must be authored as mary@invincibleyou.world, or Vercel (Hobby plan) blocks the deploy.
