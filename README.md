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

There is no sign-up page. Add a user or reset a password:

```
npm run add-user -- someone@example.com 'their-password'
```

Commits must be authored as mary@invincibleyou.world, or Vercel (Hobby plan) blocks the deploy.
