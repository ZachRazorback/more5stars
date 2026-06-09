/**
 * server.js — More5Stars API + static host.
 *
 * Public:
 *   GET  /r/:slug                       customer rating page (serves review.html)
 *   GET  /api/business/:slug            public business config for the rating page
 *   POST /api/rating                    record a star tap, return routing decision
 *   POST /api/feedback                  store private feedback (1..threshold-1 stars)
 *
 * Admin (cookie session, bcrypt login):
 *   POST /api/admin/login | /logout
 *   GET  /api/admin/me
 *   GET/POST/PUT/DELETE /api/admin/businesses[/:id]
 *   GET  /api/admin/feedback?business_id=
 *   POST /api/admin/feedback/:id/resolve
 *   GET  /api/admin/analytics?business_id=
 *
 * Security: helmet CSP, parameterized queries, bcrypt, rate limits,
 * HttpOnly+SameSite session cookies, strict input validation.
 */
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { db, seed } = require('./db');

seed(); // ensure admin + demo exist on boot

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);

// Stripe — initialized only if a secret key is configured (so the app still boots without it).
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || ''; // optional: use a fixed Price; else inline $247/mo
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);
const PRICE_CENTS = parseInt(process.env.PRICE_CENTS || '24700', 10);
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// ---- Security headers / CSP ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],   // QR lib + inline page scripts
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  crossOriginEmbedderPolicy: false,
}));

// ---- Stripe webhook (MUST be before express.json so we get the raw body for
// signature verification). Handler logic is defined further below.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('webhooks not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('webhook signature failed:', e.message);
    return res.status(400).send('signature verification failed');
  }
  // Idempotency — skip events we've already processed (Stripe retries).
  if (Q.webhookSeen.get(event.id)) return res.json({ received: true, duplicate: true });
  Q.insWebhookEvent.run(event.id, event.type);
  try { await handleStripeEvent(event); }
  catch (e) { console.error('webhook handler error:', e.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: '2mb' })); // headroom for small base64 logo uploads
app.use(cookieParser());

// ---- Rate limiters ----
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
app.use('/api/', apiLimiter);

// ---- Stateless signed-cookie sessions ----
// Tokens are HMAC-signed, so they survive server restarts/redeploys (no in-memory
// store to lose). The signing secret is stable across restarts: it's SESSION_SECRET
// if set, otherwise derived from the seeded admin's password hash.
const SESSION_TTL = 24 * 60 * 60 * 1000;
const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const a = db.prepare('SELECT password_hash FROM admins ORDER BY id LIMIT 1').get();
  return crypto.createHash('sha256').update('m5s|' + (a ? a.password_hash : 'no-admin')).digest('hex');
})();
// A session carries: sub (admin id or account id), role ('super' | 'customer'), email.
function makeSession(sub, role, email) {
  const payload = Buffer.from(JSON.stringify({ sub, role, email, exp: Date.now() + SESSION_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function readSession(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  let expected;
  try { expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); } catch { return null; }
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || !data.exp || Date.now() > data.exp) return null;
  return data;
}
// Require a logged-in user (super-admin or customer). Backward-compatible with
// pre-multi-account cookies (which had {id,email} and no role → treated as super).
function requireAuth(req, res, next) {
  const data = readSession(req.cookies.m5s_session);
  if (!data) return res.status(401).json({ error: 'Not authenticated' });
  req.user = { id: data.sub ?? data.id, role: data.role || 'super', email: data.email };
  next();
}
const requireAdmin = requireAuth; // alias — endpoints below add their own ownership checks
function requireSuper(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'super') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_TTL, path: '/' };

// A business is "live" (review page works) if it's house-owned (account_id NULL)
// or its owning account's subscription is active/trialing.
const LIVE_STATUSES = ['active', 'trialing', 'comp']; // 'comp' = free friend/comped account
function isBizLive(b) {
  if (b.account_id == null) return true;            // house-owned → always live
  const acct = Q.accountById.get(b.account_id);
  return !!acct && LIVE_STATUSES.includes(acct.subscription_status);
}
// Can this user manage this business? Super → any. Customer → only their own.
function userOwnsBiz(user, b) {
  if (!b) return false;
  if (user.role === 'super') return true;
  return b.account_id === user.id;
}

// ---- Validation helpers ----
const isInt = (v) => Number.isInteger(v);
const clampStars = (v) => (isInt(v) && v >= 1 && v <= 5 ? v : null);
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slugify = (s) => str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isHttpUrl = (u) => /^https?:\/\/.+/i.test(u || '');
// Accept an empty value, an http(s) URL, or a small base64 image data URL. Reject anything else.
const validLogoUrl = (u) => {
  if (typeof u !== 'string' || u === '') return '';
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 1500000) return u;
  if (/^https?:\/\/.+/i.test(u) && u.length <= 1000) return u;
  return '';
};

