# Gold Coast Cowboys website + pass backend

Static site plus a small backend (Vercel serverless functions in `api/`) so admins can add competitions and dancers can buy passes.

## What's here
- `passes.html?event=<slug>`: public pass page (linked from "Event Passes & Competition Passes" on each event page)
- `pass-success.html`: where Stripe sends buyers after paying
- `/admin/login.html`: admin login (not linked from the public site on purpose). Dashboard has Competitions, Buyers (with CSV download) and Team (invite links).
- `api/`: `passes`, `checkout`, `webhook`, `order-status`, `admin/[action]`
- `tests/`: `npm install && npm test` (real SQL via PGlite, Stripe stubbed); `npm run dev` runs a local copy with fake payments.

## Deploy (about 15 minutes)
1. **Vercel**: push this folder to GitHub, then Vercel -> Add New -> Project -> import it (Framework: Other).
2. **Database**: Project -> Storage -> Marketplace -> **Neon** -> create/connect. This adds `DATABASE_URL` automatically. Tables are created on first use.
3. **Env vars** (Settings -> Environment Variables), see `.env.example`:
   - `SESSION_SECRET`: any long random string
   - `ADMIN_SETUP_KEY`: any secret phrase; you'll type it once to create the first admin
   - `STRIPE_SECRET_KEY`: from Stripe -> Developers -> API keys (use the `sk_test_` key first)
4. Deploy, then in **Stripe -> Developers -> Webhooks -> Add endpoint**:
   - URL: `https://YOUR-DOMAIN/api/webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, then redeploy.
5. Visit `/admin/login.html` -> "Set up the first admin account" and enter the setup key. After that, invite others from the Team tab (copy the one-time link and send it to them).
6. Test with Stripe test mode (card `4242 4242 4242 4242`) before switching to live keys.

## How it behaves
- Buyers don't need accounts; Stripe collects their email. Admins see every buyer in the dashboard.
- Pass limits are enforced atomically. A spot is held for ~30 minutes while someone is on the Stripe page, then released automatically.
- Early-bird pricing switches off automatically at the deadline.
- Refund in the Stripe dashboard; it syncs here and frees the spot.
- Competitions with orders can be hidden but not deleted.
