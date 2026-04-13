/**
 * Cloudflare Worker - WordPress Storage Backend
 * Handles: Posts, Pages, Media Meta, Users Meta, Comments, Options, Sessions/Cache
 * D1: Structured data (posts, comments, options, users_meta, media_meta)
 * KV:  Sessions, cache, transients
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // 배포 후 실제 WordPress 도메인으로 변경 권장
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-WP-Secret',
  'Content-Type': 'application/json',
};

// ── 인증 미들웨어 ──────────────────────────────────────────────────────────────
function authenticate(request, env) {
  const secret = request.headers.get('X-WP-Secret');
  if (!secret || secret !== env.WP_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: CORS_HEADERS,
    });
  }
  return null; // OK
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: CORS_HEADERS });
}

// ── D1 초기화 SQL ──────────────────────────────────────────────────────────────
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_type  TEXT    NOT NULL DEFAULT 'post',
  status     TEXT    NOT NULL DEFAULT 'draft',
  title      TEXT,
  content    TEXT,
  excerpt    TEXT,
  slug       TEXT    UNIQUE,
  author_id  INTEGER NOT NULL DEFAULT 1,
  parent_id  INTEGER NOT NULL DEFAULT 0,
  menu_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  meta       TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  parent_id  INTEGER NOT NULL DEFAULT 0,
  author     TEXT,
  email      TEXT,
  url        TEXT,
  content    TEXT,
  status     TEXT    NOT NULL DEFAULT 'pending',
  user_id    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  meta       TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS options (
  option_name  TEXT PRIMARY KEY,
  option_value TEXT,
  autoload     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users_meta (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  meta_key   TEXT    NOT NULL,
  meta_value TEXT,
  UNIQUE(user_id, meta_key)
);

CREATE TABLE IF NOT EXISTS media_meta (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL UNIQUE,
  url         TEXT,
  filename    TEXT,
  mime_type   TEXT,
  file_size   INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  alt_text    TEXT,
  caption     TEXT,
  meta        TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_type_status ON posts(post_type, status);
CREATE INDEX IF NOT EXISTS idx_posts_slug        ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_comments_post     ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_users_meta_uid    ON users_meta(user_id);
CREATE INDEX IF NOT EXISTS idx_media_att         ON media_meta(attachment_id);
`;

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTER
// ══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const authErr = authenticate(request, env);
    if (authErr) return authErr;

    const url    = new URL(request.url);
    const parts  = url.pathname.replace(/^\//, '').split('/');
    const [resource, id, sub] = parts;
    const method = request.method;

    try {
      // ── DB 초기화 ──────────────────────────────────────────────────────────
      if (resource === 'init' && method === 'POST') {
        for (const stmt of INIT_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
          await env.DB.prepare(stmt).run();
        }
        return json({ ok: true, message: 'Database initialized' });
      }

      // ── POSTS / PAGES ──────────────────────────────────────────────────────
      if (resource === 'posts') {
        return await handlePosts(request, env, method, id, sub, url);
      }

      // ── COMMENTS ──────────────────────────────────────────────────────────
      if (resource === 'comments') {
        return await handleComments(request, env, method, id, url);
      }

      // ── OPTIONS ───────────────────────────────────────────────────────────
      if (resource === 'options') {
        return await handleOptions(request, env, method, id);
      }

      // ── USERS META ────────────────────────────────────────────────────────
      if (resource === 'users_meta') {
        return await handleUsersMeta(request, env, method, id, sub);
      }

      // ── MEDIA META ────────────────────────────────────────────────────────
      if (resource === 'media_meta') {
        return await handleMediaMeta(request, env, method, id);
      }

      // ── KV: SESSION ───────────────────────────────────────────────────────
      if (resource === 'session') {
        return await handleKV(request, env, method, id, env.SESSION_KV, 'session:');
      }

      // ── KV: CACHE / TRANSIENT ─────────────────────────────────────────────
      if (resource === 'cache') {
        return await handleKV(request, env, method, id, env.CACHE_KV, 'cache:');
      }

      // ── KV: TRANSIENT (WordPress 호환) ────────────────────────────────────
      if (resource === 'transient') {
        return await handleKV(request, env, method, id, env.CACHE_KV, 'transient:');
      }

      return err('Unknown endpoint', 404);
    } catch (e) {
      return err(e.message, 500);
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  POSTS
// ══════════════════════════════════════════════════════════════════════════════
async function handlePosts(request, env, method, id, sub, url) {
  const db = env.DB;

  // GET /posts  or  GET /posts?type=page&status=publish&search=...&limit=20&offset=0
  if (method === 'GET' && !id) {
    const type   = url.searchParams.get('type')   || 'post';
    const status = url.searchParams.get('status') || 'publish';
    const search = url.searchParams.get('search') || '';
    const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '20'), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    let query  = 'SELECT * FROM posts WHERE post_type = ? AND status = ?';
    const args = [type, status];
    if (search) { query += ' AND (title LIKE ? OR content LIKE ?)'; args.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);

    const { results } = await db.prepare(query).bind(...args).all();
    const countQ = search
      ? 'SELECT COUNT(*) as c FROM posts WHERE post_type=? AND status=? AND (title LIKE ? OR content LIKE ?)'
      : 'SELECT COUNT(*) as c FROM posts WHERE post_type=? AND status=?';
    const countArgs = search ? [type, status, `%${search}%`, `%${search}%`] : [type, status];
    const { results: cRes } = await db.prepare(countQ).bind(...countArgs).all();
    return json({ posts: results, total: cRes[0].c, limit, offset });
  }

  // GET /posts/:id
  if (method === 'GET' && id && !sub) {
    const row = isNaN(id)
      ? await db.prepare('SELECT * FROM posts WHERE slug = ?').bind(id).first()
      : await db.prepare('SELECT * FROM posts WHERE id = ?').bind(parseInt(id)).first();
    if (!row) return err('Post not found', 404);
    return json(row);
  }

  // GET /posts/:id/meta
  if (method === 'GET' && id && sub === 'meta') {
    const row = await db.prepare('SELECT meta FROM posts WHERE id = ?').bind(parseInt(id)).first();
    if (!row) return err('Post not found', 404);
    return json(JSON.parse(row.meta || '{}'));
  }

  // POST /posts
  if (method === 'POST' && !id) {
    const body = await request.json();
    const { post_type='post', status='draft', title='', content='', excerpt='',
            slug='', author_id=1, parent_id=0, menu_order=0, meta={} } = body;
    const finalSlug = slug || slugify(title) || `post-${Date.now()}`;
    const { meta: _, lastRowId } = await db.prepare(
      `INSERT INTO posts (post_type,status,title,content,excerpt,slug,author_id,parent_id,menu_order,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(post_type, status, title, content, excerpt, finalSlug, author_id, parent_id, menu_order, JSON.stringify(meta)).run();
    const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(lastRowId).first();
    return json(row, 201);
  }

  // PUT /posts/:id
  if (method === 'PUT' && id) {
    const body = await request.json();
    const existing = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(parseInt(id)).first();
    if (!existing) return err('Post not found', 404);

    const merged = {
      post_type:  body.post_type  ?? existing.post_type,
      status:     body.status     ?? existing.status,
      title:      body.title      ?? existing.title,
      content:    body.content    ?? existing.content,
      excerpt:    body.excerpt    ?? existing.excerpt,
      slug:       body.slug       ?? existing.slug,
      author_id:  body.author_id  ?? existing.author_id,
      parent_id:  body.parent_id  ?? existing.parent_id,
      menu_order: body.menu_order ?? existing.menu_order,
      meta:       JSON.stringify({ ...JSON.parse(existing.meta || '{}'), ...(body.meta || {}) }),
    };

    await db.prepare(
      `UPDATE posts SET post_type=?,status=?,title=?,content=?,excerpt=?,slug=?,
       author_id=?,parent_id=?,menu_order=?,meta=?,updated_at=datetime('now') WHERE id=?`
    ).bind(...Object.values(merged), parseInt(id)).run();
    const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(parseInt(id)).first();
    return json(row);
  }

  // DELETE /posts/:id
  if (method === 'DELETE' && id) {
    const { changes } = await db.prepare('DELETE FROM posts WHERE id = ?').bind(parseInt(id)).run();
    if (!changes) return err('Post not found', 404);
    return json({ ok: true, deleted_id: parseInt(id) });
  }

  return err('Method not allowed', 405);
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMMENTS
// ══════════════════════════════════════════════════════════════════════════════
async function handleComments(request, env, method, id, url) {
  const db = env.DB;

  if (method === 'GET' && !id) {
    const post_id = url.searchParams.get('post_id');
    const status  = url.searchParams.get('status') || 'approve';
    const limit   = Math.min(parseInt(url.searchParams.get('limit')  || '50'), 200);
    const offset  = parseInt(url.searchParams.get('offset') || '0');

    let query = 'SELECT * FROM comments WHERE status = ?';
    const args = [status];
    if (post_id) { query += ' AND post_id = ?'; args.push(parseInt(post_id)); }
    query += ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    const { results } = await db.prepare(query).bind(...args).all();
    return json({ comments: results });
  }

  if (method === 'GET' && id) {
    const row = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(parseInt(id)).first();
    if (!row) return err('Comment not found', 404);
    return json(row);
  }

  if (method === 'POST' && !id) {
    const body = await request.json();
    const { post_id, parent_id=0, author='', email='', url:cUrl='', content='', status='pending', user_id=0, meta={} } = body;
    if (!post_id) return err('post_id required');
    const { lastRowId } = await db.prepare(
      `INSERT INTO comments (post_id,parent_id,author,email,url,content,status,user_id,meta)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(post_id, parent_id, author, email, cUrl, content, status, user_id, JSON.stringify(meta)).run();
    const row = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(lastRowId).first();
    return json(row, 201);
  }

  if (method === 'PUT' && id) {
    const body = await request.json();
    const existing = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(parseInt(id)).first();
    if (!existing) return err('Comment not found', 404);
    const merged = {
      author:  body.author  ?? existing.author,
      email:   body.email   ?? existing.email,
      url:     body.url     ?? existing.url,
      content: body.content ?? existing.content,
      status:  body.status  ?? existing.status,
      meta:    JSON.stringify({ ...JSON.parse(existing.meta || '{}'), ...(body.meta || {}) }),
    };
    await db.prepare(
      `UPDATE comments SET author=?,email=?,url=?,content=?,status=?,meta=? WHERE id=?`
    ).bind(merged.author, merged.email, merged.url, merged.content, merged.status, merged.meta, parseInt(id)).run();
    const row = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(parseInt(id)).first();
    return json(row);
  }

  if (method === 'DELETE' && id) {
    const { changes } = await db.prepare('DELETE FROM comments WHERE id = ?').bind(parseInt(id)).run();
    if (!changes) return err('Comment not found', 404);
    return json({ ok: true, deleted_id: parseInt(id) });
  }

  return err('Method not allowed', 405);
}

// ══════════════════════════════════════════════════════════════════════════════
//  OPTIONS
// ══════════════════════════════════════════════════════════════════════════════
async function handleOptions(request, env, method, name) {
  const db = env.DB;

  if (method === 'GET' && !name) {
    const autoload = request.url.includes('autoload=1') ? 1 : null;
    let q = 'SELECT * FROM options';
    if (autoload !== null) q += ' WHERE autoload = 1';
    const { results } = await db.prepare(q).all();
    return json(results);
  }

  if (method === 'GET' && name) {
    const row = await db.prepare('SELECT * FROM options WHERE option_name = ?').bind(name).first();
    if (!row) return err('Option not found', 404);
    return json(row);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { option_name, option_value, autoload=1 } = body;
    if (!option_name) return err('option_name required');
    await db.prepare(
      `INSERT INTO options (option_name, option_value, autoload) VALUES (?,?,?)
       ON CONFLICT(option_name) DO UPDATE SET option_value=excluded.option_value, autoload=excluded.autoload`
    ).bind(option_name, String(option_value ?? ''), autoload ? 1 : 0).run();
    return json({ ok: true, option_name });
  }

  if (method === 'PUT' && name) {
    const body = await request.json();
    const { option_value, autoload } = body;
    const existing = await db.prepare('SELECT * FROM options WHERE option_name = ?').bind(name).first();
    if (!existing) return err('Option not found', 404);
    await db.prepare(
      `UPDATE options SET option_value=?, autoload=? WHERE option_name=?`
    ).bind(String(option_value ?? existing.option_value), autoload ?? existing.autoload, name).run();
    return json({ ok: true, option_name: name });
  }

  if (method === 'DELETE' && name) {
    await db.prepare('DELETE FROM options WHERE option_name = ?').bind(name).run();
    return json({ ok: true, deleted: name });
  }

  // Bulk GET by names  POST /options/bulk
  if (method === 'POST' && name === 'bulk') {
    const body = await request.json();
    const names = body.names || [];
    if (!names.length) return json([]);
    const placeholders = names.map(() => '?').join(',');
    const { results } = await db.prepare(
      `SELECT * FROM options WHERE option_name IN (${placeholders})`
    ).bind(...names).all();
    return json(results);
  }

  return err('Method not allowed', 405);
}

// ══════════════════════════════════════════════════════════════════════════════
//  USERS META
// ══════════════════════════════════════════════════════════════════════════════
async function handleUsersMeta(request, env, method, user_id, meta_key) {
  const db = env.DB;

  if (method === 'GET' && user_id && !meta_key) {
    const { results } = await db.prepare(
      'SELECT * FROM users_meta WHERE user_id = ?'
    ).bind(parseInt(user_id)).all();
    return json(results);
  }

  if (method === 'GET' && user_id && meta_key) {
    const row = await db.prepare(
      'SELECT * FROM users_meta WHERE user_id = ? AND meta_key = ?'
    ).bind(parseInt(user_id), meta_key).first();
    if (!row) return err('Meta not found', 404);
    return json(row);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { user_id: uid, meta_key: key, meta_value: val } = body;
    if (!uid || !key) return err('user_id and meta_key required');
    await db.prepare(
      `INSERT INTO users_meta (user_id, meta_key, meta_value) VALUES (?,?,?)
       ON CONFLICT(user_id, meta_key) DO UPDATE SET meta_value=excluded.meta_value`
    ).bind(parseInt(uid), key, String(val ?? '')).run();
    return json({ ok: true });
  }

  if (method === 'DELETE' && user_id && meta_key) {
    await db.prepare(
      'DELETE FROM users_meta WHERE user_id = ? AND meta_key = ?'
    ).bind(parseInt(user_id), meta_key).run();
    return json({ ok: true });
  }

  return err('Method not allowed', 405);
}

// ══════════════════════════════════════════════════════════════════════════════
//  MEDIA META
// ══════════════════════════════════════════════════════════════════════════════
async function handleMediaMeta(request, env, method, attachment_id) {
  const db = env.DB;

  if (method === 'GET' && !attachment_id) {
    const { results } = await db.prepare('SELECT * FROM media_meta ORDER BY created_at DESC LIMIT 200').all();
    return json(results);
  }

  if (method === 'GET' && attachment_id) {
    const row = await db.prepare(
      'SELECT * FROM media_meta WHERE attachment_id = ?'
    ).bind(parseInt(attachment_id)).first();
    if (!row) return err('Media not found', 404);
    return json(row);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { attachment_id: aid, url='', filename='', mime_type='', file_size=0,
            width=0, height=0, alt_text='', caption='', meta={} } = body;
    if (!aid) return err('attachment_id required');
    await db.prepare(
      `INSERT INTO media_meta (attachment_id,url,filename,mime_type,file_size,width,height,alt_text,caption,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(attachment_id) DO UPDATE SET url=excluded.url,filename=excluded.filename,
         mime_type=excluded.mime_type,file_size=excluded.file_size,width=excluded.width,
         height=excluded.height,alt_text=excluded.alt_text,caption=excluded.caption,meta=excluded.meta`
    ).bind(parseInt(aid), url, filename, mime_type, file_size, width, height, alt_text, caption, JSON.stringify(meta)).run();
    return json({ ok: true, attachment_id: aid });
  }

  if (method === 'DELETE' && attachment_id) {
    await db.prepare('DELETE FROM media_meta WHERE attachment_id = ?').bind(parseInt(attachment_id)).run();
    return json({ ok: true });
  }

  return err('Method not allowed', 405);
}

// ══════════════════════════════════════════════════════════════════════════════
//  KV (SESSION / CACHE / TRANSIENT)
// ══════════════════════════════════════════════════════════════════════════════
async function handleKV(request, env, method, key, kvNS, prefix) {
  if (!kvNS) return err('KV namespace not bound', 500);

  if (method === 'GET' && key) {
    const val = await kvNS.get(prefix + key);
    if (val === null) return err('Key not found', 404);
    try { return json(JSON.parse(val)); } catch { return json({ value: val }); }
  }

  if (method === 'POST' || method === 'PUT') {
    const body = await request.json();
    const { value, ttl } = body;
    if (value === undefined) return err('value required');
    const opts = ttl ? { expirationTtl: parseInt(ttl) } : {};
    await kvNS.put(prefix + key, typeof value === 'string' ? value : JSON.stringify(value), opts);
    return json({ ok: true, key });
  }

  if (method === 'DELETE' && key) {
    await kvNS.delete(prefix + key);
    return json({ ok: true, key });
  }

  // GET /session (list — limited)
  if (method === 'GET' && !key) {
    const list = await kvNS.list({ prefix });
    return json({ keys: list.keys.map(k => k.name.replace(prefix, '')) });
  }

  return err('Method not allowed', 405);
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function slugify(text = '') {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 200);
}
