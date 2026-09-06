'use strict';

/* ============ 全局状态 ============ */
const state = {
  me: null,          // 当前登录用户
  feedTab: 'latest', // 首页时间线 tab
  feedBefore: 0,     // 首页分页游标
  profile: null,     // 当前浏览的用户资料
  profileBefore: 0,
  search: '',
  convs: [],         // 会话列表缓存
  chat: null,        // 当前会话 { id, other, messages }
  friendReq: null,   // 好友申请缓存 {incoming, outgoing}
  friends: [],       // 好友列表缓存
  timers: {},        // 定时器
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ============ 小工具 ============ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function linkify(s) {
  return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function pad(n) { return String(n).padStart(2, '0'); }

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function fullTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtCount(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(n);
}

function avatarHTML(user, size = '') {
  if (user && user.avatarUrl) {
    return `<span class="avatar ${size}"><img src="${esc(user.avatarUrl)}" alt="" loading="lazy" /></span>`;
  }
  const a = (user && user.avatar) || { char: '?', color: '#888' };
  return `<span class="avatar ${size}" style="background:${a.color}">${esc(a.char)}</span>`;
}

async function uploadAvatar(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast('图片不能超过 2MB');
    return;
  }
  const fd = new FormData();
  fd.append('avatar', file, file.name);
  let res;
  try {
    res = await fetch('/api/me/avatar', { method: 'POST', body: fd });
  } catch (e) {
    toast('上传失败，请检查网络');
    return;
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    toast((data && data.error) || '上传失败');
    return;
  }
  state.me = data.user;
  toast('头像已更新 ✨', 'ok');
  route();
}

function toast(msg, type = 'error') {
  const wrap = $('#toast-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

/* ============ 路由 ============ */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const name = parts[0] || 'home';
  return { name, parts };
}

function go(path) {
  if (location.hash === `#/${path}`) route();
  else location.hash = `#/${path}`;
}

function clearTimers() {
  Object.values(state.timers).forEach((t) => clearInterval(t));
  state.timers = {};
}

/* 好友关系文案 */
function friendActionHTML(user, mini = false) {
  const enc = encodeURIComponent(user.username);
  const cls = mini ? 'btn tiny ' : 'btn ';
  switch (user.friendStatus) {
    case 'friends':
      return `<button class="${cls}is-friend" data-action="remove-friend" data-id="${user.id}" title="删除好友">✓ 好友</button>`;
    case 'pending_out':
      return `<button class="${cls}waiting" disabled>⏳ 待验证</button>`;
    case 'pending_in':
      return `<button class="${cls}primary" data-action="add-friend" data-username="${enc}" title="对方申请加你为好友，点击即可通过">✅ 接受</button>`;
    default:
      return `<button class="${cls}primary" data-action="add-friend" data-username="${enc}">＋ 加好友</button>`;
  }
}

/* ============ 全局事件（事件委托） ============ */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  try {
    if (act === 'like-post') {
      await post(`/api/posts/${el.dataset.id}/like`);
      refreshVisiblePost(el.dataset.id);
    } else if (act === 'unlike-post') {
      await del(`/api/posts/${el.dataset.id}/like`);
      refreshVisiblePost(el.dataset.id);
    } else if (act === 'delete-post') {
      if (!confirm('确定要删除这条动态吗？')) return;
      await del(`/api/posts/${el.dataset.id}`);
      toast('已删除', 'ok');
      route();
    } else if (act === 'follow') {
      const u = el.dataset.username;
      await post(`/api/users/${encodeURIComponent(u)}/follow`);
      toast(`已关注 @${u}`, 'ok');
      route();
    } else if (act === 'unfollow') {
      const u = el.dataset.username;
      await del(`/api/users/${encodeURIComponent(u)}/follow`);
      toast('已取消关注', 'ok');
      route();
    } else if (act === 'add-friend') {
      const u = el.dataset.username;
      const d = await post(`/api/users/${encodeURIComponent(u)}/friend-request`);
      if (d.status === 'friends') toast('你们已成为好友啦！🎉', 'ok');
      else toast(`已向 @${u} 发送好友申请`, 'ok');
      await route();
    } else if (act === 'accept-friend') {
      await post(`/api/friend-requests/${el.dataset.id}/accept`);
      toast('已同意，你们现在是好友啦！🎉', 'ok');
      await route();
    } else if (act === 'reject-friend') {
      await post(`/api/friend-requests/${el.dataset.id}/reject`);
      toast('已拒绝该申请');
      await route();
    } else if (act === 'cancel-friend') {
      await del(`/api/friend-requests/${el.dataset.id}`);
      toast('已撤销申请', 'ok');
      await route();
    } else if (act === 'remove-friend') {
      if (!confirm('确定要删除这位好友吗？')) return;
      await del(`/api/friends/${el.dataset.id}`);
      toast('已删除好友', 'ok');
      await route();
    } else if (act === 'open-chat') {
      await openConversation(Number(el.dataset.id));
    } else if (act === 'load-more') {
      const target = el.dataset.target;
      if (target === 'feed') await appendFeed();
      else if (target === 'profile') await appendProfilePosts();
    } else if (act === 'back') {
      history.back();
    } else if (act === 'logout') {
      await post('/api/logout');
      state.me = null;
      clearTimers();
      toast('已退出登录', 'ok');
      location.hash = '#/auth';
      route();
    } else if (act === 'auth-tab') {
      setAuthTab(el.dataset.tab);
    } else if (act === 'search') {
      await runSearch();
    }
  } catch (err) {
    if (err.status === 401) {
      state.me = null;
      toast('登录已过期，请重新登录');
      location.hash = '#/auth';
      route();
    } else {
      toast(err.message || '操作失败');
    }
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.action === 'upload-avatar' && t.files && t.files[0]) {
    await uploadAvatar(t.files[0]);
    t.value = '';
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'composer-form') {
    e.preventDefault();
    await submitPost();
  } else if (form.id === 'auth-form') {
    e.preventDefault();
    await submitAuth();
  } else if (form.id === 'chat-form') {
    e.preventDefault();
    await submitMessage();
  } else if (form.id === 'search-form') {
    e.preventDefault();
    await runSearch();
  }
});

