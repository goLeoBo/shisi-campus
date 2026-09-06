'use strict';

const { db, now } = require('./db');
const auth = require('./auth');

const POST_MAX = 500; // 动态最大字数
const MSG_MAX = 2000; // 私信最大字数
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

// ---------- 通用小工具 ----------

function avatarOf(user) {
  const name = (user && (user.display_name || user.displayName)) || '?';
  const char = Array.from(name)[0] || '?';
  const key = (user && (user.username || user.display_name)) || 'x';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { char, color: `hsl(${hue}, 62%, 52%)` };
}

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio || '',
    createdAt: u.created_at,
    avatar: avatarOf(u),
    avatarUrl: u.avatar_url || null,
  };
}

function publicUserById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? toPublicUser(row) : null;
}

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function toPublicPost(row, me) {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    likeCount: row.like_count || 0,
    likedByMe: !!row.liked,
    mine: me ? row.user_id === me.id : false,
    author: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio || '',
      avatar: avatarOf(row),
    },
  };
}

const POST_SELECT = `
  SELECT p.id, p.content, p.created_at, p.user_id,
         u.username, u.display_name, u.bio,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
         EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?) AS liked
  FROM posts p
  JOIN users u ON u.id = p.user_id
`;

function loadPosts(whereClause, params, me, limit) {
  const rows = db
    .prepare(`${POST_SELECT} ${whereClause} ORDER BY p.id DESC LIMIT ?`)
    .all(me ? me.id : -1, ...params, limit);
  return rows.map((r) => toPublicPost(r, me));
}

function likeCount(postId) {
  return db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(postId).c;
}

// ---------- 好友系统辅助 ----------
function friendshipExists(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return !!db
    .prepare('SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ?')
    .get(lo, hi);
}

function addFriendship(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  db.prepare(
    'INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)'
  ).run(lo, hi, now());
}

function friendStatusOf(meId, otherId) {
  if (friendshipExists(meId, otherId)) return 'friends';
  if (
    db
      .prepare(
        "SELECT 1 FROM friend_requests WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
      )
      .get(meId, otherId)
  ) {
    return 'pending_out';
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM friend_requests WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
      )
      .get(otherId, meId)
  ) {
    return 'pending_in';
  }
  return 'none';
}

function friendCountOf(id) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM friendships WHERE user_low = ? OR user_high = ?')
    .get(id, id).c;
}

// ---------- 业务处理 ----------

