/**
 * 主应用：hash 路由 + 页面渲染（源 → 站点 → 内容 → 详情 → 播放）
 */

const app = document.getElementById('app');

// ---------- 工具 ----------
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function setTitle(title, sub) {
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-sub').textContent = sub || '';
}

function showModal(html) {
  const el = document.getElementById('modal');
  el.innerHTML = html;
  el.classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}
window.closeModal = closeModal;

// ---------- 路由 ----------
const navStack = [];
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, queryStr] = h.split('?');
  const query = {};
  if (queryStr) new URLSearchParams(queryStr).forEach((v, k) => { query[k] = v; });
  return { path, query };
}
function go(hash) {
  navStack.push(location.hash.slice(1) || '/');
  location.hash = hash;
}
function historyBack() {
  const prev = navStack.pop();
  if (prev) location.hash = prev;
  else location.hash = '/';
}
window.historyBack = historyBack;
window.go = go;

async function render() {
  const { path } = parseHash();
  const segs = path.split('/').filter(Boolean);
  // 首页整体作为落地页：顶栏（只有返回键和站名）在首页没有意义，隐藏掉把整屏留给内容
  document.body.classList.toggle('is-home', segs.length === 0);
  try {
    if (!segs.length) await renderHome();
    else if (segs[0] === 'browse') await renderBrowse(decodeURIComponent(segs[1]));
    else if (segs[0] === 'detail') await renderDetail(decodeURIComponent(segs[1]), decodeURIComponent(segs[2]));
    else if (segs[0] === 'webdav') await renderWebdav(decodeURIComponent(segs[1] || ''));
    else if (segs[0] === 'iptv') {
      app.innerHTML = '<div class="empty">IPTV 功能已禁用（本部署已移除）</div>';
    }
    else await renderHome();
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn primary" onclick="go('/')">返回首页</button></div>`;
  }
}
window.addEventListener('hashchange', render);

// ============================================================
// 封面图：从 public/covers/ 里挑
//   · 有 covers/manifest.json 就用它列出的文件（可写任意文件名）
//   · 否则按命名约定自动探测 cover-1 / cover-2 / cover-3 …（必须从 1 开始连续）
//   · 一张都没有时，用卡片自带的渐变底兜底，界面照样完整
// ============================================================
const COVER_DIR = 'covers/';
const COVER_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const COVER_PROBE_MAX = 12;   // 走命名约定时最多探测到第几张
let coverPool = null;   // 封面清单（只加载一次）
let coverPick = null;   // 本次随机分配结果（同一页面内保持不变，刷新才重挑）

/**
 * 判断某个封面文件是否真的存在。
 * 注意：本项目在 wrangler.toml 里开了 not_found_handling = "single-page-application"，
 * 不存在的路径会返回 200 + index.html，所以只看状态码会把所有路径都判成"存在"，
 * 必须再校验 content-type 是 image/*。
 */
async function coverExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'force-cache' });
    if (!r.ok) return false;
    return (r.headers.get('content-type') || '').startsWith('image/');
  } catch (_) { return false; }
}

/**
 * 读取封面清单。两级策略：
 *   ① covers/manifest.json —— 一次请求拿全（推荐，也是最快路径）
 *   ② 没有清单时才按 cover-1/2/3… 命名约定探测
 * 这个函数**不参与首屏渲染**，调用方拿到结果后再把图贴上去。
 */
async function loadCovers() {
  if (coverPool) return coverPool;
  const found = [];
  try {
    const r = await fetch(COVER_DIR + 'manifest.json', { cache: 'force-cache' });
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.indexOf('json') >= 0) {
      const j = await r.json();
      const arr = (Array.isArray(j) ? j : (j && j.list) || [])
        .filter((s) => typeof s === 'string' && s.trim());
      arr.forEach((s) => found.push(/^(https?:)?\/\//.test(s) ? s : COVER_DIR + s.replace(/^\/+/, '')));
    }
  } catch (_) { /* 没有清单就走命名约定 */ }
  if (found.length) { coverPool = found; return found; }

  // 命名约定兜底：所有候选**并行**探测。
  // 之前是串行 for-await，6 张图要等 19 个来回（3 个扩展名 × 6 张 + 收尾 1 次），
  // 首页会被硬生生拖慢好几秒 —— 这是实测出来的数字，别改回串行。
  const tasks = [];
  for (let i = 1; i <= COVER_PROBE_MAX; i++) {
    for (const e of COVER_EXTS) {
      const url = `${COVER_DIR}cover-${i}.${e}`;
      tasks.push(coverExists(url).then((ok) => (ok ? { i: i, url: url } : null)));
    }
  }
  const hits = await Promise.all(tasks);
  const byIndex = {};
  hits.forEach((h) => { if (h && !byIndex[h.i]) byIndex[h.i] = h.url; });
  for (let i = 1; i <= COVER_PROBE_MAX; i++) {
    if (!byIndex[i]) break;        // 命名必须从 1 开始连续
    found.push(byIndex[i]);
  }
  coverPool = found;
  return found;
}

/** 随机分配给各个入口；图片张数不够时循环复用 */
function assignCovers(pool, n) {
  const out = new Array(n).fill('');
  if (!pool.length) return out;
  const bag = pool.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }
  for (let i = 0; i < n; i++) out[i] = bag[i % bag.length];
  return out;
}

