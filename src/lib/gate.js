// src/lib/gate.js
// 站点访问口令门禁。
//
// 用法：
//   1) 在 Cloudflare 后台给 Worker 添加「机密」类型变量 SITE_PASS（值即口令）；
//   2) 在 wrangler.toml 的 [assets] 段加 run_worker_first = true（否则静态资源不经过 Worker，门禁失效）；
//   3) src/index.js 里引入并调用 guard()。
//
// 行为：
//   - 未设置 SITE_PASS 时完全跳过，行为与改动前一致（方便随时关掉）。
//   - 通过后种一个 HMAC 签名的 cookie，默认一年有效。
//   - 改了 SITE_PASS 或 TMH_SECRET，所有已发出的 cookie 立即失效（等于全站强制重新输入）。

const COOKIE_NAME = 'tmh_gate';
export const GATE_PATH = '/__gate';
const MAX_AGE = 31536000; // 一年
const TOKEN_MATERIAL = 'tmh-gate-v1';

const enc = new TextEncoder();

export function gateEnabled(env) {
  return !!(env && env.SITE_PASS);
}

// 口令 token：由 SITE_PASS + TMH_SECRET 派生，两者任一变化都会让旧 cookie 全部作废
export async function gateToken(env) {
  const material =
    TOKEN_MATERIAL + '|' + String(env.SITE_PASS) + '|' + String(env.TMH_SECRET || '');
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(TOKEN_MATERIAL));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 定长比较，避免时序侧信道
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (_) {
    return '';
  }
}

// 只允许站内跳转，避免开放重定向
function safeNext(next) {
  const s = String(next || '');
  return /^\/(?!\/)/.test(s) ? s : '/';
}

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function page(msg, next) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#0f1115">
<meta name="robots" content="noindex, nofollow">
<title>需要访问口令</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f1115;color:#e8eaed;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  form{width:min(420px,88vw);padding:34px 28px;border-radius:16px;background:#171a21;border:1px solid #262b36}
  h1{margin:0 0 8px;font-size:20px;font-weight:500}
  .sub{margin:0 0 22px;font-size:13px;color:#9aa0a6;line-height:1.6}
  input[type=password]{width:100%;height:54px;padding:0 16px;font-size:17px;border-radius:10px;
    background:#0f1115;border:1px solid #303643;color:#e8eaed;outline:none}
  input[type=password]:focus{border-color:#e5484d}
  button{width:100%;height:54px;margin-top:14px;font-size:17px;font-weight:500;border:0;
    border-radius:10px;background:#e5484d;color:#fff}
  .err{margin-top:14px;min-height:18px;font-size:13px;color:#ff6b6b;text-align:center}
</style>
</head>
<body>
<form method="POST" action="${GATE_PATH}">
  <h1>请输入访问口令</h1>
  <p class="sub">本站仅限授权设备访问</p>
  <input name="pass" type="password" placeholder="口令" autocomplete="current-password" autofocus>
  <button type="submit">进 入</button>
  <div class="err">${esc(msg)}</div>
  <input type="hidden" name="next" value="${esc(next)}">
</form>
</body>
</html>`;
}

/**
 * 门禁中间件。
 * 已通过 / 未启用 → 返回 null，调用方继续走正常流程。
 * 未通过 → 直接返回要发出的 Response（口令页或跳转）。
 */
export async function guard(request, env, url) {
  if (!gateEnabled(env)) return null;

  const want = await gateToken(env);
  if (safeEqual(readCookie(request, COOKIE_NAME), want)) return null;

  // 提交口令
  if (url.pathname === GATE_PATH && request.method === 'POST') {
    let pass = '';
    let next = '/';
    try {
      const form = await request.formData();
      pass = String(form.get('pass') || '');
      next = safeNext(form.get('next'));
    } catch (_) {
      next = '/';
    }

    if (safeEqual(pass, String(env.SITE_PASS))) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: next,
          'Set-Cookie':
            COOKIE_NAME + '=' + want + '; Path=/; Max-Age=' + MAX_AGE + '; HttpOnly; Secure; SameSite=Lax',
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(page('口令不正确', next), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // 未通过：接口请求登录后回首页，页面请求回原地址
  let next = url.pathname + (url.search || '');
  if (url.pathname.startsWith('/api/')) next = '/';

  return new Response(page('', next), {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