function registerApi(router) {
  // ---- 认证 ----
  router.get('/api/me', (ctx) => {
    ctx.json(200, { user: ctx.user ? toPublicUser(ctx.user) : null });
  });

  router.post('/api/me/avatar', (ctx) => {
    if (!ctx.requireUser()) return;
    const parts = ctx.body._multipart;
    if (!parts || parts.length === 0) return ctx.json(400, { error: '请上传图片文件' });
    const filePart = parts.find(p => p.filename);
    if (!filePart) return ctx.json(400, { error: '请选择头像图片文件' });
    const allowedTypes = ['image/png','image/jpeg','image/jpg','image/webp','image/avif','image/gif'];
    if (!allowedTypes.includes(filePart.contentType)) return ctx.json(400, { error: '只支持 PNG / JPEG / WebP / AVIF / GIF 格式' });
    if (filePart.data.length > 2 * 1024 * 1024) return ctx.json(400, { error: '图片不能超过 2MB' });
    const extMap = { 'image/png': '.png','image/jpeg': '.jpg','image/jpg': '.jpg','image/webp': '.webp','image/avif': '.avif','image/gif': '.gif' };
    const ext = extMap[filePart.contentType] || '.png';
    const filename = 'avatar_' + ctx.user.id + '_' + crypto.randomBytes(4).toString('hex') + ext;
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, filename), filePart.data);
    const avatarUrl = '/uploads/' + filename;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, ctx.user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    ctx.json(200, { user: toPublicUser(updated) });
  });

  router.post('/api/register', (ctx) => {
    const username = String(ctx.body.username || '').trim();
    const displayName = String(ctx.body.displayName || '').trim();
    const password = String(ctx.body.password || '');

    if (!USERNAME_RE.test(username)) {
      return ctx.json(400, { error: '用户名需为 2-20 位的中文、字母、数字或下划线' });
    }
    if (displayName.length < 1 || displayName.length > 24) {
      return ctx.json(400, { error: '昵称长度需为 1-24 个字符' });
    }
    if (password.length < 6 || password.length > 72) {
      return ctx.json(400, { error: '密码长度需为 6-72 位' });
    }
    if (findUserByUsername(username)) {
      return ctx.json(409, { error: '该用户名已被注册' });
    }

    const salt = auth.newSalt();
    const passwordHash = auth.hashPassword(password, salt);
    const createdAt = now();
    const info = db
      .prepare(
        'INSERT INTO users (username, display_name, bio, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(username, displayName, '', passwordHash, salt, createdAt);
    const userId = Number(info.lastInsertRowid);
    const token = auth.createSession(userId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    ctx.res.setHeader('Set-Cookie', auth.buildSessionCookie(token));
    ctx.json(200, { user: toPublicUser(user) });
  });

  router.post('/api/login', (ctx) => {
    const username = String(ctx.body.username || '').trim();
    const password = String(ctx.body.password || '');
    const user = findUserByUsername(username);
    if (!user || !auth.verifyPassword(password, user.salt, user.password_hash)) {
      return ctx.json(401, { error: '用户名或密码错误' });
    }
    const token = auth.createSession(user.id);
    ctx.res.setHeader('Set-Cookie', auth.buildSessionCookie(token));
    ctx.json(200, { user: toPublicUser(user) });
  });

  router.post('/api/logout', (ctx) => {
    if (ctx.token) auth.deleteSession(ctx.token);
    ctx.res.setHeader('Set-Cookie', auth.clearSessionCookie());
    ctx.json(200, { ok: true });
  });

  // ---- 用户 ----
  router.get('/api/users', (ctx) => {
    if (!ctx.requireUser()) return;
    const q = String(ctx.query.get('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(ctx.query.get('limit') || '8', 10) || 8, 1), 20);
    let rows;
    if (q) {
      rows = db
        .prepare(
          `SELECT * FROM users WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) ORDER BY id LIMIT ?`
        )
        .all(ctx.user.id, `%${q}%`, `%${q}%`, limit);
    } else {
      rows = db
        .prepare(
          `SELECT u.* FROM users u
           WHERE u.id != ? AND NOT EXISTS (
             SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = u.id
           )
           ORDER BY u.id LIMIT ?`
        )
        .all(ctx.user.id, ctx.user.id, limit);
    }
    ctx.json(200, {
      users: rows.map((u) => ({
        ...toPublicUser(u),
        isFollowing: !!db
          .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?')
          .get(ctx.user.id, u.id),
        friendStatus: u.id === ctx.user.id ? null : friendStatusOf(ctx.user.id, u.id),
      })),
    });
  });

  router.get('/api/users/:username', (ctx) => {
    if (!ctx.requireUser()) return;
    const target = findUserByUsername(ctx.params.username);
    if (!target) return ctx.json(404, { error: '用户不存在' });
    const stats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
           (SELECT COUNT(*) FROM follows WHERE followee_id = ?) AS follower_count,
           (SELECT COUNT(*) FROM posts WHERE user_id = ?) AS post_count,
           (SELECT COUNT(*) FROM friendships WHERE user_low = ? OR user_high = ?) AS friend_count`
      )
      .get(target.id, target.id, target.id, target.id, target.id);
    const isFollowing = !!db
      .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?')
      .get(ctx.user.id, target.id);
    ctx.json(200, {
      user: toPublicUser(target),
      stats: {
        followingCount: stats.following_count,
        followerCount: stats.follower_count,
        postCount: stats.post_count,
        friendCount: stats.friend_count,
      },
      isSelf: target.id === ctx.user.id,
      isFollowing,
      friendStatus: target.id === ctx.user.id ? null : friendStatusOf(ctx.user.id, target.id),
    });
  });

  router.get('/api/users/:username/posts', (ctx) => {
    if (!ctx.requireUser()) return;
    const target = findUserByUsername(ctx.params.username);
    if (!target) return ctx.json(404, { error: '用户不存在' });
    const beforeId = parseInt(ctx.query.get('beforeId') || '0', 10) || 0;
    const limit = Math.min(Math.max(parseInt(ctx.query.get('limit') || '20', 10) || 20, 1), 50);
    const posts = loadPosts(
      'WHERE p.user_id = ? AND p.id < ?',
      [target.id, beforeId || 2147483647],
      ctx.user,
      limit
    );
    ctx.json(200, { posts });
  });

  router.post('/api/users/:username/follow', (ctx) => {
    if (!ctx.requireUser()) return;
    const target = findUserByUsername(ctx.params.username);
    if (!target) return ctx.json(404, { error: '用户不存在' });
    if (target.id === ctx.user.id) return ctx.json(400, { error: '不能关注自己' });
    db.prepare(
      'INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)'
    ).run(ctx.user.id, target.id, now());
    ctx.json(200, { following: true });
  });

  router.delete('/api/users/:username/follow', (ctx) => {
    if (!ctx.requireUser()) return;
    const target = findUserByUsername(ctx.params.username);
    if (!target) return ctx.json(404, { error: '用户不存在' });
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(
      ctx.user.id,
      target.id
    );
    ctx.json(200, { following: false });
  });

  // ---- 动态 ----
  router.get('/api/posts', (ctx) => {
    if (!ctx.requireUser()) return;
    const tab = ctx.query.get('tab') === 'following' ? 'following' : 'latest';
    const beforeId = parseInt(ctx.query.get('beforeId') || '0', 10) || 0;
    const limit = Math.min(Math.max(parseInt(ctx.query.get('limit') || '20', 10) || 20, 1), 50);
    const maxId = beforeId || 2147483647;
    let whereClause = '';
    let params = [];
    if (tab === 'following') {
      whereClause = `WHERE (p.user_id = ? OR p.user_id IN (
          SELECT followee_id FROM follows WHERE follower_id = ?
        )) AND p.id < ?`;
      params = [ctx.user.id, ctx.user.id, maxId];
    } else {
      whereClause = 'WHERE p.id < ?';
      params = [maxId];
    }
    const posts = loadPosts(whereClause, params, ctx.user, limit);
    ctx.json(200, { posts, tab });
  });

  router.post('/api/posts', (ctx) => {
    if (!ctx.requireUser()) return;
    const content = String(ctx.body.content || '').trim();
    if (!content) return ctx.json(400, { error: '动态内容不能为空' });
    if (content.length > POST_MAX) {
      return ctx.json(400, { error: `动态最多 ${POST_MAX} 字` });
    }
    const info = db
      .prepare('INSERT INTO posts (user_id, content, created_at) VALUES (?, ?, ?)')
      .run(ctx.user.id, content, now());
    const row = db
      .prepare(
        `SELECT p.id, p.content, p.created_at, p.user_id,
                u.username, u.display_name, u.bio,
                0 AS like_count, 0 AS liked
         FROM posts p JOIN users u ON u.id = p.user_id
         WHERE p.id = ?`
      )
      .get(Number(info.lastInsertRowid));
    ctx.json(200, { post: toPublicPost(row, ctx.user) });
  });

  router.delete('/api/posts/:id', (ctx) => {
    if (!ctx.requireUser()) return;
    const id = parseInt(ctx.params.id, 10);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!post) return ctx.json(404, { error: '动态不存在' });
    if (post.user_id !== ctx.user.id) return ctx.json(403, { error: '只能删除自己的动态' });
    db.prepare('DELETE FROM posts WHERE id = ?').run(id);
    ctx.json(200, { ok: true });
  });

  router.post('/api/posts/:id/like', (ctx) => {
    if (!ctx.requireUser()) return;
    const id = parseInt(ctx.params.id, 10);
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(id);
    if (!post) return ctx.json(404, { error: '动态不存在' });
    db.prepare(
      'INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)'
    ).run(ctx.user.id, id, now());
    ctx.json(200, { liked: true, likeCount: likeCount(id) });
  });

  router.delete('/api/posts/:id/like', (ctx) => {
    if (!ctx.requireUser()) return;
    const id = parseInt(ctx.params.id, 10);
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(id);
    if (!post) return ctx.json(404, { error: '动态不存在' });
    db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(ctx.user.id, id);
    ctx.json(200, { liked: false, likeCount: likeCount(id) });
  });

  // ---- 私信 ----
  // 会话视图（带对方信息、最后一条消息、未读数）
  function conversationView(conv, me) {
    const otherId = conv.user_a === me.id ? conv.user_b : conv.user_a;
    const other = publicUserById(otherId);
    const last = db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'
      )
      .get(conv.id);
    const unread = db
      .prepare(
        'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_flag = 0'
      )
      .get(conv.id, me.id).c;
    return {
      id: conv.id,
      other,
      lastMessage: last
        ? {
            id: last.id,
            content: last.content,
            createdAt: last.created_at,
            fromMe: last.sender_id === me.id,
          }
        : null,
      unread,
    };
  }

  function getOrCreateConversation(a, b) {
    const userA = Math.min(a, b);
    const userB = Math.max(a, b);
    let conv = db
      .prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?')
      .get(userA, userB);
    if (!conv) {
      const info = db
        .prepare('INSERT INTO conversations (user_a, user_b, created_at) VALUES (?, ?, ?)')
        .run(userA, userB, now());
      conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(info.lastInsertRowid));
    }
    return conv;
  }

  router.get('/api/conversations', (ctx) => {
    if (!ctx.requireUser()) return;
    const rows = db
      .prepare('SELECT * FROM conversations WHERE user_a = ? OR user_b = ? ORDER BY id DESC')
      .all(ctx.user.id, ctx.user.id);
    const list = rows
      .map((c) => conversationView(c, ctx.user))
      .sort((x, y) => {
        const tx = x.lastMessage ? x.lastMessage.createdAt : 0;
        const ty = y.lastMessage ? y.lastMessage.createdAt : 0;
        return ty - tx;
      });
    ctx.json(200, { conversations: list });
  });

  router.post('/api/conversations', (ctx) => {
    if (!ctx.requireUser()) return;
    const otherId = parseInt(ctx.body.userId, 10);
    if (!otherId || otherId === ctx.user.id) {
      return ctx.json(400, { error: '不能和自己私信' });
    }
    const other = db.prepare('SELECT id FROM users WHERE id = ?').get(otherId);
    if (!other) return ctx.json(404, { error: '用户不存在' });
    const conv = getOrCreateConversation(ctx.user.id, otherId);
    const messages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 100')
      .all(conv.id);
    // 打开即已读
    db.prepare(
      'UPDATE messages SET read_flag = 1 WHERE conversation_id = ? AND sender_id != ?'
    ).run(conv.id, ctx.user.id);
    ctx.json(200, {
      conversation: conversationView(conv, ctx.user),
      messages: messages.map((m) => messageView(m, ctx.user)),
    });
  });

  function messageView(m, me) {
    return {
      id: m.id,
      content: m.content,
      createdAt: m.created_at,
      fromMe: m.sender_id === me.id,
    };
  }

  function getMyConversation(id, me) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv) return null;
    if (conv.user_a !== me.id && conv.user_b !== me.id) return null;
    return conv;
  }

  router.get('/api/conversations/:id/messages', (ctx) => {
    if (!ctx.requireUser()) return;
    const id = parseInt(ctx.params.id, 10);
    const conv = getMyConversation(id, ctx.user);
    if (!conv) return ctx.json(404, { error: '会话不存在' });
    const afterId = parseInt(ctx.query.get('afterId') || '0', 10) || 0;
    const rows = db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 200'
      )
      .all(id, afterId);
    ctx.json(200, { messages: rows.map((m) => messageView(m, ctx.user)) });
  });

  router.post('/api/conversations/:id/messages', (ctx) => {
    if (!ctx.requireUser()) return;
    const id = parseInt(ctx.params.id, 10);
    const conv = getMyConversation(id, ctx.user);
    if (!conv) return ctx.json(404, { error: '会话不存在' });
    const content = String(ctx.body.content || '').trim();
    if (!content) return ctx.json(400, { error: '消息内容不能为空' });
    if (content.length > MSG_MAX) return ctx.json(400, { error: `消息最多 ${MSG_MAX} 字` });
    const info = db
      .prepare(
        'INSERT INTO messages (conversation_id, sender_id, content, created_at, read_flag) VALUES (?, ?, ?, ?, 0)'
      )
      .run(id, ctx.user.id, content, now());
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
    ctx.json(200, { message: messageView(m, ctx.user) });
  });

  router.post('/api/conversations/:id/read', (ctx) => {
    if (!ctx.requireUser()) return;
    const id = parseInt(ctx.params.id, 10);
    const conv = getMyConversation(id, ctx.user);
    if (!conv) return ctx.json(404, { error: '会话不存在' });
    db.prepare(
      'UPDATE messages SET read_flag = 1 WHERE conversation_id = ? AND sender_id != ?'
    ).run(id, ctx.user.id);
    ctx.json(200, { ok: true });
  });
}

// ==================== 好友系统 API ====================
function registerFriendApi(router) {
  // 发送好友申请（若对方已向你发出申请，则直接互为好友）
  router.post('/api/users/:username/friend-request', (ctx) => {
    if (!ctx.requireUser()) return;
    const target = findUserByUsername(ctx.params.username);
    if (!target) return ctx.json(404, { error: '用户不存在' });
    if (target.id === ctx.user.id) return ctx.json(400, { error: '不能添加自己为好友' });
    if (friendshipExists(ctx.user.id, target.id)) return ctx.json(200, { status: 'friends' });

    const incoming = db
      .prepare(
        "SELECT id FROM friend_requests WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
      )
      .get(target.id, ctx.user.id);
    if (incoming) {
      db.prepare("UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?").run(
        now(),
        incoming.id
      );
      addFriendship(ctx.user.id, target.id);
      return ctx.json(200, { status: 'friends' });
    }

    const existing = db
      .prepare(
        "SELECT id FROM friend_requests WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
      )
      .get(ctx.user.id, target.id);
    if (existing) return ctx.json(200, { status: 'pending' });

    db.prepare(
      "INSERT INTO friend_requests (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)"
    ).run(ctx.user.id, target.id, now());
    ctx.json(200, { status: 'pending' });
  });

  // 好友申请列表：收到的 + 发出的（仅待处理）
  router.get('/api/friend-requests', (ctx) => {
    if (!ctx.requireUser()) return;
    const incoming = db
      .prepare(
        `SELECT r.id AS request_id, r.created_at, u.* FROM friend_requests r
         JOIN users u ON u.id = r.requester_id
         WHERE r.addressee_id = ? AND r.status = 'pending'
         ORDER BY r.id DESC`
      )
      .all(ctx.user.id);
    const outgoing = db
      .prepare(
        `SELECT r.id AS request_id, r.created_at, u.* FROM friend_requests r
         JOIN users u ON u.id = r.addressee_id
         WHERE r.requester_id = ? AND r.status = 'pending'
         ORDER BY r.id DESC`
      )
      .all(ctx.user.id);
    const map = (rows) =>
      rows.map((r) => ({ id: r.request_id, createdAt: r.created_at, user: toPublicUser(r) }));
    ctx.json(200, { incoming: map(incoming), outgoing: map(outgoing) });
  });

  // 同意好友申请
  router.post('/api/friend-requests/:id/accept', (ctx) => {
    if (!ctx.requireUser()) return;
    const req = db
      .prepare('SELECT * FROM friend_requests WHERE id = ?')
      .get(parseInt(ctx.params.id, 10));
    if (!req) return ctx.json(404, { error: '申请不存在' });
    if (req.addressee_id !== ctx.user.id) return ctx.json(403, { error: '无权操作该申请' });
    if (req.status !== 'pending') return ctx.json(400, { error: '该申请已处理过了' });
    db.prepare("UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?").run(
      now(),
      req.id
    );
    addFriendship(req.requester_id, req.addressee_id);
    ctx.json(200, { ok: true });
  });

  // 拒绝好友申请
  router.post('/api/friend-requests/:id/reject', (ctx) => {
    if (!ctx.requireUser()) return;
    const req = db
      .prepare('SELECT * FROM friend_requests WHERE id = ?')
      .get(parseInt(ctx.params.id, 10));
    if (!req) return ctx.json(404, { error: '申请不存在' });
    if (req.addressee_id !== ctx.user.id) return ctx.json(403, { error: '无权操作该申请' });
    if (req.status !== 'pending') return ctx.json(400, { error: '该申请已处理过了' });
    db.prepare("UPDATE friend_requests SET status = 'rejected', responded_at = ? WHERE id = ?").run(
      now(),
      req.id
    );
    ctx.json(200, { ok: true });
  });

  // 撤销自己发出的申请
  router.delete('/api/friend-requests/:id', (ctx) => {
    if (!ctx.requireUser()) return;
    const req = db
      .prepare('SELECT * FROM friend_requests WHERE id = ?')
      .get(parseInt(ctx.params.id, 10));
    if (!req) return ctx.json(404, { error: '申请不存在' });
    if (req.requester_id !== ctx.user.id) return ctx.json(403, { error: '无权操作该申请' });
    db.prepare('DELETE FROM friend_requests WHERE id = ?').run(req.id);
    ctx.json(200, { ok: true });
  });

  // 好友列表
  router.get('/api/friends', (ctx) => {
    if (!ctx.requireUser()) return;
    const rows = db
      .prepare(
        `SELECT u.*, f.created_at AS friend_since
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
         WHERE f.user_low = ? OR f.user_high = ?
         ORDER BY f.created_at DESC`
      )
      .all(ctx.user.id, ctx.user.id, ctx.user.id);
    ctx.json(
      200,
      { friends: rows.map((r) => ({ ...toPublicUser(r), friendSince: r.friend_since })) }
    );
  });

  // 删除好友
  router.delete('/api/friends/:userId', (ctx) => {
    if (!ctx.requireUser()) return;
    const otherId = parseInt(ctx.params.userId, 10);
    if (!otherId || otherId === ctx.user.id) return ctx.json(400, { error: '参数错误' });
    const info = db
      .prepare('DELETE FROM friendships WHERE user_low = ? AND user_high = ?')
      .run(Math.min(ctx.user.id, otherId), Math.max(ctx.user.id, otherId));
    if (!info.changes) return ctx.json(404, { error: '你们还不是好友' });
    ctx.json(200, { ok: true });
  });
}

module.exports = { registerApi, registerFriendApi, avatarOf, POST_MAX, MSG_MAX };