// ---------- 首页：数据源海报轮播（仅切换用，管理在 /admin） ----------
// 顶栏在首页隐藏，中间是一排可左右无限循环的海报卡片；
// 每张海报背景随机取自 covers/（图片失效时自动退回渐变底，不会出现破图）。
function carSlideHtml(e, cover, k) {
  const glyph = `<div class="car-glyph">${esc((e.name || '?').slice(0, 1))}</div>`;
  const img = cover
    ? `<img class="car-img" src="${esc(cover)}" alt="" loading="lazy" onload="this.classList.add('is-loaded')" onerror="this.remove()">`
    : '';
  return `
    <div class="car-slide" data-k="${k}">
      <div class="car-card">
        <div class="car-art car-art-${(k % 6) + 1}"></div>
        ${glyph}
        ${img}
        <div class="car-scrim"></div>
        <div class="car-body">
          <span class="badge">${esc(e.badge)}</span>
          <div class="car-name">${esc(e.name)}</div>
          <div class="car-cta"><span>进入</span><span class="car-cta-arrow">›</span></div>
        </div>
      </div>
    </div>`;
}

async function renderHome() {
  setTitle('选择数据源', '');
  const data = await api('/api/sources').catch(() => ({ list: [] }));
  const entries = (data.list || [])
    .filter((s) => String(s.type || '').toLowerCase() !== 'iptv')   // CF 版已移除 IPTV
    .map((s) => ({
      kind: 'src',
      id: s.id,
      type: s.type,
      name: s.name || '未命名源',
      meta: s.url || '',
      badge: s.type === 'applecms' ? 'AppleCMS' : String(s.type || '源'),
    }));
  entries.push({ kind: 'dav', id: '__webdav__', name: 'WebDAV 网盘', meta: '播放网盘内 .mp4 / .strm', badge: '网盘' });

  CAR.entries = entries;
  CAR.n = entries.length;
  // 首屏不等封面：先用「CSS 兜底画面」立刻渲染，封面图到了再贴上去（见 applyCovers）。
  // 之前这里是 `await loadCovers()`，等于把首屏卡在网络请求上 —— 首页变慢就是它。
  if (!coverPick || coverPick.length !== entries.length) coverPick = assignCovers(coverPool || [], entries.length);

  // 同一个列表渲染三份，滑动到边缘时无动画跳回中间一份，实现"无限循环"
  let slides = '';
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < entries.length; i++) {
      slides += carSlideHtml(entries[i], coverPick[i], r * entries.length + i);
    }
  }

  const hisArr = hisRead();
  app.innerHTML = `
    ${hisArr.length ? `
    <div class="his-wrap">
      <div class="section-title his-title">继续观看
        <button class="his-clear" onclick="clearHistory()">清空</button>
      </div>
      <div class="his-row">${hisArr.map(hisCardHtml).join('')}</div>
    </div>` : ''}
    <div class="home-hero">
      <div class="home-hero-title">选择数据源</div>
      <div class="home-hero-sub">共 ${entries.length} 个入口 · 左右滑动切换</div>
    </div>
    <div class="carousel">
      <div class="car-viewport" id="car-viewport">
        <div class="car-track" id="car-track">${slides}</div>
      </div>
      <button class="car-arrow car-prev" onclick="carStep(-1)" aria-label="上一个">‹</button>
      <button class="car-arrow car-next" onclick="carStep(1)" aria-label="下一个">›</button>
      <div class="car-dots" id="car-dots"></div>
    </div>
    <div class="home-hint">点中间那张卡片进入 · 两侧轻点可居中</div>`;

  carInit();
  applyCovers();

  // 封面清单只在本次访问里拉一次；拉回来后再把图贴到已经渲染好的卡片上
  if (!coverPool) {
    loadCovers().then((pool) => {
      coverPool = pool;
      if (!document.getElementById('car-track')) return;   // 已经离开首页了
      coverPick = assignCovers(pool, entries.length);
      applyCovers();
    }).catch(() => { /* 封面拿不到就用兜底画面，不影响使用 */ });
  }
}

