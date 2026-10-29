/**
 * dsh-douyin-audio —— 浏览器半端（**设置里的一页**）
 * ============================================================================
 * ⭐ 这套机制是从样板 ai/bili/dsh-bili-extract/package/client.js 里抄的，结论：
 *
 * 1) client bundle **不是 ESM，是自注册脚本**（样板 4-9 / 28-30 / 841 行）：
 *
 *        window.__ModuleLoader__.load({
 *          id: '<包名>',                     // 必须等于 package.json 的 name
 *          factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *        })
 *
 * 2) **怎么进「设置」**（样板 811-826 行）：
 *
 *        return { inject: ['slots'], apply(ctx) { ... } }
 *        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
 *        slots.inject('settings.section', () => slots.register(
 *          { name: 'settings.section', id: 'douyin-audio', order: 31, label: '大肥鱼刷抖音网页版' },
 *          () => h(Panel),                   // label = 左侧导航里那一项
 *        ))
 *    ＋ 样式走 document.head.appendChild(<style data-plugin-css>)，用 ctx.effect 登记卸载（样板 813-818 行）。
 *
 * 3) **怎么和 host 半端通信**（样板 34-48 行）：**同源 fetch + JSON**，没有 websocket、没有事件总线；
 *    credentials: 'same-origin'，而且**一定要看 res.ok** —— 样板原先直接 .json()，
 *    HTTP 500 的 {ok:false,error} 会被当成「已保存」把故障盖掉（样板 35-41 行的注释就是那次踩坑）。
 *    本文件对应的 host 路由（由 index.js 实现）：
 *        GET  /douyin-audio/config              -> { ok, config }
 *        POST /douyin-audio/config {key,value}  -> { ok, config }
 *        POST /douyin-audio/run    {action,count?,limit?} -> { ok, ...结果 }
 *        GET  /douyin-audio/qr                   -> image/png（qr 模式的二维码，同源直显）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-audio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/douyin-audio'
    /* ⚠️ 不看 res.ok 就会把 HTTP 500 的 {ok:false,error} 当成成功（样板 35-41 行的坑） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）'
        : res.status === 403 ? '（被宿主拦了）'
          : res.status === 404 ? '（这版宿主还没这个路由）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    /* 同源鉴权：插件的 HTTP 路由带一道同源门（Sec-Fetch-Site / Origin / 一次性 token 三选一）。
       token 在第一次请求前取一次，之后每个请求都带 x-dsh-douyin-token；取不到就退化成不带 ——
       同源请求本来就靠 Sec-Fetch-Site / Origin 过门，不会因为拿不到 token 就全挂。 */
    let authToken = ''
    const authHeaders = () => (authToken ? { 'x-dsh-douyin-token': authToken } : {})
    const ensureToken = async () => {
      if (authToken) return authToken
      try {
        const r = await fetch(API + '/token', { credentials: 'same-origin' })
        if (r.ok) {
          const j = await r.json()
          if (j && typeof j.token === 'string' && j.token) authToken = j.token
        }
      } catch { /* 取不到就退化成不带：门那边还有同源判据兜着 */ }
      return authToken
    }
    const jget = async (p) => {
      await ensureToken()
      return asJson(await fetch(API + p, { credentials: 'same-origin', headers: authHeaders() }))
    }
    const jpost = async (p, body) => {
      await ensureToken()
      return asJson(await fetch(API + p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body || {}),
      }))
    }
    /* 二维码用 <img> 取：<img> 带不了请求头，token 走查询参数（服务端同源门两种都认） */
    const qrUrl = (tick) => API + '/qr?t=' + tick + (authToken ? '&token=' + encodeURIComponent(authToken) : '')
    /* ⚠️ 别叫 msg —— Panel 里的 msg 是状态名，会在函数作用域里把它盖掉（setState 那次就是踩这个） */
    const errText = (e) => String((e && e.message) || e || '未知错误')

    const CSS = `
[data-dy-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-dy-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dy-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dy-grow]{flex:1;min-width:0;}
[data-dy-label]{font-size:13px;}
[data-dy-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-hint]{font-size:11px;line-height:16px;color:#f59e0b;}
[data-dy-hint][data-dy-ok]{color:#22c55e;}
[data-dy-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dy-input]:focus{outline:none;border-color:#3b82f6;}
[data-dy-num]{width:88px;text-align:center;}
[data-dy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dy-sw][data-on]{background:#3b82f6;}
[data-dy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-dy-sw][data-on] i{left:19px;}
[data-dy-sw][disabled]{opacity:.45;cursor:default;}
[data-dy-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-dy-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dy-btn][disabled]{opacity:.5;cursor:default;}
[data-dy-btn][data-missing]{border-color:rgba(245,158,11,.55);color:#f59e0b;}
[data-dy-sub]{display:block;font-size:10px;line-height:12px;opacity:.6;font-weight:400;}
[data-dy-opt]{display:flex;align-items:center;gap:4px;}
[data-dy-del]{padding:7px 8px;line-height:1;}
[data-dy-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-msg][data-warn]{color:#f59e0b;}
[data-dy-msg][data-good]{color:#22c55e;}
[data-dy-qr]{width:200px;height:200px;border-radius:8px;background:#fff;object-fit:contain;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));}
[data-dy-out]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:260px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-acct]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 6px;font-size:11px;
  line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-acct][data-known] [data-dy-acct-nick]{color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600;}
[data-dy-acct] [data-dy-acct-label]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-acct] [data-dy-acct-at]{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:10px;}
[data-dy-mask]{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;
  justify-content:center;z-index:60;}
[data-dy-modal]{width:min(460px,86vw);border-radius:12px;padding:14px 16px;
  background:var(--dsw-alias-bg-layer-2,#25272b);
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));box-shadow:0 12px 32px rgba(0,0,0,.45);}
[data-dy-modal] [data-dy-modal-title]{font-size:13px;font-weight:600;
  color:var(--dsw-alias-label-primary,#e8eaed);margin-bottom:6px;}
[data-dy-advice]{margin:6px 0 0;padding:8px 10px;border-radius:8px;font-size:11px;line-height:17px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.10));}
[data-dy-advice] [data-dy-advice-item]{color:var(--dsw-alias-label-secondary,#c9ccd1);}
/* ── 顶栏：徽章 + 刷一轮（抄刷B站那页的样子）── */
[data-dy-bar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));}
[data-dy-bar-badges]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0;}
[data-dy-badge]{font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;white-space:nowrap;
  font-family:inherit;cursor:pointer;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-badge]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-badge][data-static]{cursor:default;}
[data-dy-badge][data-static]:hover{background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));}
[data-dy-badge][data-good]{color:#22c55e;border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.12);}
[data-dy-badge][data-warn]{color:#f59e0b;border-color:rgba(245,158,11,.45);background:rgba(245,158,11,.12);}
[data-dy-badge][disabled]{opacity:.5;cursor:default;}
/* ── 标签栏：跟 [data-dy-btn] 同一套变量，只是选中态换成「页签」形状 ── */
[data-dy-tabs]{display:flex;align-items:flex-end;gap:4px;flex-wrap:wrap;
  border-bottom:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));}
[data-dy-tab]{padding:6px 13px;border-radius:8px 8px 0 0;font-size:12px;cursor:pointer;font-family:inherit;
  white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa0a6);background:transparent;
  border:1px solid transparent;border-bottom:0;margin-bottom:-1px;}
[data-dy-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));}
[data-dy-tab][data-active]{color:inherit;cursor:default;
  border-color:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));}
[data-dy-tab][data-active]:hover{background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));}
[data-dy-tabbody]{display:flex;flex-direction:column;gap:18px;}
[data-dy-layout]{display:flex;align-items:center;gap:4px;}
[data-dy-layout] [data-dy-btn]{padding:5px 9px;font-size:11px;}
[data-dy-quota]{font-size:13px;line-height:18px;}
[data-dy-progress]{font-size:11px;line-height:16px;color:#3b82f6;}
[data-dy-hist]{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;padding:7px 9px;
  border-radius:8px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.10));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));}
[data-dy-hist-item]{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
[data-dy-hist-at]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-hist-dir]{color:var(--dsw-alias-label-secondary,#c9ccd1);word-break:break-all;flex:1;min-width:0;}
[data-dy-hist-ok]{color:#22c55e;}
[data-dy-hist-bad]{color:#f59e0b;}
/* ── 装入配置环境：扫描结果小表 + 单选框 ── */
[data-dy-table]{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.10));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.10));}
[data-dy-tablerow]{display:flex;gap:8px;font-size:11px;line-height:16px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
[data-dy-tablek]{flex:none;width:52px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-tablev]{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-radio]{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;}
[data-dy-radio][data-off]{opacity:.5;cursor:default;}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-dy-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-dy-row': '' },
        h('div', { 'data-dy-grow': '' },
          h('div', { 'data-dy-label': '' }, label),
          note ? h('div', { 'data-dy-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    /* 能力等级的一行：等级名 + 一句说明（含风险）+ 开关；
       hint = 前置等级没开时的提示（只提示，不禁用开关）；badge = 「上级已开」的绿色说明 */
    function TierRow({ title, note, hint, badge, on, onChange, disabled }) {
      return h('div', { 'data-dy-row': '' },
        h('div', { 'data-dy-grow': '' },
          h('div', { 'data-dy-label': '' }, title),
          note ? h('div', { 'data-dy-note': '' }, note) : null,
          hint ? h('div', { 'data-dy-hint': '' }, hint) : null,
          badge ? h('div', { 'data-dy-hint': '', 'data-dy-ok': '' }, badge) : null),
        h(Switch, { on, onChange, disabled }))
    }

    /* 四个能力的定义（顺序 = 等级顺序；needRead = 依赖 ① 只读） */
    const TIERS = [
      { key: 'tierRead', title: '① 只读', note: '看热榜、搜视频、读视频详情和评论列表 —— 只读不写，不动你账号里的任何东西' },
      { key: 'tierNotify', title: '② 通知', note: '读私信、拉通知摘要 —— 风险：能看到你账号收到的私信内容' },
      { key: 'tierReact', title: '③A 轻互动（点赞收藏）', note: '点赞、收藏、取消 —— 风险：会动你账号的互动记录，但可撤回', needRead: true },
      { key: 'tierComment', title: '③B 评论回复', note: '发评论、回复 —— 风险：会以你的账号公开发言，发出去收不回', needRead: true },
      { key: 'tierPublish', title: '④ 发布', note: '上传视频到抖音 —— 风险：会向你的账号上传视频', needRead: true },
    ]

    /* 结果区：等宽字体，接口原样回什么就贴什么（出错时的原因也一起贴，别只剩一句"失败了"） */
    const show = (r) => {
      try { return JSON.stringify(r, null, 2) } catch (e) { return String(r) }
    }

    /* 运行痕迹里的时间：ms 数或 ISO 串都吃；认不出来就原样贴，别显示 Invalid Date */
    const fmtAt = (at) => {
      if (at === null || at === undefined || at === '') return '—'
      const d = new Date(typeof at === 'number' ? at : String(at))
      if (isNaN(d.getTime())) return String(at)
      const p = (n) => (n < 10 ? '0' + n : String(n))
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    /* ── 顶栏徽章：只从 douyin_status 的返回里推，不猜 ──────────────────────────
       注意① ok:false 不代表「状态没拿到」—— 环境缺的时候 pyScroll 那些字段照旧返回，
             所以判断「是不是状态体」看字段，不看 ok。
       注意② 找不到的项返回的是 '(未找到…)' 这种占位字符串（truthy），不能只判真假。 */
    const isStatusPayload = (r) => !!(r && typeof r === 'object'
      && ('pythonScroll' in r || 'pythonAsr' in r || 'videos' in r || 'cookie' in r))
    /* 占位文案 '(未找到…)' 与空串都算缺；有真路径才算有 */
    const hasEnvValue = (v) => typeof v === 'string' && v.trim() !== '' && v.indexOf('未找到') < 0

    /* 环境四件套：X 只取三个中文名（两个 Python 缺项都叫 Python），顺序 = 报缺的顺序 */
    const ENV_PARTS = [
      { name: 'Python', why: 'Python(playwright) 没找到', has: (s) => hasEnvValue(s.pythonScroll) },
      { name: 'Python', why: 'Python(sherpa_onnx) 没找到', has: (s) => hasEnvValue(s.pythonAsr) },
      { name: 'ffmpeg', why: 'ffmpeg 没找到', has: (s) => hasEnvValue(s.ffmpeg) },
      { name: '转写模型', why: '转写模型目录不存在', has: (s) => !!(s.modelDir && s.modelDir.exists) },
    ]

    /** 四枚徽章：{ text, tone(good|warn|''), act(env|login|null), title } */
    function statusBadges(s, acct) {
      const envObj = s && s.env && typeof s.env === 'object' ? s.env : null
      const pyPath = String((s && s.cfg && s.cfg.pythonPath) || '').trim()
      const miss = ENV_PARTS.filter((p) => !p.has(s))
      /* 「装入配置环境」三档：
         venv 可用 = 插件自己的解释器就绪（路径固定，跟 pythonPath 配没配无关）→ 直接算环境就绪；
         没 venv 但扫到能复用的 Python、pythonPath 还空着 → 提示去一键配置（这是唯一需要人点一下的状态）。 */
      let env
      if (envObj && envObj.venvUsable) {
        env = { text: '环境就绪', tone: 'good', act: 'env', title: '插件 venv 可用（playwright + sherpa 都在）' + (envObj.basePython ? '，基于 ' + envObj.basePython : '') + '（点这里重跑自检）' }
      } else if (envObj && envObj.canReusePython && !pyPath) {
        env = { text: '环境未配置（可一键配置）', tone: 'warn', act: 'env', title: '本机已有可用 Python' + (envObj.reusePythonPath ? '：' + envObj.reusePythonPath : '') + '，但 pythonPath 还空着 —— 去「环境与诊断」页点「一键配置环境」' }
      } else if (miss.length) {
        env = { text: '环境缺 ' + miss[0].name, tone: 'warn', act: 'env', title: miss.map((p) => p.why).join('；') + '（点这里跳到「装入配置环境」）' }
      } else {
        env = { text: '环境就绪', tone: 'good', act: 'env', title: '四件套都在（点这里跳到「装入配置环境」）' }
      }
      /* ⚠️ 只按 cookie 文件在不在说，不写「已登录」—— 真实登录态我们确认不了 */
      /* 账号昵称：优先用界面刚 whoami 到的，其次用状态里缓存的 */
      const nick = (acct && acct.known && acct.nick) ? String(acct.nick) : ''
      const login = s.cookie && s.cookie.exists
        ? {
          text: nick ? '已登录 · ' + nick : '已登录',
          tone: nick ? 'good' : '',
          act: 'login',
          title: nick
            ? '登录账号：' + nick + (acct && acct.uid ? '（抖音号 ' + acct.uid + '）' : '') + ' —— 点这里跳到登录区'
            : 'cookie 文件已就绪，但还没识别账号 —— 点这里跳到登录区，那里有【识别账号】',
        }
        : { text: '未登录', tone: 'warn', act: 'login', title: 'cookie 文件还没写出来 —— 点这里跳到「登录」区块扫码' }
      const n = Array.isArray(s.videos) ? s.videos.length : 0
      const videos = n > 0
        ? { text: '已下载 ' + n + ' 条', tone: '', act: null, title: '本地 videos 目录里有 ' + n + ' 个 mp4' }
        : { text: '本地无视频', tone: '', act: null, title: '本地 videos 目录里还没有 mp4' }
      const raw = s.version ? String(s.version) : ''
      const ver = { text: raw ? (/^v/i.test(raw) ? raw : 'v' + raw) : 'v?', tone: '', act: null, title: raw ? '插件版本' : '宿主没回版本号（package.json 没读到）' }
      return [env, login, videos, ver]
    }

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      const [form, setForm] = React.useState(null)      // 数字/路径的本地草稿（null = 还没从配置填过）
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [out, setOut] = React.useState(null)        // 结果显示区（null = 还没跑过）
      const [sys, setSys] = React.useState(null)        // 本机核数（null = 还没问到；cores:0 = 没问到，降级）
      const [login, setLogin] = React.useState(null)    // 登录状态（douyin_login_poll / start 的原样返回）
      const [qrTick, setQrTick] = React.useState(0)     // 二维码时间戳：每轮询一次换一个，绕过浏览器缓存
      const [st, setSt] = React.useState(null)          // douyin_status 的原样返回（顶栏徽章的数据源）
      const [stErr, setStErr] = React.useState('')      // 状态没拿到时的原因（拿到了就空串）
      const [tab, setTab] = React.useState('collect')   // 当前标签页（默认「采集」）
      const [duty, setDuty] = React.useState(null)      // douyin_duty status 的原样返回（「采集」页额度行的数据源）
      const [dutyErr, setDutyErr] = React.useState('')  // duty 状态没拿到时的原因
      const [hist, setHist] = React.useState(null)      // 「它刷过什么」= 运行记录（null = 没展开）
      const [histBusy, setHistBusy] = React.useState(false)
      const [dutyRunning, setDutyRunning] = React.useState(false)  // 「现在刷一轮」跑着的时候禁用按钮
      const loginRef = React.useRef(null)               // 「登录」区块：点登录徽章要滚到这里
      const envRef = React.useRef(null)                 // 「装入配置环境」区块：点环境徽章要滚到这里
      const [scanBusy, setScanBusy] = React.useState(false)   // 「扫描已安装的浏览器」跑着的时候
      const [scanMsg, setScanMsg] = React.useState('')        // 扫描结果一句话（检测到 Edge、Chrome）
      const [extraOpen, setExtraOpen] = React.useState(false) // 「手动添加」的内联输入区开着没
      const [extraPath, setExtraPath] = React.useState('')    // 手动添加：浏览器可执行文件路径
      const [extraName, setExtraName] = React.useState('')    // 手动添加：可选名称
      const [deletedExtras, setDeletedExtras] = React.useState({})   // 刚删掉的自定义项（宿主那份 status 还是旧的，本地先藏起来）
      /* 「装入配置环境」：默认只露一个「一键配置环境」，其余全在「高级选项」里 */
      const [setupBusy, setSetupBusy] = React.useState('')      // '' | auto | install | scan | env
      const [autoRes, setAutoRes] = React.useState(null)        // 安装结论（前台返回或 env.setupResult）
      const [scanRes, setScanRes] = React.useState(null)        // setup_scan 的原样返回（inventory 小表）
      const [advOpen, setAdvOpen] = React.useState(false)       // 「高级选项」展开没（默认收起）
      const [advMode, setAdvMode] = React.useState('minimal')   // 高级选项里的精简 / 完整
      const [forceVenv, setForceVenv] = React.useState(false)   // 强制新建 venv（不复用已有 Python）
      const [installMsg, setInstallMsg] = React.useState('')    // 「安装中…（几分钟）」
      const [logOpen, setLogOpen] = React.useState(false)       // setup.log 展开没
      const [upd, setUpd] = React.useState(null)                // 检查更新结果（null = 还没查）
      const [acct, setAcct] = React.useState(null)              // 登录账号（{known,nick,uid}）
      const [acctBusy, setAcctBusy] = React.useState(false)
      const [updAsk, setUpdAsk] = React.useState(false)          // 升级确认弹窗开着没
      const [updApply, setUpdApply] = React.useState(null)       // 点「立即升级」后的宿主回执
      const [updBusy, setUpdBusy] = React.useState(false)

      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }

      /* 通用复制：成功返回 true（navigator.clipboard 不可用时退回 execCommand） */
      const copyText = async (text) => {
        try { await navigator.clipboard.writeText(text); return true } catch (e) { /* 兜底 */ }
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand && document.execCommand('copy')
          document.body.removeChild(ta)
          return !!ok
        } catch (e2) { return false }
      }

      /* 识别账号：跑一次 whoami（读个人页昵称，约 10-15 秒）。silent=true 时只在顶栏更新，不刷提示 */
      const doWhoami = async (silent) => {
        if (acctBusy) return
        setAcctBusy(true)
        try {
          const r = await jpost('/run', { action: 'whoami' })
          if (r && r.ok && r.nick) {
            setAcct({ known: true, nick: r.nick, uid: r.uid || '' })
            if (!silent) say('已识别账号：' + r.nick + (r.uid ? '（抖音号 ' + r.uid + '）' : ''), 'good')
          } else {
            setAcct({ known: false, nick: '', uid: '', error: (r && (r.error || r.reason)) || '没读到账号' })
            if (!silent) say('没识别到账号：' + ((r && (r.error || r.reason)) || 'cookie 可能已过期'), 'warn')
          }
        } catch (e) {
          setAcct({ known: false, nick: '', uid: '', error: errText(e) })
          if (!silent) say('识别账号失败：' + errText(e), 'warn')
        } finally {
          setAcctBusy(false)
        }
      }

      /* 用户点「立即升级」：宿主侧判断安装方式，npm 版才真跑 npm install */
      const doApplyUpdate = async (action) => {
        setUpdBusy(true)
        try {
          const r = await jpost('/update', { action: action || 'apply' })
          setUpdApply(r && typeof r === 'object' ? r : { ok: false, message: '宿主没回执' })
          say((r && r.message) || '已请求升级', r && r.ok ? 'good' : 'warn')
        } catch (e) {
          setUpdApply({ ok: false, message: errText(e) })
          say('升级请求失败：' + errText(e), 'warn')
        } finally {
          setUpdBusy(false)
        }
      }

      /* 检查更新：silent=true 只在顶栏标记，不打断说话（挂载时先静默查一次） */
      const checkUpd = async (silent) => {
        if (updBusy) return
        setUpdBusy(true)
        try {
          const r = await jget('/update')
          const res = r && typeof r === 'object' ? r : { ok: false, error: '宿主没回检查结果' }
          setUpd(res)
          if (silent) return
          const from = res.source ? '（来自 ' + res.source + '）' : ''
          if (res.ok && res.hasUpdate) say('有新版本 v' + res.latest + '（当前 v' + res.current + '）' + from + ' —— 点徽章复制升级命令', 'warn')
          else if (res.ok) say('已是最新：v' + res.current + from, 'good')
          else say('检查更新失败：' + (res.error || '原因不详'), 'warn')
        } catch (e) {
          setUpd({ ok: false, error: errText(e) })
          if (!silent) say('检查更新失败：' + errText(e), 'warn')
        } finally {
          setUpdBusy(false)
        }
      }

    /** 把结果区原文复制到剪贴板；navigator.clipboard 不可用时退回 execCommand */
    const copyOut = async () => {
      const text = out == null ? '' : String(out)
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        say('已复制结果到剪贴板', 'good')
        return
      } catch (e) { /* 落到下面兜底 */ }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand && document.execCommand('copy')
        document.body.removeChild(ta)
        say(ok ? '已复制结果到剪贴板' : '复制失败：请手动选中结果区文本', ok ? 'good' : 'warn')
      } catch (e2) { say('复制失败：' + errText(e2), 'warn') }
    }

      const reload = async () => {
        try {
          const r = await jget('/config')
          if (r && r.ok && r.config) { setCfg(r.config); setFails(0) }
          else { setFails((n) => n + 1); say('读不到设置：' + ((r && r.error) || '宿主没回 config'), 'warn') }
        } catch (e) { setFails((n) => n + 1); say('读不到设置：' + errText(e), 'warn') }
      }
      React.useEffect(() => { reload() }, [])
      /* 挂载时静默查一次更新：有新版本就在顶栏亮一枚徽章，不打断任何操作 */
      React.useEffect(() => { checkUpd(true) }, [])
      /* 挂载时读账号缓存；从没识别过且有 cookie → 后台静默识别一次（约 10 秒，不打断） */
      React.useEffect(() => {
        let live = true
        jget('/account')
          .then((r) => {
            if (!live) return
            if (r && r.known && r.nick) setAcct({ known: true, nick: r.nick, uid: r.uid || '' })
            else if (st && st.cookie && st.cookie.exists) doWhoami(true)
          })
          .catch(() => { /* 读不到就让用户手动点 */ })
        return () => { live = false }
      }, [st && st.cookie ? st.cookie.exists : false])
      /* 线程数提示：按本机核数算建议区间，别再写死「8–16」——14 核的机器填 16 会被夹取，说法与事实不符 */
      const threadHint = (cores) => {
        if (!(cores > 0)) {
          return '没读到本机核数（宿主这版没有 /sysinfo 路由）：按 1–64 填，建议不超过一半（越大越快，但会占满 CPU）'
        }
        const hi = cores
        const lo = Math.min(hi, Math.max(2, Math.floor(cores / 2)))
        return '本机 ' + cores + ' 逻辑核；建议 ' + lo + '–' + hi + '（越大越快，但会占满 CPU）'
      }

      /* 建议区：把结果里的原始 JSON 翻译成「下一步该点什么」，不重复贴数据 */
      const adviceFor = (raw) => {
        if (raw === null || raw === undefined) {
          return ['还没跑过 —— 先点【自检】看本机缺什么；缺依赖就点【一键配置环境】补齐']
        }
        let o = raw
        if (typeof raw === 'string') { try { o = JSON.parse(raw) } catch { return [] } }
        if (!o || typeof o !== 'object') return []
        const gone = (v) => typeof v === 'string' && v.indexOf('未找到') >= 0
        const out = []
        const isSelfCheck = o.env !== undefined || o.pythonScroll !== undefined
        if (isSelfCheck) {
          if (gone(o.pythonScroll) || gone(o.pythonAsr)) {
            out.push('Python 依赖缺失 → 点【一键配置环境】（装 playwright + sherpa-onnx，首次几分钟、要联网）')
          }
          if (gone(o.ffmpeg)) out.push('缺 ffmpeg（转写要用）→ 用【一键配置环境】的「完整」模式，或把 ffmpeg.exe 放进 ~/.dsh/bin')
          if (o.modelDir && o.modelDir.exists === false) out.push('缺 SenseVoice 模型（约 200MB）→「完整」模式会下到 ~/.dsh/models')
          if (o.cookie && o.cookie.exists === false) out.push('还没登录 → 点【开始登录】，真窗口那条最稳')
          const sc = o.browsers && Array.isArray(o.browsers.shortcuts) ? o.browsers.shortcuts : []
          if (sc.length) out.push('发现可选浏览器：' + sc.map((s) => s.name).join('、') + ' → 在「浏览器内核」里一键添加')
          if (o.ok === true) out.push('环境齐全 → 点【刷 1 屏】试跑一条，确认能下载')
          return out
        }
        if (o.ok === false) {
          return ['这次失败：' + String(o.error || o.reason || '看上面的原始结果') + ' → 按上面第一条修完再试']
        }
        return []
      }

      /* 建议区渲染：没有可说的就不占位置 */
      const adviceBlock = (raw) => {
        const items = adviceFor(raw)
        if (!items.length) return null
        return h('div', { 'data-dy-advice': '' },
          h('div', { 'data-dy-h': '' }, '建议'),
          items.map((t, i) => h('div', { 'data-dy-advice-item': '', key: 'adv-' + i }, '· ' + t)))
      }

      /* 只读端点：拿本机逻辑核数，给线程数输入框定上限。旧宿主没有 /sysinfo -> 走降级（1–64），不报错 */
      React.useEffect(() => {
        let live = true
        jget('/sysinfo')
          .then((r) => {
            if (!live) return
            const cores = r && r.ok ? Math.floor(Number(r.cores)) : 0
            setSys({ cores: Number.isFinite(cores) && cores > 0 ? cores : 0, totalMemGB: (r && r.totalMemGB) || 0 })
          })
          .catch(() => { if (live) setSys({ cores: 0, totalMemGB: 0 }) })
        return () => { live = false }
      }, [])
      /* 登录轮询：只有 waiting / scanned 才每 3 秒问一次 douyin_login_poll；出结果（ok/expired/error）就停 */
      React.useEffect(() => {
        const phase = login && login.phase
        if (phase !== 'waiting' && phase !== 'scanned') return undefined
        let live = true
        const id = setInterval(async () => {
          try {
            const r = await jpost('/run', { action: 'login_poll' })
            if (!live) return
            const p = (r && r.phase) || 'error'
            setLogin(r || null)
            setQrTick((n) => n + 1)      // 换时间戳 = 让 <img> 重新去拉最新那张 qr.png
            if (p === 'ok') say('已登录，cookie 已写入', 'good')
            else if (p === 'expired') say('登录：二维码过期了，点「开始登录」重新来一次', 'warn')
            else if (p === 'error') say('登录：' + ((r && r.message) || '出错了'), 'warn')
          } catch (e) {
            if (!live) return
            setLogin({ phase: 'error', message: errText(e) })
            say('登录状态读不到：' + errText(e), 'warn')
          }
        }, 3000)
        return () => { live = false; clearInterval(id) }
      }, [login && login.phase])

      React.useEffect(() => {
        if (cfg && form === null) {
          setForm({
            count: Number(cfg.count),
            delay: Number(cfg.delay),
            downloadTimeout: Number(cfg.downloadTimeout),
            pythonPath: cfg.pythonPath == null ? '' : String(cfg.pythonPath),
            // 旧宿主可能没有 asrThreads（/config 里缺这个键）→ 回落到 8，别渲染成 NaN
            asrThreads: Number.isFinite(Number(cfg.asrThreads)) ? Number(cfg.asrThreads) : 8,
            // 谷时自动刷的两个新键：旧宿主没有就退回契约里的默认值，别渲染成 NaN / undefined
            dutyWindow: cfg.dutyWindow == null ? '12:00-14:00,18:00-23:59' : String(cfg.dutyWindow),
            dailyLimit: Number.isFinite(Number(cfg.dailyLimit)) ? Number(cfg.dailyLimit) : 5,
          })
        }
      }, [cfg, form])

      const patch = async (key, value, what) => {
        setBusy(key)
        try {
          const r = await jpost('/config', { key, value })
          if (r && r.ok && r.config) { setCfg(r.config); setFails(0) }
          if (r && r.ok) say((what || key) + '：已保存', 'good')
          else say((what || key) + '：没存进去 —— ' + ((r && r.error) || '宿主没回 config'), 'warn')
        } catch (e) { say((what || key) + '：' + errText(e), 'warn') }
        finally { setBusy('') }
      }

      /* ── 浏览器内核 browserChannel ─────────────────────────────────────────
            三个会起浏览器的脚本（scroll / read / login）用它。
            ⭐ 列表里只放真能用的：已知安装路径命中的内核 + 快捷方式扫出来的 + 手动添加的 + 当前选中值。
               每项都标来源：已知安装路径（名字 + 路径）/（从快捷方式发现）/（手动添加，带 × 可删）。
               classic 与 tabs 只有外面那层 h('div',{data-dy-sec}) 不同，内容共用这一份。 */
      const KERNELS = [
        { key: 'msedge', label: 'Edge', install: 'npx playwright install msedge', sub: '系统安装的 Microsoft Edge（最稳）' },
        { key: 'chrome', label: 'Chrome', install: 'npx playwright install chrome', sub: '系统安装的 Google Chrome' },
        { key: 'chromium', label: '内置 Chromium', install: 'npx playwright install chromium', sub: 'Playwright 自带的 chromium（容易被风控）' },
        { key: 'firefox', label: 'Firefox', install: 'npx playwright install firefox', sub: 'Playwright 的 firefox（指纹弱于真实 Edge）' },
        { key: 'webkit', label: 'WebKit', install: 'npx playwright install webkit', sub: 'Playwright 的 webkit（最容易撞验证码）' },
      ]
      const kernelOf = (k) => KERNELS.find((x) => x.key === String(k || '').trim().toLowerCase()) || null
      /** 配置值原样保留：五个已知内核 / 自定义项 id（custom-N）/ 一个 exe 路径（快捷方式项）；空 / 其它未知值按 msedge */
      const channelOf = (c) => {
        const v = String((c && c.browserChannel) || '').trim()
        if (!v) return 'msedge'
        if (kernelOf(v)) return v.toLowerCase()
        if (/^custom-/i.test(v) || /\.exe$/i.test(v) || /[\\/]/.test(v)) return v
        return 'msedge'
      }
      /** douyin_status 的 browsers：没拿到（或形状不对）就 null —— 不知道 ≠ 没装 */
      const browsersOf = (s) => (s && s.browsers && typeof s.browsers === 'object' && !Array.isArray(s.browsers) ? s.browsers : null)
      const browsersNow = browsersOf(st)
      const pathsNow = () => (browsersNow && browsersNow.paths && typeof browsersNow.paths === 'object' ? browsersNow.paths : {})
      const shortcutsNow = () => (browsersNow && Array.isArray(browsersNow.shortcuts)
        ? browsersNow.shortcuts.filter((x) => x && x.path && x.name) : [])
      /** cfg.browserExtras 本地解析：手动添加完不用等下一次扫描就能在列表里看到 */
      const extrasFromCfg = () => {
        try {
          const v = JSON.parse(String((cfg && cfg.browserExtras) || '[]'))
          if (!Array.isArray(v)) return []
          return v.filter((x) => x && typeof x === 'object' && String(x.path || '').trim())
            .map((x, i) => ({ id: String(x.id || '') || 'custom-' + (i + 1), label: String(x.label || '') || '自定义 ' + (i + 1), path: String(x.path).trim(), exists: null }))
        } catch { return [] }
      }
      /** 手动添加项：本地配置打底，扫描结果里的 exists 覆盖上去 */
      const extrasNow = () => {
        const map = new Map()
        for (const e of extrasFromCfg()) map.set(e.id, e)
        for (const e of (browsersNow && Array.isArray(browsersNow.extras) ? browsersNow.extras : [])) {
          if (!e || !e.id) continue
          map.set(e.id, { ...(map.get(e.id) || {}), ...e })
        }
        return [...map.values()].filter((e) => !deletedExtras[e.id])
      }
      /** 这个已知内核装没装（paths 优先，老宿主只有布尔值也认） */
      const kernelPath = (k) => {
        const p = pathsNow()[k]
        return p ? String(p) : ''
      }
      /** 可选列表：[{ key, label, sub, source, missing, id? }]；key 就是 patch 进 browserChannel 的值 */
      const channelOptions = () => {
        const cur = channelOf(cfg)
        const list = []
        const push = (o) => { if (!list.some((x) => String(x.key).toLowerCase() === String(o.key).toLowerCase())) list.push(o) }
        for (const k of KERNELS) {
          const p = kernelPath(k.key)
          if (p) push({ key: k.key, label: k.label, sub: p, source: 'known', missing: false })
        }
        for (const s of shortcutsNow()) push({ key: String(s.path), label: String(s.name), sub: String(s.path) + '（从快捷方式发现）', source: 'shortcut', missing: false })
        for (const e of extrasNow()) {
          if (e.exists === false) continue
          push({ key: e.id, label: e.label, sub: String(e.path) + '（手动添加）', source: 'extra', missing: false, id: e.id })
        }
        if (!list.some((x) => x.key === cur)) {
          // 当前选中值也得出现（哪怕探测不到）—— 否则配置了 firefox 的人在界面里找不到自己选的那个
          const k = kernelOf(cur)
          const e = extrasNow().find((x) => x.id === cur)
          const s = shortcutsNow().find((x) => String(x.path).toLowerCase() === String(cur).toLowerCase())
          list.push({
            key: cur,
            label: k ? k.label : (e ? e.label : (s ? String(s.name) : cur)),
            sub: k ? k.sub : String(e ? e.path : (s ? s.path : cur)),
            source: k ? 'known' : (e ? 'extra' : 'shortcut'),
            missing: true,
            id: e ? e.id : undefined,
          })
        }
        return list
      }
      /** 当前选中项探测得到吗 */
      const curMissing = () => {
        const cur = channelOf(cfg)
        const k = kernelOf(cur)
        if (k) return !kernelPath(k.key) && !(browsersNow && browsersNow[k.key] === true)
        const e = extrasNow().find((x) => x.id === cur)
        if (e) return e.exists === false
        return false
      }
      /** 说明行用：当前选中项的名字 + 路径 + 为什么「不走内核候选链」 */
      const selectedInfo = () => {
        const cur = channelOf(cfg)
        const k = kernelOf(cur)
        if (k) return { label: k.label, path: kernelPath(k.key), note: '' }
        const e = extrasNow().find((x) => x.id === cur)
        if (e) return { label: e.label, path: String(e.path), note: '手动添加的浏览器，不走内核候选链（直接 --browser-executable 起它）' }
        const s = shortcutsNow().find((x) => String(x.path).toLowerCase() === String(cur).toLowerCase())
        if (s) return { label: String(s.name), path: String(s.path), note: '从快捷方式发现的浏览器，不走内核候选链（直接 --browser-executable 起它）' }
        if (cur !== 'msedge') return { label: cur, path: String(cur), note: '手动添加的浏览器，不走内核候选链；这个路径探测不到，实际会报错' }
        return { label: 'Edge', path: '', note: '' }
      }
      const detectedNames = (payload) => {
        const b = browsersOf(payload)
        if (!b) return null
        const names = KERNELS.filter((k) => b[k.key] === true).map((k) => k.label)
        for (const e of (Array.isArray(b.extras) ? b.extras : [])) if (e && e.exists === true) names.push(e.label)
        for (const s of (Array.isArray(b.shortcuts) ? b.shortcuts : [])) if (s && s.name) names.push(String(s.name))
        return names
      }
      /** 【扫描已安装的浏览器】= 带 scan:true 再调一次 douyin_status（快捷方式那一步会重扫） */
      const scanBrowsers = async () => {
        setScanBusy(true)
        try {
          const r = await refreshStatus(true)
          const names = detectedNames(r)
          if (names === null) setScanMsg('扫描失败：宿主没回自检结果（' + (stErr || '原因不详') + '）')
          else if (names.length === 0) setScanMsg('扫描完成：没检测到任何浏览器 —— 先 npx playwright install msedge')
          else if (names.length === 1) setScanMsg('扫描完成：只检测到 ' + names[0])
          else setScanMsg('扫描完成：检测到 ' + names.join('、'))
        } finally { setScanBusy(false) }
      }
      /** 【手动添加】存进 browserExtras 并立刻选中：同路径按 id 覆盖，不堆重复项 */
      const addExtra = async () => {
        const p = String(extraPath || '').trim()
        if (!p) { say('手动添加：先填浏览器可执行文件路径（例如 C:\\Program Files\\...\\chrome.exe）', 'warn'); return }
        const list = extrasFromCfg()
        const same = list.find((x) => String(x.path).toLowerCase() === p.toLowerCase())
        let id = same ? same.id : ''
        if (!id) {
          const used = new Set(list.map((x) => x.id))
          let n = 1
          while (used.has('custom-' + n)) n++
          id = 'custom-' + n
        }
        const label = String(extraName || '').trim() || (same ? same.label : '自定义浏览器 ' + id.replace(/^custom-/, ''))
        const next = list.filter((x) => x.id !== id).map((x) => ({ id: x.id, label: x.label, path: x.path }))
        next.push({ id, label, path: p })
        await patch('browserExtras', JSON.stringify(next), '自定义浏览器')
        await patch('browserChannel', id, '浏览器内核')
        setExtraOpen(false); setExtraPath(''); setExtraName('')
      }
      /** 删掉一个手动添加项；删的若是当前选中项 → 自动切回 msedge 并提示 */
      const removeExtra = async (id) => {
        const next = extrasFromCfg().filter((x) => x.id !== id).map((x) => ({ id: x.id, label: x.label, path: x.path }))
        const wasCur = channelOf(cfg) === id
        setDeletedExtras((old) => ({ ...(old || {}), [id]: true }))
        await patch('browserExtras', JSON.stringify(next), '自定义浏览器')
        if (wasCur) {
          await patch('browserChannel', 'msedge', '浏览器内核')
          say('删掉了当前选中的自定义浏览器，已切回 Edge（msedge）', 'warn')
        }
      }
      const browserChannelBody = () => {
        const cur = channelOf(cfg)
        const opts = channelOptions()
        const info = selectedInfo()
        const missing = curMissing()
        const busyChan = busy === 'browserChannel' || busy === 'browserExtras'
        return [
          h('div', { 'data-dy-row': '', key: 'channel-row' }, opts.map((opt) => {
            const btn = h('button', {
              key: 'b-' + opt.key,
              'data-dy-btn': '', 'data-dy-channel': opt.key, 'data-dy-source': opt.source,
              'data-primary': cur === opt.key ? '' : undefined,
              'data-missing': opt.missing ? '' : undefined,
              disabled: busyChan,
              title: opt.sub,
              onClick: () => { if (cur !== opt.key) patch('browserChannel', opt.key, '浏览器内核') },
            }, opt.label + (opt.missing ? '（未安装）' : ''), h('span', { 'data-dy-sub': '' }, opt.sub))
            if (opt.source !== 'extra') return btn
            return h('div', { 'data-dy-opt': '', key: 'w-' + opt.key },
              btn,
              h('button', {
                'data-dy-btn': '', 'data-dy-del': opt.id || opt.key, disabled: busyChan,
                title: '从配置里删掉这个自定义浏览器',
                onClick: () => removeExtra(opt.id || opt.key),
              }, '×'))
          })),
          h('div', { 'data-dy-note': '', 'data-dy-selected': '', key: 'channel-selected' },
            '当前：' + info.label + (info.path ? '（' + info.path + '）' : '')),
          info.note ? h('div', { 'data-dy-note': '', 'data-dy-selected-note': '', key: 'channel-selected-note' }, info.note) : null,
          missing
            ? h('div', { 'data-dy-hint': '', 'data-dy-cur-missing': '', key: 'channel-missing' },
              '当前选择的内核探测不到，实际会报错 —— ' + (kernelOf(cur) ? '先运行 ' + kernelOf(cur).install : '检查这个路径还在不在') + '，或换一个内核')
            : null,
          h('div', { 'data-dy-row': '', key: 'channel-actions' },
            h('button', { 'data-dy-btn': '', 'data-dy-channel-action': 'scan', disabled: scanBusy || busyChan, onClick: scanBrowsers },
              scanBusy ? '扫描中…' : '扫描已安装的浏览器'),
            h('button', { 'data-dy-btn': '', 'data-dy-channel-action': 'add', disabled: busyChan, onClick: () => setExtraOpen((v) => !v) },
              extraOpen ? '收起手动添加' : '手动添加')),
          scanMsg ? h('div', { 'data-dy-msg': '', 'data-dy-scan-msg': '', key: 'channel-scan-msg' }, scanMsg) : null,
          extraOpen
            ? h('div', { 'data-dy-sec': '', 'data-dy-extra-form': '', key: 'channel-extra-form' },
              h('div', { 'data-dy-label': '' }, '浏览器可执行文件路径'),
              h('input', {
                'data-dy-input': '', 'data-dy-field': 'extraPath', type: 'text', spellCheck: false,
                placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                value: extraPath, onChange: (e) => setExtraPath(e.target.value),
              }),
              h('div', { 'data-dy-label': '' }, '名称（可留空）'),
              h('input', {
                'data-dy-input': '', 'data-dy-field': 'extraName', type: 'text', spellCheck: false,
                placeholder: '如「公司装的 Chrome」',
                value: extraName, onChange: (e) => setExtraName(e.target.value),
              }),
              h('div', { 'data-dy-row': '' },
                h('button', { 'data-dy-btn': '', 'data-primary': '', 'data-dy-field': 'extraSave', disabled: busyChan, onClick: addExtra }, '保存并选中'),
                h('button', { 'data-dy-btn': '', 'data-dy-field': 'extraCancel', onClick: () => { setExtraOpen(false); setExtraPath(''); setExtraName('') } }, '取消')),
              h('div', { 'data-dy-note': '' }, '存进配置 browserExtras（JSON），保存后立刻出现在上面的列表里并选中；同路径会覆盖，不会堆重复项'))
            : null,
          h('div', { 'data-dy-note': '', key: 'channel-fallback' },
            '只列真能用的：已知安装路径命中的、开始菜单 / 桌面快捷方式里发现的、手动添加的。'
            + '没装的（含 firefox / webkit）不会出现在列表里 —— 先 npx playwright install <内核> 再点「扫描已安装的浏览器」，或「手动添加」填路径'),
          h('div', { 'data-dy-note': '', key: 'channel-restart' }, '换浏览器内核后需要重启 DSH 才生效'),
        ]
      }

      /* 数字项「本地草稿 + 失焦提交」：每敲一个字符就 POST 一次既吵，又会把半截值（"1"→"12"）存进去 */
      const editNum = (key, raw, typing) => {
        setForm((old) => ({ ...(old || {}), [key]: raw }))
        if (typing) return
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) {
          setForm((old) => ({ ...(old || {}), [key]: cfg ? cfg[key] : '' }))
          say('没提交：' + key + ' 要填一个不小于 0 的数字', 'warn')
          return
        }
        patch(key, n)
      }
      const editPath = (key, raw, typing) => {
        setForm((old) => ({ ...(old || {}), [key]: raw }))
        if (typing) return
        patch(key, String(raw || '').trim())
      }

      /* 顶栏徽章的数据源：走 /run 的 status（跟「自检」是同一个工具，不另开路由） */
      /** scan=true → 让宿主重扫快捷方式（【扫描已安装的浏览器】按钮）；返回 selfcheck 原始结果 */
      const refreshStatus = async (scan) => {
        try {
          const r = await jpost('/run', { action: 'status', scan: !!scan })
          if (isStatusPayload(r)) { setSt(r); setStErr(''); return r }
          setStErr((r && (r.error || r.reason)) || '宿主没回状态')
          return null
        } catch (e) { setStErr(errText(e)); return null }
      }
      /* 挂载就把徽章填上，别等用户去点「自检」 */
      React.useEffect(() => { refreshStatus() }, [])

      /* 「采集」页额度行的数据源 = douyin_duty 的 action=status（走 /run 泛化路由，不另开路由）
         旧宿主没有这个工具时会 404 / 回 {ok:false,error} —— 只把原因记下来，额度行退回 0，不报错 */
      const refreshDuty = async () => {
        try {
          const r = await jpost('/run', { action: 'duty_status' })
          if (r && typeof r === 'object' && ('todayScreens' in r || 'dailyLimit' in r)) {
            setDuty(r); setDutyErr('')
          } else setDutyErr((r && (r.error || r.reason)) || '宿主没回 todayScreens')
        } catch (e) { setDutyErr(errText(e)) }
      }
      React.useEffect(() => { refreshDuty() }, [])

      /* 「它刷过什么」：再点一次收起（列表开着的时候按钮文案就变成「收起记录」） */
      const loadHistory = async () => {
        if (hist !== null) { setHist(null); return }
        setHistBusy(true)
        try {
          const r = await jpost('/run', { action: 'duty_history' })
          if (r && Array.isArray(r.items)) {
            setHist(r.items)
            if (!r.ok) say('运行记录：' + ((r.error || r.reason) || '宿主说没好'), 'warn')
          } else {
            say('运行记录读不到：' + ((r && (r.error || r.reason)) || '宿主没回 items'), 'warn')
          }
        } catch (e) { say('运行记录读不到：' + errText(e), 'warn') }
        finally { setHistBusy(false) }
      }

      /* 「现在刷一轮」：等价 douyin_duty 的 action=run（内部按配置里的 count 刷）
         跑起来禁用按钮 + 显示进度文案；跑完刷新顶栏徽章和额度行（刷过之后这两处都会变） */
      const runDuty = async () => {
        setDutyRunning(true)
        say('正在刷一轮…')
        try {
          const r = await jpost('/run', { action: 'duty_run' })
          setOut(show(r))
          if (r && r.ok) {
            const n = Number(r.screens)
            say('刷一轮：完成 —— ' + (Number.isFinite(n) ? n : 0) + ' 屏'
              + (r.dir ? '，存到 ' + r.dir : ''), 'good')
          } else say('刷一轮：失败 —— ' + ((r && (r.error || r.reason)) || '看「环境与诊断」页的结果'), 'warn')
        } catch (e) {
          setOut(String((e && e.message) || e))
          say('刷一轮：' + errText(e), 'warn')
        } finally { setDutyRunning(false) }
        await refreshStatus()
        await refreshDuty()
      }

      /* 滚到某个区块并聚焦它第一个按钮（滚动参数不被认就退化成默认滚动） */
      const scrollToRef = (ref) => {
        const el = ref && ref.current
        if (!el) return false
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) { /* 老浏览器不认参数 */ }
        try {
          const btn = el.querySelector ? el.querySelector('button') : null
          if (btn && btn.focus) btn.focus()
        } catch (e) { /* 聚焦失败不影响滚动 */ }
        return true
      }

      /* 徽章跳转：标签页布局下目标可能在别的页里 —— 先切页，等渲染出来再滚。
         两套布局共用同一套 ref，所以无需分支。 */
      const jumpTo = (ref, tabName) => {
        if (scrollToRef(ref)) return
        if (!tabName || tab === tabName) return
        setTab(tabName)
        setTimeout(() => { scrollToRef(ref) }, 90)
      }

      const focusLogin = () => jumpTo(loginRef, 'perms')
      const focusEnv = () => jumpTo(envRef, 'diag')

      const run = async (action, extra, what) => {
        setBusy(action)
        try {
          const r = await jpost('/run', { action, ...(extra || {}) })
          setOut(show(r))
          say(what + (r && r.ok ? '：完成' : '：失败 —— ' + ((r && r.error) || '看下面结果')), r && r.ok ? 'good' : 'warn')
          /* 徽章跟着结果走：自检直接用它回来的那份；刷完视频数变了，得重新数一遍 */
          if (action === 'status' && isStatusPayload(r)) { setSt(r); setStErr('') }
          else if (action === 'scroll') await refreshStatus()
        } catch (e) { setOut(String((e && e.message) || e)); say(what + '：' + errText(e), 'warn') }
        finally { setBusy('') }
      }

      /* 开始登录：window = 前台弹真窗口（工具会一直等到你扫完或超时）；qr = 后台抓码，接着轮询 */
      const startLogin = async () => {
        const mode = cfg.loginMode === 'qr' ? 'qr' : 'window'
        setBusy('login_start')
        setOut(null)
        setQrTick((n) => n + 1)
        if (mode === 'window') {
          setLogin({ phase: 'window', message: '窗口已弹出，去窗口里扫码' })
          say('窗口已弹出，去窗口里扫码')
        } else {
          setLogin({ phase: 'waiting', message: '正在起浏览器抓二维码…' })
        }
        try {
          const r = await jpost('/run', { action: 'login_start', mode })
          setOut(show(r))
          if (!r || !r.ok) {
            setLogin({ phase: 'error', message: (r && (r.reason || r.error)) || '登录没起来' })
            say('登录：失败 —— ' + ((r && (r.reason || r.error)) || '看下面结果'), 'warn')
            return
          }
          if (mode === 'window') {
            setLogin({
              phase: r.loggedIn ? 'ok' : 'expired',
              message: r.loggedIn ? '已登录，cookie 已写入' : '窗口关了但没检测到登录 —— 可以再点一次',
              cookiePath: r.cookiePath || null,
              loggedIn: r.loggedIn === true,
            })
            say(r.loggedIn ? '已登录，cookie 已写入' : '没检测到登录，可以再点一次', r.loggedIn ? 'good' : 'warn')
          } else {
            setLogin({ phase: r.phase === 'ok' ? 'ok' : 'waiting', message: r.hint || '等待扫码…' })
            say('二维码已生成 —— 用手机抖音扫它', 'good')
          }
        } catch (e) {
          setLogin({ phase: 'error', message: errText(e) })
          say('登录：' + errText(e), 'warn')
        } finally { setBusy('') }
      }

      /* 读不到配置时的兜底页：留一个【检查更新】——
         装上坏版本（比如 1.2.2 的 403）时，用户正需要知道「新版能修我这个问题」 */
      if (!cfg) {
        return h('div', { 'data-dy-page': '' },
          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-h': '' }, '刷抖音 · 音频转写'),
            h('div', { 'data-dy-note': '' },
              fails
                ? '读设置失败 ' + fails + ' 次 —— 宿主这版可能还没有 /douyin-audio/config 路由（改完 index.js 要重启 dsh）'
                : '读设置中…'),
            fails ? h('div', { 'data-dy-row': '' },
              h('button', { 'data-dy-btn': '', onClick: reload }, '重试'),
              h('button', {
                'data-dy-btn': '', 'data-primary': '', disabled: updBusy,
                title: '问 npm registry 有没有新版本（8 秒超时）',
                onClick: () => checkUpd(false),
              }, updBusy ? '查询中…' : '检查更新')) : null,
            upd
              ? h('div', { 'data-dy-note': '', 'data-dy-selected': upd.ok && upd.hasUpdate ? '' : undefined },
                upd.ok
                  ? (upd.hasUpdate
                    ? (upd.source ? upd.source : '远端') + ' 上已有 v' + upd.latest + '（当前 v' + upd.current + '）—— 可能就是这个问题的修复：'
                      + 'npm install dsh-douyin-audio@latest'
                    : '已是最新版本 v' + upd.current)
                  : '检查更新失败：' + (upd.error || '原因不详'))
              : null,
            upd && upd.ok && upd.hasUpdate
              ? h('div', { 'data-dy-row': '' },
                h('button', {
                  'data-dy-btn': '',
                  onClick: async () => {
                    const ok = await copyText('npm install dsh-douyin-audio@latest')
                    say(ok ? '已复制升级命令' : '复制失败，请手动执行 npm install dsh-douyin-audio@latest', ok ? 'good' : 'warn')
                  },
                }, '复制升级命令'))
              : null,
            msg ? h('div', { 'data-dy-msg': '', 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null))
      }

      const f = form || {}
      const on = (k) => Boolean(cfg[k])
      /* 登录：模式来自配置 loginMode；状态来自 douyin_login_poll 的 phase */
      const LOGIN_PHASE = {
        window: '窗口已弹出，去窗口里扫码',
        waiting: '等待扫码…',
        scanned: '已扫码，在手机上确认',
        ok: '已登录，cookie 已写入',
        expired: '二维码过期了 —— 点「开始登录」重新来一次',
        error: '出错了',
        none: '还没开始',
      }
      const loginPhase = login && login.phase ? String(login.phase) : ''
      const loginModeCfg = cfg.loginMode === 'qr' ? 'qr' : 'window'
      const showQr = loginModeCfg === 'qr' && (loginPhase === 'waiting' || loginPhase === 'scanned')
      const maxThreads = sys && sys.cores > 0 ? sys.cores : 64   // 没读到核数就按 64 兜底
      /* 「刷一轮」用的屏数 = 当前配置的 count（表单里还没提交的草稿不算数；配歪了就按 1 屏） */
      const cfgCount = Number(cfg && cfg.count)
      const runCount = Number.isFinite(cfgCount) && cfgCount > 0 ? cfgCount : 1

      /* 线程数：提交前按 [1, 本机逻辑核] 夹取，并把纠偏结果说出来（不悄悄改用户填的值） */
      const editThreads = (raw) => {
        const n = Number(raw)
        if (!Number.isFinite(n)) {
          setForm((old) => ({ ...(old || {}), asrThreads: cfg ? cfg.asrThreads : '' }))
          say('没提交：asrThreads 要填一个数字', 'warn')
          return
        }
        const clamped = Math.min(maxThreads, Math.max(1, Math.round(n)))
        setForm((old) => ({ ...(old || {}), asrThreads: clamped }))
        if (clamped !== Math.round(n)) {
          say('已按本机 ' + (sys && sys.cores > 0 ? sys.cores + ' 逻辑核' : '64 上限') + '调整为 ' + clamped, 'warn')
        }
        patch('asrThreads', clamped)
      }

      /* ── 四个标签页：只是「怎么分区看」，状态全在 Panel 外层 ───────────────────
         cfg / form / out / msg 都不在页里，所以切页既不丢没提交的草稿，也不丢上次结果。 */
      const tabs = [
        { key: 'collect', label: '采集' },
        { key: 'transcribe', label: '转写' },
        { key: 'perms', label: '权限与登录' },
        { key: 'diag', label: '环境与诊断' },
      ]

      const autoRunOn = Boolean(cfg.autoRun)
      const todayScreens = duty && Number.isFinite(Number(duty.todayScreens)) ? Number(duty.todayScreens) : 0
      const dailyLimit = Number.isFinite(Number(cfg.dailyLimit)) ? Number(cfg.dailyLimit) : 5
      /* 额度行文案（契约原文）：autoRun 关着时补一句「自动刷已关，只能手动跑」 */
      const quotaText = '今天已刷 ' + todayScreens + ' / ' + dailyLimit + ' 屏'
        + (autoRunOn ? '' : '；自动刷已关，只能手动跑')
      const dutyNote = dutyErr
        ? 'duty 状态读不到：' + dutyErr + '（宿主这版可能还没有 douyin_duty；额度行按 0 屏显示）'
        : duty && duty.inWindow
          ? '现在就在谷时窗口里'
          : duty && duty.nextWindowAt
            ? '下一个窗口 ' + duty.nextWindowAt
            : '现在不在谷时窗口'

      /* 数字输入框：本地草稿 + 失焦提交（别每敲一个字符就 POST 一次） */
      const numField = (key, label, extra) => h('div', { 'data-dy-sec': '', key: 'nf-' + key },
        h('div', { 'data-dy-label': '' }, label),
        h('input', { ...{
          'data-dy-input': '', 'data-dy-num': '', 'data-dy-field': key, type: 'number',
          value: f[key] == null ? '' : String(f[key]), disabled: busy === key,
          onChange: (e) => editNum(key, e.target.value, true),
          onBlur: (e) => editNum(key, e.target.value, false),
        }, ...(extra || {}) }))

      /* 记录里的单条：时间 / 屏数 / 目录 / 成功与否（失败时把原因也贴出来） */
      const histRow = (it, i) => h('div', { 'data-dy-hist-item': '', key: 'hist' + i },
        h('span', { 'data-dy-hist-at': '' }, fmtAt(it && it.at)),
        h('span', null, (Number(it && it.screens) || 0) + ' 屏'),
        h('span', { 'data-dy-hist-dir': '', title: it && it.dir ? String(it.dir) : '' },
          it && it.dir ? String(it.dir) : '—'),
        h('span', {
          'data-dy-hist-ok': it && it.ok ? '' : undefined,
          'data-dy-hist-bad': it && it.ok ? undefined : '',
        }, it && it.ok ? '成功' : '失败'),
        it && !it.ok && it.error ? h('span', null, '（' + String(it.error) + '）') : null)

      /* 转写页要的两条只读环境信息：都从 douyin_status 的返回里取，取不到就去诊断页自检 */
      const MISS_ENV = '未检测到，去「环境与诊断」页点自检'
      const modelDirText = st && st.modelDir && st.modelDir.exists
        ? '已就位' + (st.modelDir.path ? '（' + String(st.modelDir.path) + '）' : '')
        : MISS_ENV
      const ffmpegText = st && hasEnvValue(st.ffmpeg) ? String(st.ffmpeg) : MISS_ENV

      /* ── 1 采集：屏数/怎么刷 + 谷时自动刷三件套 + 今天刷了多少 + 立刻刷一轮 ── */
      const pageCollect = () => [
        h('div', { 'data-dy-sec': '', key: 'collect-scroll' },
          h('div', { 'data-dy-h': '' }, '刷几屏、怎么刷'),
          h('div', { 'data-dy-row': '' },
            numField('count', '屏数 count', { min: 1 }),
            numField('delay', '每屏停留 delay', { min: 0, step: '0.1' }),
            numField('downloadTimeout', '下载超时 downloadTimeout', { min: 1 })),
          h('div', { 'data-dy-note': '' },
            'count = 下滑几屏；delay = 每屏停几秒（可带小数）；downloadTimeout = 单个视频下载的超时（毫秒）'),
          h(ToggleRow, {
            label: '后台跑 headless',
            note: '开着就不弹浏览器窗口（看不见过程，但不会抢焦点）',
            on: on('headless'), disabled: busy === 'headless',
            onChange: (v) => patch('headless', v, '后台跑'),
          }),
          h(ToggleRow, {
            label: '逐屏下载 saveAll',
            note: '关掉只截图、不下载视频（那就没有音频可转写了）',
            on: on('saveAll'), disabled: busy === 'saveAll',
            onChange: (v) => patch('saveAll', v, '逐屏下载'),
          })),
        h('div', { 'data-dy-sec': '', key: 'collect-duty' },
          h('div', { 'data-dy-h': '' }, '谷时自动刷'),
          h(ToggleRow, {
            label: '谷时自动刷 autoRun',
            note: '开着才由插件自己定时跑（只在下面的谷时窗口里跑）；关着就只能手动点「现在刷一轮」',
            on: autoRunOn, disabled: busy === 'autoRun',
            onChange: (v) => patch('autoRun', v, '谷时自动刷'),
          }),
          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-label': '' }, '谷时窗口 dutyWindow'),
            h('input', {
              'data-dy-input': '', 'data-dy-duty-window': '', type: 'text', spellCheck: false,
              placeholder: '12:00-14:00,18:00-23:59',
              value: f.dutyWindow == null ? '' : String(f.dutyWindow), disabled: busy === 'dutyWindow',
              onChange: (e) => editPath('dutyWindow', e.target.value, true),
              onBlur: (e) => editPath('dutyWindow', e.target.value, false),
            }),
            h('div', { 'data-dy-note': '' },
              '逗号分隔多个 HH:MM-HH:MM 时段（例：12:00-14:00,18:00-23:59）—— 只有这些时段里才会自动刷')),
          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-label': '' }, '每天最多刷几屏 dailyLimit'),
            h('input', {
              'data-dy-input': '', 'data-dy-num': '', 'data-dy-duty-limit': '', type: 'number', min: 0,
              value: f.dailyLimit == null ? '' : String(f.dailyLimit), disabled: busy === 'dailyLimit',
              onChange: (e) => editNum('dailyLimit', e.target.value, true),
              onBlur: (e) => editNum('dailyLimit', e.target.value, false),
            }),
            h('div', { 'data-dy-note': '' },
              '填 0 = 不自动刷（「现在刷一轮」照样能手动跑）；单位是「屏」，不是视频条数'))),
        h('div', { 'data-dy-sec': '', key: 'collect-today' },
          h('div', { 'data-dy-h': '' }, '今天'),
          h('div', { 'data-dy-quota': '' }, quotaText),
          h('div', { 'data-dy-note': '' }, dutyNote),
          h('div', { 'data-dy-note': '' }, '每天刷够 dailyLimit 屏就停；额度没用完之前，只在谷时窗口里自动跑'),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-dy-duty': 'history', disabled: histBusy,
              onClick: loadHistory,
            }, histBusy ? '读着呢…' : (hist === null ? '它刷过什么' : '收起记录')),
            h('button', {
              'data-dy-btn': '', 'data-primary': '', 'data-dy-duty': 'run', disabled: dutyRunning,
              onClick: runDuty,
            }, dutyRunning ? '刷着呢…' : '现在刷一轮')),
          dutyRunning
            ? h('div', { 'data-dy-progress': '' }, '正在刷一轮…（后台跑着，跑完这里和顶上那排徽章都会更新）')
            : null,
          hist === null
            ? null
            : hist.length === 0
              ? h('div', { 'data-dy-note': '' }, '还没刷过')
              : h('div', { 'data-dy-hist': '' }, hist.map((it, i) => histRow(it, i)))),
      ]

      /* ── 2 转写：线程数 + 自动转写 + 转一条 + 转写环境的只读说明 ── */
      const pageTranscribe = () => [
        h('div', { 'data-dy-sec': '', key: 'trans-speed' },
          h('div', { 'data-dy-h': '' }, '提速'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-sec': '' },
              h('div', { 'data-dy-label': '' }, '线程数 asrThreads'),
              h('input', {
                'data-dy-input': '', 'data-dy-num': '', 'data-dy-field': 'asrThreads', type: 'number',
                min: 1, max: maxThreads,
                value: f.asrThreads == null ? '' : String(f.asrThreads), disabled: busy === 'asrThreads',
                onChange: (e) => setForm((old) => ({ ...(old || {}), asrThreads: e.target.value })),
                onBlur: (e) => editThreads(e.target.value),
              })),
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-note': '' },
                threadHint(sys && sys.cores)))),
          h(ToggleRow, {
            label: '刷完自动转写 autoTranscribe',
            note: '关 = 刷完只给清单，由你决定转哪条（推荐）；开 = 刷完自动转最近 N 条',
            on: on('autoTranscribe'), disabled: busy === 'autoTranscribe',
            onChange: (v) => patch('autoTranscribe', v, '自动转写'),
          })),
        h('div', { 'data-dy-sec': '', key: 'trans-run' },
          h('div', { 'data-dy-h': '' }, '转写'),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-primary': '', disabled: busy === 'transcribe',
              onClick: () => run('transcribe', { limit: 1 }, '转写最近一条'),
            }, '转写最近一条'),
            h('div', { 'data-dy-note': '' },
              '把最新下载的那条转成文字（本地 SenseVoice，不联网）；批量转换屏用工具 douyin_transcribe'))),
        h('div', { 'data-dy-sec': '', key: 'trans-env' },
          h('div', { 'data-dy-h': '' }, '转写要用到的环境（只读）'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-label': '', 'data-dy-grow': '' }, '转写模型目录'),
            h('div', { 'data-dy-note': '', 'data-dy-models': '' }, modelDirText)),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-label': '', 'data-dy-grow': '' }, 'ffmpeg'),
            h('div', { 'data-dy-note': '', 'data-dy-ffmpeg': '' }, ffmpegText)),
          h('div', { 'data-dy-note': '' }, '这两项都是点顶栏「环境」徽章（= 自检）时一起取回来的，本页只读')),
      ]

      /* ── 3 权限与登录：五个等级开关 + 等级说明 + 登录方式与登录区块 ── */
      const pagePerms = () => [
        h('div', { 'data-dy-sec': '', key: 'perms-tiers' },
          h('div', { 'data-dy-h': '' }, '能力等级'),
          TIERS.map((t) => h(TierRow, {
            key: t.key,
            title: t.title,
            note: t.note,
            on: Boolean(cfg[t.key]),
            disabled: busy === t.key,
            /* ③④ 依赖 ①：只提示「需要先开启」，开关照旧可点 */
            hint: t.needRead && !cfg.tierRead ? '需要先开启 ① 只读' : null,
            /* ① 本身关着、但 ③ 或 ④ 开着时：① 实际已生效 —— 只标注，不改用户的值 */
            badge: t.key === 'tierRead' && !cfg.tierRead && (cfg.tierReact || cfg.tierComment || cfg.tierPublish)
              ? '上级已开：③A / ③B / ④ 打开时，只读自动生效（你的存值仍是关）'
              : null,
            onChange: (v) => patch(t.key, v, t.title),
          })),
          h('div', { 'data-dy-note': '' },
            '基础功能（刷屏 / 转写 / 自检 / 配置 / 定时刷）不受等级限制。这五个开关只负责把选择存进配置，'
            + '具体哪些操作真会被拦住，以宿主（index.js）的闸门接线为准。')),
        h('div', { 'data-dy-sec': '', key: 'perms-login', ref: loginRef },
          h('div', { 'data-dy-h': '' }, '登录'),
          /* 当前账号：whoami 读到的昵称（缓存里也有一份，界面上直接显示） */
          h('div', { 'data-dy-acct': '', 'data-known': acct && acct.known ? '' : undefined },
            h('span', { 'data-dy-acct-label': '' }, '当前账号：'),
            acct && acct.known
              ? h('span', { 'data-dy-acct-nick': '' }, acct.nick + (acct.uid ? '（抖音号 ' + acct.uid + '）' : ''))
              : h('span', { 'data-dy-acct-nick': '' },
                acctBusy ? '识别中…' : (st && st.cookie && st.cookie.exists ? '还没识别' : '未登录')),
            h('button', {
              'data-dy-btn': '', 'data-dy-acct-btn': '', disabled: acctBusy || !(st && st.cookie && st.cookie.exists),
              title: '打开抖音个人页读昵称（约 10-15 秒；只读，不发任何内容）',
              onClick: () => doWhoami(false),
            }, acctBusy ? '识别中…' : (acct && acct.known ? '重新识别' : '识别账号')),
            acct && acct.known && acct.at
              ? h('span', { 'data-dy-acct-at': '' }, '识别于 ' + String(acct.at).slice(0, 16).replace('T', ' '))
              : null),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-dy-loginmode': 'window',
              'data-primary': loginModeCfg === 'window' ? '' : undefined,
              disabled: busy === 'loginMode',
              onClick: () => { if (loginModeCfg !== 'window') patch('loginMode', 'window', '登录方式') },
            }, '真窗口（推荐）'),
            h('button', {
              'data-dy-btn': '', 'data-dy-loginmode': 'qr',
              'data-primary': loginModeCfg === 'qr' ? '' : undefined,
              disabled: busy === 'loginMode',
              onClick: () => { if (loginModeCfg !== 'qr') patch('loginMode', 'qr', '登录方式') },
            }, '抓二维码到设置页'),
            h('div', { 'data-dy-note': '' },
              loginModeCfg === 'window'
                ? '弹一个真的 Edge 窗口，你在窗口里扫码/过验证 —— 最稳，推荐'
                : '后台无窗口跑，二维码抓到本页显示，用手机抖音扫 —— 不弹窗、不抢焦点')),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-primary': '', disabled: busy === 'login_start',
              onClick: startLogin,
            }, '开始登录'),
            login ? h('div', {
              'data-dy-msg': '',
              'data-good': loginPhase === 'ok' ? '' : undefined,
              'data-warn': loginPhase === 'error' || loginPhase === 'expired' ? '' : undefined,
            }, (LOGIN_PHASE[loginPhase] || loginPhase || '?')
              + (loginPhase !== 'ok' && login.message ? '（' + login.message + '）' : '')) : null),
          showQr ? h('img', {
            'data-dy-qr': '', src: qrUrl(qrTick), alt: '抖音登录二维码', width: 200, height: 200,
          }) : null,
          h('div', { 'data-dy-note': '' },
            '登录方式选好后点「开始登录」。登录成功后 cookie 写到 ~/.dsh/cookies/douyin_cookies.txt，'
            + '只读 / 通知 / 私信这些工具就开始能用。登录本身不受「能力等级」限制'
            + '（读不到登录态，上面那些开关都白开）。')),
      ]

      /* ── 装入配置环境（两种布局共用）：默认只露【一键配置环境】，其余收在「高级选项」里 ──
            数据源：/run 的 setup_scan 前台回 inventory；一键配置走 setup_auto（后台派生）+ 轮询
            douyin_status.env.setupRunning / env.setupResult；venv 状态看 env.venvUsable。 */
      const envOf = (s) => (s && s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? s.env : null)
      const envNow = () => envOf(st)
      /** 本机有能直接用的 python 吗：scan 的结论优先，其次 status.env 的轻量兜底 */
      const canReuse = () => !!(scanRes && scanRes.canReusePython) || !!(envNow() && envNow().canReusePython)
      const reusePathNow = () => String((scanRes && scanRes.reusePythonPath) || (envNow() && envNow().reusePythonPath) || '')
      /** inventory：刚扫的优先，其次 status.env 里带回来的上次扫描缓存 */
      const invNow = () => (scanRes && typeof scanRes === 'object' ? scanRes : (envNow() && envNow().scan) || null)

      /** 安装结论的一行文案：两种来源都吃 —— setup_auto 的前台返回，或脚本写的 setup-result.json */
      const autoLine = (r) => {
        if (!r || typeof r !== 'object') return null
        const py = r.python && typeof r.python === 'object' ? r.python : null
        const path = (py && py.path) || r.pythonPath || r.reusePythonPath || ''
        const ver = (py && py.version) || r.version || '?'
        const mark = (b) => (b === true ? '✓' : b === false ? '✗' : '?')
        const pick = (a, b, c) => (a !== undefined && a !== null ? a : (b !== undefined && b !== null ? b : c))
        const pw = py ? pick(py.playwright, r.playwright, r.hasPlaywright) : pick(r.playwright, r.hasPlaywright)
        const sh = py ? pick(py.sherpa, r.sherpa, r.hasSherpa) : pick(r.sherpa, r.hasSherpa)
        if (r.action === 'reused') {
          return { tone: 'good', text: '已复用现有环境：' + (path || '(宿主没回路径)') + '（Python ' + ver + '，playwright' + mark(pw) + ' sherpa' + mark(sh) + '）' }
        }
        if (r.action === 'installed') {
          return { tone: 'good', text: '已安装独立环境：' + (path || '(宿主没回路径)') + '（Python ' + ver + '）' }
        }
        const why = (r.error || r.reason || (r.action === 'failed' ? '看日志' : '')) || '没拿到安装结果（点「查看日志」）'
        return { tone: 'warn', failed: true, text: '配置失败：' + why }
      }

      /* 【一键配置环境】= HTTP setup_auto：**后台派生**（宿主不等它装完，否则几分钟的长请求会被 HTTP 掐断），
         立刻回 started:true；之后这里每 3 秒轮询一次 status，直到 env.setupRunning 变 false，
         再用 env.setupResult 渲染那一行结果。最多盯 30 分钟。 */
      const SETUP_POLL_MS = 3000
      const SETUP_POLL_MAX_MS = 30 * 60 * 1000
      const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

      /** 轮询到装完：返回 setupResult；null = 没拿到结果；undefined = 盯到超时还在跑 */
      const waitSetup = async (startedAt) => {
        let sawRunning = false
        while (Date.now() - startedAt < SETUP_POLL_MAX_MS) {
          const env = envOf(await refreshStatus())
          if (env) {
            if (env.setupRunning) sawRunning = true
            else {
              const res = env.setupResult
              const at = Number(res && res.at) || 0
              // 上一轮留下的旧结果不算（at 早于这次点击就不认）
              const fresh = !at || at >= startedAt - 5000
              if (res && fresh) { setAutoRes(res); return res }
              if (sawRunning || Date.now() - startedAt > 30000) { setAutoRes(null); return null }
            }
          }
          await sleep(SETUP_POLL_MS)
        }
        return undefined
      }

      const runAuto = async () => {
        setSetupBusy('auto')
        setAutoRes(null)
        setLogOpen(false)
        const startedAt = Date.now()
        say('正在配置环境…（首次可能要几分钟，别关窗口）')
        try {
          const r = await jpost('/run', { action: 'setup_auto' })
          if (!(r && r.ok && r.started)) {
            const why = (r && (r.reason || r.error)) || '宿主没回 started'
            setAutoRes({ ok: false, action: 'failed', error: why })
            say('配置没起来：' + why, 'warn')
            return
          }
          const res = await waitSetup(startedAt)
          if (res === undefined) say('还在跑，点【刷新状态】查看结果', 'warn')
          else if (!res) say('没拿到安装结果，点【查看日志】看脚本走到哪一步了', 'warn')
          else if (res.action === 'reused') say('已复用现有环境', 'good')
          else if (res.action === 'installed') say('已安装独立环境', 'good')
          else say('配置失败：' + ((res.error || res.reason) || '点「查看日志」'), 'warn')
        } catch (e) {
          setAutoRes({ ok: false, action: 'failed', error: errText(e) })
          say('配置环境：' + errText(e), 'warn')
        } finally { setSetupBusy('') }
        await reload()          // 脚本会自己把 venv python 写进 pythonPath，配置得重读一遍
        await refreshStatus()
      }

      /** 高级选项里的【开始安装】：按单选 + 强制复选框拼 mode（*-force 就是 --force-venv） */
      const startInstall = async () => {
        const mode = (advMode === 'full' ? 'full' : 'minimal') + (forceVenv ? '-force' : '')
        setSetupBusy('install')
        try {
          const r = await jpost('/run', { action: 'setup_start', mode })
          setOut(show(r))
          if (r && r.ok && r.started) {
            setInstallMsg('安装中…（几分钟）')
            say('安装已在后台开始（' + mode + '），装完点「刷新状态」', 'good')
          } else {
            setInstallMsg('')
            say('安装没起来：' + ((r && (r.reason || r.error)) || '宿主没回 started'), 'warn')
          }
        } catch (e) { say('安装：' + errText(e), 'warn') }
        finally { setSetupBusy('') }
        await refreshStatus()
      }

      /** 「复用现有环境」：把扫到的 python 路径写进 pythonPath（这时不需要装任何东西） */
      const reuseExisting = async () => {
        const p = reusePathNow()
        if (!p) return
        await patch('pythonPath', p, '复用现有环境')
        await refreshStatus()
      }

      const runScan = async () => {
        setSetupBusy('scan')
        try {
          const r = await jpost('/run', { action: 'setup_scan' })
          const res = r && typeof r === 'object' ? r : { ok: false, error: '宿主没回扫描结果' }
          setScanRes(res)
          if (res.ok) say('扫描完成：' + (res.canReusePython ? '有可用 Python，无需安装' : '需要安装'), res.canReusePython ? 'good' : '')
          else say('扫描失败：' + ((res.error || res.reason) || '看结果区'), 'warn')
        } catch (e) { say('扫描：' + errText(e), 'warn') }
        finally { setSetupBusy('') }
        await refreshStatus()
      }

      /** 刷新状态 = 重跑自检（拿最新的 env）；装完了这里也会顺手清掉「安装中」提示 */
      const refreshEnv = async () => {
        setSetupBusy('env')
        try {
          const r = await refreshStatus()
          setInstallMsg('')
          if (r) say('环境状态已刷新', 'good')
        } finally { setSetupBusy('') }
      }

      /** 扫描结果小表：Python（路径/版本/playwright/sherpa/来源）、ffmpeg、模型、cookie */
      const scanTable = (inv) => {
        if (!inv) return h('div', { 'data-dy-note': '' }, '还没扫描过 —— 点「只看扫描结果」看本机现在有什么')
        const py = inv.python || null
        const mark = (b) => (b === true ? '✓' : b === false ? '✗' : '?')
        const ck = inv.cookie || null
        const rows = [
          ['Python', py
            ? (py.path || '(未找到)') + (py.version ? '（Python ' + py.version + '）' : '')
              + ' playwright' + mark(py.playwright) + ' sherpa' + mark(py.sherpa)
              + (py.source ? ' · 来源 ' + py.source : '')
            : '(未找到)'],
          ['ffmpeg', inv.ffmpeg || '(未找到)'],
          ['模型', inv.model || '(未找到)'],
          ['cookie', ck ? (ck.count > 0 ? ck.count + ' 条' : (ck.exists ? '0 条（文件在）' : '未登录')) : '未登录'],
        ]
        return h('div', { 'data-dy-table': '' },
          rows.map(([k, v]) => h('div', { key: 'scanrow-' + k, 'data-dy-tablerow': '' },
            h('span', { 'data-dy-tablek': '' }, k),
            h('span', { 'data-dy-tablev': '' }, String(v)))))
      }

      const scanVerdict = (inv) => {
        if (!inv) return null
        if (inv.canReusePython) {
          return h('div', { 'data-dy-msg': '', 'data-good': '' },
            '已找到可直接使用的 Python，无需安装' + (inv.reusePythonPath ? '：' + inv.reusePythonPath : ''))
        }
        const miss = Array.isArray(inv.missingPackages) && inv.missingPackages.length
          ? inv.missingPackages.join('、')
          : 'playwright、sherpa-onnx'
        return h('div', { 'data-dy-msg': '', 'data-warn': '' }, '需要安装：' + miss)
      }

      /** 环境状态那一行（只读；点「刷新状态」更新） */
      const envLine = () => {
        const e = envNow()
        if (!e) return '还没拿到 env 状态（点「刷新状态」）'
        const mark = (b) => (b ? '✓' : '✗')
        return 'venv ' + (e.venvUsable ? '可用' : (e.venv ? '在但不可用' : '没有'))
          + ' · playwright ' + mark(e.playwright) + ' · sherpa ' + mark(e.sherpa)
          + (e.basePython ? ' · 基于 ' + e.basePython : '')
          + (e.canReusePython ? ' · 可复用 ' + (e.reusePythonPath || '(路径未知)') : '')
          + (e.setupRunning ? ' · 安装中' : '')
      }

      const setupLogCard = () => {
        const e = envNow()
        const tail = (e && Array.isArray(e.setupLogTail) ? e.setupLogTail : []).slice(-12)
        return h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, 'setup.log（最近几行）'),
          h('pre', { 'data-dy-out': '', 'data-dy-setuplogtail': '' },
            tail.length ? tail.join('\n') : '（还没有日志 —— 先点「一键配置环境」或「刷新状态」）'))
      }

      /** 高级选项：精简/完整、强制新建 venv、开始安装 / 只看扫描结果 / 刷新状态 + 扫描表 + 日志 */
      const advCard = () => {
        const can = canReuse()
        return h('div', { 'data-dy-sec': '', 'data-dy-adv': '' },
          h('div', { 'data-dy-note': '' },
            can ? '已找到可直接使用的 Python —— 安装选项置灰；要重装就勾「强制新建独立 venv」走下面的【开始安装】'
              : '不确定就用上面的「一键配置环境」；这里只是把它背后的开关摊开'),
          h('div', { 'data-dy-row': '', 'data-dy-setupmodes': '' },
            ...[['minimal', '精简（venv + playwright + sherpa）'], ['full', '完整（另含 ffmpeg 与模型）']].map(([m, label]) => h('label', {
              key: 'advmode-' + m, 'data-dy-radio': '', 'data-off': can ? '' : undefined,
            },
            h('input', {
              type: 'radio', name: 'dy-setup-mode', value: m, 'data-dy-setupmode': m,
              checked: advMode === m, disabled: can,
              onChange: () => setAdvMode(m),
            }),
            h('span', {}, label)))),
          h('label', { 'data-dy-radio': '', 'data-off': can ? '' : undefined },
            h('input', {
              type: 'checkbox', 'data-dy-forcevenv': '', checked: forceVenv, disabled: can,
              onChange: (e) => setForceVenv(!!(e && e.target && e.target.checked)),
            }),
            h('span', {}, '强制新建独立 venv（不复用已有 Python）')),
          h('div', { 'data-dy-row': '' },
            can
              ? h('button', {
                'data-dy-btn': '', 'data-primary': '', 'data-dy-reuse': '',
                disabled: !reusePathNow(), onClick: reuseExisting,
                title: reusePathNow() || '扫描没回可复用的路径',
              }, '复用现有环境')
              : h('button', {
                'data-dy-btn': '', 'data-primary': '', 'data-dy-setupstart': '',
                disabled: setupBusy === 'install' || !!installMsg, onClick: startInstall,
              }, setupBusy === 'install' ? '安装中…' : '开始安装'),
            h('button', {
              'data-dy-btn': '', 'data-dy-setupscan': '',
              disabled: setupBusy === 'scan', onClick: runScan,
            }, setupBusy === 'scan' ? '扫描中…' : '只看扫描结果'),
            h('button', {
              'data-dy-btn': '', 'data-dy-envrefresh': '',
              disabled: setupBusy === 'env', onClick: refreshEnv,
            }, '刷新状态')),
          installMsg ? h('div', { 'data-dy-msg': '', 'data-warn': '', 'data-dy-installing': '' }, installMsg) : null,
          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-h': '' }, '扫描结果'),
            scanTable(invNow()),
            scanVerdict(invNow())),
          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-h': '' }, '环境状态'),
            h('div', { 'data-dy-note': '', 'data-dy-envline': '' }, envLine())),
          setupLogCard())
      }

      /** 主区域：一个大按钮 + 一行结果 + 一行「高级选项」（默认收起） */
      const setupBody = () => {
        const env = envNow()
        /* 后台安装期间（本轮点下去，或上次点完还在跑 —— 刷新页面也认）按钮一律禁用 */
        const running = setupBusy === 'auto' || !!(env && env.setupRunning)
        const line = autoLine(autoRes || (env && env.setupResult) || null)
        return [
          h('div', { 'data-dy-sec': '', key: 'diag-setup', 'data-dy-setup': '', ref: envRef },
            h('div', { 'data-dy-h': '' }, '装入配置环境'),
            h('div', { 'data-dy-row': '' },
              h('button', {
                'data-dy-btn': '', 'data-primary': '', 'data-dy-setupauto': '',
                disabled: running,
                title: '扫描本机：有能用（playwright + sherpa）的 Python 就直接复用，没有就在插件目录建 venv 装依赖',
                onClick: runAuto,
              }, running ? '配置中…（首次可能要几分钟）' : '一键配置环境')),
            line ? h('div', {
              'data-dy-msg': '', 'data-dy-autoline': '',
              'data-good': line.tone === 'good' ? '' : undefined,
              'data-warn': line.tone === 'warn' ? '' : undefined,
            }, line.text) : null,
            line && line.failed ? h('div', { 'data-dy-row': '' },
              h('button', {
                'data-dy-btn': '', 'data-dy-setuplog': '',
                onClick: () => { setLogOpen((v) => !v); if (!envNow()) refreshStatus() },
              }, logOpen ? '收起日志' : '查看日志')) : null,
            h('div', { 'data-dy-row': '' },
              h('button', {
                'data-dy-btn': '', 'data-dy-advtoggle': '',
                onClick: () => setAdvOpen((v) => !v),
                title: '精简/完整、强制新建 venv、只看扫描结果',
              }, (advOpen ? '▾ ' : '▸ ') + '高级选项')),
            advOpen ? advCard() : null,
            logOpen ? setupLogCard() : null,
            h('div', { 'data-dy-note': '' },
              '装到插件的 venv 目录；装完脚本会自己把 pythonPath 指过去。'
              + '插件升级 / npm install 会把 venv 清掉，升级后需要重装一次。')),
        ]
      }

      /* ── 4 环境与诊断：pythonPath + 自检/刷 1 屏 + 结果区 ── */
      const pageDiag = () => [
        ...setupBody(),
        h('div', { 'data-dy-sec': '', key: 'diag-py' },
          h('div', { 'data-dy-h': '' }, 'Python（转写要用）'),
          h('div', { 'data-dy-label': '' }, 'pythonPath'),
          h('input', {
            'data-dy-input': '', 'data-dy-field': 'pythonPath', type: 'text', spellCheck: false,
            value: f.pythonPath == null ? '' : String(f.pythonPath), disabled: busy === 'pythonPath',
            onChange: (e) => editPath('pythonPath', e.target.value, true),
            onBlur: (e) => editPath('pythonPath', e.target.value, false),
          }),
          h('div', { 'data-dy-note': '' }, '留空就用插件自己找的那个 —— 有没有找到，点「自检」会直接说')),
        h('div', { 'data-dy-sec': '', key: 'diag-browser' },
          h('div', { 'data-dy-h': '' }, '浏览器内核 browserChannel'),
          ...browserChannelBody()),
        h('div', { 'data-dy-sec': '', key: 'diag-run' },
          h('div', { 'data-dy-h': '' }, '诊断'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'status', onClick: () => run('status', {}, '自检') }, '自检'),
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'scroll', onClick: () => run('scroll', { count: 1 }, '刷 1 屏') }, '刷 1 屏'),
            h('div', { 'data-dy-note': '' }, busy ? '跑着呢…' : '自检 = 查环境（顶上「环境」徽章点一下也是它）；刷 1 屏 = 下滑一屏并下载'))),
        h('div', { 'data-dy-sec': '', key: 'diag-out' },
          h('div', { 'data-dy-h': '' }, '结果'),
          out === null
            ? h('div', { 'data-dy-note': '' }, '还没跑过 —— 点上面任意一个按钮，这里会贴宿主返回的原始摘要')
            : h('pre', { 'data-dy-out': '' }, out),
          adviceBlock(out),
          out === null ? null : h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', onClick: copyOut }, '复制结果'),
            h('button', { 'data-dy-btn': '', onClick: () => setOut(null) }, '清空结果'))),
      ]

      const PAGE = { collect: pageCollect, transcribe: pageTranscribe, perms: pagePerms, diag: pageDiag }

      /* ── 布局开关：uiLayout = 'classic'（默认，一长条平铺）| 'tabs'（四标签页）
             两版共用同一个顶栏、同一份 cfg/form 状态和同一批 patch/run，只有第三层分支渲染。 ── */
      const useTabs = cfg.uiLayout === 'tabs'
      const setLayout = async (v) => {
        setCfg((c) => (c ? { ...c, uiLayout: v } : c))   // 当场切，别等宿主回话
        await patch('uiLayout', v, '界面布局')
        /* 宿主还没把 uiLayout 放进白名单时，回来的 config 里没这个键 —— 再压一次，
           免得点了「新版」当场弹回旧版（有没有真存进去，msg 里会说） */
        setCfg((c) => (c ? { ...c, uiLayout: v } : c))
      }

      /* 出错了吗：有警告提示 / 读配置失败 / 上一次结果里 ok:false —— 满足任一就顶部露出「生成错误日志」 */
      const hasError = msgTone === 'warn' || fails > 0
        || (typeof out === 'string' && /"ok"\s*:\s*false/.test(out))
        || (updApply && updApply.ok === false)

      /* 生成错误日志：宿主拼一份报告（环境/配置/各日志尾部）落盘，同时复制到剪贴板 */
      const doDiag = async () => {
        setUpdBusy(true)
        try {
          const r = await jget('/diag')
          if (r && r.ok && typeof r.text === 'string') {
            const ok = await copyText(r.text)
            say((ok ? '诊断报告已复制到剪贴板' : '复制失败，报告已存到磁盘') + '，文件：' + (r.path || '(未保存)'), 'good')
          } else {
            say('生成诊断失败：' + ((r && r.error) || '宿主没回报告'), 'warn')
          }
        } catch (e) {
          say('生成诊断失败：' + errText(e), 'warn')
        } finally {
          setUpdBusy(false)
        }
      }

      /* ── 第一层：顶栏（两版共用）：四枚徽章 + 旧版/新版 + 刷一轮 ── */
      const topBar = h('div', { 'data-dy-bar': '' },
        h('div', { 'data-dy-bar-badges': '' },
          st
            ? statusBadges(st, acct).map((b, i) => h('button', {
              key: 'badge' + i,
              'data-dy-badge': '',
              'data-good': b.tone === 'good' ? '' : undefined,
              'data-warn': b.tone === 'warn' ? '' : undefined,
              'data-static': b.act ? undefined : '',
              title: b.title || b.text,
              onClick: b.act === 'env' ? focusEnv
                : b.act === 'login' ? focusLogin : undefined,
            }, b.text))
            : h('div', { 'data-dy-note': '' }, stErr ? '状态读不到：' + stErr : '状态读中…'),
          upd && upd.ok && upd.hasUpdate
            ? h('button', {
              key: 'badge-upd',
              'data-dy-badge': '', 'data-warn': '',
              title: (upd.source ? upd.source + ' 上为 v' : '远端为 v') + upd.latest + '（当前 v' + upd.current + '）—— 点这里复制升级命令',
              onClick: () => { setUpdApply(null); setUpdAsk(true) },
            }, 'v' + upd.current + ' → v' + upd.latest)
            : null),
        h('div', { 'data-dy-layout': '' },
          hasError
            ? h('button', {
              'data-dy-btn': '', 'data-dy-diag': '', disabled: updBusy,
              title: '把版本、配置、环境探针与各日志尾部拼成一份报告：复制到剪贴板并存到状态目录',
              onClick: doDiag,
            }, '生成错误日志')
            : null,
          h('button', {
            'data-dy-btn': '', disabled: updBusy,
            title: '问远端仓库与 npm 有没有新版本（国内源优先，10 秒超时）',
            onClick: () => checkUpd(false),
          }, updBusy ? '查询中…' : '检查更新'),
          h('button', {
            'data-dy-btn': '', 'data-dy-layout-btn': 'classic', 'data-primary': useTabs ? undefined : '',
            disabled: busy === 'uiLayout', title: '一长条平铺的设置页（默认）',
            onClick: () => { if (useTabs) setLayout('classic') },
          }, '旧版'),
          h('button', {
            'data-dy-btn': '', 'data-dy-layout-btn': 'tabs', 'data-primary': useTabs ? '' : undefined,
            disabled: busy === 'uiLayout', title: '顶部状态栏 + 四个标签页',
            onClick: () => { if (!useTabs) setLayout('tabs') },
          }, '新版')),
        h('button', {
          'data-dy-btn': '', 'data-primary': '', 'data-dy-run-one': '',
          disabled: busy === 'scroll',
          onClick: () => run('scroll', { count: runCount }, '刷一轮'),
        }, busy === 'scroll' ? '刷着呢…' : '刷一轮'))

      /* 升级确认弹窗：点黄色版本徽章弹出；「立即升级」只在 npm 安装的机器上给（file: 链接会覆盖源码） */
      const updModal = updAsk && upd
        ? h('div', { 'data-dy-mask': '', onClick: () => setUpdAsk(false) },
          h('div', { 'data-dy-modal': '', onClick: (e) => e.stopPropagation() },
            h('div', { 'data-dy-modal-title': '' }, upd.ok && upd.hasUpdate ? '发现新版本，要更新吗？' : '检查更新'),
            h('div', { 'data-dy-note': '' },
              upd.ok
                ? '当前 v' + upd.current + (upd.hasUpdate ? ' → 远端 v' + upd.latest : '（已是最新）')
                  + (upd.source ? '（来自 ' + upd.source + '）' : '')
                : '检查更新失败：' + (upd.error || '原因不详')),
            updApply
              ? h('div', { 'data-dy-note': '', 'data-dy-selected': '' }, updApply.message || '')
              : null,
            upd.mode === 'linked'
              ? h('div', { 'data-dy-note': '' },
                '当前是源码链接安装：只会在源码目录执行 git pull --ff-only（不覆盖、不删除本地文件），更新后需重启 DSH。')
              : null,
            h('div', { 'data-dy-row': '' },
              upd.ok && upd.hasUpdate
                ? h('button', {
                  'data-dy-btn': '', 'data-primary': '', disabled: updBusy,
                  title: upd.mode === 'linked'
                    ? '在源码目录执行 git pull --ff-only，不覆盖本地改动；更新后需重启 DSH'
                    : '在插件目录执行 npm install dsh-douyin-audio@latest，装完需重启 DSH',
                  onClick: () => doApplyUpdate(upd.mode === 'linked' ? 'pull' : 'apply'),
                }, updBusy ? '请求中…' : (upd.mode === 'linked' ? '拉取最新源码' : '立即升级'))
                : null,
              h('button', {
                'data-dy-btn': '',
                onClick: async () => {
                  const ok = await copyText('npm install dsh-douyin-audio@latest')
                  say(ok ? '已复制升级命令' : '复制失败，请手动执行', ok ? 'good' : 'warn')
                },
              }, '复制命令'),
              h('button', { 'data-dy-btn': '', onClick: () => setUpdAsk(false) }, '关闭'))))
        : null

      const renderTabs = () => h('div', { 'data-dy-page': '' },
        topBar,
        updModal,
        /* ── 第二层：四个标签 ── */
        h('div', { 'data-dy-tabs': '' }, tabs.map((t) => h('button', {
          key: 'tab-' + t.key,
          'data-dy-tab': t.key,
          'data-active': tab === t.key ? '' : undefined,
          title: '切到「' + t.label + '」页',
          onClick: () => setTab(t.key),
        }, t.label))),
        /* 保存反馈放标签栏底下：不管在哪个页都看得见 */
        msg ? h('div', {
          'data-dy-msg': '',
          'data-good': msgTone === 'good' ? '' : undefined,
          'data-warn': msgTone === 'warn' ? '' : undefined,
        }, msg) : null,
        /* ── 第三层：当前页 ── */
        h('div', { 'data-dy-tabbody': '' }, (PAGE[tab] || pageCollect)()))

      /* ── 旧版：一长条平铺（跟 HEAD 逐行一致，只是顶栏换成共用的那个）── */
      const renderClassic = () => {
      return h('div', { 'data-dy-page': '' },
        topBar,
        updModal,

        /* ── 刷几屏、怎么刷 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '刷几屏、怎么刷'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-sec': '' },
              h('div', { 'data-dy-label': '' }, '屏数 count'),
              h('input', {
                'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 1,
                value: f.count == null ? '' : String(f.count), disabled: busy === 'count',
                onChange: (e) => editNum('count', e.target.value, true),
                onBlur: (e) => editNum('count', e.target.value, false),
              })),
            h('div', { 'data-dy-sec': '' },
              h('div', { 'data-dy-label': '' }, '每屏停留 delay'),
              h('input', {
                'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 0, step: '0.1',
                value: f.delay == null ? '' : String(f.delay), disabled: busy === 'delay',
                onChange: (e) => editNum('delay', e.target.value, true),
                onBlur: (e) => editNum('delay', e.target.value, false),
              })),
            h('div', { 'data-dy-sec': '' },
              h('div', { 'data-dy-label': '' }, '下载超时 downloadTimeout'),
              h('input', {
                'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 1,
                value: f.downloadTimeout == null ? '' : String(f.downloadTimeout), disabled: busy === 'downloadTimeout',
                onChange: (e) => editNum('downloadTimeout', e.target.value, true),
                onBlur: (e) => editNum('downloadTimeout', e.target.value, false),
              }))),
          h('div', { 'data-dy-note': '' },
            'count = 下滑几屏；delay = 每屏停几秒（可带小数）；downloadTimeout = 单个视频下载的超时（毫秒）'),
          h(ToggleRow, {
            label: '后台跑 headless',
            note: '开着就不弹浏览器窗口（看不见过程，但不会抢焦点）',
            on: on('headless'), disabled: busy === 'headless',
            onChange: (v) => patch('headless', v, '后台跑'),
          }),
          h(ToggleRow, {
            label: '逐屏下载 saveAll',
            note: '关掉只截图、不下载视频（那就没有音频可转写了）',
            on: on('saveAll'), disabled: busy === 'saveAll',
            onChange: (v) => patch('saveAll', v, '逐屏下载'),
          })),

        /* ── Python ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, 'Python（转写要用）'),
          h('div', { 'data-dy-label': '' }, 'pythonPath'),
          h('input', {
            'data-dy-input': '', type: 'text', spellCheck: false,
            value: f.pythonPath == null ? '' : String(f.pythonPath), disabled: busy === 'pythonPath',
            onChange: (e) => editPath('pythonPath', e.target.value, true),
            onBlur: (e) => editPath('pythonPath', e.target.value, false),
          }),
          h('div', { 'data-dy-note': '' }, '留空就用插件自己找的那个 —— 有没有找到，点「自检」会直接说')),

        /* ── 装入配置环境（跟「环境与诊断」页共用同一份 setupBody）── */
        ...setupBody(),

        /* ── 浏览器内核 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '浏览器内核 browserChannel'),
          ...browserChannelBody()),

        /* ── 能力等级 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '能力等级'),
          TIERS.map((t) => h(TierRow, {
            key: t.key,
            title: t.title,
            note: t.note,
            on: Boolean(cfg[t.key]),
            disabled: busy === t.key,
            /* ③④ 依赖 ①：只提示「需要先开启」，开关照旧可点 */
            hint: t.needRead && !cfg.tierRead ? '需要先开启 ① 只读' : null,
            /* ① 本身关着、但 ③ 或 ④ 开着时：① 实际已生效 —— 只标注，不改用户的值 */
            badge: t.key === 'tierRead' && !cfg.tierRead && (cfg.tierReact || cfg.tierComment || cfg.tierPublish)
              ? '上级已开：③A / ③B / ④ 打开时，只读自动生效（你的存值仍是关）'
              : null,
            onChange: (v) => patch(t.key, v, t.title),
          })),
          h('div', { 'data-dy-note': '' },
            '基础功能（刷屏 / 转写 / 自检 / 配置）不受等级限制。这五个开关只负责把选择存进配置，'
            + '具体哪些操作真会被拦住，以宿主（index.js）的闸门接线为准。')),

        /* ── 提速 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '提速'),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-sec': '' },
              h('div', { 'data-dy-label': '' }, '线程数 asrThreads'),
              h('input', {
                'data-dy-input': '', 'data-dy-num': '', type: 'number', min: 1, max: maxThreads,
                value: f.asrThreads == null ? '' : String(f.asrThreads), disabled: busy === 'asrThreads',
                onChange: (e) => setForm((old) => ({ ...(old || {}), asrThreads: e.target.value })),
                onBlur: (e) => editThreads(e.target.value),
              })),
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-note': '' },
                threadHint(sys && sys.cores)))),
          h(ToggleRow, {
            label: '刷完自动转写 autoTranscribe',
            note: '关 = 刷完只给清单，由你决定转哪条（推荐）；开 = 刷完自动转最近 N 条',
            on: on('autoTranscribe'), disabled: busy === 'autoTranscribe',
            onChange: (v) => patch('autoTranscribe', v, '自动转写'),
          })),

        /* ── 登录 ── */
        h('div', { 'data-dy-sec': '', ref: loginRef },
          h('div', { 'data-dy-h': '' }, '登录'),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-primary': loginModeCfg === 'window' ? '' : undefined,
              disabled: busy === 'loginMode',
              onClick: () => { if (loginModeCfg !== 'window') patch('loginMode', 'window', '登录方式') },
            }, '真窗口（推荐）'),
            h('button', {
              'data-dy-btn': '', 'data-primary': loginModeCfg === 'qr' ? '' : undefined,
              disabled: busy === 'loginMode',
              onClick: () => { if (loginModeCfg !== 'qr') patch('loginMode', 'qr', '登录方式') },
            }, '抓二维码到设置页'),
            h('div', { 'data-dy-note': '' },
              loginModeCfg === 'window'
                ? '弹一个真的 Edge 窗口，你在窗口里扫码/过验证 —— 最稳，推荐'
                : '后台无窗口跑，二维码抓到本页显示，用手机抖音扫 —— 不弹窗、不抢焦点')),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-primary': '', disabled: busy === 'login_start',
              onClick: startLogin,
            }, '开始登录'),
            login ? h('div', {
              'data-dy-msg': '',
              'data-good': loginPhase === 'ok' ? '' : undefined,
              'data-warn': loginPhase === 'error' || loginPhase === 'expired' ? '' : undefined,
            }, (LOGIN_PHASE[loginPhase] || loginPhase || '?')
              + (loginPhase !== 'ok' && login.message ? '（' + login.message + '）' : '')) : null),
          showQr ? h('img', {
            'data-dy-qr': '', src: qrUrl(qrTick), alt: '抖音登录二维码', width: 200, height: 200,
          }) : null,
          h('div', { 'data-dy-note': '' },
            '登录成功后 cookie 写到 ~/.dsh/cookies/douyin_cookies.txt，只读 / 通知 / 私信这些工具就开始能用。'
            + '登录本身不受「能力等级」限制（读不到登录态，上面那些开关都白开）。')),

        /* ── 跑一下 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '跑一下'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'status', onClick: () => run('status', {}, '自检') }, '自检'),
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'scroll', onClick: () => run('scroll', { count: 1 }, '刷 1 屏') }, '刷 1 屏'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'transcribe', onClick: () => run('transcribe', { limit: 1 }, '转写最近一条') }, '转写最近一条'),
            h('div', { 'data-dy-note': '' }, busy ? '跑着呢…' : '自检 = 查环境；刷 1 屏 = 下滑一屏并下载；转写 = 把最新那条转成文字（本地 SenseVoice，不联网）')),
          msg ? h('div', { 'data-dy-msg': '', 'data-good': msgTone === 'good' ? '' : undefined, 'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null,
          h('div', { 'data-dy-h': '' }, '结果'),
          out === null
            ? h('div', { 'data-dy-note': '' }, '还没跑过 —— 点上面任意一个按钮，这里会贴宿主返回的原始摘要')
            : h('pre', { 'data-dy-out': '' }, out),
          adviceBlock(out),
          out === null ? null : h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', onClick: copyOut }, '复制结果'),
            h('button', { 'data-dy-btn': '', onClick: () => setOut(null) }, '清空结果'))))
      }

      return useTabs ? renderTabs() : renderClassic()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-audio')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-audio: 设置页样式')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-bili-scroll/package/client.js 811-826 行）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-audio', order: 31, label: '大肥鱼刷抖音网页版' },
          () => h(Panel),
        ))
      },
    }
  },
})