// Prepared statements
const Q = {
  bizBySlug: db.prepare('SELECT * FROM businesses WHERE slug = ? AND active = 1'),
  bizById: db.prepare('SELECT * FROM businesses WHERE id = ?'),
  allBiz: db.prepare('SELECT * FROM businesses ORDER BY created_at DESC'),
  bizByAccount: db.prepare('SELECT * FROM businesses WHERE account_id = ? ORDER BY created_at DESC'),
  insBiz: db.prepare(`INSERT INTO businesses (slug, name, logo_text, logo_url, brand_color, google_review_url, star_threshold, notify_email, account_id)
                      VALUES (@slug, @name, @logo_text, @logo_url, @brand_color, @google_review_url, @star_threshold, @notify_email, @account_id)`),
  updBiz: db.prepare(`UPDATE businesses SET name=@name, logo_text=@logo_text, logo_url=@logo_url, brand_color=@brand_color,
                      google_review_url=@google_review_url, star_threshold=@star_threshold,
                      notify_email=@notify_email, active=@active WHERE id=@id`),
  delBiz: db.prepare('DELETE FROM businesses WHERE id = ?'),
  insEvent: db.prepare('INSERT INTO rating_events (business_id, stars, routed_to) VALUES (?, ?, ?)'),
  insFeedback: db.prepare(`INSERT INTO feedback (business_id, stars, message, customer_name, customer_email, customer_phone)
                           VALUES (@business_id, @stars, @message, @customer_name, @customer_email, @customer_phone)`),
  feedbackByBiz: db.prepare('SELECT * FROM feedback WHERE business_id = ? ORDER BY created_at DESC LIMIT 500'),
  resolveFeedback: db.prepare('UPDATE feedback SET resolved = ? WHERE id = ?'),
  adminByEmail: db.prepare('SELECT * FROM admins WHERE email = ?'),
  accountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ?'),
  accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  allAccounts: db.prepare(`SELECT a.id, a.email, a.subscription_status, a.trial_ends_at, a.created_at,
                                  (SELECT name FROM businesses WHERE account_id = a.id ORDER BY created_at LIMIT 1) AS business_name,
                                  (SELECT COUNT(*) FROM businesses WHERE account_id = a.id) AS business_count
                           FROM accounts a ORDER BY a.created_at DESC`),
  insCompAccount: db.prepare(`INSERT INTO accounts (email, password_hash, subscription_status) VALUES (?, ?, 'comp')`),
  updAccountStatus: db.prepare('UPDATE accounts SET subscription_status = ? WHERE id = ?'),
  insAccountFull: db.prepare(`INSERT INTO accounts (email, password_hash, stripe_customer_id, stripe_subscription_id, subscription_status, trial_ends_at)
                              VALUES (@email, @password_hash, @stripe_customer_id, @stripe_subscription_id, @subscription_status, @trial_ends_at)`),
  updAccountFromStripe: db.prepare(`UPDATE accounts SET password_hash=@password_hash, stripe_customer_id=@stripe_customer_id,
                                    stripe_subscription_id=@stripe_subscription_id, subscription_status=@subscription_status,
                                    trial_ends_at=@trial_ends_at WHERE id=@id`),
  accountBySubId: db.prepare('SELECT * FROM accounts WHERE stripe_subscription_id = ?'),
  accountByCustomerId: db.prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?'),
  updAccountSubState: db.prepare('UPDATE accounts SET subscription_status=?, trial_ends_at=? WHERE id=?'),
  updAccountStripeIds: db.prepare(`UPDATE accounts SET stripe_customer_id=@stripe_customer_id, stripe_subscription_id=@stripe_subscription_id,
                                   subscription_status=@subscription_status, trial_ends_at=@trial_ends_at WHERE id=@id`),
  webhookSeen: db.prepare('SELECT id FROM webhook_events WHERE id = ?'),
  insWebhookEvent: db.prepare('INSERT OR IGNORE INTO webhook_events (id, type) VALUES (?, ?)'),
};

