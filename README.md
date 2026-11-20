# Worktime

Work time tracking on Cloudflare Workers + D1.

## Deploy
```bash
npm install
npx wrangler d1 create worktime          # copy the database_id into wrangler.toml
npm run db:remote                        # apply migrations
npm run deploy
```
Local dev: `npm run db:local && npm run dev`

After creating your account(s) set `ALLOW_REGISTRATION = "false"` in `wrangler.toml` and redeploy.

## Calendar
Settings → "Calendar subscription URL" → add it as an internet calendar (Google, Apple, Outlook).
Generate a new link at any time to revoke the old one.
