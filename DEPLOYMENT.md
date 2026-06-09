# More5Stars — Deployment Guide

## Quick Deploy to Render

**Recommended:** Render.com (free tier available, easy SSL, auto-deploys from Git)

### Steps

1. **Push to GitHub** (if not already):
   ```bash
   cd more5stars
   git init
   git add .
   git commit -m "More5Stars review routing SaaS"
   git remote add origin https://github.com/YOUR_GITHUB/more5stars.git
   git push -u origin main
   ```

2. **Deploy on Render**:
   - Go to https://render.com
   - Click "New" → "Web Service"
   - Connect your GitHub repo
   - Select the `more5stars` directory (if monorepo)
   - Environment:
     - **Name:** More5Stars
     - **Runtime:** Node
     - **Build command:** `npm install`
     - **Start command:** `npm start`
   - Environment Variables:
     ```
     NODE_ENV=production
     PORT=3000
     ADMIN_EMAIL=zach@revenueleaksystems.com
     ADMIN_PASSWORD=YOUR_STRONG_PASSWORD_HERE
     ```
   - Click "Deploy"

3. **Domain Setup**:
   - After deploy, Render gives you a `.onrender.com` domain
   - OR point your own domain (more5stars.net):
     - In Render dashboard, go to "Settings" → "Custom Domain"
     - Add `more5stars.net`
     - Update DNS CNAME to Render's DNS target

4. **Access Dashboard**:
   - Visit: `https://your-domain.onrender.com/admin`
   - Login: `zach@revenueleaksystems.com` / your password
   - Create a new business location
   - Get the QR code for customer rating page

## Local Testing (before deploying)

```bash
cd more5stars
npm install
npm start
```

Open http://localhost:3000

- **Landing page:** `/`
- **Demo rating page:** `/r/demo`
- **Admin dashboard:** `/admin`

Login with default credentials:
- Email: `admin@more5stars.net`
- Password: `changeme123`

## Architecture

- **Frontend:** HTML + vanilla JS (review.html, admin.html, index.html)
- **Backend:** Node.js + Express
- **Database:** SQLite (better-sqlite3)
- **Auth:** Session cookies + bcrypt
- **Security:** helmet, rate limiting, parameterized queries, CSP headers

## Key Features

### Review Routing Logic

- **5★ tap:** Customer redirected to Google review page
- **1–4★ tap:** Customer sees private feedback form
- **Configurable per location:** Set `star_threshold` in admin dashboard:
  - `5` = only 5★ → Google (default)
  - `4` = 4–5★ → Google
  - `1` = everyone → Google (compliant mode)
  - `6` = everyone → private feedback

### Admin Dashboard

- **Manage locations:** Add businesses, get QR codes
- **View feedback:** See all 1–4★ private feedback in one inbox
- **Analytics:** Rating distribution, Google conversion %, feedback volume
- **QR download:** PNG QR codes for printing/signage

## API Endpoints

### Public

- `GET /api/business/:slug` — business config
- `POST /api/rating {slug, stars}` — record tap, get routing
- `POST /api/feedback {slug, stars, message, ...}` — store private feedback

### Admin (authenticated)

- `POST /api/admin/login` — create session
- `GET/POST/PUT/DELETE /api/admin/businesses` — CRUD locations
- `GET /api/admin/feedback?business_id=` — fetch feedback
- `GET /api/admin/analytics?business_id=` — get stats

## Compliance Note

Review routing (sending only high ratings to Google) may conflict with **Google's review policies** and **FTC 2024 rules on review suppression**.

This app supports compliant mode: set `star_threshold=1` to invite everyone to Google while still capturing private feedback for internal use.

**You are responsible for how you configure and use this tool.**

## Troubleshooting

### "SQLite file not found"
- The app auto-creates `./data/more5stars.db` on first boot
- Ensure the `data/` directory exists and is writable

### Admin login not working
- Check your `.env` file has `ADMIN_EMAIL` and `ADMIN_PASSWORD`
- On first boot, an admin user is seeded automatically
- To reset, delete `data/more5stars.db` and restart

### Deployment fails (Render)
- Check `NODE_ENV=production` is set
- Verify `npm start` works locally
- Check logs in Render dashboard

## Next Steps

1. Deploy to Render
2. Test with a demo location
3. Create customer accounts
4. Share QR codes with businesses
5. Monitor feedback in admin dashboard
6. Optionally integrate with Stripe for auto-provisioning (webhook handler ready)