/**
 * 把封面图贴到已经渲染好的卡片上。
 * 因为首屏是先渲染兜底画面、不等网络，图片必须单独补。这个函数同时负责三件事：
 *   · 卡片上还没有 img 就建一个（插在压暗层之前）
 *   · 有 img 但地址不对就换地址
 *   · 图片已进入缓存（complete）但 onload 没触发时，补上显示状态，避免一直不可见
 */
function applyCovers() {
  const track = document.getElementById('car-track');
  if (!track || !CAR.n) return;
  for (let i = 0; i < track.children.length; i++) {
    const slide = track.children[i];
    const card = slide.firstElementChild;
    if (!card) continue;
    const url = (coverPick && coverPick[Number(slide.dataset.k) % CAR.n]) || '';
    let img = card.querySelector('.car-img');
    if (!url) {
      if (img) img.remove();
      continue;
    }
    if (!img) {
      img = document.createElement('img');
      img.className = 'car-img';
      img.alt = '';
      img.loading = 'lazy';
      img.onload = function () { this.classList.add('is-loaded'); };
      img.onerror = function () { this.remove(); };
      const scrim = card.querySelector('.car-scrim');
      card.insertBefore(img, scrim);
    }
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
    if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded');
  }
}

// ============================================================
// 首页轮播：无限循环 + 自动播放 + 箭头 / 圆点 / 滑动 / 键盘
// ============================================================
const CAR = { entries: [], n: 0, idx: 0, step: 0, timer: null, paused: false, dragMoved: false, bound: false };

function carLayout(animate) {
  const track = document.getElementById('car-track');
  const vp = document.getElementById('car-viewport');
  if (!track || !vp || !CAR.n || !track.children.length) return;
  const cs = getComputedStyle(track);
  const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
  // 必须用 offsetWidth：侧边卡片带 scale(.85)，getBoundingClientRect()
  // 返回的是"缩放后"的宽度，会算歪居中位置。
  const w = track.children[0].offsetWidth || 0;
  if (!w) return;
  CAR.step = w + gap;
  // 让当前卡片始终居中
  const offset = vp.clientWidth / 2 - w / 2 - CAR.idx * CAR.step;
  if (!animate) track.style.transition = 'none';
  track.style.transform = `translate3d(${Math.round(offset)}px,0,0)`;
  if (!animate) { void track.offsetWidth; track.style.transition = ''; }
  for (let i = 0; i < track.children.length; i++) {
    const el = track.children[i];
    const d = Math.abs(i - CAR.idx);
    el.classList.toggle('is-active', d === 0);
    el.classList.toggle('is-near', d === 1);
  }
  carDots();
}

function carDots() {
  const dots = document.getElementById('car-dots');
  if (!dots || !CAR.n) return;
  const cur = ((CAR.idx % CAR.n) + CAR.n) % CAR.n;
  if (dots.children.length !== CAR.n) {
    let h = '';
    for (let i = 0; i < CAR.n; i++) h += `<button class="car-dot" onclick="carGoto(${i})" aria-label="第 ${i + 1} 个"></button>`;
    dots.innerHTML = h;
  }
  for (let i = 0; i < dots.children.length; i++) dots.children[i].classList.toggle('on', i === cur);
}

/**
 * 把越界的 idx 归位到中间那一份。
 * 这一步不能省：回位原本只挂在 transitionend 上，用户连点箭头 / 连续滑动时
 * 动画被打断，transitionend 不触发，idx 就会一路顶到轨道尽头（右边没有卡片了，
 * 露出空白 —— 也就是"循环首位接不上"）。归位放在每次移动之前做，任何入口都不会漏。
 * 因为相邻一份的内容完全一样，归位不产生任何可见跳变。
 */
function carNormalize() {
  if (!CAR.n) return;
  if (CAR.idx < CAR.n || CAR.idx >= CAR.n * 2) {
    CAR.idx = ((CAR.idx % CAR.n) + CAR.n) % CAR.n + CAR.n;
    carLayout(false);
  }
}

function carSet(i, animate) {
  if (!CAR.n) return;
  CAR.idx = Math.max(1, Math.min(CAR.n * 3 - 2, i));
  carLayout(animate !== false);
  carAuto();
}
function carStep(dir) { carNormalize(); carSet(CAR.idx + dir, true); }
function carGoto(i) {
  carNormalize();
  const cur = CAR.idx - CAR.n;        // 归位后，中间份的起点就是逻辑下标 0
  let d = i - cur;
  if (d > CAR.n / 2) d -= CAR.n;      // 走最近的绕行方向，避免绕远路
  if (d < -CAR.n / 2) d += CAR.n;
  carSet(CAR.idx + d, true);
}
window.carStep = carStep;
window.carGoto = carGoto;

function carAuto() {
  if (CAR.timer) { clearInterval(CAR.timer); CAR.timer = null; }
  if (!CAR.n || CAR.n < 2) return;   // 只有一个入口就不轮播
  CAR.timer = setInterval(() => {
    if (CAR.paused || document.hidden) return;
    carStep(1);                      // 走 carStep，自动播放一样会先归位
  }, 5200);
}

