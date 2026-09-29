/**
 * 播放器层：适配车载大屏触摸
 * 统一播放引擎（tesla-media-hub 内置播放库，基于 wody11/Tesla-VideoPlayer）：
 *   - 完全无 <video> 标签，纯 WebCodecs 解码 → Canvas 渲染
 *   - AppleCMS 点播：浏览器直连源站 HLS/MP4（不走服务端，零服务器负载）
 *   - IPTV 直播：浏览器拉取服务端 ffmpeg 转码推流的 MPEG-TS 流
 *   - 源站不支持 WebCodecs 或跨域受限时给出提示
 *
 * 【本版重要调整 —— 为什么默认改成「浏览器直连」】
 * 国内影视源站普遍封禁 Cloudflare 数据中心的海外出口 IP，经 Worker 代理拉流一律 403，
 * 连「抓取 HTML 跳转页解析真实地址」这一步也会 403 而失败。
 * 而实测这些源站的 CDN 都返回 `access-control-allow-origin: *`，浏览器直连（用户本地网络）
 * 完全不受影响。因此：
 *   - AppleCMS 点播：默认浏览器直连；直连失败再回退到同源代理（适合校验 Referer 的源站）
 *   - 跳转页解析：改在浏览器端完成（fetch 跳转页 → 正则提取真实地址 → 相对地址按页面 URL 补全）
 *   - WebDAV 网盘：仍然必须走同源代理（NAS 一般不返回 CORS 头，且需要服务端注入 Basic Auth）
 */

const playerLayer = document.getElementById('player-layer');
let iptvPlayer = null;     // 统一播放实例（tesla-media-hub 内置播放库），承载 IPTV 直播与 AppleCMS 点播
let playCtx = null;        // AppleCMS 点播上下文：{ siteKey, vodName, plays, flagIdx, curEp, qualityIdx, urls, lastUrl, isLastEp }
let startupTimer = null;   // 点播首帧超时诊断：黑屏无提示时给出可能原因
let lastFramePaused = false; // 末集/单集：已在最后一秒暂停画面，避免重复暂停与误触发续播
const LAST_FRAME_PAUSE_SEC = 1; // 距离片尾不足该秒数时暂停在末帧

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 将第三方播放地址改写为同源流媒体代理地址，绕过源站防盗链 / 跨域限制。
 * - blob:/data: 等浏览器本地地址原样返回
 * - 已是 /api/stream 的地址（幂等）原样返回，并补齐为绝对 URL
 * - 仅对 http(s) 绝对地址进行代理包装
 * 注意：AVPlayer 在 Web Worker 中拉流，Worker 内无法解析相对 URL，因此必须返回绝对地址。
 */