/* 刷新某条帖子的点赞状态（局部更新，不整页重载） */
async function refreshVisiblePost(id) {
  try {
    const d = await get(`/api/posts?tab=${state.feedTab}&beforeId=0&limit=50`);
    const found = d.posts.find((p) => p.id === Number(id));
    if (!found) return route();
    const card = $(`.post[data-post-id="${id}"]`);
    if (!card) return route();
    const btn = $('.like-btn', card);
    if (btn) {
      btn.className = `like-btn ${found.likedByMe ? 'active' : ''}`;
      btn.dataset.action = found.likedByMe ? 'unlike-post' : 'like-post';
      btn.innerHTML = `${found.likedByMe ? '♥' : '♡'} ${found.likeCount}`;
    }
  } catch (e) { /* 忽略局部刷新失败 */ }
}

/* ============ 启动 ============ */
async function init() {
  try {
    const d = await get('/api/me');
    state.me = d.user;
  } catch (e) { /* 忽略 */ }
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  clearTimers();
  const { name, parts } = parseHash();

  // 未登录强制去登录页
  if (!state.me) {
    if (name !== 'auth') history.replaceState(null, '', '#/auth');
    renderAuth();
    return;
  }

  // 已登录但停留在登录页 -> 回首页
  if (name === 'auth') {
    history.replaceState(null, '', '#/home');
    renderLayout('home');
    return renderHome();
  }

  renderLayout(name);

  if (name === 'home') {
    await renderHome();
  } else if (name === 'user') {
    await renderProfile(parts[1] || '');
  } else if (name === 'messages' && parts.length > 1) {
    await renderChat(parts[1]);
  } else if (name === 'messages') {
    await renderMessages();
  } else if (name === 'friends') {
    await renderFriends();
  } else {
    await renderHome();
  }
}