/** 点最中间那张卡：进入对应源（网盘入口直接进网盘） */
function carEnter(k) {
  const e = (CAR.entries || [])[k % (CAR.n || 1)];
  if (!e) return;
  if (e.kind === 'dav') return go('/webdav');
  enterSource(e.id, e.type);
}
window.carEnter = carEnter;

function carInit() {
  const track = document.getElementById('car-track');
  const vp = document.getElementById('car-viewport');
  if (!track || !vp || !CAR.n) return;
  CAR.idx = CAR.n;                 // 从中间那一份的开头开始，两边都有余量
  carLayout(false);
  requestAnimationFrame(() => carLayout(false));
  carAuto();

  // 注意：首页每次渲染都是整块 innerHTML 替换，track / viewport 都是全新元素，
  // 所以这些监听必须每次都绑在新元素上（旧元素随替换被丢弃，不会堆积）。
  // 之前把它们放在"只绑一次"的分支里，导致从浏览页返回首页后 点击/循环回跳 全部失效。
  track.addEventListener('transitionend', (e) => {
    if (e.target !== track || e.propertyName !== 'transform' || !CAR.n) return;
    if (CAR.idx >= CAR.n * 2) { CAR.idx -= CAR.n; carLayout(false); }
    else if (CAR.idx < CAR.n) { CAR.idx += CAR.n; carLayout(false); }
    carDots();
  });

  let sx = 0, sy = 0, down = false;
  vp.addEventListener('pointerenter', () => { CAR.paused = true; });
  vp.addEventListener('pointerdown', (e) => { down = true; sx = e.clientX; sy = e.clientY; CAR.paused = true; CAR.dragMoved = false; });
  vp.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) CAR.dragMoved = true;
  });
  const endDrag = (e) => {
    if (!down) return;
    down = false;
    CAR.paused = false;
    const dx = (e && typeof e.clientX === 'number') ? e.clientX - sx : 0;
    const dy = (e && typeof e.clientY === 'number') ? e.clientY - sy : 0;
    if (Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy)) carStep(dx < 0 ? 1 : -1);
  };
  vp.addEventListener('pointerup', endDrag);
  vp.addEventListener('pointercancel', endDrag);
  vp.addEventListener('pointerleave', () => { down = false; CAR.paused = false; });

  // 点侧边卡片 → 居中；点中间卡片 → 进入（拖动过就不算点击）
  track.addEventListener('click', (e) => {
    const slide = e.target.closest('.car-slide');
    if (!slide || CAR.dragMoved) return;
    const k = Number(slide.dataset.k);
    if (slide.classList.contains('is-active')) carEnter(k);
    else carSet(k, true);
  });

  // 全局监听只绑一次
  if (CAR.bound) return;
  CAR.bound = true;
  window.addEventListener('resize', () => { if (document.getElementById('car-track')) carLayout(false); });
  window.addEventListener('keydown', (e) => {
    if (!document.getElementById('car-track')) return;
    if (e.key === 'ArrowLeft') carStep(-1);
    else if (e.key === 'ArrowRight') carStep(1);
  });
}

// ============================================================
// 观看记录：存在浏览器本地（localStorage），最多留最近 3 条
// ============================================================
const HIS_KEY = 'tmh_watch_history';
const HIS_MAX = 3;

function hisRead() {
  try {
    const arr = JSON.parse(localStorage.getItem(HIS_KEY) || '[]');
    // 这里也截断一次：万一存储被外部写多了，界面也只认最近 3 条
    return Array.isArray(arr) ? arr.filter((x) => x && x.key).slice(0, HIS_MAX) : [];
  } catch (_) { return []; }
}
function hisWrite(arr) {
  try { localStorage.setItem(HIS_KEY, JSON.stringify(arr.slice(0, HIS_MAX))); } catch (_) { /* 无痕模式忽略 */ }
}
/** 写入/置顶一条记录（同一部片只留一条，重复观看会顶到最前） */
function hisPush(item) {
  if (!item || !item.key) return;
  const arr = hisRead().filter((x) => x.key !== item.key);
  arr.unshift(item);
  hisWrite(arr);
}

function hisCardHtml(it, i) {
  const pic = (it.kind === 'dav' || !it.poster)
    ? ''
    : `/api/proxy/image?url=${encodeURIComponent(it.poster)}`;
  const tag = it.epName || (it.kind === 'dav' ? '网盘' : '');
  return `
    <div class="his-card" onclick="resumeHistory(${i})">
      <div class="his-art">
        ${pic ? `<img src="${pic}" loading="lazy" onerror="this.style.display='none'">` : ''}
        <span class="his-play"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 5.4v13.2L19 12z" fill="currentColor"/></svg></span>
        ${tag ? `<span class="his-tag">${esc(tag)}</span>` : ''}
      </div>
      <div class="his-name">${esc(it.vodName || it.name || '')}</div>
    </div>`;
}

