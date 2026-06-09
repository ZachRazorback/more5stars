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
const { db, seed } = require('./db');

seed(); // ensure admin + demo exist on boot

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);

// ---- Security headers / CSP ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],   // QR lib
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

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// ---- Rate limiters ----
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
app.use('/api/', apiLimiter);

// ---- Simple in-memory session store (swap for Redis in prod) ----
const sessions = new Map(); // token -> { adminId, email, created }
const SESSION_TTL = 24 * 60 * 60 * 1000;
function makeSession(admin) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { adminId: admin.id, email: admin.email, created: Date.now() });
  return token;
}
function requireAdmin(req, res, next) {
  const token = req.cookies.m5s_session;
  const s = token && sessions.get(token);
  if (!s || Date.now() - s.created > SESSION_TTL) {
    if (s) sessions.delete(token);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.admin = s;
  next();
}
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_TTL, path: '/' };

// ---- Validation helpers ----
const isInt = (v) => Number.isInteger(v);
const clampStars = (v) => (isInt(v) && v >= 1 && v <= 5 ? v : null);
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slugify = (s) => str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isHttpUrl = (u) => /^https?:\/\/.+/i.test(u || '');

// Prepared statements
const Q = {
  bizBySlug: db.prepare('SELECT * FROM businesses WHERE slug = ? AND active = 1'),
  bizById: db.prepare('SELECT * FROM businesses WHERE id = ?'),
  allBiz: db.prepare('SELECT * FROM businesses ORDER BY created_at DESC'),
  insBiz: db.prepare(`INSERT INTO businesses (slug, name, logo_text, brand_color, google_review_url, star_threshold, notify_email)
                      VALUES (@slug, @name, @logo_text, @brand_color, @google_review_url, @star_threshold, @notify_email)`),
  updBiz: db.prepare(`UPDATE businesses SET name=@name, logo_text=@logo_text, brand_color=@brand_color,
                      google_review_url=@google_review_url, star_threshold=@star_threshold,
                      notify_email=@notify_email, active=@active WHERE id=@id`),
  delBiz: db.prepare('DELETE FROM businesses WHERE id = ?'),
  insEvent: db.prepare('INSERT INTO rating_events (business_id, stars, routed_to) VALUES (?, ?, ?)'),
  insFeedback: db.prepare(`INSERT INTO feedback (business_id, stars, message, customer_name, customer_email, customer_phone)
                           VALUES (@business_id, @stars, @message, @customer_name, @customer_email, @customer_phone)`),
  feedbackByBiz: db.prepare('SELECT * FROM feedback WHERE business_id = ? ORDER BY created_at DESC LIMIT 500'),
  resolveFeedback: db.prepare('UPDATE feedback SET resolved = ? WHERE id = ?'),
  adminByEmail: db.prepare('SELECT * FROM admins WHERE email = ?'),
};

function publicBiz(b) {
  return { slug: b.slug, name: b.name, logo_text: b.logo_text, brand_color: b.brand_color, star_threshold: b.star_threshold };
}

// ============ PUBLIC API ============

// Business config for the rating page
app.get('/api/business/:slug', (req, res) => {
  const b = Q.bizBySlug.get(str(req.params.slug, 60).toLowerCase());
  if (!b) return res.status(404).json({ error: 'Business not found' });
  res.json(publicBiz(b));
});

// Record a star tap and return where the customer should go.
// 5 (or >= star_threshold) -> google ; otherwise -> private feedback form.
app.post('/api/rating', writeLimiter, (req, res) => {
  const slug = str(req.body.slug, 60).toLowerCase();
  const stars = clampStars(req.body.stars);
  const b = Q.bizBySlug.get(slug);
  if (!b) return res.status(404).json({ error: 'Business not found' });
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

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const admin = Q.adminByEmail.get(email);
  // constant-ish time: always run a compare
  const ok = admin ? bcrypt.compareSync(password, admin.password_hash) : bcrypt.compareSync(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!admin || !ok) return res.status(401).json({ error: 'Invalid email or password' });
  const token = makeSession(admin);
  res.cookie('m5s_session', token, cookieOpts);
  res.json({ ok: true, email: admin.email });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies.m5s_session;
  if (token) sessions.delete(token);
  res.clearCookie('m5s_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));

// ============ ADMIN: BUSINESSES ============

app.get('/api/admin/businesses', requireAdmin, (req, res) => {
  res.json(Q.allBiz.all());
});

function readBizInput(body) {
  let slug = slugify(body.slug || body.name);
  return {
    slug,
    name: str(body.name, 120),
    logo_text: str(body.logo_text, 4) || (str(body.name, 1).toUpperCase() || '★'),
    brand_color: /^#[0-9a-fA-F]{6}$/.test(body.brand_color || '') ? body.brand_color : '#6C2BD9',
    google_review_url: str(body.google_review_url, 500),
    star_threshold: isInt(body.star_threshold) && body.star_threshold >= 1 && body.star_threshold <= 6 ? body.star_threshold : 5,
    notify_email: str(body.notify_email, 200),
  };
}

app.post('/api/admin/businesses', requireAdmin, writeLimiter, (req, res) => {
  const data = readBizInput(req.body);
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

app.put('/api/admin/businesses/:id', requireAdmin, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = Q.bizById.get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const data = readBizInput(req.body);
  if (!isHttpUrl(data.google_review_url)) return res.status(400).json({ error: 'google_review_url must be a valid http(s) URL' });
  const payload = {
    id,
    name: data.name || existing.name,
    logo_text: data.logo_text,
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

app.delete('/api/admin/businesses/:id', requireAdmin, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Q.bizById.get(id)) return res.status(404).json({ error: 'not found' });
  Q.delBiz.run(id);
  res.json({ ok: true });
});

// ============ ADMIN: FEEDBACK ============

app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const bizId = parseInt(req.query.business_id, 10);
  if (!bizId || !Q.bizById.get(bizId)) return res.status(400).json({ error: 'valid business_id required' });
  res.json(Q.feedbackByBiz.all(bizId));
});

app.post('/api/admin/feedback/:id/resolve', requireAdmin, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const resolved = req.body.resolved ? 1 : 0;
  Q.resolveFeedback.run(resolved, id);
  res.json({ ok: true });
});

// ============ ADMIN: ANALYTICS ============

app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const bizId = parseInt(req.query.business_id, 10);
  if (!bizId || !Q.bizById.get(bizId)) return res.status(400).json({ error: 'valid business_id required' });
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