/* ============ 整体布局（登录后） ============ */
function renderLayout(active) {
  const me = state.me;
  const uname = encodeURIComponent(me.username);
  const isHome = active === 'home';
  const isMsg = active === 'messages';
  const isFriends = active === 'friends';
  const isProfile = active === 'profile' || active === 'user';

  $('#app').innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="logo"><span>🏫</span><span class="logo-text">十四校园网</span></div>
      <nav class="nav">
        <a class="nav-item ${isHome ? 'active' : ''}" href="#/home">🏠 首页</a>
        <a class="nav-item ${isFriends ? 'active' : ''}" href="#/friends">👥 好友
          <span id="friend-badge" class="badge hidden"></span>
        </a>
        <a class="nav-item ${isMsg ? 'active' : ''}" href="#/messages">💬 私信
          <span id="nav-badge" class="badge hidden"></span>
        </a>
        <a class="nav-item ${isProfile ? 'active' : ''}" href="#/user/${uname}">👤 我的主页</a>
        <button class="nav-item nav-logout" data-action="logout">🚪 退出</button>
      </nav>
      <div class="sidebar-me">
        <a href="#/user/${uname}">${avatarHTML(me)}</a>
        <div class="sidebar-me-text">
          <a class="me-name" href="#/user/${uname}">${esc(me.displayName)}</a>
          <span class="me-username">@${esc(me.username)}</span>
        </div>
      </div>
    </aside>

    <main class="main" id="main"><div class="loading">加载中…</div></main>

    <aside class="side-right">
      <form class="search-card" id="search-form">
        <input id="search-input" type="search" placeholder="搜索同学用户名 / 昵称" value="${esc(state.search)}" />
        <button type="submit" class="btn small">搜索</button>
        <div id="search-result"></div>
      </form>
      <div class="card suggest-card">
        <h3>✨ 找同学，加好友</h3>
        <div id="suggest-list"><div class="loading small">加载中…</div></div>
      </div>
    </aside>
  </div>`;

  refreshBadges();
  state.timers.badge = setInterval(refreshBadges, 6000);
  loadSuggestions();
}

async function refreshBadges() {
  try {
    const d = await get('/api/conversations');
    state.convs = d.conversations;
    const totalMsg = state.convs.reduce((s, c) => s + c.unread, 0);
    const msgBadge = $('#nav-badge');
    if (msgBadge) {
      msgBadge.textContent = totalMsg > 0 ? (totalMsg > 99 ? '99+' : String(totalMsg)) : '';
      msgBadge.classList.toggle('hidden', totalMsg === 0);
    }
  } catch (e) { /* 忽略 */ }
  try {
    const d = await get('/api/friend-requests');
    state.friendReq = d;
    const n = d.incoming.length;
    const fBadge = $('#friend-badge');
    if (fBadge) {
      fBadge.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      fBadge.classList.toggle('hidden', n === 0);
    }
  } catch (e) { /* 忽略 */ }
}

async function loadSuggestions() {
  try {
    const d = await get('/api/users');
    const box = $('#suggest-list');
    if (!box) return;
    if (!d.users.length) {
      box.innerHTML = '<div class="muted">还没有其他同学注册，快邀请他们来吧~</div>';
      return;
    }
    box.innerHTML = d.users
      .map((u) => {
        const enc = encodeURIComponent(u.username);
        return `
        <div class="suggest-row">
          <a href="#/user/${enc}">${avatarHTML(u, 'sm')}</a>
          <div class="suggest-info">
            <a class="s-name" href="#/user/${enc}">${esc(u.displayName)}</a>
            <span class="s-uname">@${esc(u.username)}</span>
          </div>
          ${friendActionHTML(u, true)}
        </div>`;
      })
      .join('');
  } catch (e) { /* 忽略 */ }
}

/* ============ 登录 / 注册页（创意版） ============ */
function renderAuth() {
  $('#app').innerHTML = `
  <div class="auth-page">
    <div class="auth-blob a"></div>
    <div class="auth-blob b"></div>
    <div class="auth-grid"></div>

    <div class="auth-hero">
      <div class="hero-brand">🏫 <b>十四校园网</b></div>
      <div class="hero-copy">
        <p class="hero-kicker">CAMPUS · CONNECT · CHAT</p>
        <h1 class="hero-title">在校园里，<br/><span class="grad">认识每一个有趣的 TA</span></h1>
        <p class="hero-desc">发动态分享校园日常，一键加好友，随时开聊——<br/>这里只属于十四中人。</p>
        <div class="hero-features">
          <span>📝 记录日常</span>
          <span>👥 寻找好友</span>
          <span>💬 无距聊天</span>
        </div>
      </div>

      <div class="float-card fc-1">
        <div class="fc-head">${avatarHTML({ displayName: '同', username: 'classmate', avatar: { char: '同', color: '#7c3aed' } })}<div><b>同班同学</b><small>@classmate_14</small></div></div>
        <p>放学一起去打球吗？🏀</p>
        <div class="fc-foot"><span>💬 2 条回复</span><span>♥ 18</span></div>
      </div>
      <div class="float-card fc-2">
        <div class="fc-head">${avatarHTML({ displayName: '她', username: 'her', avatar: { char: '她', color: '#1d9bf0' } })}<div><b>她</b><small>刚刚</small></div></div>
        <p>今天的天也太好看了吧 ☁️✨</p>
        <div class="fc-foot"><span>💬 5 条回复</span><span>♥ 42</span></div>
      </div>
      <div class="float-chip fc-3">你们已成为好友 🎉</div>
    </div>

    <div class="auth-panel">
      <div class="auth-card">
        <div class="auth-mobile-brand">🏫 十四校园网</div>
        <div class="auth-tabs">
          <button data-action="auth-tab" data-tab="login" class="active" id="tab-login">登 录</button>
          <button data-action="auth-tab" data-tab="register" id="tab-register">注 册</button>
        </div>
        <form id="auth-form" autocomplete="on">
          <div class="field">
            <label for="auth-username">用户名</label>
            <input id="auth-username" name="username" required autocomplete="username"
                   placeholder="2-20 位，支持中文/字母/数字/_" />
          </div>
          <div class="field hidden" id="nickname-field">
            <label for="auth-nickname">昵称</label>
            <input id="auth-nickname" name="displayName" autocomplete="nickname"
                   placeholder="在网站上显示的名字（1-24 字）" />
          </div>
          <div class="field">
            <label for="auth-password">密码</label>
            <input id="auth-password" name="password" type="password" required
                   autocomplete="current-password" placeholder="至少 6 位" />
          </div>
          <button type="submit" class="btn primary auth-submit" id="auth-submit">登 录</button>
        </form>
        <p class="auth-hint" id="auth-hint">还没有账号？点上方「注册」即可创建</p>
        <div class="auth-foot">由 十四校园网 驱动 · 仅校园内部使用</div>
      </div>
    </div>
  </div>`;
}

function setAuthTab(tab) {
  const login = tab === 'login';
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#nickname-field').classList.toggle('hidden', login);
  const nickInput = $('#auth-nickname');
  if (nickInput) nickInput.required = !login;
  $('#auth-submit').textContent = login ? '登 录' : '注 册';
  $('#auth-hint').textContent = login ? '还没有账号？点上方「注册」即可创建' : '已有账号？点上方「登录」';
  $('#auth-password').autocomplete = login ? 'current-password' : 'new-password';
}

async function submitAuth() {
  const isLogin = $('#tab-login').classList.contains('active');
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const displayName = $('#auth-nickname') ? $('#auth-nickname').value.trim() : '';
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    let d;
    if (isLogin) {
      d = await post('/api/login', { username, password });
      toast(`欢迎回来，${d.user.displayName}！`, 'ok');
    } else {
      d = await post('/api/register', { username, displayName, password });
      toast(`注册成功，欢迎加入十四校园网！🎉`, 'ok');
    }
    state.me = d.user;
    go('home');
  } catch (err) {
    toast(err.message || '操作失败');
  } finally {
    btn.disabled = false;
  }
}

/* ============ 首页（时间线 + 发动态） ============ */
async function renderHome() {
  state.feedTab = state.feedTab || 'latest';
  state.feedBefore = 0;
  $('#main').innerHTML = `
    <div class="page-head">
      <h1>首页</h1>
      <div class="tabs">
        <button class="tab ${state.feedTab === 'latest' ? 'active' : ''}" data-tab="latest">推荐</button>
        <button class="tab ${state.feedTab === 'following' ? 'active' : ''}" data-tab="following">关注</button>
      </div>
    </div>
    <div class="composer card">
      <a href="#/user/${encodeURIComponent(state.me.username)}">${avatarHTML(state.me)}</a>
      <form id="composer-form" class="composer-form">
        <textarea id="composer-input" maxlength="500" rows="2"
          placeholder="分享新鲜事…（支持链接，最多 500 字）"></textarea>
        <div class="composer-foot">
          <span id="composer-count" class="muted">0/500</span>
          <button type="submit" class="btn primary">发布</button>
        </div>
      </form>
    </div>
    <div id="feed"><div class="loading">加载中…</div></div>`;

  bindComposer();
  $$('.tab', $('#main')).forEach((b) => {
    b.addEventListener('click', async () => {
      state.feedTab = b.dataset.tab;
      await renderHome();
    });
  });
  await appendFeed();
}

function bindComposer() {
  const ta = $('#composer-input');
  if (ta) {
    ta.addEventListener('input', () => {
      const c = $('#composer-count');
      if (c) c.textContent = `${ta.value.length}/500`;
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $('#composer-form').requestSubmit();
      }
    });
  }
}

async function submitPost() {
  const ta = $('#composer-input');
  if (!ta) return;
  const content = ta.value.trim();
  if (!content) return toast('先写点内容再发布吧');
  const btn = $('.composer-foot .btn', ta.closest('.composer'));
  if (btn) btn.disabled = true;
  try {
    await post('/api/posts', { content });
    toast('发布成功！', 'ok');
    await renderHome();
  } catch (err) {
    toast(err.message || '发布失败');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function appendFeed() {
  const box = $('#feed');
  if (!box) return;
  const tab = state.feedTab;
  const d = await get(`/api/posts?tab=${tab}&beforeId=${state.feedBefore || 0}`);
  const posts = d.posts;
  if (!posts.length) {
    if (!state.feedBefore) {
      box.innerHTML = tab === 'following'
        ? `<div class="empty">关注里的人还没有动态～<br/>去右边「找同学，加好友」认识几个同学吧！</div>`
        : `<div class="empty">还没有人发动态，快来抢沙发发第一条吧！</div>`;
    } else {
      const more = $('#more-btn');
      if (more) more.remove();
    }
    return;
  }
  state.feedBefore = posts[posts.length - 1].id;
  if (!state.feedBefore || state.feedBefore === 0) state.feedBefore = posts[0].id;
  const html = posts.map(postHTML).join('');
  if (box.dataset.append !== '1') {
    box.innerHTML = html;
    box.dataset.append = '1';
  } else {
    box.insertAdjacentHTML('beforeend', html);
  }
  const moreBtn = $('#more-btn');
  if (moreBtn) moreBtn.remove();
  if (posts.length >= 20) {
    box.insertAdjacentHTML(
      'beforeend',
      `<button class="btn block more-btn" id="more-btn" data-action="load-more" data-target="feed">加载更多</button>`
    );
  }
}

function postHTML(p) {
  const likeCls = p.likedByMe ? 'active' : '';
  const likeAct = p.likedByMe ? 'unlike-post' : 'like-post';
  const delBtn = p.mine
    ? `<button class="post-del" title="删除" data-action="delete-post" data-id="${p.id}">🗑</button>`
    : '';
  return `
  <article class="post card" data-post-id="${p.id}">
    <a class="post-avatar" href="#/user/${encodeURIComponent(p.author.username)}">${avatarHTML(p.author)}</a>
    <div class="post-body">
      <div class="post-head">
        <a class="post-name" href="#/user/${encodeURIComponent(p.author.username)}">${esc(p.author.displayName)}</a>
        <a class="post-uname" href="#/user/${encodeURIComponent(p.author.username)}">@${esc(p.author.username)}</a>
        <span class="post-time" title="${fullTime(p.createdAt)}">· ${timeAgo(p.createdAt)}</span>
        ${delBtn}
      </div>
      <p class="post-content">${linkify(p.content)}</p>
      <div class="post-actions">
        <button class="like-btn ${likeCls}" data-action="${likeAct}" data-id="${p.id}"
          title="${p.likedByMe ? '取消点赞' : '点赞'}">${p.likedByMe ? '♥' : '♡'} ${fmtCount(p.likeCount)}</button>
      </div>
    </div>
  </article>`;
}

/* ============ 个人主页 ============ */
async function renderProfile(username) {
  if (!username) return renderHome();
  $('#main').innerHTML = `<div class="loading">加载中…</div>`;
  try {
    const d = await get(`/api/users/${encodeURIComponent(username)}`);
    const u = d.user;
    state.profile = d;
    state.profileBefore = 0;
    const enc = encodeURIComponent(u.username);
    const isSelf = d.isSelf;

    let actionBtns = '';
    if (!isSelf) {
      let friendBtn = '';
      if (d.friendStatus === 'friends') {
        friendBtn = `<button class="btn is-friend" data-action="remove-friend" data-id="${u.id}" title="删除好友">✅ 已是好友</button>`;
      } else if (d.friendStatus === 'pending_out') {
        friendBtn = `<button class="btn waiting" disabled>⏳ 已申请，等待对方验证</button>`;
      } else if (d.friendStatus === 'pending_in') {
        friendBtn = `<button class="btn primary" data-action="add-friend" data-username="${enc}">✅ TA 想加你，点我通过</button>`;
      } else {
        friendBtn = `<button class="btn primary" data-action="add-friend" data-username="${enc}">＋ 添加好友</button>`;
      }
      const followBtn = `<button class="btn" data-action="${d.isFollowing ? 'unfollow' : 'follow'}" data-username="${enc}">${d.isFollowing ? '✓ 已关注' : '＋ 关注'}</button>`;
      const chatBtn = `<button class="btn" data-action="open-chat" data-id="${u.id}">💬 私信</button>`;
      actionBtns = `<div class="profile-btns">${friendBtn}${followBtn}${chatBtn}</div>`;
    } else {
      actionBtns = `<a class="btn" href="#/friends">👥 我的好友</a><a class="btn" href="#/messages">💬 我的私信</a>`;
    }

    const pendingNote = !isSelf && d.friendStatus === 'pending_in'
      ? `<div class="friend-note">💡 ${esc(u.displayName)} 向你发出了好友申请，点击上方蓝色按钮即可通过～</div>`
      : '';

    $('#main').innerHTML = `
      <div class="page-head"><button class="back" data-action="back">←</button><h1>个人主页</h1></div>
      <div class="profile-card card">
        <div class="profile-banner"></div>
        <div class="profile-info">
          <div class="profile-avatar-wrap">
            ${avatarHTML(u, 'xl')}
            ${isSelf ? `<label class="avatar-edit" title="更换头像">
              <input type="file" accept="image/*" data-action="upload-avatar" hidden />
              <span>📷 换头像</span>
            </label>` : ''}
          </div>
          <div class="profile-head">
            <h2>${esc(u.displayName)}</h2>
            <span class="post-uname">@${esc(u.username)}</span>
          </div>
          <p class="profile-bio">${u.bio ? linkify(u.bio) : '<span class="muted">这个人很懒，什么都没写~</span>'}</p>
          ${pendingNote}
          <div class="profile-meta">
            <span>📅 ${new Date(u.createdAt).getFullYear()} 年加入</span>
            ${actionBtns}
          </div>
          <div class="profile-stats">
            <span><b>${fmtCount(d.stats.postCount)}</b> 动态</span>
            <span><b>${fmtCount(d.stats.followingCount)}</b> 关注</span>
            <span><b>${fmtCount(d.stats.followerCount)}</b> 粉丝</span>
            <span><b>${fmtCount(d.stats.friendCount)}</b> 好友</span>
          </div>
        </div>
      </div>
      <div class="page-sub"><h3>TA 的动态</h3></div>
      <div id="profile-feed"></div>`;
    await appendProfilePosts();
  } catch (err) {
    $('#main').innerHTML = `<div class="empty">${esc(err.message || '加载失败')}</div>`;
  }
}

async function appendProfilePosts() {
  const box = $('#profile-feed');
  if (!box) return;
  const u = state.profile.user.username;
  const d = await get(`/api/users/${encodeURIComponent(u)}/posts?beforeId=${state.profileBefore || 0}`);
  const posts = d.posts;
  if (!posts.length) {
    if (!state.profileBefore) box.innerHTML = `<div class="empty">还没有发布动态</div>`;
    else { const m = $('#profile-more'); if (m) m.remove(); }
    return;
  }
  state.profileBefore = posts[posts.length - 1].id;
  box.insertAdjacentHTML('beforeend', posts.map(postHTML).join(''));
  const more = $('#profile-more');
  if (more) more.remove();
  if (posts.length >= 20) {
    box.insertAdjacentHTML(
      'beforeend',
      `<button class="btn block more-btn" id="profile-more" data-action="load-more" data-target="profile">加载更多</button>`
    );
  }
}

/* ============ 好友页 ============ */
async function renderFriends() {
  $('#main').innerHTML = `
    <div class="page-head"><h1>👥 好友</h1></div>
    <div id="friends-root"><div class="loading">加载中…</div></div>`;
  await refreshFriends();
  state.timers.friends = setInterval(refreshFriends, 5000);
}

async function refreshFriends() {
  const root = $('#friends-root');
  if (!root) return;
  let incoming = [], outgoing = [], friends = [];
  try {
    const req = await get('/api/friend-requests');
    state.friendReq = req;
    incoming = req.incoming;
    outgoing = req.outgoing;
  } catch (e) { /* ignore */ }
  try {
    const f = await get('/api/friends');
    state.friends = f.friends;
    friends = f.friends;
  } catch (e) { /* ignore */ }

  const personRow = (u, btns) => `
    <div class="person-row">
      <a href="#/user/${encodeURIComponent(u.username)}">${avatarHTML(u)}</a>
      <div class="person-info">
        <a class="person-name" href="#/user/${encodeURIComponent(u.username)}">${esc(u.displayName)}</a>
        <span class="person-uname">@${esc(u.username)}</span>
      </div>
      ${btns}
    </div>`;

  let html = '';
  // 好友申请
  if (incoming.length) {
    html += `
      <div class="section-card card">
        <h3 class="section-title">📩 新的好友申请 <span class="pill danger">${incoming.length}</span></h3>
        ${incoming
          .map(
            (r) => personRow(
              r.user,
              `<div class="person-btns">
                <button class="btn tiny primary" data-action="accept-friend" data-id="${r.id}">同意</button>
                <button class="btn tiny danger" data-action="reject-friend" data-id="${r.id}">拒绝</button>
              </div>`
            )
          )
          .join('')}
      </div>`;
  }
  if (outgoing.length) {
    html += `
      <div class="section-card card">
        <h3 class="section-title">🕓 我发出的申请</h3>
        ${outgoing
          .map(
            (r) => personRow(
              r.user,
              `<div class="person-btns">
                <span class="tag wait">等待验证…</span>
                <button class="btn tiny" data-action="cancel-friend" data-id="${r.id}">撤销</button>
              </div>`
            )
          )
          .join('')}
      </div>`;
  }
  // 好友列表
  if (friends.length) {
    html += `
      <div class="section-card card">
        <h3 class="section-title">🌟 我的好友 <span class="pill ok">${friends.length}</span></h3>
        ${friends
          .map(
            (f) => personRow(
              f,
              `<div class="person-btns">
                <span class="tag ok">好友</span>
                <button class="btn tiny primary" data-action="open-chat" data-id="${f.id}">💬 私信</button>
                <button class="btn tiny" data-action="remove-friend" data-id="${f.id}">删除</button>
              </div>`
            )
          )
          .join('')}
      </div>`;
  }

  if (!html) {
    html = `<div class="empty">还没有好友哦～<br/>去右侧「找同学，加好友」或打开同学主页点「＋ 添加好友」吧！</div>`;
  }
  root.innerHTML = html;
}

/* ============ 私信：会话列表 ============ */
async function renderMessages() {
  $('#main').innerHTML = `
    <div class="page-head"><h1>私信</h1></div>
    <div class="card">
      <div id="conv-list"><div class="loading">加载中…</div></div>
    </div>`;
  await refreshConversationList();
  state.timers.convs = setInterval(refreshConversationList, 5000);
}

async function refreshConversationList() {
  const box = $('#conv-list');
  if (!box) return;
  try {
    const d = await get('/api/conversations');
    state.convs = d.conversations;
  } catch (e) {
    return;
  }
  const list = state.convs;
  if (!list.length) {
    box.innerHTML = `<div class="empty">还没有私信～<br/>去别人主页点「💬 私信」开聊吧！</div>`;
    return;
  }
  box.innerHTML = list
    .map((c) => {
      const last = c.lastMessage;
      const preview = last
        ? `${last.fromMe ? '我: ' : ''}${esc(last.content.length > 40 ? last.content.slice(0, 40) + '…' : last.content)}`
        : '<span class="muted">开始聊天吧</span>';
      return `
      <a class="conv-row" href="#/messages/${c.id}">
        ${avatarHTML(c.other)}
        <div class="conv-info">
          <div class="conv-name">${esc(c.other.displayName)} <span class="post-uname">@${esc(c.other.username)}</span></div>
          <div class="conv-preview">${preview}</div>
        </div>
        <div class="conv-side">
          ${last ? `<span class="conv-time">${timeAgo(last.createdAt)}</span>` : ''}
          ${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        </div>
      </a>`;
    })
    .join('');
}

async function openConversation(userId) {
  try {
    const d = await post('/api/conversations', { userId });
    go(`messages/${d.conversation.id}`);
  } catch (err) {
    toast(err.message || '无法发起私信');
  }
}

/* ============ 私信：聊天窗口 ============ */
async function renderChat(convId) {
  const idNum = Number(convId);
  $('#main').innerHTML = `
    <div class="chat-view">
      <div class="chat-head">
        <a class="back" href="#/messages">←</a>
        <div id="chat-peer">加载中…</div>
      </div>
      <div class="chat-body" id="chat-body"></div>
      <form id="chat-form" class="chat-form">
        <textarea id="chat-input" rows="1" maxlength="2000" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
        <button type="submit" class="btn primary">发送</button>
      </form>
    </div>`;
  try {
    await post(`/api/conversations/${idNum}/read`, {});
    const peer = await get(`/api/conversations`);
    const found = peer.conversations.find((c) => c.id === idNum);
    if (!found) throw Object.assign(new Error('会话不存在'), { status: 404 });
    state.chat = { id: idNum, other: found.other, lastId: 0, lastFromMe: false };
    $('#chat-peer').innerHTML = `
      <a class="chat-peer-user" href="#/user/${encodeURIComponent(found.other.username)}">
        ${avatarHTML(found.other)}
        <span><b>${esc(found.other.displayName)}</b><br/><small>@${esc(found.other.username)}</small></span>
      </a>`;
    await loadChatMessages(true);
    const ta = $('#chat-input');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#chat-form').requestSubmit();
      }
    });
    state.timers.chat = setInterval(() => loadChatMessages(false), 2000);
  } catch (err) {
    $('#main').innerHTML = `<div class="empty">${esc(err.message || '加载失败')}</div>`;
    toast(err.message || '加载失败');
  }
}

async function loadChatMessages(initial) {
  if (!state.chat) return;
  const body = $('#chat-body');
  if (!body) return;
  try {
    const d = await get(`/api/conversations/${state.chat.id}/messages?afterId=${state.chat.lastId || 0}`);
    const msgs = d.messages;
    if (!msgs.length) {
      if (initial) body.innerHTML = `<div class="empty">打个招呼，开始聊天吧～</div>`;
      return;
    }
    if (initial) body.innerHTML = '';
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    let lastFromMe = state.chat.lastFromMe;
    const html = msgs
      .map((m) => {
        const cur = m.fromMe;
        const bubble = bubbleHTML(m, cur, lastFromMe);
        lastFromMe = cur;
        return bubble;
      })
      .join('');
    if (initial) body.innerHTML = html;
    else body.insertAdjacentHTML('beforeend', html);
    state.chat.lastId = msgs[msgs.length - 1].id;
    state.chat.lastFromMe = lastFromMe;
    if (msgs.some((m) => !m.fromMe)) {
      post(`/api/conversations/${state.chat.id}/read`, {});
    }
    if (initial || nearBottom) body.scrollTop = body.scrollHeight;
  } catch (e) { /* 忽略轮询错误 */ }
}

function bubbleHTML(m, fromMe, prevFromMe) {
  const cls = fromMe ? 'mine' : 'other';
  const gap = prevFromMe !== fromMe ? ' gap' : '';
  return `
  <div class="bubble-row ${cls}${gap}">
    ${fromMe ? '' : avatarHTML(state.chat.other, 'sm')}
    <div class="bubble" title="${fullTime(m.createdAt)}">${linkify(m.content)}</div>
  </div>`;
}

async function submitMessage() {
  const ta = $('#chat-input');
  if (!ta || !state.chat) return;
  const content = ta.value.trim();
  if (!content) return;
  ta.value = '';
  ta.style.height = 'auto';
  try {
    const d = await post(`/api/conversations/${state.chat.id}/messages`, { content });
    const body = $('#chat-body');
    const lastFromMe = state.chat.lastFromMe;
    const html = bubbleHTML(d.message, true, lastFromMe);
    const empty = body.querySelector('.empty');
    if (empty) empty.remove();
    body.insertAdjacentHTML('beforeend', html);
    state.chat.lastId = d.message.id;
    state.chat.lastFromMe = true;
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    toast(err.message || '发送失败');
  }
}

/* ============ 搜索 ============ */
async function runSearch() {
  const input = $('#search-input');
  const box = $('#search-result');
  if (!input || !box) return;
  const q = input.value.trim();
  state.search = q;
  if (!q) {
    box.innerHTML = '';
    return;
  }
  try {
    const d = await get(`/api/users?q=${encodeURIComponent(q)}`);
    if (!d.users.length) {
      box.innerHTML = `<div class="muted small">没有找到「${esc(q)}」相关用户</div>`;
      return;
    }
    box.innerHTML = d.users
      .map((u) => {
        const enc = encodeURIComponent(u.username);
        return `
      <div class="suggest-row">
        <a href="#/user/${enc}">${avatarHTML(u, 'sm')}</a>
        <a class="suggest-info" href="#/user/${enc}">
          <span class="s-name">${esc(u.displayName)}</span>
          <span class="s-uname">@${esc(u.username)}</span>
        </a>
        ${friendActionHTML(u, true)}
      </div>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
  }
}

init();