function proxyUrl(raw) {
  if (!raw) return raw;
  if (/^(blob:|data:)/i.test(raw)) return raw;
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';
  if (raw.indexOf('/api/stream') !== -1) {
    if (/^https?:\/\//i.test(raw)) return raw;
    return origin + raw;
  }
  if (/^https?:\/\//i.test(raw)) return origin + '/api/stream?url=' + encodeURIComponent(raw);
  return raw;
}

// ---------- 浏览器端地址解析 ----------
// 部分 AppleCMS 源给出的不是视频直链，而是一个 HTML 跳转页（形如 /share/xxxx），
// 页面里用 `const url = "/20260924/xxxx/index.m3u8?sign=xxx"` 这样的相对地址指向真实播放地址。
// 服务端解析这条路会被源站按 IP 拦掉（403），所以在浏览器端做：
// 这些跳转页实测都返回 access-control-allow-origin: *，可以跨域 fetch。
const DIRECT_MEDIA_RE = /\.(m3u8|mp4|flv|mkv|ts|webm|mov|mp3|aac|ogg)(\?|#|$)/i;

async function resolvePlayAddress(raw) {
  const url = String(raw || '').trim();
  if (!url || /^(blob|data):/i.test(url)) return url;
  if (DIRECT_MEDIA_RE.test(url)) return url;          // 已是直链，直接用
  if (!/^https?:\/\//i.test(url)) return url;

  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return url;
    const html = await res.text();
    if (!html || !/<(html|!doctype)/i.test(html)) return url;

    const patterns = [
      /url\s*[:=]\s*["']([^"']*\.(?:m3u8|mp4|flv|webm|ts|mkv)[^"']*)["']/i,
      /(?:src|href)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4|flv|webm|ts|mkv)[^"'\s]*)["']/i,
      /(https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4|flv|webm|ts|mkv)[^"'\s<>]*)/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        const found = m[1].trim();
        if (/^https?:\/\//i.test(found)) return found;
        try { return new URL(found, url).toString(); } catch (_) { return found; }
      }
    }
  } catch (e) {
    /* 解析失败按原地址处理 */
  }
  return url;
}

async function openPlayer(ctx) {
  // 销毁可能存在的播放实例（包括 AppleCMS/IPTv 任一模式）
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }
  playCtx = {
    _preferProxy: false,   // AppleCMS 点播默认浏览器直连
    ...ctx,
    curEp: ctx.startEp || 0,
    qualityIdx: -1,
    urls: [],
    lastUrl: '',        // 当前集解析后的真实播放地址
  };
  playerLayer.classList.remove('hidden');
  renderEpStrip();
  await playCurrent();
}

/**
 * 打开 IPTV 频道播放（服务端 ffmpeg 转码推流 → tesla-media-hub 内置播放库拉流）
 * ctx: { sourceId, name, type, streamUrl }
 */
async function openIptvPlayer(ctx) {
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }
  playCtx = null; // 清理可能残留的 applecms 上下文，避免互相干扰

  const driveView = document.getElementById('drive-view');
  const iptvView = document.getElementById('iptv-view');
  const host = document.getElementById('iptv-host');
  const titleEl = document.getElementById('player-title');
  const qBtn = document.getElementById('btn-quality');

  titleEl.textContent = ctx.name || 'IPTV';
  if (qBtn) qBtn.style.display = 'none';

  playerLayer.classList.remove('hidden');
  driveView.classList.add('hidden');
  iptvView.classList.remove('hidden');

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }

  if (!window.IptvAdapter || !window.IptvAdapter.isSupported()) {
    showToast('当前浏览器不支持 WebCodecs（IPTV 播放所需）');
    return;
  }

  showToast('正在加载 ' + (ctx.name || '频道'));
  try {
    iptvPlayer = await window.IptvAdapter.createPlayer(host, ctx.streamUrl, {
      live: true,
      onFirstFrame: () => {
        const t = document.getElementById('toast');
        if (t) t.classList.remove('show');
      },
      onStatus: (msg) => showToast(msg),
      onError: (e) => showToast('播放出错：' + (e && e.message ? e.message : '未知错误')),
      onEnded: () => showToast('直播已结束'),
    });
  } catch (e) {
    showToast('IPTV 播放失败：' + (e && e.message ? e.message : ''));
  }
}
window.openIptvPlayer = openIptvPlayer;

/**
 * 启动 AppleCMS 点播播放（tesla-media-hub 内置播放库，VOD 模式）
 */
async function applyMode() {
  const ctx = playCtx;
  if (!ctx) return;

  const driveView = document.getElementById('drive-view');
  const driveHost = document.getElementById('tesla-host');
  const iptvView = document.getElementById('iptv-view');

  // 切到 AppleCMS 视图（drive-view 容器），隐藏 iptv-view
  iptvView.classList.add('hidden');
  driveView.classList.remove('hidden');
  driveHost.classList.remove('hidden');

  // 销毁可能残留的播放实例
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  if (!window.IptvAdapter || !window.IptvAdapter.isSupported()) {
    showToast('当前浏览器不支持 WebCodecs');
    return;
  }

  // 连接方式：默认按 _preferProxy 决定（AppleCMS=直连，WebDAV=代理）；
  // 一旦 _fallback 被置位，就切换到另一种方式重试。
  const useProxy = ctx._fallback ? !ctx._preferProxy : ctx._preferProxy;
  ctx.lastUrl = useProxy ? proxyUrl(ctx.rawUrl) : ctx.rawUrl;

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  // 首帧超时提示：解码/渲染若静默失败（黑屏无报错），主动给出可能原因
  startupTimer = setTimeout(() => {
    startupTimer = null;
    showToast('首帧等待超时：该片源可能为车机不支持的编码（如 HEVC/H265）或解码缓慢，可尝试切换线路');
  }, 15000);

  try {
    iptvPlayer = await window.IptvAdapter.createPlayer(driveHost, ctx.lastUrl, {
      live: false,
      onFirstFrame: () => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      },
      onError: (e) => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        // 当前方式失败 → 自动切换到另一种连接方式（仅一次）
        if (!ctx._fallback && !ctx._fallbackTried) {
          ctx._fallbackTried = true;
          ctx._fallback = true;
          showToast(useProxy ? '代理失败，改试浏览器直连源站…' : '直连失败，改试同源代理…');
          applyMode();
          return;
        }
        showToast('播放出错：' + (e && e.message ? e.message : '未知错误'));
      },
      // 时间更新：末集/单集在最后一秒暂停画面，保留末帧（不黑屏、不销毁）
      onTime: (currentTime, duration) => {
        const c = playCtx;
        if (!c || !c.isLastEp) return;          // 非末集不处理（由 onEnded 自动续播）
        if (lastFramePaused) return;            // 已暂停，跳过
        if (!duration || duration <= 0) return;  // 直播/时长未知不处理
        if (duration - currentTime <= LAST_FRAME_PAUSE_SEC) {
          lastFramePaused = true;
          try { iptvPlayer && iptvPlayer.pause(); } catch (_) { /* ignore */ }
          showToast('已播至本片结尾（末集）');
        }
      },
      // 播放结束：非末集自动续播下一集；末集由 onTime 已暂停在末帧，此处兜底
      onEnded: () => {
        const c = playCtx;
        if (!c) return;
        if (!c.isLastEp) {
          const next = c.curEp + 1;
          const epsLen = ((c.plays[c.flagIdx] || {}).episodes || []).length;
          if (next < epsLen) {
            showToast('自动播放下一集…');
            switchEp(next);
          }
        } else if (iptvPlayer && !lastFramePaused) {
          // 兜底：极端情况下 onTime 未命中，则在此暂停保持末帧
          lastFramePaused = true;
          try { iptvPlayer.pause(); } catch (_) { /* ignore */ }
        }
      },
    });
  } catch (e) {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (!ctx._fallback && !ctx._fallbackTried) {
      ctx._fallbackTried = true;
      ctx._fallback = true;
      showToast(useProxy ? '代理失败，改试浏览器直连源站…' : '直连失败，改试同源代理…');
      applyMode();
      return;
    }
    showToast('播放失败（浏览器需支持 WebCodecs 且源站允许跨域）：' + (e && e.message ? e.message : ''));
  }
}