function clearHistory() {
  hisWrite([]);
  showToast('已清空观看记录');
  render();
}
window.clearHistory = clearHistory;

/** 点记录直接回到播放：重新拉一次详情，定位到上次那一集 */
async function resumeHistory(i) {
  const it = hisRead()[i];
  if (!it) return;
  if (it.kind === 'dav') {
    showToast('正在打开网盘文件…');
    try {
      const data = await api('/api/dav/play?path=' + encodeURIComponent(it.davPath));
      if (!data.url) return showToast('未获取到播放地址');
      hisPush(Object.assign({}, it, { ts: Date.now() }));
      playWebdav(data.url, it.name);
    } catch (e) { showToast(e.message); }
    return;
  }
  showToast('正在恢复播放…');
  try {
    const data = await api(`/api/sites/${encodeURIComponent(it.siteKey)}/detail?id=${encodeURIComponent(it.vodId)}`);
    const plays = data.plays || [];
    if (!plays.length) throw new Error('该影片暂无可用线路');
    let flagIdx = Math.min(it.flagIdx || 0, plays.length - 1);
    if (!((plays[flagIdx] || {}).episodes || []).length) {
      const k = plays.findIndex((p) => p.episodes && p.episodes.length);
      flagIdx = k >= 0 ? k : 0;
    }
    const eps = (plays[flagIdx] || {}).episodes || [];
    if (!eps.length) throw new Error('该影片暂无可用选集');
    const epIdx = Math.min(it.epIdx || 0, eps.length - 1);
    detailState.siteKey = it.siteKey;
    detailState.vodId = it.vodId;
    detailState.data = data;
    detailState.plays = plays;
    detailState.flagIdx = flagIdx;
    hisPush(Object.assign({}, it, {
      vodName: data.vod_name || it.vodName,
      poster: data.vod_pic || it.poster,
      flagIdx,
      epIdx,
      epName: (eps[epIdx] || {}).name || it.epName,
      ts: Date.now(),
    }));
    openPlayer({
      siteKey: it.siteKey,
      vodId: it.vodId,
      vodName: data.vod_name || it.vodName,
      poster: data.vod_pic || it.poster,
      plays,
      flagIdx,
      startEp: epIdx,
    });
  } catch (e) {
    showToast('恢复失败：' + (e.message || e));
    go(`/detail/${encodeURIComponent(it.siteKey)}/${encodeURIComponent(it.vodId)}`);
  }
}
window.resumeHistory = resumeHistory;

// player.js 每次真正开始播一集时回调（含切集、自动续播下一集），用于写观看记录
window.onTmhPlay = function (info) {
  try {
    if (!info || info.isDav || !info.siteKey || !info.vodId) return;
    hisPush({
      kind: 'vod',
      key: `vod:${info.siteKey}:${info.vodId}`,
      siteKey: info.siteKey,
      vodId: String(info.vodId),
      vodName: info.vodName || '',
      poster: info.poster || '',
      flagIdx: info.flagIdx || 0,
      epIdx: info.epIdx || 0,
      epName: info.epName || '',
      ts: Date.now(),
    });
  } catch (_) { /* 记录失败不影响播放 */ }
};

/** 根据源类型进入对应浏览页：applecms → 站点浏览；iptv 已禁用 */
function enterSource(sourceId, type) {
  if (String(type || '').toLowerCase() === 'iptv') {
    showToast('IPTV 功能已禁用（本部署已移除）');
    return;
  }
  enterSourceBrowse(sourceId);
}
window.enterSource = enterSource;

// ---------- IPTV 频道列表 ----------
const iptvState = { sourceId: '', sourceName: '', channels: [] };

function enterIptv(sourceId) {
  go(`/iptv/${encodeURIComponent(sourceId)}`);
}
window.enterIptv = enterIptv;

async function renderIptv(sourceId) {
  iptvState.sourceId = sourceId;
  setTitle('加载中…', '');
  app.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const data = await api(`/api/iptv/channels?sourceId=${encodeURIComponent(sourceId)}`);
    iptvState.sourceName = (data.source && data.source.name) || '';
    iptvState.channels = data.channels || [];
    setTitle(iptvState.sourceName || 'IPTV', `共 ${iptvState.channels.length} 个频道`);
    renderIptvContent();
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn primary" onclick="go('/')">返回首页</button></div>`;
  }
}

