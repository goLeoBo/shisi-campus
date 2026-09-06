'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const Router = require('./lib/router');
const { registerApi, registerFriendApi } = require('./lib/api');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1MB

const apiRouter = new Router();
registerApi(apiRouter);
registerFriendApi(apiRouter);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}


// ── Minimal multipart/form-data parser ──
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const endBoundaryBuf = Buffer.from('--' + boundary + '--');
  let start = 0;
  while (start < buffer.length) {
    const idx = buffer.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    const next = buffer.indexOf(Buffer.from('\r\n\r\n'), idx);
    if (next === -1) break;
    const headerEnd = next + 4;
    const nextBoundary = buffer.indexOf(boundaryBuf, headerEnd);
    if (nextBoundary === -1) break;
    const bodyEnd = nextBoundary - 2; // strip preceding CRLF
    const headers = buffer.slice(idx + boundaryBuf.length + 2, next).toString('utf8');
    const body = buffer.slice(headerEnd, bodyEnd);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'text/plain',
      data: body,
    });
    start = nextBoundary + boundaryBuf.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    if (buffer[start] === 0x0d) start += 2;
    if (buffer[start] === 0x0a) start += 1;
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
          const m = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
          const boundary = m ? (m[1] || m[2]) : null;
          if (boundary) {
            resolve({ _multipart: parseMultipart(raw, boundary) });
            return;
          }
        }
        resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {});
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法的 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// 跨站请求防护：非 GET 请求若带 Origin，必须与本站一致（浏览器表单跨站会被拦截）
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  let filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退：未知路径返回首页
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (err2, html) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not Found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname;
    const method = req.method;

    // API
    if (pathname.startsWith('/uploads/')) {
      const rel = pathname.slice('/uploads/'.length);
      const fp = path.normalize(path.join(UPLOADS_DIR, rel));
      if (!fp.startsWith(UPLOADS_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
      return fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not Found'); }
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
    }

    if (pathname.startsWith('/api/')) {
      if (method !== 'GET' && !originAllowed(req)) {
        return sendJson(res, 403, { error: '跨站请求被拒绝' });
      }
      const route = apiRouter.match(method, pathname);
      if (!route) return sendJson(res, 404, { error: '接口不存在' });

      let body = {};
      if (method !== 'GET' && method !== 'DELETE') {
        body = await readBody(req);
      }
      const cookies = auth.parseCookies(req.headers.cookie);
      const token = cookies[auth.COOKIE_NAME] || null;
      const user = token ? auth.findUserByToken(token) : null;
      const ctx = {
        req,
        res,
        params: route.params,
        query: u.searchParams,
        body,
        user,
        token,
        json: (status, obj) => sendJson(res, status, obj),
        requireUser() {
          if (!this.user) {
            sendJson(res, 401, { error: '请先登录' });
            return false;
          }
          return true;
        },
      };
      return await route.handler(ctx);
    }

    // 静态资源
    if (method === 'GET' || method === 'HEAD') {
      return serveStatic(res, pathname);
    }

    sendJson(res, 405, { error: '方法不允许' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[server error]', err);
    sendJson(res, status, { error: status >= 500 ? '服务器内部错误' : err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  十四校园网 已启动 ✅');
  console.log(`  请打开浏览器访问: http://${HOST}:${PORT}`);
  console.log('==============================================');
});
