# More5Stars

Multi-tenant **smart review routing** SaaS for local businesses.

A customer taps 1–5 stars on their phone. **5 stars are sent to your Google review page; 1–4 stars open a private feedback form** that goes straight to the business owner — so problems get fixed before they become public reviews. The star threshold is a per-location setting, so you can switch to "4★ and up → Google" or a fully compliant "everyone gets invited" mode without touching code.

## What's included

- **Redesigned landing page** (`/`) — marketing site with live demo, new 5-star routing copy, pricing, FAQ.
- **Customer rating page** (`/r/:slug`) — the page customers scan. Per-business branding, the star→route logic, and private feedback capture.
- **Admin dashboard** (`/admin`) — login, manage locations, view the private feedback inbox, analytics (rating distribution, Google conversion %, open feedback), and a per-location QR generator with PNG download.
- **Backend API** — Node + Express + SQLite, multi-tenant, parameterized queries, bcrypt admin auth, rate limiting, helmet CSP headers.

## Run it

```bash
cd more5stars
cp .env.example .env        # then edit ADMIN_PASSWORD
npm install
npm start
```

Open http://localhost:3000

- Landing page: `/`
- Demo rating page: `/r/demo`
- Dashboard: `/admin` — log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from your `.env` (defaults `admin@more5stars.net` / `changeme123`).

On first boot the app seeds an admin user and a `demo` business automatically.

## How the routing works

`POST /api/rating` records the tap and returns where to send the customer:

```
stars >= business.star_threshold   ->  routed_to: "google"  (returns google_review_url)
stars <  business.star_threshold    ->  routed_to: "private" (customer sees feedback form)
```

`star_threshold` is per location (set in the dashboard):

| Threshold | Behavior |
|-----------|----------|
| **5** (default) | Only 5★ → Google. 1–4★ → private feedback. *(what you asked for)* |
| 4 | 4–5★ → Google. 1–3★ → private. |
| 1 | Everyone is invited to Google (compliant mode), feedback still captured for low scores. |
| 6 | Gating disabled — everyone goes to private feedback. |

## API reference

**Public**
- `GET /api/business/:slug` — business config for the rating page
- `POST /api/rating` `{slug, stars}` — record tap, get routing decision
- `POST /api/feedback` `{slug, stars, message, customer_name?, customer_email?, customer_phone?}` — store private feedback

**Admin (cookie session)**
- `POST /api/admin/login` `{email, password}` · `POST /api/admin/logout` · `GET /api/admin/me`
- `GET/POST /api/admin/businesses`, `PUT/DELETE /api/admin/businesses/:id`
- `GET /api/admin/feedback?business_id=` · `POST /api/admin/feedback/:id/resolve`
- `GET /api/admin/analytics?business_id=`

## Security

Built against the hardening checklist: parameterized SQLite queries (no string concat), bcrypt password hashing (cost 12), rate limiting (login 8/15min, writes 30/min, general 120/min), HttpOnly + SameSite session cookies, helmet CSP / HSTS / nosniff / frame-ancestors, strict input validation and length caps, and secrets in env vars. Before going live: set a strong `ADMIN_PASSWORD`, run behind HTTPS (`NODE_ENV=production` enables HSTS + secure cookies), and `chmod 600` the SQLite file.

## Compliance note (read this)

Routing only your highest raters to Google while diverting lower ratings to a private form is **"review gating."** It can conflict with **Google's review policies** and the **U.S. FTC's 2024 rule on review suppression**, and Google may filter or remove reviews if detected. This app supports a compliant mode (set threshold to 1 to invite everyone while still capturing private feedback). How you configure it is your call and your responsibility.

## Tech & deployment

Node 18+, Express, better-sqlite3, bcryptjs, helmet, express-rate-limit. SQLite makes this a single deployable app — run it on any VPS, Render, Railway, Fly, or a small EC2. To scale to many tenants later, swap better-sqlite3 for Postgres (the query layer is already parameterized) and move sessions to Redis. The Stripe "Start Free Trial" buttons point at your existing payment link; wire `POST /webhook` with signature verification when you want to auto-provision accounts on payment.

## Files

```
more5stars/
├── server.js            Express app: API, auth, routing, static host
├── db.js                SQLite schema + seed (admin + demo business)
├── package.json
├── .env.example
└── public/
    ├── index.html       Redesigned landing page
    ├── review.html      Customer rating + routing page (/r/:slug)
    └── admin.html       Dashboard: locations, feedback, analytics, QR
```