function renderIptvContent() {
  const list = iptvState.channels;
  const grid = list.length
    ? `<div class="card-grid">${list.map((c) => channelCardHtml(c)).join('')}</div>`
    : '<div class="empty">该 IPTV 源未解析到可用频道<br>（请检查 M3U 地址与格式）</div>';
  app.innerHTML = `
    <div class="page-title">${esc(iptvState.sourceName || 'IPTV')} · 频道列表</div>
    ${grid}`;
}

function channelCardHtml(c) {
  const meta = [String(c.type || '').toUpperCase()];
  if (c.transcode) meta.push('转码');
  if (!c.transcode && c.direct) meta.push('直连');
  return `
    <div class="card vod-card" onclick="playIptvChannel('${esc(iptvState.sourceId)}','${esc(c.id)}')">
      <div class="poster"><div class="remarks">${esc(meta.join(' '))}</div></div>
      <div class="v-name">${esc(c.name)}</div>
    </div>`;
}

function playIptvChannel(sourceId, channelId) {
  const ch = iptvState.channels.find((c) => String(c.id) === String(channelId));
  if (!ch) return showToast('频道不存在');
  // IPTV 流默认需管理员 token（服务端 IPTV_AUTH=true）；从本地存储取，与管理后台同源共享
  let token = '';
  try { token = localStorage.getItem('media_hub_admin_token') || ''; } catch (_) { /* ignore */ }
  const streamUrl =
    ch.playUrl + (ch.playUrl.includes('?') ? '&' : '?') +
    'sid=' + Date.now().toString(36) + Math.random().toString(36).slice(2) +
    (token ? '&token=' + encodeURIComponent(token) : '');
  openIptvPlayer({ sourceId, name: ch.name, type: ch.type, streamUrl });
}
window.playIptvChannel = playIptvChannel;

/** 点击源：解析站点后直接进入首个站点浏览（多站支持浏览页顶栏切换） */
async function enterSourceBrowse(sourceId) {
  try {
    const data = await api(`/api/sources/${sourceId}/sites`);
    const sites = data.list || [];
    if (!sites.length) return showToast('该源无可用站点');
    browseState.sites = sites;
    enterSite(encodeURIComponent(sites[0].key));
  } catch (e) {
    showToast(e.message);
  }
}
window.enterSourceBrowse = enterSourceBrowse;

function enterSite(encodedKey) {
  // 调用方已 encodeURIComponent，这里不再二次编码（避免 :: 被双重编码导致服务端解析失败）
  go(`/browse/${encodedKey}`);
}
window.enterSite = enterSite;

// ---------- 内容浏览 ----------
const browseState = { siteKey: '', classes: [], cat: '', page: 1, pagecount: 1, mode: 'home', wd: '' };

async function renderBrowse(siteKey) {
  browseState.siteKey = siteKey;
  browseState.cat = '';
  browseState.page = 1;
  browseState.mode = 'home';
  browseState.wd = '';
  setTitle('加载中…', '');
  app.innerHTML = '<div class="loading">加载中…</div>';

  // 并行加载：首页内容 + 当前源下全部站点（用于"切换站点"）
  const idx = siteKey.indexOf('::');
  const sourceId = idx < 0 ? siteKey : siteKey.slice(0, idx);
  const [home, sitesRes] = await Promise.all([
    api(`/api/sites/${encodeURIComponent(siteKey)}/home`).catch(() => ({ classes: [], list: [] })),
    api(`/api/sources/${sourceId}/sites`).catch(() => ({ list: [] })),
  ]);
  browseState.classes = home.classes || [];
  browseState.pagecount = 1;
  browseState.sites = (sitesRes && sitesRes.list) || [];
  setTitle('浏览', browseState.sites.length > 1 ? `共 ${browseState.sites.length} 个站点可切换` : '');
  renderBrowseContent(home.list || []);
}

function searchRowHtml() {
  return `
    <div class="search-row">
      <input id="search-input" placeholder="搜索影视名称" value="${esc(browseState.wd)}">
      <button onclick="doSearch()">搜索</button>
    </div>`;
}

function renderBrowseContent(list) {
  const switchSiteBtn = (browseState.sites && browseState.sites.length > 1)
    ? `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn" style="min-height:40px;padding:0 14px;font-size:14px" onclick="showSwitchSite()">⇆ 切换站点</button></div>`
    : '';
  const catBar = `
    <div class="cat-bar">
      <button class="cat ${browseState.cat === '' ? 'active' : ''}" onclick="selectCat('')">全部</button>
      ${browseState.classes.map((c) => `
        <button class="cat ${browseState.cat === String(c.type_id) ? 'active' : ''}" onclick="selectCat('${esc(String(c.type_id))}')">${esc(c.type_name)}</button>`).join('')}
    </div>`;

  const grid = list.length
    ? `<div class="card-grid">${list.map((v) => vodCardHtml(v)).join('')}</div>`
    : '<div class="empty">暂无内容</div>';

  const pager = browseState.pagecount > 1
    ? `<div class="pager">
        <button class="btn" onclick="changePage(-1)" ${browseState.page <= 1 ? 'disabled style="opacity:.4"' : ''}>上一页</button>
        <span class="info">${browseState.page} / ${browseState.pagecount}</span>
        <button class="btn" onclick="changePage(1)" ${browseState.page >= browseState.pagecount ? 'disabled style="opacity:.4"' : ''}>下一页</button>
      </div>`
    : '';

  app.innerHTML = switchSiteBtn + searchRowHtml() + catBar + grid + pager;
}

