'use strict';

// 极简路由：支持类似 "/api/users/:username/posts" 这样的模式
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const segs = pattern.split('/').filter(Boolean);
    const source = segs
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const regex = new RegExp(`^/${source}$`, 'i');
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler });
  }

  get(pattern, handler) {
    this.add('GET', pattern, handler);
  }
  post(pattern, handler) {
    this.add('POST', pattern, handler);
  }
  delete(pattern, handler) {
    this.add('DELETE', pattern, handler);
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
    return null;
  }
}

module.exports = Router;
