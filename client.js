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
      { key: 'tierInteract', title: '③ 互动', note: '发评论、回复、点赞 —— 风险：会用你的账号发评论', needRead: true },
      { key: 'tierPublish', title: '④ 发布', note: '上传视频到抖音 —— 风险：会向你的账号上传视频', needRead: true },
    ]

    /* 结果区：等宽字体，接口原样回什么就贴什么（出错时的原因也一起贴，别只剩一句"失败了"） */
    const show = (r) => {
      try { return JSON.stringify(r, null, 2) } catch (e) { return String(r) }
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

      const run = async (action, extra, what) => {
        setBusy(action)
        try {
          const r = await jpost('/run', { action, ...(extra || {}) })
          setOut(show(r))
          say(what + (r && r.ok ? '：完成' : '：失败 —— ' + ((r && r.error) || '看下面结果')), r && r.ok ? 'good' : 'warn')
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

      return h('div', { 'data-dy-page': '' },
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
            badge: t.key === 'tierRead' && !cfg.tierRead && (cfg.tierInteract || cfg.tierPublish)
              ? '上级已开：③ 互动 / ④ 发布 打开时，只读自动生效（你的存值仍是关）'
              : null,
            onChange: (v) => patch(t.key, v, t.title),
          })),
          h('div', { 'data-dy-note': '' },
            '基础功能（刷屏 / 转写 / 自检 / 配置）不受等级限制。这四个开关只负责把选择存进配置，'
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
        h('div', { 'data-dy-sec': '' },
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
