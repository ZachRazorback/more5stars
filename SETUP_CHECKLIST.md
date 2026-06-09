# More5Stars — Setup & Launch Checklist

## Pre-Deployment

- [ ] **Test locally**
  - [ ] Run `npm install && npm start`
  - [ ] Visit http://localhost:3000
  - [ ] Try demo page at /r/demo
  - [ ] Log in to admin with default credentials
  - [ ] Create a test location
  - [ ] Download test QR code
  - [ ] Tap 5 stars (should go to Google)
  - [ ] Tap 4 stars (should show feedback form)

- [ ] **Customize .env**
  - [ ] Set ADMIN_EMAIL to your email
  - [ ] Generate strong ADMIN_PASSWORD (use: `openssl rand -base64 32`)
  - [ ] Set NODE_ENV=production (for deployment)

- [ ] **Customize landing page** (public/index.html)
  - [ ] Update tagline/hero copy
  - [ ] Add your logo
  - [ ] Update pricing if different from defaults
  - [ ] Update footer contact info
  - [ ] Test that it renders properly

- [ ] **Update admin dashboard branding** (public/admin.html)
  - [ ] Change "More5Stars" heading to match your brand
  - [ ] Update any logo references

## Deployment (Choose One)

### Option A: Render (Recommended)

- [ ] Create Render.com account
- [ ] Push code to GitHub
- [ ] Connect GitHub to Render
- [ ] Create "Web Service" from repo
- [ ] Set environment variables:
  - `NODE_ENV=production`
  - `ADMIN_EMAIL=YOUR_EMAIL`
  - `ADMIN_PASSWORD=YOUR_PASSWORD`
  - `PORT=3000`
- [ ] Deploy (wait 2-3 min)
- [ ] Test: Visit your-app.onrender.com
- [ ] (Optional) Point custom domain via CNAME

### Option B: Railway

- [ ] Create Railway.app account
- [ ] Connect GitHub repo
- [ ] Add environment variables (same as above)
- [ ] Deploy
- [ ] Get public URL

### Option C: Fly.io

- [ ] Create Fly.io account
- [ ] Install Fly CLI
- [ ] Run `flyctl launch` in project directory
- [ ] Configure Dockerfile (or use Node buildpack)
- [ ] Set env vars via dashboard
- [ ] Deploy

### Option D: Your Own VPS

- [ ] SSH into server
- [ ] Install Node 18+
- [ ] Clone/copy repo
- [ ] Run `npm install`
- [ ] Set .env variables
- [ ] Run with PM2: `pm2 start server.js --name "more5stars"`
- [ ] Configure nginx reverse proxy to localhost:3000
- [ ] Enable SSL with Let's Encrypt

## Post-Deployment

- [ ] **Test live deployment**
  - [ ] Visit your production URL
  - [ ] Log in to admin with your credentials
  - [ ] Create a test location (use "Test Co")
  - [ ] Get the QR code
  - [ ] Open the QR code link on your phone
  - [ ] Tap 5 stars → should redirect to Google
  - [ ] Go back, tap 4 stars → should show feedback form
  - [ ] Submit feedback → should appear in admin dashboard

- [ ] **Check database/data**
  - [ ] Verify `data/more5stars.db` exists (SQLite file)
  - [ ] Set file permissions: `chmod 600 data/more5stars.db`
  - [ ] Backup to your server daily or use database backups

- [ ] **Enable HTTPS**
  - [ ] Render/Railway/Fly all provide free SSL by default
  - [ ] If self-hosted, use Let's Encrypt (certbot)
  - [ ] Verify HTTPS works: padlock icon in browser

## Sales Prep

- [ ] **Create sales collateral**
  - [ ] Print CUSTOMER_PITCH.md as PDF
  - [ ] Record 30-second demo video (tap stars, see routing)
  - [ ] Create pricing one-sheet
  - [ ] Build landing page for your brand (optional)

- [ ] **Set up customer accounts** (test run)
  - [ ] Log into admin dashboard
  - [ ] Create "Test Med Spa" location
  - [ ] Add fake Google review link
  - [ ] Download QR code
  - [ ] Send to a colleague, have them test
  - [ ] Collect feedback before selling to real customers

- [ ] **Prepare onboarding**
  - [ ] Write customer setup guide
  - [ ] Create "how to print QR code" instructions
  - [ ] Document dashboard walkthrough
  - [ ] Plan: how will you handle support?

## Launch & Sales

- [ ] **First customer sale**
  - [ ] Close deal (price: $97, $247, or custom)
  - [ ] Create account in dashboard
  - [ ] Send welcome email with:
    - [ ] Login credentials
    - [ ] Link to dashboard
    - [ ] Setup instructions
    - [ ] QR code (printable)
    - [ ] Support contact
  - [ ] Follow up after 3 days

- [ ] **Monitor early**
  - [ ] Check admin dashboard daily
  - [ ] Verify ratings are being recorded
  - [ ] Check that 5★ redirects work
  - [ ] Monitor 1-4★ feedback form submissions
  - [ ] Respond quickly if customer has issues

- [ ] **Set up billing** (optional, later)
  - [ ] If using Stripe: integrate webhook
  - [ ] Auto-provision accounts on payment
  - [ ] Send login credentials automatically
  - [ ] Or: manually create accounts + email invoices

## Scaling (After 5-10 Customers)

- [ ] **Performance monitoring**
  - [ ] Monitor deployment logs
  - [ ] Check database size (may need backup strategy)
  - [ ] Monitor uptime / response times

- [ ] **Feature requests**
  - [ ] Track what customers ask for
  - [ ] Prioritize V2 features:
    - [ ] SMS notifications for feedback
    - [ ] Email summaries
    - [ ] Custom branding per customer
    - [ ] Integration with CRM (Salesforce, HubSpot)
    - [ ] Zapier webhook support

- [ ] **Marketing**
  - [ ] Create case study with first successful customer
  - [ ] Post on social media
  - [ ] Cold email more prospects
  - [ ] Consider ads ($500 test budget)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Admin login doesn't work | Check .env: ADMIN_EMAIL & ADMIN_PASSWORD. Delete data/more5stars.db and restart to reset. |
| QR code link returns 404 | Make sure location "slug" is correct (no spaces, lowercase). |
| 5-star tap doesn't go to Google | Check that Google review URL is set in location settings. |
| Feedback form doesn't submit | Check browser console for errors. Verify POST /api/feedback works. |
| Database file is locked | Kill any running npm processes: `pkill -f node` |
| High memory usage | SQLite should be lightweight. If memory spikes, check database size. |

---

## Support & Questions

- **Technical issues:** Check `README.md` troubleshooting section
- **Deployment problems:** See `DEPLOYMENT.md`
- **Sales/pitch questions:** See `CUSTOMER_PITCH.md`
- **API integration:** See `server.js` comments and API reference in README

---

## Timeline Estimate

- **Customization:** 30 min
- **Local testing:** 15 min
- **Deploy to production:** 15 min
- **Test live:** 10 min
- **Sales prep:** 1-2 hours
- **First customer setup:** 15 min

**Total:** ~3-4 hours from now to first paying customer 🚀