function vodCardHtml(v) {
  const pic = v.vod_pic ? `/api/proxy/image?url=${encodeURIComponent(v.vod_pic)}` : '';
  const vodId = encodeURIComponent(String(v.vod_id));
  return `
    <div class="card vod-card" onclick="enterDetail('${encodeURIComponent(browseState.siteKey)}','${vodId}')">
      <div class="poster">
        ${pic ? `<img src="${pic}" loading="lazy" onerror="this.style.display='none'">` : ''}
        ${v.vod_remarks ? `<div class="remarks">${esc(v.vod_remarks)}</div>` : ''}
      </div>
      <div class="v-name">${esc(v.vod_name)}</div>
    </div>`;
}

function enterDetail(siteKey, vodId) {
  go(`/detail/${siteKey}/${vodId}`);
}
window.enterDetail = enterDetail;

async function selectCat(cat) {
  browseState.cat = cat;
  browseState.mode = 'category';
  browseState.page = 1;
  await loadList();
}
window.selectCat = selectCat;

async function doSearch() {
  const input = document.getElementById('search-input');
  const wd = input ? input.value.trim() : '';
  if (!wd) return showToast('请输入搜索关键词');
  browseState.wd = wd;
  browseState.mode = 'search';
  browseState.page = 1;
  await loadList();
}
window.doSearch = doSearch;

async function changePage(delta) {
  browseState.page = Math.max(1, browseState.page + delta);
  await loadList();
}
window.changePage = changePage;

// ---------- 切换站点 ----------
function showSwitchSite() {
  const sites = browseState.sites || [];
  if (sites.length <= 1) return showToast('该源只有 1 个站点');
  const current = browseState.siteKey;
  const cards = sites.map((s) => `
    <div class="card source-card" style="cursor:pointer;border-color:${s.key===current?'var(--accent)':''}" onclick="switchSite('${encodeURIComponent(s.key)}')">
      <span class="badge ${s.sourceType}">${s.sourceType === 'applecms' ? 'AppleCMS' : esc(s.sourceType)}</span>
      <div class="card-title">${esc(s.name)}</div>
      <div class="card-meta">${esc(s.api)}</div>
    </div>`).join('');
  showModal(`
    <div class="modal-body">
      <h3>切换站点</h3>
      ${cards}
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div>`);
}
window.showSwitchSite = showSwitchSite;

function switchSite(encodedKey) {
  closeModal();
  enterSite(encodedKey);
}
window.switchSite = switchSite;

