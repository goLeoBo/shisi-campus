# 🏫 十四校园网

一个类似 Twitter / 微博的**校园社交网站**：注册登录 → 发动态、点赞、关注好友、一对一私信聊天。

纯 Node.js 实现，**零第三方依赖**（使用 Node 内置的 `node:sqlite` 存数据），一条命令即可运行。

## ✨ 功能

- 👤 **账户系统**：注册 / 登录 / 退出（密码用 scrypt 加盐加密，会话用 HttpOnly Cookie）
- 📝 **发动态**：发布、点赞、删除自己的动态，支持链接自动识别
- 🏠 **首页时间线**：推荐（全站）/ 关注（只看关注的人）
- 👥 **好友系统**：一键「添加好友」→ 对方收到申请（侧边栏红点）→ 同意后成为好友；好友页集中管理申请与好友，也可删除好友
- ➕ **关注与搜索**：关注 / 取消关注、按用户名或昵称搜索同学、右侧「找同学，加好友」一键推荐
- 💬 **私信聊天**：一键发起私信、实时轮询新消息、未读红点提示
- 📱 响应式界面：电脑 / 手机都能用

## 🚀 运行

需要 **Node.js ≥ 22.5**（本项目在 Node 24 上开发测试）。

```bash
node server.js
# 或
npm start
```

然后打开浏览器访问 <http://127.0.0.1:3000>

> 想换端口：`PORT=8080 node server.js`
> 想允许局域网其他设备访问：`HOST=0.0.0.0 node server.js`

## 🧪 快速体验

1. 打开首页 → 点「注册」，创建第一个账号（如 `小明`）
2. 发布几条动态，点「♥」点赞试试
3. 再开一个**无痕窗口**注册第二个账号（如 `小红`）
4. 用第二个账号搜索第一个账号 → 点「＋ 加好友」发出申请
5. 回到第一个账号：侧边栏「好友」出现**红点** → 打开「好友」页点「同意」→ 成为好友
6. 在好友列表或对方主页点「💬 私信」开聊 —— 聊天是实时刷新哒

## 📁 项目结构

```
├── server.js            # HTTP 服务器入口（路由 + 静态资源 + 安全头）
├── lib/
│   ├── db.js            # SQLite 数据库与表结构
│   ├── auth.js          # 密码哈希 / 会话 / Cookie
│   ├── router.js        # 极简 URL 路由
│   └── api.js           # 全部 JSON API
├── public/
│   ├── index.html       # 单页应用入口
│   ├── css/style.css    # 样式
│   └── js/
│       ├── api.js       # fetch 封装
│       └── app.js       # 页面与交互逻辑
└── data/                # 运行时自动生成 app.db（已 gitignore）
```

## 🔌 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录 |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 当前用户 |
| GET | `/api/users?q=` | 搜索用户 |
| GET | `/api/users/:username` | 用户资料 |
| GET | `/api/users/:username/posts` | 某用户的动态 |
| POST | `/api/users/:username/friend-request` | 发送 / 自动通过好友申请 |
| GET | `/api/friend-requests` | 收到的 / 发出的好友申请 |
| POST | `/api/friend-requests/:id/accept` | 同意好友申请 |
| POST | `/api/friend-requests/:id/reject` | 拒绝好友申请 |
| DELETE | `/api/friend-requests/:id` | 撤销自己发出的申请 |
| GET | `/api/friends` | 好友列表 |
| DELETE | `/api/friends/:userId` | 删除好友 |
| POST/DELETE | `/api/users/:username/follow` | 关注 / 取消关注 |
| GET | `/api/posts?tab=latest\|following&beforeId=` | 时间线（分页） |
| POST | `/api/posts` | 发布动态 |
| DELETE | `/api/posts/:id` | 删除动态 |
| POST/DELETE | `/api/posts/:id/like` | 点赞 / 取消点赞 |
| GET | `/api/conversations` | 会话列表 |
| POST | `/api/conversations` | 发起 / 打开会话 |
| GET | `/api/conversations/:id/messages?afterId=` | 拉取新消息 |
| POST | `/api/conversations/:id/messages` | 发消息 |
| POST | `/api/conversations/:id/read` | 标记已读 |

## 🔒 安全说明（已内置）

- 密码 **scrypt 加盐哈希**，不存明文
- 登录态使用 **HttpOnly + SameSite Cookie**
- 服务端做了 **Origin 校验**，防止跨站表单伪造请求（CSRF）
- 所有用户内容输出前 **HTML 转义**，防 XSS
- 带安全响应头（CSP、X-Frame-Options 等）

## 🚧 后续可扩展

- 动态配图 / 头像上传
- 评论（回复）功能
- WebSocket 实时推送（替代轮询）
- 修改密码 / 找回密码
- 部署到服务器（如 Vercel / 云服务器 + Nginx）

## 📝 备注

- 目前聊天采用 **2 秒轮询**，本地/小规模使用体验流畅；人数多时可换成 WebSocket
- 数据存放在 `data/app.db`，想重置数据直接删除 `data/` 目录重启即可
