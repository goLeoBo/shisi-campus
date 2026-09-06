'use strict';

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    const err = new Error('网络错误，请检查连接');
    err.status = 0;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败(${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const get = (url) => api('GET', url);
const post = (url, body) => api('POST', url, body === undefined ? {} : body);
const del = (url) => api('DELETE', url);