async function loadList() {
  const key = encodeURIComponent(browseState.siteKey);
  let url;
  if (browseState.mode === 'search') {
    url = `/api/sites/${key}/search?wd=${encodeURIComponent(browseState.wd)}&page=${browseState.page}`;
  } else {
    url = `/api/sites/${key}/category?cat=${encodeURIComponent(browseState.cat)}&page=${browseState.page}`;
  }
  try {
    const data = await api(url);
    browseState.pagecount = Math.max(1, Number(data.pagecount || 1));
    renderBrowseContent(data.list || []);
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- 详情页 ----------
const detailState = { siteKey: '', vodId: '', data: null, plays: [], flagIdx: 0 };

async function renderDetail(siteKey, vodId) {
  detailState.siteKey = siteKey;
  detailState.vodId = vodId;
  setTitle('详情', '');
  app.innerHTML = '<div class="loading">加载中…</div>';
  const data = await api(`/api/sites/${encodeURIComponent(siteKey)}/detail?id=${encodeURIComponent(vodId)}`);
  detailState.data = data;
  detailState.plays = data.plays || [];
  const firstWithEp = detailState.plays.findIndex((p) => p.episodes && p.episodes.length);
  detailState.flagIdx = firstWithEp >= 0 ? firstWithEp : 0;
  setTitle(data.vod_name || '', data.type_name || '');
  renderDetailContent();
}

function renderDetailContent() {
  const data = detailState.data || {};
  const plays = detailState.plays;
  const flagIdx = detailState.flagIdx;
  const flag = plays[flagIdx] || {};
  const eps = flag.episodes || [];
  const pic = data.vod_pic ? `/api/proxy/image?url=${encodeURIComponent(data.vod_pic)}` : '';

  const infoLines = [];
  if (data.vod_score) infoLines.push(`评分 ${esc(data.vod_score)}`);
  if (data.vod_year) infoLines.push(esc(data.vod_year));
  if (data.vod_area) infoLines.push(esc(data.vod_area));
  if (data.type_name) infoLines.push(esc(data.type_name));

  app.innerHTML = `
    <div class="detail-head">
      <div class="poster">${pic ? `<img src="${pic}" onerror="this.style.display='none'">` : ''}</div>
      <div class="detail-info">
        <div class="d-title">${esc(data.vod_name)}</div>
        <div class="d-line">${infoLines.join(' · ') || '&nbsp;'}</div>
        <div class="d-line">导演：${esc(data.vod_director || '-')}</div>
        <div class="d-line">主演：${esc(data.vod_actor || '-')}</div>
      </div>
    </div>
    <div class="detail-desc">${esc(data.vod_content || '暂无简介')}</div>
    ${plays.length > 1 ? `
      <div class="section-title">播放线路</div>
      <div class="tab-bar">
        ${plays.map((p, i) => `<button class="tab ${i === flagIdx ? 'active' : ''}" onclick="switchDetailFlag(${i})">${esc(p.flag || '线路' + (i + 1))}</button>`).join('')}
      </div>` : ''}
    <div class="section-title">选集（共 ${eps.length} 集）</div>
    <div class="ep-grid">
      ${eps.length ? eps.map((e, i) => `<button class="ep" onclick="playNow(${i})">${esc(e.name || '第' + (i + 1) + '集')}</button>`).join('') : '<div class="empty">暂无选集（该站点可能需要特殊解析，无法直接播放）</div>'}
    </div>
    <div style="height:20px"></div>`;
}

function switchDetailFlag(i) {
  detailState.flagIdx = i;
  renderDetailContent();
}
window.switchDetailFlag = switchDetailFlag;

function playNow(epIdx) {
  openPlayer({
    siteKey: detailState.siteKey,
    vodId: detailState.vodId,           // 供"观看记录"定位（player.js 原样带回）
    vodName: (detailState.data || {}).vod_name || '',
    poster: (detailState.data || {}).vod_pic || '',
    plays: detailState.plays,
    flagIdx: detailState.flagIdx,
    startEp: epIdx,
  });
}
window.playNow = playNow;

// ---------- WebDAV 网盘浏览 ----------
let webdavItems = [];
async function renderWebdav(subPath) {
  const path = subPath || '/';
  setTitle('WebDAV 网盘', path);
  app.innerHTML = '<div class="loading">加载中…</div>';
  let data;
  try {
    data = await api('/api/dav?path=' + encodeURIComponent(path));
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn primary" onclick="go('/')">返回首页</button></div>`;
    return;
  }
  const items = data.items || [];
  webdavItems = items;
  const up = path !== '/' ? `<div style="margin-bottom:8px"><button class="btn" onclick="go('/webdav')">↑ 根目录</button></div>` : '';
  const grid = items.length
    ? `<div class="card-grid">${items.map((it, idx) => webdavItemHtml(it, idx)).join('')}</div>`
    : '<div class="empty">该目录为空</div>';
  app.innerHTML = `
    <div class="page-title">WebDAV 网盘 · ${esc(path)}</div>
    ${up}${grid}`;
}
function webdavItemHtml(it, idx) {
  if (it.isDir) {
    return `<div class="card vod-card" onclick="go('/webdav/${encodeURIComponent(it.path.replace(/^\/+/, ''))}')">
      <div class="poster"><div class="remarks">文件夹</div></div>
      <div class="v-name">${esc(it.name)}</div></div>`;
  }
  const tag = it.playable ? '▶ 可播放' : '文件';
  return `<div class="card vod-card" onclick="playWebdavByIndex(${idx})">
    <div class="poster"><div class="remarks">${esc(tag)}</div></div>
    <div class="v-name">${esc(it.name)}</div></div>`;
}
function playWebdavByIndex(idx) {
  const it = webdavItems[idx];
  if (!it) return;
  if (!it.playable) return showToast('该文件类型暂不支持播放（仅 .mp4 / .strm 等）');
  showToast('获取播放地址…');
  (async () => {
    try {
      const data = await api('/api/dav/play?path=' + encodeURIComponent(it.path));
      if (!data.url) return showToast('未获取到播放地址');
      hisPush({ kind: 'dav', key: 'dav:' + it.path, davPath: it.path, name: it.name, vodName: it.name, epName: '网盘', ts: Date.now() });
      playWebdav(data.url, it.name);
    } catch (e) { showToast(e.message); }
  })();
}
window.playWebdavByIndex = playWebdavByIndex;

// ---------- 启动 ----------
render();