function publicBiz(b) {
  return { slug: b.slug, name: b.name, logo_text: b.logo_text, logo_url: b.logo_url, brand_color: b.brand_color, star_threshold: b.star_threshold };
}

// ============ PUBLIC API ============

// Server-rendered QR PNG for a business's review link (reliable, no CDN/client lib).
// Always dark-on-white for guaranteed scannability regardless of brand color.
app.get('/api/qr.png', async (req, res) => {
  const slug = str(req.query.slug, 60).toLowerCase();
  const b = Q.bizBySlug.get(slug);
  if (!b) return res.status(404).send('not found');
  const reviewUrl = `${req.protocol}://${req.get('host')}/r/${slug}`;
  try {
    const buf = await QRCode.toBuffer(reviewUrl, {
      type: 'png', width: 360, margin: 1,
      color: { dark: '#160f24', light: '#ffffff' },
    });
    res.type('png');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch (e) {
    res.status(500).send('qr error');
  }
});

// ---- Self-serve signup (Stripe Checkout + onboarding) ----

// Start a 14-day free trial: create a subscription Checkout Session, redirect to Stripe.
app.get('/start-trial', async (req, res) => {
  if (!stripe) return res.status(503).send('Checkout is not configured yet. Please contact us.');
  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const lineItem = STRIPE_PRICE_ID
      ? { price: STRIPE_PRICE_ID, quantity: 1 }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: PRICE_CENTS, recurring: { interval: 'month' }, product_data: { name: 'More5Stars — Smart Review Routing' } } };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [lineItem],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      payment_method_collection: 'always',          // card on file during trial
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=1`,
    });
    res.redirect(303, session.url);
  } catch (e) {
    console.error('checkout error:', e.message);
    res.status(500).send('Could not start checkout. Please try again.');
  }
});

// Verify a completed Checkout Session and return the email to prefill onboarding.
app.get('/api/onboard/session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'not configured' });
  const sid = str(req.query.session_id, 100);
  if (!sid.startsWith('cs_')) return res.status(400).json({ error: 'invalid session' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sid);
    if (session.status !== 'complete') return res.status(400).json({ error: 'Checkout not complete yet.' });
    const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
    const existing = email ? Q.accountByEmail.get(email) : null;
    res.json({ email, already_onboarded: !!(existing && existing.password_hash) });
  } catch (e) {
    res.status(400).json({ error: 'Could not verify your checkout session.' });
  }
});

// Complete onboarding: verify session, create the account + business, log them in.
app.post('/api/onboard/complete', writeLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'not configured' });
  const sid = str(req.body.session_id, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!sid.startsWith('cs_')) return res.status(400).json({ error: 'invalid session' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const biz = readBizInput(req.body);
  if (!biz.name) return res.status(400).json({ error: 'Business name is required.' });
  if (!isHttpUrl(biz.google_review_url)) return res.status(400).json({ error: 'A valid Google review URL is required.' });

  let session;
  try { session = await stripe.checkout.sessions.retrieve(sid, { expand: ['subscription'] }); }
  catch (e) { return res.status(400).json({ error: 'Could not verify your checkout session.' }); }
  if (session.status !== 'complete') return res.status(400).json({ error: 'Checkout not complete.' });

  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No email on the checkout session.' });
  const sub = session.subscription;
  const subId = typeof sub === 'string' ? sub : (sub && sub.id) || null;
  const custId = typeof session.customer === 'string' ? session.customer : (session.customer && session.customer.id) || null;
  const status = (sub && sub.status) || 'trialing';
  const trialEnds = sub && sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
  const hash = bcrypt.hashSync(password, 12);

  let account = Q.accountByEmail.get(email);
  if (account) {
    Q.updAccountFromStripe.run({ id: account.id, password_hash: hash, stripe_customer_id: custId, stripe_subscription_id: subId, subscription_status: status, trial_ends_at: trialEnds });
  } else {
    const info = Q.insAccountFull.run({ email, password_hash: hash, stripe_customer_id: custId, stripe_subscription_id: subId, subscription_status: status, trial_ends_at: trialEnds });
    account = Q.accountById.get(info.lastInsertRowid);
  }

  // Create their business (idempotent — skip if they already have one).
  if (Q.bizByAccount.all(account.id).length === 0) {
    let base = biz.slug || 'business', slug = base, i = 1;
    while (db.prepare('SELECT id FROM businesses WHERE slug=?').get(slug)) { slug = base + '-' + (++i); }
    biz.slug = slug;
    biz.account_id = account.id;
    try { Q.insBiz.run(biz); } catch (e) { return res.status(400).json({ error: 'Could not create your business.' }); }
  }

  res.cookie('m5s_session', makeSession(account.id, 'customer', email), cookieOpts);
  res.json({ ok: true });
});

// ---- Webhook event processing (called by /webhook/stripe, registered above) ----
const isoFromUnix = (s) => (s ? new Date(s * 1000).toISOString() : null);

// Create or update an account from Stripe data without ever clobbering a comp account or a set password.
function ensureAccount(email, custId, subId, status, trialEnds) {
  let acct = (subId && Q.accountBySubId.get(subId)) || (custId && Q.accountByCustomerId.get(custId));
  if (!acct && email) acct = Q.accountByEmail.get(email.toLowerCase());
  if (acct) {
    if (acct.subscription_status === 'comp') return acct; // never override a free account
    Q.updAccountStripeIds.run({
      id: acct.id,
      stripe_customer_id: custId || acct.stripe_customer_id,
      stripe_subscription_id: subId || acct.stripe_subscription_id,
      subscription_status: status || acct.subscription_status,
      trial_ends_at: trialEnds,
    });
    return acct;
  }
  if (!email) return null;
  const info = Q.insAccountFull.run({
    email: email.toLowerCase(), password_hash: null,
    stripe_customer_id: custId || null, stripe_subscription_id: subId || null,
    subscription_status: status || 'trialing', trial_ends_at: trialEnds,
  });
  return Q.accountById.get(info.lastInsertRowid);
}

async function handleStripeEvent(event) {
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || '';
    const custId = typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id) || null;
    const subId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id) || null;
    let status = 'trialing', trialEnds = null;
    if (subId && stripe) {
      try { const sub = await stripe.subscriptions.retrieve(subId); status = sub.status; trialEnds = isoFromUnix(sub.trial_end); } catch (e) {}
    }
    ensureAccount(email, custId, subId, status, trialEnds);
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = obj;
    const custId = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null;
    const acct = Q.accountBySubId.get(sub.id) || (custId && Q.accountByCustomerId.get(custId));
    if (acct && acct.subscription_status !== 'comp') {
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      Q.updAccountSubState.run(status, isoFromUnix(sub.trial_end), acct.id);
    }
  } else if (event.type === 'invoice.payment_failed') {
    const subId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id);
    const acct = subId && Q.accountBySubId.get(subId);
    if (acct && acct.subscription_status !== 'comp') Q.updAccountSubState.run('past_due', acct.trial_ends_at, acct.id);
  }
}

// Business config for the rating page
app.get('/api/business/:slug', (req, res) => {
  const b = Q.bizBySlug.get(str(req.params.slug, 60).toLowerCase());
  if (!b) return res.status(404).json({ error: 'Business not found' });
  if (!isBizLive(b)) return res.json({ locked: true, name: b.name });
  res.json(publicBiz(b));
});

// Record a star tap and return where the customer should go.
// 5 (or >= star_threshold) -> google ; otherwise -> private feedback form.
app.post('/api/rating', writeLimiter, (req, res) => {
  const slug = str(req.body.slug, 60).toLowerCase();
  const stars = clampStars(req.body.stars);
  const b = Q.bizBySlug.get(slug);
  if (!b) return res.status(404).json({ error: 'Business not found' });
  if (!isBizLive(b)) return res.status(403).json({ error: 'This review page is currently unavailable.' });
  if (!stars) return res.status(400).json({ error: 'stars must be an integer 1-5' });

  const goGoogle = stars >= b.star_threshold;
  const routed_to = goGoogle ? 'google' : 'private';
  Q.insEvent.run(b.id, stars, routed_to);

  res.json({
    routed_to,
    stars,
    google_review_url: goGoogle ? b.google_review_url : null,
  });
});

// Store private feedback (low-star path)
app.post('/api/feedback', writeLimiter, (req, res) => {
  const slug = str(req.body.slug, 60).toLowerCase();
  const stars = clampStars(req.body.stars);
  const b = Q.bizBySlug.get(slug);
  if (!b) return res.status(404).json({ error: 'Business not found' });
  if (!isBizLive(b)) return res.status(403).json({ error: 'This review page is currently unavailable.' });
  if (!stars) return res.status(400).json({ error: 'invalid stars' });

  const row = {
    business_id: b.id,
    stars,
    message: str(req.body.message, 2000),
    customer_name: str(req.body.customer_name, 120),
    customer_email: str(req.body.customer_email, 200),
    customer_phone: str(req.body.customer_phone, 40),
  };
  const info = Q.insFeedback.run(row);

  // In production, fire an email/SMS to b.notify_email here.
  if (b.notify_email) {
    console.log(`[feedback] ${b.name}: ${stars}★ -> notify ${b.notify_email} (id ${info.lastInsertRowid})`);
  }
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ============ ADMIN AUTH ============

const DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  // 1) Super-admin (you)
  const admin = Q.adminByEmail.get(email);
  if (admin && bcrypt.compareSync(password, admin.password_hash)) {
    res.cookie('m5s_session', makeSession(admin.id, 'super', admin.email), cookieOpts);
    return res.json({ ok: true, email: admin.email, role: 'super' });
  }
  // 2) Customer account (self-serve). Only if a password has been set (onboarding done).
  const acct = Q.accountByEmail.get(email);
  if (acct && acct.password_hash && bcrypt.compareSync(password, acct.password_hash)) {
    res.cookie('m5s_session', makeSession(acct.id, 'customer', acct.email), cookieOpts);
    return res.json({ ok: true, email: acct.email, role: 'customer' });
  }
  // constant-time-ish miss
  bcrypt.compareSync(password, DUMMY_HASH);
  return res.status(401).json({ error: 'Invalid email or password' });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('m5s_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAuth, (req, res) => {
  const out = { email: req.user.email, role: req.user.role };
  if (req.user.role === 'customer') {
    const acct = Q.accountById.get(req.user.id);
    if (acct) { out.subscription_status = acct.subscription_status; out.trial_ends_at = acct.trial_ends_at; }
  }
  res.json(out);
});

// ============ ADMIN: BUSINESSES ============

// Super-admin sees every business; a customer sees only their own.
app.get('/api/admin/businesses', requireAuth, (req, res) => {
  res.json(req.user.role === 'super' ? Q.allBiz.all() : Q.bizByAccount.all(req.user.id));
});

function readBizInput(body) {
  let slug = slugify(body.slug || body.name);
  return {
    slug,
    name: str(body.name, 120),
    logo_text: str(body.logo_text, 4) || (str(body.name, 1).toUpperCase() || '★'),
    logo_url: validLogoUrl(body.logo_url),
    brand_color: /^#[0-9a-fA-F]{6}$/.test(body.brand_color || '') ? body.brand_color : '#6C2BD9',
    google_review_url: str(body.google_review_url, 500),
    star_threshold: isInt(body.star_threshold) && body.star_threshold >= 1 && body.star_threshold <= 6 ? body.star_threshold : 5,
    notify_email: str(body.notify_email, 200),
  };
}

app.post('/api/admin/businesses', requireAuth, writeLimiter, (req, res) => {
  const data = readBizInput(req.body);
  // Super-admin creates house-owned businesses (account_id NULL); a customer's
  // new business belongs to their own account.
  data.account_id = req.user.role === 'super' ? null : req.user.id;
  if (!data.name) return res.status(400).json({ error: 'name is required' });
  if (!data.slug) return res.status(400).json({ error: 'could not derive slug' });
  if (!isHttpUrl(data.google_review_url)) return res.status(400).json({ error: 'google_review_url must be a valid http(s) URL' });
  if (Q.bizBySlug.get(data.slug) || db.prepare('SELECT id FROM businesses WHERE slug=?').get(data.slug)) {
    return res.status(409).json({ error: 'slug already exists' });
  }
  try {
    const info = Q.insBiz.run(data);
    res.status(201).json(Q.bizById.get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: 'could not create business' });
  }
});

app.put('/api/admin/businesses/:id', requireAuth, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = Q.bizById.get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (!userOwnsBiz(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });
  const data = readBizInput(req.body);
  if (!isHttpUrl(data.google_review_url)) return res.status(400).json({ error: 'google_review_url must be a valid http(s) URL' });
  const payload = {
    id,
    name: data.name || existing.name,
    logo_text: data.logo_text,
    logo_url: data.logo_url,
    brand_color: data.brand_color,
    google_review_url: data.google_review_url,
    star_threshold: data.star_threshold,
    notify_email: data.notify_email,
    active: body_active(req.body.active, existing.active),
  };
  Q.updBiz.run(payload);
  res.json(Q.bizById.get(id));
});
function body_active(v, fallback) { return v === undefined ? fallback : (v ? 1 : 0); }

app.delete('/api/admin/businesses/:id', requireAuth, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = Q.bizById.get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (!userOwnsBiz(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });
  Q.delBiz.run(id);
  res.json({ ok: true });
});

// ============ ADMIN: FEEDBACK ============

app.get('/api/admin/feedback', requireAuth, (req, res) => {
  const bizId = parseInt(req.query.business_id, 10);
  const biz = bizId && Q.bizById.get(bizId);
  if (!biz) return res.status(400).json({ error: 'valid business_id required' });
  if (!userOwnsBiz(req.user, biz)) return res.status(403).json({ error: 'Forbidden' });
  res.json(Q.feedbackByBiz.all(bizId));
});

app.post('/api/admin/feedback/:id/resolve', requireAuth, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fb = db.prepare('SELECT business_id FROM feedback WHERE id = ?').get(id);
  if (!fb) return res.status(404).json({ error: 'not found' });
  if (!userOwnsBiz(req.user, Q.bizById.get(fb.business_id))) return res.status(403).json({ error: 'Forbidden' });
  Q.resolveFeedback.run(req.body.resolved ? 1 : 0, id);
  res.json({ ok: true });
});

// ============ ADMIN: ANALYTICS ============

app.get('/api/admin/analytics', requireAuth, (req, res) => {
  const bizId = parseInt(req.query.business_id, 10);
  const biz = bizId && Q.bizById.get(bizId);
  if (!biz) return res.status(400).json({ error: 'valid business_id required' });
  if (!userOwnsBiz(req.user, biz)) return res.status(403).json({ error: 'Forbidden' });
  const dist = db.prepare('SELECT stars, COUNT(*) n FROM rating_events WHERE business_id=? GROUP BY stars').all(bizId);
  const byRoute = db.prepare('SELECT routed_to, COUNT(*) n FROM rating_events WHERE business_id=? GROUP BY routed_to').all(bizId);
  const totalFeedback = db.prepare('SELECT COUNT(*) n FROM feedback WHERE business_id=?').get(bizId).n;
  const openFeedback = db.prepare('SELECT COUNT(*) n FROM feedback WHERE business_id=? AND resolved=0').get(bizId).n;
  const last30 = db.prepare(`SELECT date(created_at) d, COUNT(*) n FROM rating_events
                             WHERE business_id=? AND created_at >= datetime('now','-30 day')
                             GROUP BY date(created_at) ORDER BY d`).all(bizId);

  const distMap = [0, 0, 0, 0, 0];
  let totalRatings = 0, sum = 0;
  dist.forEach((r) => { distMap[r.stars - 1] = r.n; totalRatings += r.n; sum += r.stars * r.n; });
  const google = (byRoute.find((r) => r.routed_to === 'google') || {}).n || 0;
  const priv = (byRoute.find((r) => r.routed_to === 'private') || {}).n || 0;

  res.json({
    total_ratings: totalRatings,
    avg_rating: totalRatings ? +(sum / totalRatings).toFixed(2) : 0,
    distribution: distMap,                       // [1★,2★,3★,4★,5★]
    routed_google: google,
    routed_private: priv,
    google_conversion: totalRatings ? +((google / totalRatings) * 100).toFixed(1) : 0,
    total_feedback: totalFeedback,
    open_feedback: openFeedback,
    timeseries: last30,
  });
});

// ============ SUPER-ADMIN: ACCOUNTS (customers) ============

const ALLOWED_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'comp'];
function daysLeft(trial_ends_at) {
  if (!trial_ends_at) return null;
  // Accept both ISO ("...T...Z") and SQLite datetime ("YYYY-MM-DD HH:MM:SS").
  const t = trial_ends_at.includes('T') ? trial_ends_at : trial_ends_at.replace(' ', 'T') + 'Z';
  const ms = new Date(t).getTime() - Date.now();
  return isNaN(ms) ? null : Math.ceil(ms / 86400000);
}

// List every customer account (super-admin only).
app.get('/api/admin/accounts', requireSuper, (req, res) => {
  const rows = Q.allAccounts.all().map((a) => ({
    id: a.id,
    email: a.email,
    business_name: a.business_name,
    business_count: a.business_count,
    subscription_status: a.subscription_status,
    days_left: daysLeft(a.trial_ends_at),
    customer_since: a.created_at,
  }));
  res.json(rows);
});

// Create a free "comp" account for a friend (super-admin only). Full access, no Stripe, never charged.
app.post('/api/admin/accounts/comp', requireSuper, writeLimiter, (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (Q.accountByEmail.get(email) || Q.adminByEmail.get(email)) return res.status(409).json({ error: 'an account with that email already exists' });
  const hash = bcrypt.hashSync(password, 12);
  const info = Q.insCompAccount.run(email, hash);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, email, subscription_status: 'comp' });
});

// Change an account's status (e.g., comp ↔ canceled) — super-admin only.
app.post('/api/admin/accounts/:id/status', requireSuper, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = str(req.body.status, 20);
  if (!ALLOWED_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
  if (!Q.accountById.get(id)) return res.status(404).json({ error: 'not found' });
  Q.updAccountStatus.run(status, id);
  res.json({ ok: true });
});

// ============ STATIC + PAGES ============
const PUB = path.join(__dirname, 'public');
app.get('/r/:slug', (req, res) => res.sendFile(path.join(PUB, 'review.html')));
app.use(express.static(PUB, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));

app.use((req, res) => res.status(404).sendFile(path.join(PUB, 'index.html')));

app.listen(PORT, () => {
  console.log(`More5Stars running → http://localhost:${PORT}`);
  console.log(`  Landing:   http://localhost:${PORT}/`);
  console.log(`  Demo rate: http://localhost:${PORT}/r/demo`);
  console.log(`  Admin:     http://localhost:${PORT}/admin`);
});
