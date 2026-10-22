const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const secureCookie = process.env.NODE_ENV === 'production';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const paymentsReady = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && (
  RAZORPAY_KEY_ID.startsWith('rzp_test_') ||
  (process.env.NODE_ENV === 'production' && process.env.PAYMENTS_LIVE_ENABLED === 'true' && RAZORPAY_WEBHOOK_SECRET)
));
const scrypt = promisify(crypto.scrypt);
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'venue-vista.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin'))
    ,user_type TEXT NOT NULL DEFAULT 'customer'
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS venues (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    area TEXT NOT NULL,
    kind TEXT NOT NULL,
    rating REAL NOT NULL,
    reviews INTEGER NOT NULL,
    capacity INTEGER NOT NULL,
    price TEXT NOT NULL,
    image TEXT NOT NULL,
    alt TEXT NOT NULL,
    description TEXT NOT NULL,
    price_paise INTEGER NOT NULL DEFAULT 0,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    listing_status TEXT NOT NULL DEFAULT 'approved'
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, venue_id)
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    event_date TEXT NOT NULL,
    guests INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Awaiting Payment','Confirmed','Cancelled','Declined','Expired')),
    amount_paise INTEGER,
    payment_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function hasColumn(table, column) { return db.prepare('PRAGMA table_info(' + table + ')').all().some(row => row.name === column); }