function renderEpStrip() {
  const ctx = playCtx;
  const flag = (ctx.plays[ctx.flagIdx] || {});
  const eps = flag.episodes || [];
  const strip = document.getElementById('ep-strip');
  strip.innerHTML = eps
    .map((e, i) => `<button class="ep-mini ${i === ctx.curEp ? 'active' : ''}" onclick="switchEp(${i})">${esc(e.name || '第' + (i + 1) + '集')}</button>`)
    .join('');
  const active = strip.querySelector('.ep-mini.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

async function switchEp(i) {
  const ctx = playCtx;
  const eps = (ctx.plays[ctx.flagIdx] || {}).episodes || [];
  if (i < 0 || i >= eps.length) return;
  ctx.curEp = i;
  renderEpStrip();
  await playCurrent();
}

async function playCurrent(resume) {
  const ctx = playCtx;
  const flag = ctx.plays[ctx.flagIdx] || {};
  const ep = (flag.episodes || [])[ctx.curEp];
  if (!ep) {
    showToast('该线路暂无选集');
    return;
  }
  const title = `${ctx.vodName} · ${ep.name || '第' + (ctx.curEp + 1) + '集'}`;
  document.getElementById('player-title').textContent = title;

  // 是否为当前线路最后一集（或单集）：用于「末集停在末帧」判定
  const eps = (flag.episodes || []);
  ctx.isLastEp = ctx.curEp >= eps.length - 1;
  lastFramePaused = false; // 新的一集重新开始计时

  // WebDAV / 直链播放：跳过 /api/sites 解析，直接使用已提供的真实地址
  if (ctx.directPlay) {
    const epUrl = ep.url || ep.id || '';
    if (!epUrl) { showToast('未获取到播放地址'); return; }
    ctx.rawUrl = epUrl;
    ctx._preferProxy = true;   // WebDAV 必须走同源代理：NAS 无 CORS 头，且需服务端注入 Basic Auth
    ctx._fallback = false;
    ctx._fallbackTried = false;
    ctx.lastUrl = ctx.rawUrl;
    ctx.urls = [{ label: '默认', url: epUrl }];
    ctx.qualityIdx = 0;
    const qBtn = document.getElementById('btn-quality');
    if (qBtn) qBtn.style.display = 'none';
    await applyMode();
    return;
  }

  let res;
  try {
    res = await api(
      `/api/sites/${encodeURIComponent(ctx.siteKey)}/play` +
      `?id=${encodeURIComponent(ep.id || ep.url || '')}`
    );
  } catch (e) {
    showToast('获取播放地址失败：' + e.message);
    return;
  }

  // 服务端解析可能因源站封 IP 而拿不到真实地址（返回的是 HTML 跳转页），
  // 这里在浏览器端再解析一次；已经是直链的会直接返回。
  const fromServer = res.url || ep.url || ep.id || '';
  ctx.rawUrl = await resolvePlayAddress(fromServer);

  // 每次重新解析选集时重置回退状态，优先按默认方式尝试
  ctx._preferProxy = false;  // AppleCMS 点播默认浏览器直连
  ctx._fallback = false;
  ctx._fallbackTried = false;
  ctx.lastUrl = ctx.rawUrl;
  ctx.urls = (res.urls && res.urls.length) ? res.urls : (ctx.rawUrl ? [{ label: res.label || '自动', url: ctx.rawUrl }] : []);
  if (!ctx.urls.length) {
    showToast('未获取到播放地址');
    return;
  }
  ctx.qualityIdx = ctx.urls.length - 1;

  const qBtn = document.getElementById('btn-quality');
  if (ctx.urls.length > 1) {
    qBtn.style.display = '';
    qBtn.textContent = ctx.urls[ctx.qualityIdx].label;
  } else {
    qBtn.style.display = 'none';
  }

  // 用解析出的地址启动 tesla-media-hub 内置播放库解码
  await applyMode();
}

async function cycleQuality() {
  const ctx = playCtx;
  if (!ctx.urls || ctx.urls.length < 2) return;
  ctx.qualityIdx = (ctx.qualityIdx + 1) % ctx.urls.length;
  const q = ctx.urls[ctx.qualityIdx];
  document.getElementById('btn-quality').textContent = q.label;
  ctx.rawUrl = await resolvePlayAddress(q.url);
  ctx.lastUrl = ctx.rawUrl;
  ctx._fallback = false;
  ctx._fallbackTried = false;
  await applyMode(); // 重建播放实例以装载新清晰度
  showToast('已切换：' + q.label);
}

function closePlayer() {
  // 所有清理均 try/catch，确保最终必能关闭播放层返回页面
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  // 清理播放器容器内的 canvas/控件，保留 view 容器（drive-view/iptv-view），避免下次打开叠加
  try {
    const driveHost = document.getElementById('tesla-host');
    const iptvHost = document.getElementById('iptv-host');
    if (driveHost) driveHost.innerHTML = '';
    if (iptvHost) iptvHost.innerHTML = '';
    document.getElementById('drive-view').classList.add('hidden');
    document.getElementById('iptv-view').classList.add('hidden');
  } catch (e) { /* ignore */ }

  // 清空选集条，释放 DOM 与播放缓存
  try { document.getElementById('ep-strip').innerHTML = ''; } catch (e) { /* ignore */ }

  playCtx = null;
  lastFramePaused = false;
  playerLayer.classList.add('hidden');
}

// WebDAV / 直链播放入口：streamUrl 为真实源站地址（未代理），由 applyMode 统一走 /api/stream 代理 + 回退直连
function playWebdav(streamUrl, name) {
  openPlayer({
    vodName: name || 'WebDAV',
    poster: '',
    plays: [{ flag: 'WebDAV', episodes: [{ name: name || 'WebDAV', url: streamUrl }] }],
    flagIdx: 0,
    startEp: 0,
    directPlay: true,
  });
}
window.playWebdav = playWebdav;

// 暴露给 app.js 使用
window.openPlayer = openPlayer;
window.switchEp = switchEp;
window.cycleQuality = cycleQuality;
window.closePlayer = closePlayer;
