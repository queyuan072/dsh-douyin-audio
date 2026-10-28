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
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))
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
    function statusBadges(s) {
      const miss = ENV_PARTS.filter((p) => !p.has(s))
      const env = miss.length
        ? { text: '环境缺 ' + miss[0].name, tone: 'warn', act: 'env', title: miss.map((p) => p.why).join('；') + '（点这里重跑自检）' }
        : { text: '环境就绪', tone: 'good', act: 'env', title: '四件套都在（点这里重跑自检）' }
      /* ⚠️ 只按 cookie 文件在不在说，不写「已登录」—— 真实登录态我们确认不了 */
      const login = s.cookie && s.cookie.exists
        ? { text: 'cookie 已配置', tone: '', act: 'login', title: '只按 cookie 文件存在判断，不代表当前登录态一定有效（点这里去登录区）' }
        : { text: '未登录', tone: 'warn', act: 'login', title: 'cookie 文件还没写出来 —— 点这里去「登录」区块扫码' }
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

      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }

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

      /* ── 浏览器内核 browserChannel：三个会起浏览器的脚本（scroll / read / login）用哪个 ──
             两版布局共用这一份按钮 + 说明，classic 与 tabs 只有外面那层 h('div',{data-dy-sec}) 不同。 */
      const BROWSER_CHANNELS = [
        { key: 'msedge', label: 'Edge（推荐）', note: '用你装的 Microsoft Edge —— 实测最稳，抖音风控对真浏览器宽松' },
        { key: 'chrome', label: 'Chrome', note: '用你装的 Google Chrome —— Edge 出问题时的替代方案' },
        { key: 'chromium', label: '内置 Chromium', note: '用 Playwright 自带的那个，没有真实用户的浏览痕迹 —— 最容易撞验证码，只建议排查问题时用' },
      ]
      /** 配置值 → 三选一（缺键 / 旧宿主 / 未知值都按 msedge，与宿主的默认值一致） */
      const channelOf = (c) => (c && (c.browserChannel === 'chrome' || c.browserChannel === 'chromium') ? c.browserChannel : 'msedge')
      const browserChannelBody = () => {
        const cur = channelOf(cfg)
        const picked = BROWSER_CHANNELS.find((x) => x.key === cur) || BROWSER_CHANNELS[0]
        return [
          h('div', { 'data-dy-row': '', key: 'channel-row' }, BROWSER_CHANNELS.map((x) => h('button', {
            key: x.key,
            'data-dy-btn': '', 'data-dy-channel': x.key,
            'data-primary': cur === x.key ? '' : undefined,
            disabled: busy === 'browserChannel',
            onClick: () => { if (cur !== x.key) patch('browserChannel', x.key, '浏览器内核') },
          }, x.label))),
          h('div', { 'data-dy-note': '', key: 'channel-note' }, picked.note),
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
      const refreshStatus = async () => {
        try {
          const r = await jpost('/run', { action: 'status' })
          if (isStatusPayload(r)) { setSt(r); setStErr('') }
          else setStErr((r && (r.error || r.reason)) || '宿主没回状态')
        } catch (e) { setStErr(errText(e)) }
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

      /* 点「登录」徽章：滚到登录区块并聚焦（滚动参数不被认就退化成默认滚动） */
      const focusLogin = () => {
        const el = loginRef && loginRef.current
        if (!el) return
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) { /* 老浏览器不认参数 */ }
        try {
          const btn = el.querySelector ? el.querySelector('button') : null
          if (btn && btn.focus) btn.focus()
        } catch (e) { /* 聚焦失败不影响滚动 */ }
      }

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

      if (!cfg) {
        return h('div', { 'data-dy-page': '' },
          h('div', { 'data-dy-sec': '' },
            h('div', { 'data-dy-h': '' }, '刷抖音 · 音频转写'),
            h('div', { 'data-dy-note': '' },
              fails
                ? '读设置失败 ' + fails + ' 次 —— 宿主这版可能还没有 /douyin-audio/config 路由（改完 index.js 要重启 dsh）'
                : '读设置中…'),
            fails ? h('div', { 'data-dy-row': '' },
              h('button', { 'data-dy-btn': '', onClick: reload }, '重试')) : null,
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
                sys && sys.cores > 0
                  ? '本机 ' + sys.cores + ' 逻辑核；建议 8–16（越大越快，但会占满 CPU）'
                  : '没读到本机核数（宿主这版没有 /sysinfo 路由）：按 1–64 填，建议 8–16（越大越快，但会占满 CPU）'))),
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
            'data-dy-qr': '', src: API + '/qr?t=' + qrTick, alt: '抖音登录二维码', width: 200, height: 200,
          }) : null,
          h('div', { 'data-dy-note': '' },
            '登录方式选好后点「开始登录」。登录成功后 cookie 写到 ~/.dsh/cookies/douyin_cookies.txt，'
            + '只读 / 通知 / 私信这些工具就开始能用。登录本身不受「能力等级」限制'
            + '（读不到登录态，上面那些开关都白开）。')),
      ]

      /* ── 4 环境与诊断：pythonPath + 自检/刷 1 屏 + 结果区 ── */
      const pageDiag = () => [
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

      /* ── 第一层：顶栏（两版共用）：四枚徽章 + 旧版/新版 + 刷一轮 ── */
      const topBar = h('div', { 'data-dy-bar': '' },
        h('div', { 'data-dy-bar-badges': '' },
          st
            ? statusBadges(st).map((b, i) => h('button', {
              key: 'badge' + i,
              'data-dy-badge': '',
              'data-good': b.tone === 'good' ? '' : undefined,
              'data-warn': b.tone === 'warn' ? '' : undefined,
              'data-static': b.act ? undefined : '',
              title: b.title || b.text,
              disabled: b.act === 'env' && busy === 'status',
              onClick: b.act === 'env' ? () => run('status', {}, '自检')
                : b.act === 'login' ? focusLogin : undefined,
            }, b.text))
            : h('div', { 'data-dy-note': '' }, stErr ? '状态读不到：' + stErr : '状态读中…')),
        h('div', { 'data-dy-layout': '' },
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

      const renderTabs = () => h('div', { 'data-dy-page': '' },
        topBar,
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
                sys && sys.cores > 0
                  ? '本机 ' + sys.cores + ' 逻辑核；建议 8–16（越大越快，但会占满 CPU）'
                  : '没读到本机核数（宿主这版没有 /sysinfo 路由）：按 1–64 填，建议 8–16（越大越快，但会占满 CPU）'))),
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
            'data-dy-qr': '', src: API + '/qr?t=' + qrTick, alt: '抖音登录二维码', width: 200, height: 200,
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