if (!hasColumn('users', 'role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'customer'");
if (!hasColumn('users', 'user_type')) db.exec("ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'customer'");
if (!hasColumn('venues', 'price_paise')) db.exec('ALTER TABLE venues ADD COLUMN price_paise INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('venues', 'owner_id')) db.exec('ALTER TABLE venues ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
if (!hasColumn('venues', 'listing_status')) db.exec("ALTER TABLE venues ADD COLUMN listing_status TEXT NOT NULL DEFAULT 'approved'");
db.exec("UPDATE venues SET price_paise=CAST(REPLACE(REPLACE(price,'₹',''),',','') AS INTEGER)*100 WHERE price_paise=0");
const oldBookingSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get().sql;
if (!oldBookingSql.includes('Approved')) {
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    ALTER TABLE bookings RENAME TO bookings_legacy;
    CREATE TABLE bookings (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      event_date TEXT NOT NULL,
      guests INTEGER NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Awaiting Payment','Confirmed','Cancelled','Declined','Expired')),
      amount_paise INTEGER,
      payment_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO bookings(id,user_id,venue_id,event_date,guests,message,status,created_at)
      SELECT id,user_id,venue_id,event_date,guests,message,CASE WHEN status='Cancelled' THEN 'Cancelled' ELSE 'Pending' END,created_at FROM bookings_legacy;
    DROP TABLE bookings_legacy;
    COMMIT; PRAGMA foreign_keys=ON;`);
}
if (!hasColumn('bookings', 'amount_paise')) db.exec('ALTER TABLE bookings ADD COLUMN amount_paise INTEGER');
if (!hasColumn('bookings', 'payment_expires_at')) db.exec('ALTER TABLE bookings ADD COLUMN payment_expires_at TEXT');
if (!hasColumn('bookings', 'quote_expires_at')) db.exec('ALTER TABLE bookings ADD COLUMN quote_expires_at TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL UNIQUE,
    payment_id TEXT UNIQUE,
    amount_paise INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','authorized','captured','failed','refunded','expired')),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  DROP INDEX IF EXISTS booking_active_date;
  CREATE UNIQUE INDEX booking_active_date ON bookings(venue_id,event_date) WHERE status IN ('Approved','Awaiting Payment','Confirmed');
`);
const oldPaymentSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'").get().sql;
if (!oldPaymentSql.includes('expired')) {
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    ALTER TABLE payments RENAME TO payments_legacy;
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      order_id TEXT NOT NULL UNIQUE,
      payment_id TEXT UNIQUE,
      amount_paise INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','authorized','captured','failed','refunded','expired')),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO payments(id,booking_id,order_id,payment_id,amount_paise,status,created_at,updated_at)
      SELECT id,booking_id,order_id,payment_id,amount_paise,status,created_at,updated_at FROM payments_legacy;
    DROP TABLE payments_legacy;
    COMMIT; PRAGMA foreign_keys=ON;`);
}
if (!hasColumn('payments', 'expires_at')) db.exec('ALTER TABLE payments ADD COLUMN expires_at TEXT');

const seed = [
  ['The Glasshouse','Bengaluru','Whitefield','Wedding',4.9,128,180,'₹1,80,000','photo-1519167758481-83f550bb49b3','Garden wedding reception under warm lights','A light-filled garden venue for gatherings that deserve a little extra magic.'],
  ['Olive & Ember','Mumbai','Bandra West','Dinner',4.8,86,48,'₹2,500','photo-1414235077428-338989a2e8c0','Intimate restaurant dining room','A cosy private dining room with a seasonal menu and a relaxed, candlelit feel.'],
  ['The Courtyard House','Jaipur','Civil Lines','Wedding',5.0,64,120,'₹95,000','photo-1519741497674-611481863552','Courtyard celebration with flowers','A heritage courtyard wrapped in greenery, ideal for close-knit celebrations.'],
  ['Studio Fern','Pune','Koregaon Park','Corporate',4.9,42,36,'₹18,000','photo-1497366754035-f200968a6e72','Bright modern creative workspace','A calm, naturally lit space for workshops, offsites, and thoughtful team sessions.'],
  ['Casa Sol','Goa','Assagao','Weekend',4.9,103,14,'₹22,000','photo-1613490493576-7fde63acd811','Tropical villa with private pool','A quiet tropical hideaway for a long weekend with your favourite people.'],
  ['The Conservatory','Hyderabad','Jubilee Hills','Dinner',4.7,57,60,'₹1,800','photo-1517248135467-4c7edcad34c4','Restaurant with warm pendant lighting','A leafy dining room with a welcoming menu and room for a proper get-together.']
];
const venueCount = db.prepare('SELECT COUNT(*) AS count FROM venues').get().count;
if (!venueCount) {
  const insertVenue = db.prepare('INSERT INTO venues(name,city,area,kind,rating,reviews,capacity,price,image,alt,description) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try { seed.forEach(row => insertVenue.run(...row)); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
db.exec("UPDATE venues SET price_paise=CAST(REPLACE(REPLACE(price,'₹',''),',','') AS INTEGER)*100 WHERE price_paise=0");
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

const mimeTypes = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon' };
const authAttempts = new Map();
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers });
  res.end(body);
}
function fail(status, message) { const error = new Error(message); error.status = status; return error; }
function safeUser(row) { return row ? { id:row.id, name:row.name, email:row.email, userType:row.user_type || 'customer' } : null; }
function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const entry = cookies.map(part => part.trim()).find(part => part.startsWith(name + '='));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function sessionCookie(token, maxAge) {
  return 'vv_session=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (secureCookie ? '; Secure' : '');
}
function currentUser(req) {
  const token = cookieValue(req, 'vv_session');
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT users.id, users.name, users.email, users.user_type FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').get(tokenHash, Date.now());
  return safeUser(row);
}
function requireUser(req) { const user = currentUser(req); if (!user) throw fail(401, 'Sign in to continue.'); return user; }
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try { if (new URL(origin).host !== req.headers.host) throw fail(403, 'This request was not allowed.'); }
  catch (error) { if (error.status) throw error; throw fail(403, 'This request was not allowed.'); }
}
function checkRateLimit(req) {
  const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
  const attempts = (authAttempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if (attempts.length >= 8) throw fail(429, 'Too many sign-in attempts. Please try again in a few minutes.');
  attempts.push(now); authAttempts.set(key, attempts);
}
async function readJson(req) {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw fail(400, 'Please send valid JSON.'); }
}
async function readRawBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) throw fail(413, 'Request is too large.'); }
  return raw;
}
function expirePaymentHolds() {
  const now = new Date().toISOString();
  db.prepare("UPDATE payments SET status='expired',updated_at=CURRENT_TIMESTAMP WHERE status='created' AND expires_at IS NOT NULL AND expires_at<?").run(now);
  db.prepare("UPDATE bookings SET status='Expired' WHERE status='Awaiting Payment' AND payment_expires_at<? AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.booking_id=bookings.id AND payments.status IN ('created','authorized','captured'))").run(now);
}
function paymentSignature(expected, provided) {
  if (typeof provided !== 'string' || !/^[a-f\d]{64}$/i.test(provided)) return false;
  const expectedBuffer = Buffer.from(expected, 'hex'), providedBuffer = Buffer.from(provided, 'hex');
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), userId, Date.now() + SESSION_MS);
  return token;
}
function venueFromRow(row) { return row; }

async function handleApi(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/venues') {
    const q = text(url.searchParams.get('q') || '', 100), kind = text(url.searchParams.get('kind') || '', 30), occasion = text(url.searchParams.get('occasion') || '', 30);
    let sql = "SELECT id,name,city,area,kind,rating,reviews,capacity,price,price_paise,image,alt,description FROM venues WHERE listing_status='approved'", args = [];
    if (q) { const like = '%' + q + '%'; sql += ' AND (name LIKE ? OR city LIKE ? OR area LIKE ?)'; args.push(like, like, like); }
    if (kind && kind !== 'all') { sql += ' AND kind=?'; args.push(kind); }
    if (occasion && occasion !== 'all') { if (occasion === 'Birthday') { sql += " AND kind IN ('Dinner','Wedding')"; } else { sql += ' AND kind=?'; args.push(occasion); } }
    sql += ' ORDER BY rating DESC, name';
    return sendJson(res, 200, { venues:db.prepare(sql).all(...args).map(venueFromRow) });
  }
  const availabilityMatch = route.match(/^\/api\/venues\/(\d+)\/availability$/);
  if (req.method === 'GET' && availabilityMatch) {
    expirePaymentHolds();
    const venueId=Number(availabilityMatch[1]), date=text(url.searchParams.get('date')||'',10);
    if (!db.prepare('SELECT id FROM venues WHERE id=?').get(venueId)) throw fail(404,'Venue not found.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400,'Choose a valid date.');
    const parsed=new Date(date+'T00:00:00');
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==date) throw fail(400,'Choose a valid date.');
    const booked=Boolean(db.prepare("SELECT id FROM bookings WHERE venue_id=? AND event_date=? AND status IN ('Approved','Awaiting Payment','Confirmed')").get(venueId,date));
    return sendJson(res,200,{available:!booked});
  }
  if (req.method === 'GET' && route === '/api/me') return sendJson(res, 200, { user:currentUser(req) });
  if (req.method === 'GET' && route === '/api/payments/config') return sendJson(res,200,{enabled:paymentsReady,keyId:paymentsReady?RAZORPAY_KEY_ID:''});
  if (req.method === 'POST' && (route === '/api/auth/register' || route === '/api/auth/login')) {
    checkRateLimit(req); const body = await readJson(req);
    const email = text(body.email, 254).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
    if (!validEmail(email) || password.length < 10 || password.length > 200) throw fail(400, 'Enter a valid email and a password between 10 and 200 characters.');
    let user;
    if (route.endsWith('/register')) {
      const name = text(body.name, 80);
      if (name.length < 2) throw fail(400, 'Please enter your name.');
      const userType = body.accountType === 'owner' ? 'owner' : 'customer';
      const salt = crypto.randomBytes(16), derived = await scrypt(password, salt, 64);
      try { const result = db.prepare('INSERT INTO users(name,email,password_hash,user_type) VALUES(?,?,?,?)').run(name, email, salt.toString('hex') + ':' + derived.toString('hex'), userType); user = { id:Number(result.lastInsertRowid), name, email, userType }; }
      catch (error) { if (String(error.message).includes('UNIQUE')) throw fail(409, 'An account with that email already exists.'); throw error; }
    } else {
      const row = db.prepare('SELECT id,name,email,password_hash,user_type FROM users WHERE email=? COLLATE NOCASE').get(email);
      let valid = false;
      if (row) { const [saltHex, hashHex] = row.password_hash.split(':'); const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64); const expected = Buffer.from(hashHex, 'hex'); valid = expected.length === actual.length && crypto.timingSafeEqual(actual, expected); }
      if (!valid) throw fail(401, 'Email or password is incorrect.');
      user = safeUser(row);
    }
    const token = createSession(user.id);
    return sendJson(res, 200, { user }, { 'Set-Cookie':sessionCookie(token, SESSION_DAYS * 24 * 60 * 60) });
  }
  if (req.method === 'POST' && route === '/api/auth/logout') {
    const token = cookieValue(req, 'vv_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
    return sendJson(res, 200, { ok:true }, { 'Set-Cookie':sessionCookie('', 0) });
  }
  if (req.method === 'GET' && route === '/api/favorites') {
    const user = requireUser(req); return sendJson(res, 200, { venueIds:db.prepare('SELECT venue_id FROM favorites WHERE user_id=? ORDER BY created_at DESC').all(user.id).map(row => row.venue_id) });
  }
  const favoriteMatch = route.match(/^\/api\/favorites\/(\d+)$/);
  if (favoriteMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const user = requireUser(req), venueId = Number(favoriteMatch[1]);
    if (!db.prepare('SELECT id FROM venues WHERE id=?').get(venueId)) throw fail(404, 'Venue not found.');
    if (req.method === 'PUT') db.prepare('INSERT OR IGNORE INTO favorites(user_id,venue_id) VALUES(?,?)').run(user.id, venueId);
    else db.prepare('DELETE FROM favorites WHERE user_id=? AND venue_id=?').run(user.id, venueId);
    return sendJson(res, 200, { ok:true });
  }
  if (req.method === 'GET' && route === '/api/bookings') {
    expirePaymentHolds(); const user = requireUser(req);
    const bookings = db.prepare('SELECT bookings.id,bookings.event_date AS date,bookings.guests,bookings.message,bookings.status,bookings.amount_paise AS amountPaise,bookings.created_at AS createdAt,venues.id AS venueId,venues.name AS venueName,venues.city,(SELECT payments.order_id FROM payments WHERE payments.booking_id=bookings.id AND payments.status IN (\'created\',\'authorized\') ORDER BY payments.id DESC LIMIT 1) AS paymentOrderId FROM bookings JOIN venues ON venues.id=bookings.venue_id WHERE bookings.user_id=? ORDER BY bookings.created_at DESC').all(user.id);
    return sendJson(res, 200, { bookings });
  }
  if (route.startsWith('/api/owner/')) {
    const user = requireUser(req);
    if (user.userType !== 'owner') throw fail(403, 'This area is for venue owners.');
    if (req.method === 'GET' && route === '/api/owner/venues') {
      return sendJson(res,200,{venues:db.prepare('SELECT id,name,city,area,kind,capacity,price,price_paise,description FROM venues WHERE owner_id=? ORDER BY id DESC').all(user.id)});
    }
    if (req.method === 'POST' && route === '/api/owner/venues') {
      const body=await readJson(req), name=text(body.name,100), city=text(body.city,60), area=text(body.area,80), kind=text(body.kind,30), capacity=Number(body.capacity), price=Number(body.price), description=text(body.description,500);
      if(name.length<2||city.length<2||area.length<2||!['Wedding','Dinner','Corporate','Weekend'].includes(kind)||!Number.isInteger(capacity)||capacity<1||capacity>10000||!Number.isFinite(price)||price<1||price>10000000||description.length<15) throw fail(400,'Please complete all venue details with a valid price, capacity, and description.');
      const image=kind==='Wedding'?'photo-1519741497674-611481863552':kind==='Dinner'?'photo-1414235077428-338989a2e8c0':kind==='Corporate'?'photo-1497366754035-f200968a6e72':'photo-1613490493576-7fde63acd811';
      const result=db.prepare("INSERT INTO venues(name,city,area,kind,rating,reviews,capacity,price,image,alt,description,price_paise,owner_id,listing_status) VALUES(?,?,?,?,5,0,?,?,?,?,?,?,?,'approved')").run(name,city,area,kind,capacity,new Intl.NumberFormat('en-IN').format(price),image,name+' venue space',description,Math.round(price*100),user.id);
      return sendJson(res,201,{venueId:Number(result.lastInsertRowid)});
    }
    if (req.method === 'GET' && route === '/api/owner/bookings') {
      expirePaymentHolds();
      const bookings=db.prepare("SELECT b.id,b.event_date AS date,b.guests,b.message,b.status,b.amount_paise AS amountPaise,u.name AS customerName,u.email AS customerEmail,v.id AS venueId,v.name AS venueName,v.city FROM bookings b JOIN venues v ON v.id=b.venue_id JOIN users u ON u.id=b.user_id WHERE v.owner_id=? ORDER BY b.created_at DESC").all(user.id);
      return sendJson(res,200,{bookings});
    }
    const ownerBooking=route.match(/^\/api\/owner\/bookings\/(\d+)$/);
    if(req.method==='PUT'&&ownerBooking){
      const body=await readJson(req), action=body.action, bookingId=Number(ownerBooking[1]);
      if(!['approve','decline'].includes(action)) throw fail(400,'Choose approve or decline.');
      const booking=db.prepare('SELECT b.id,b.venue_id,b.event_date,b.status FROM bookings b JOIN venues v ON v.id=b.venue_id WHERE b.id=? AND v.owner_id=?').get(bookingId,user.id);
      if(!booking||booking.status!=='Pending') throw fail(404,'This pending request could not be found.');
      if(action==='approve'&&db.prepare("SELECT id FROM bookings WHERE venue_id=? AND event_date=? AND id<>? AND status IN ('Awaiting Payment','Confirmed','Approved')").get(booking.venue_id,booking.event_date,bookingId)) throw fail(409,'Another booking already holds that date.');
      db.prepare('UPDATE bookings SET status=? WHERE id=?').run(action==='approve'?'Approved':'Declined',bookingId);
      return sendJson(res,200,{ok:true,status:action==='approve'?'Approved':'Declined'});
    }
  }
  if (req.method === 'POST' && route === '/api/bookings') {
    const user = requireUser(req), body = await readJson(req), venueId = Number(body.venueId), date = text(body.date, 10), guests = Number(body.guests), message = text(body.message, 1000);
    const parsedDate = new Date(date + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const venue=db.prepare('SELECT id,capacity,price_paise,owner_id FROM venues WHERE id=? AND listing_status=?').get(venueId,'approved');
    if (!Number.isInteger(venueId) || !venue) throw fail(400, 'Choose a valid venue.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10) !== date || parsedDate < today) throw fail(400, 'Choose a valid date from today onwards.');
    if (!Number.isInteger(guests) || guests < 1 || guests > venue.capacity) throw fail(400, 'Guest count must be between 1 and the venue capacity of '+venue.capacity+'.');
    expirePaymentHolds();
    if (db.prepare("SELECT id FROM bookings WHERE venue_id=? AND event_date=? AND status IN ('Approved','Awaiting Payment','Confirmed')").get(venueId,date)) throw fail(409,'That date has just been booked. Choose another date.');
    const status=venue.owner_id?'Pending':'Approved';
    const result = db.prepare('INSERT INTO bookings(user_id,venue_id,event_date,guests,message,status,amount_paise) VALUES(?,?,?,?,?,?,?)').run(user.id, venueId, date, guests, message,status, venue.price_paise);
    return sendJson(res, 201, { booking:{ id:Number(result.lastInsertRowid), status, amountPaise:venue.price_paise } });
  }
  const paymentOrderMatch=route.match(/^\/api\/bookings\/(\d+)\/payment\/order$/);
  if(req.method==='POST'&&paymentOrderMatch){
    const user=requireUser(req);if(!paymentsReady)throw fail(503,'Online payment is not configured yet.');
    expirePaymentHolds();const bookingId=Number(paymentOrderMatch[1]);
    const booking=db.prepare('SELECT bookings.id,bookings.user_id,bookings.venue_id,bookings.event_date,bookings.status,bookings.amount_paise,venues.name AS venue_name FROM bookings JOIN venues ON venues.id=bookings.venue_id WHERE bookings.id=? AND bookings.user_id=?').get(bookingId,user.id);
    if(!booking)throw fail(404,'Booking request not found.');
    if(booking.status==='Confirmed')throw fail(409,'This booking is already confirmed.');
    if(!['Approved','Awaiting Payment','Expired'].includes(booking.status))throw fail(409,'The venue must approve this request before payment.');
    const existing=db.prepare("SELECT order_id,amount_paise,expires_at FROM payments WHERE booking_id=? AND status IN ('created','authorized') ORDER BY id DESC LIMIT 1").get(bookingId);
    if(existing&&existing.expires_at&&existing.expires_at>new Date().toISOString())return sendJson(res,200,{orderId:existing.order_id,amount:existing.amount_paise,currency:'INR',keyId:RAZORPAY_KEY_ID});
    if(db.prepare("SELECT id FROM bookings WHERE venue_id=? AND event_date=? AND id<>? AND status IN ('Awaiting Payment','Confirmed')").get(booking.venue_id,booking.event_date,booking.id))throw fail(409,'That date has just been booked. Choose another date.');
    if(!Number.isInteger(booking.amount_paise)||booking.amount_paise<100)throw fail(400,'This venue does not have a valid price yet.');
    let gatewayResponse;
    try{const response=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(RAZORPAY_KEY_ID+':'+RAZORPAY_KEY_SECRET).toString('base64'),'Content-Type':'application/json'},body:JSON.stringify({amount:booking.amount_paise,currency:'INR',receipt:'vv'+booking.id,notes:{booking_id:String(booking.id),venue:booking.venue_name}}),signal:AbortSignal.timeout(12000)});gatewayResponse=await response.json();if(!response.ok)throw new Error(gatewayResponse.error?.description||'Razorpay could not create the payment order.');}
    catch(error){console.error('Razorpay order creation failed:',error.message);throw fail(502,'Could not start payment. Please try again in a moment.');}
    const expiresAt=new Date(Date.now()+20*60*1000).toISOString();
    try{db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO payments(booking_id,order_id,amount_paise,status,expires_at) VALUES(?,?,?,\'created\',?)').run(booking.id,gatewayResponse.id,booking.amount_paise,expiresAt);db.prepare("UPDATE bookings SET status='Awaiting Payment',payment_expires_at=? WHERE id=?").run(expiresAt,booking.id);db.exec('COMMIT');}
    catch(error){try{db.exec('ROLLBACK');}catch{}if(String(error.message).includes('UNIQUE'))throw fail(409,'That date was booked by someone else.');throw error;}
    return sendJson(res,200,{orderId:gatewayResponse.id,amount:booking.amount_paise,currency:'INR',keyId:RAZORPAY_KEY_ID});
  }
  const paymentVerifyMatch=route.match(/^\/api\/bookings\/(\d+)\/payment\/verify$/);
  if(req.method==='POST'&&paymentVerifyMatch){
    const user=requireUser(req),body=await readJson(req),bookingId=Number(paymentVerifyMatch[1]);
    const orderId=text(body.razorpay_order_id,100),paymentId=text(body.razorpay_payment_id,100),signature=text(body.razorpay_signature,128);
    const row=db.prepare('SELECT payments.order_id,payments.amount_paise,payments.status,bookings.id AS booking_id,bookings.user_id FROM payments JOIN bookings ON bookings.id=payments.booking_id WHERE payments.order_id=? AND payments.booking_id=? AND bookings.user_id=?').get(orderId,bookingId,user.id);
    if(!row)throw fail(404,'Payment order not found.');
    const expected=crypto.createHmac('sha256',RAZORPAY_KEY_SECRET).update(orderId+'|'+paymentId).digest('hex');
    if(!paymentSignature(expected,signature))throw fail(400,'Payment verification failed.');
    let payment;
    try{const response=await fetch('https://api.razorpay.com/v1/payments/'+encodeURIComponent(paymentId),{headers:{Authorization:'Basic '+Buffer.from(RAZORPAY_KEY_ID+':'+RAZORPAY_KEY_SECRET).toString('base64')},signal:AbortSignal.timeout(12000)});payment=await response.json();if(!response.ok)throw new Error('Payment status could not be confirmed.');}
    catch(error){console.error('Razorpay verification failed:',error.message);throw fail(502,'We could not confirm the payment yet. Your request is saved; please check again shortly.');}
    if(payment.order_id!==orderId||payment.amount!==row.amount_paise||payment.currency!=='INR')throw fail(400,'Payment details did not match this booking.');
    if(payment.status!=='captured')return sendJson(res,202,{message:'Payment is still processing. We will confirm the booking when capture completes.'});
    db.prepare("UPDATE payments SET payment_id=?,status='captured',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(paymentId,orderId);
    db.prepare("UPDATE bookings SET status='Confirmed' WHERE id=? AND user_id=?").run(bookingId,user.id);
    return sendJson(res,200,{ok:true,status:'Confirmed'});
  }
  if(req.method==='POST'&&route==='/api/payments/razorpay/webhook'){
    if(!RAZORPAY_WEBHOOK_SECRET)return sendJson(res,503,{error:'Payment webhook is not configured.'});
    const raw=await readRawBody(req),signature=req.headers['x-razorpay-signature']||'';
    const expected=crypto.createHmac('sha256',RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if(!paymentSignature(expected,signature))throw fail(400,'Webhook signature is invalid.');
    let event;try{event=JSON.parse(raw);}catch{throw fail(400,'Webhook payload is invalid.');}
    const entity=event.payload?.payment?.entity,orderId=entity?.order_id;
    if(entity&&orderId){
      const row=db.prepare('SELECT payments.booking_id,payments.amount_paise FROM payments WHERE order_id=?').get(orderId);
      if(row&&entity.amount===row.amount_paise&&entity.currency==='INR'){
        if(event.event==='payment.captured'){
          db.prepare("UPDATE payments SET payment_id=?,status='captured',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(entity.id,orderId);
          db.prepare("UPDATE bookings SET status='Confirmed' WHERE id=?").run(row.booking_id);
        }else if(event.event==='payment.failed'){
          db.prepare("UPDATE payments SET payment_id=?,status='failed',updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status<>'captured'").run(entity.id,orderId);
          db.prepare("UPDATE bookings SET status='Pending',payment_expires_at=NULL WHERE id=? AND status='Awaiting Payment'").run(row.booking_id);
        }
      }
    }
    return sendJson(res,200,{received:true});
  }
  const bookingMatch = route.match(/^\/api\/bookings\/(\d+)$/);
  if (req.method === 'DELETE' && bookingMatch) {
    const user = requireUser(req), result = db.prepare("UPDATE bookings SET status='Cancelled' WHERE id=? AND user_id=? AND status IN ('Pending','Approved','Expired')").run(Number(bookingMatch[1]), user.id);
    if (!result.changes) throw fail(404, 'This booking cannot be cancelled. Contact support for help with a paid booking.');
    return sendJson(res, 200, { ok:true });
  }
  sendJson(res, 404, { error:'That API route was not found.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || 'localhost:' + PORT;
    const url = new URL(req.url, 'http://' + host);
    if (url.pathname.startsWith('/api/')) {
      if (!['GET','POST','PUT','DELETE'].includes(req.method)) return sendJson(res, 405, { error:'Method not allowed.' }, { Allow:'GET, POST, PUT, DELETE' });
      if (req.method !== 'GET') checkOrigin(req);
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error:'Method not allowed.' }, { Allow:'GET, HEAD' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw fail(400, 'Invalid path.'); }
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(ROOT, '.' + pathname);
    if (path.dirname(filePath) !== ROOT || !['index.html','styles.css','app.js'].includes(path.basename(filePath))) throw fail(404, 'Page not found.');
    let stat; try { stat = fs.statSync(filePath); } catch { throw fail(404, 'Page not found.'); }
    if (!stat.isFile()) throw fail(404, 'Page not found.');
    res.writeHead(200, { 'Content-Type':mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream','Content-Length':stat.size,'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':path.extname(filePath)==='.html'?'no-cache':'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error:error.status ? error.message : 'Something went wrong. Please try again.' });
    if (!error.status) console.error(error);
  }
});

server.listen(PORT, HOST, () => console.log('Venue Vista is running at http://' + HOST + ':' + PORT));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); });
