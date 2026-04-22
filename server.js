const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Auth Middleware ─────────────────────────────────────────── */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const requireAuth = (req, res, next) => {
  if (req.cookies.admin_token === ADMIN_PASSWORD) {
    next();
  } else {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.redirect('/login.html');
    }
  }
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});

app.get('/admin.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.cookie('admin_token', ADMIN_PASSWORD, { httpOnly: true, secure: true, sameSite: 'strict' });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  if (req.cookies.admin_token === ADMIN_PASSWORD) {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

/* ── Vercel vs local file paths ───────────────────────────────
   On Vercel: __dirname is read-only. Writable temp is /tmp.
   We copy bundled files to /tmp on first read so the server
   can work within a single serverless invocation.
   Changes won't survive cold-starts — edit locally, then redeploy.
─────────────────────────────────────────────────────────────── */
const IS_VERCEL = !!process.env.VERCEL;

function getRuntimePath(filename) {
  if (!IS_VERCEL) return path.join(__dirname, filename);
  const tmpPath = path.join('/tmp', filename);
  if (!fs.existsSync(tmpPath)) {
    const bundled = path.join(__dirname, filename);
    if (fs.existsSync(bundled)) fs.copyFileSync(bundled, tmpPath);
    else fs.writeFileSync(tmpPath, JSON.stringify(getDefault(filename)));
  }
  return tmpPath;
}

function getDefault(filename) {
  if (filename === 'data.json')      return { site_title: '', folders: [] };
  if (filename === 'contacts.json')  return { contacts: [] };
  if (filename === 'analytics.json') return { events: [], project_opens: {}, page_visits: {} };
  return {};
}

function readJSON(filename) {
  try { return JSON.parse(fs.readFileSync(getRuntimePath(filename), 'utf8')); }
  catch { return getDefault(filename); }
}
function writeJSON(filename, data) {
  fs.writeFileSync(getRuntimePath(filename), JSON.stringify(data, null, 2));
}

/* ── Debug ───────────────────────────────────────────────────── */
app.get('/api/debug-files', requireAuth, (req, res) => {
  const listFiles = (dir) => {
    try {
      return fs.readdirSync(dir).map(f => {
        const p = path.join(dir, f);
        return fs.statSync(p).isDirectory() ? { name: f, isDir: true, children: listFiles(p) } : f;
      });
    } catch { return 'Error reading ' + dir; }
  };
  res.json({
    dirname: __dirname,
    public: listFiles(path.join(__dirname, 'public')),
    root: listFiles(__dirname)
  });
});

/* ── Portfolio Data ──────────────────────────────────────────── */
app.get('/api/data', (req, res) => res.json(readJSON('data.json')));

app.post('/api/data', requireAuth, (req, res) => {
  try {
    writeJSON('data.json', req.body);
    res.json({ success: true, note: IS_VERCEL ? 'Saved to session only. Redeploy to make permanent.' : 'Saved.' });
  } catch (e) { res.status(500).json({ error: 'Failed to save: ' + e.message }); }
});

/* ── Contacts / Inquiries ────────────────────────────────────── */
app.get('/api/contacts', requireAuth, (req, res) => res.json(readJSON('contacts.json')));

app.post('/api/contacts', (req, res) => {
  try {
    const store = readJSON('contacts.json');
    store.contacts.unshift({
      id: 'c_' + Date.now(),
      name: req.body.name || '', email: req.body.email || '',
      message: req.body.message || '', date: new Date().toISOString(), status: 'new'
    });
    writeJSON('contacts.json', store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/contacts/:id', requireAuth, (req, res) => {
  try {
    const store = readJSON('contacts.json');
    const i = store.contacts.findIndex(c => c.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Not found' });
    store.contacts[i] = { ...store.contacts[i], ...req.body };
    writeJSON('contacts.json', store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  try {
    const store = readJSON('contacts.json');
    store.contacts = store.contacts.filter(c => c.id !== req.params.id);
    writeJSON('contacts.json', store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Analytics ───────────────────────────────────────────────── */
app.get('/api/analytics', requireAuth, (req, res) => res.json(readJSON('analytics.json')));

app.post('/api/analytics/track', (req, res) => {
  try {
    const store = readJSON('analytics.json');
    const { type, id, label } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    if (type === 'folder_open' && id) store.project_opens[id] = (store.project_opens[id] || 0) + 1;
    if (type === 'page_visit')        store.page_visits[today] = (store.page_visits[today] || 0) + 1;
    store.events.unshift({ type, id, label, date: new Date().toISOString() });
    if (store.events.length > 1000) store.events = store.events.slice(0, 1000);
    writeJSON('analytics.json', store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Image Upload ────────────────────────────────────────────── */
const UPLOADS_DIR = IS_VERCEL
  ? '/tmp/uploads'
  : path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// On Vercel, also serve from /tmp/uploads since static middleware can't reach /tmp
if (IS_VERCEL) {
  app.get('/uploads/:file', (req, res) => {
    const filePath = path.join('/tmp/uploads', req.params.file);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).json({ error: 'File not found' });
  });
}

app.post('/api/upload', requireAuth, (req, res) => {
  try {
    const { name, data } = req.body;
    const base64  = data.split(',')[1];
    const ext     = (name.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase().replace(/[^a-z0-9.]/g,'');
    const filename = Date.now() + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(base64, 'base64'));
    res.json({ url: '/uploads/' + filename });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Start (local only — Vercel uses module.exports) ─────────── */
if (!IS_VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Portfolio Server → http://localhost:${PORT}`);
    console.log(`Dashboard       → http://localhost:${PORT}/dashboard.html`);
  });
}

module.exports = app;
