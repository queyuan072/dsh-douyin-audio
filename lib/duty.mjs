/**
 * lib/duty.mjs —— 谷时自动刷：窗口解析 / duty.json 读写 / 调度判定（纯函数）
 * ============================================================================
 * 分工：
 *   · 这里只做「算」和「存」——不启动浏览器、不起子进程、不读配置以外的任何东西；
 *     真正刷一轮由 index.js 调 douyin_scroll 那套逻辑，跑完回来 recordRun() 记账。
 *   · decide() 是纯函数（cfg + duty + now + running 进，verdict 出），可以单独单测，
 *     命令行里 node -e "import(...)" 就能把四种组合跑一遍。
 *
 * 硬规矩同 lib/state.mjs：**一个异常都不往外抛**。
 *   readDuty() 读不到/读坏了 → 一份默认值（todayScreens:0）；
 *   writeDuty() 写不了 → { ok:false, error }，让调用方自己决定记不记日志。
 *
 * 运行痕迹 <stateDir>/duty.json 的形状（插件自己写，用户不填）：
 *   { todayDate:'2026-10-28', todayScreens:3, lastRunAt:1793…, lastResult:'ok'|'fail',
 *     lastScreens:3, lastError:null, history:[{ at, screens, dir, ok, error }] }  history ≤ 20 条
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDirs, stateDir } from './state.mjs'

/**
 * 四个配置键的兜底默认值。
 * 权威定义在 lib/state.mjs 的 DEFAULTS 里（那里决定默认行为），这里留一份，
 * 防止旧 lib / 旧 config.json 读不到键时判定函数拿到 undefined。
 */
export const DUTY_DEFAULTS = {
  autoRun: false,                                   // 谷时自动刷：true 才由插件自己定时跑
  dutyWindow: '12:00-14:00,18:00-23:59',            // 谷时窗口，逗号分隔多个 HH:MM-HH:MM
  dailyLimit: 5,                                    // 每天最多刷几屏（0 = 不自动跑）
  dutyIntervalMin: 30,                              // 两次自动刷之间至少隔多少分钟
}

/** history 最多留几条 */
export const HISTORY_MAX = 20

/** 运行痕迹文件：<stateDir>/duty.json（只算路径，不建目录） */
export function dutyPath() {
  try { return join(stateDir(), 'duty.json') } catch { return 'duty.json' }
}

/** 两位补零 */
function pad2(n) { return String(n).padStart(2, '0') }

/** 非负数字兜底：NaN / 负数 / 字符串 → 0 或 Number(v) */
function num(v, dflt = 0) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

/** `YYYY-MM-DD`（本地时区；日期坏掉就返回空串，让上层当成「不是今天」） */
export function todayKey(now = Date.now()) {
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) return ''
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** 本地时区的「今天第几分钟」（0-1439）；日期坏掉返回 0 */
function minutesOfDay(now = Date.now()) {
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) return 0
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * 解析谷时窗口文本：`'12:00-14:00,18:00-23:59'` → [{ start:'12:00', end:'14:00', startMin, endMin }]
 * 容忍中文逗号/分号/换行、单个数字的小时、~ / – / 至 之类连接符；解析不出来的段直接丢掉（不抛）。
 * 允许跨零点（end < start，如 23:00-02:00）。
 */
export function parseWindows(text) {
  const raw = Array.isArray(text) ? text.join(',') : (typeof text === 'string' ? text : '')
  const out = []
  for (const part of raw.split(/[,，;；\n\r]+/)) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*(?:-|–|—|~|至|到)\s*(\d{1,2}):(\d{2})\s*$/.exec(part)
    if (!m) continue
    const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) continue
    out.push({
      start: pad2(sh) + ':' + pad2(sm),
      end: pad2(eh) + ':' + pad2(em),
      startMin: sh * 60 + sm,
      endMin: eh * 60 + em,
    })
  }
  return out
}

/** 现在在不在某个窗口里（endMin 含在内：23:59 这一分钟也算窗口内） */
export function inWindow(windows, now = Date.now()) {
  const cur = minutesOfDay(now)
  for (const w of windows || []) {
    if (w.endMin >= w.startMin) {
      if (cur >= w.startMin && cur <= w.endMin) return true
    } else if (cur >= w.startMin || cur <= w.endMin) {
      return true                                  // 跨零点窗口
    }
  }
  return false
}

/** 下一次「窗口开始」的时刻（'HH:MM'）；今天已经没有了返回 null。正在窗口里也算下一个开场。 */
export function nextWindowStart(windows, now = Date.now()) {
  const cur = minutesOfDay(now)
  let best = null
  for (const w of windows || []) {
    if (w.startMin > cur && (best === null || w.startMin < best.startMin)) best = w
  }
  return best ? best.start : null
}

/** 四个配置键：只认自己的键，缺的/类型不对的用 DUTY_DEFAULTS 兜底 */
export function dutyCfg(cfg) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
  const bool = (v, dflt) => {
    if (typeof v === 'boolean') return v
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase() === 'true'
    return dflt
  }
  const posInt = (v, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt
  }
  return {
    autoRun: bool(c.autoRun, DUTY_DEFAULTS.autoRun),
    dutyWindow: typeof c.dutyWindow === 'string' && c.dutyWindow.trim() ? c.dutyWindow : DUTY_DEFAULTS.dutyWindow,
    dailyLimit: posInt(c.dailyLimit, DUTY_DEFAULTS.dailyLimit),
    dutyIntervalMin: posInt(c.dutyIntervalMin, DUTY_DEFAULTS.dutyIntervalMin),
  }
}

/** 一条 history 记录：字段裁齐、类型纠正，坏条目一律不认 */
function cleanItem(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  return {
    at: num(x.at),
    screens: num(x.screens),
    dir: typeof x.dir === 'string' && x.dir ? x.dir : null,
    ok: x.ok === true,
    error: typeof x.error === 'string' && x.error ? x.error : null,
  }
}

/**
 * 把任意形状的运行痕迹规范成契约形状（含跨天归零：todayDate 不是今天 → todayScreens = 0）。
 * 纯函数，不改入参。
 */
export function normalizeDuty(raw, now = Date.now()) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const today = todayKey(now)
  const history = Array.isArray(d.history)
    ? d.history.map(cleanItem).filter(Boolean).slice(0, HISTORY_MAX)
    : []
  return {
    todayDate: today,
    todayScreens: d.todayDate === today ? num(d.todayScreens) : 0,
    lastRunAt: num(d.lastRunAt),
    lastResult: d.lastResult === 'ok' || d.lastResult === 'fail' ? d.lastResult : null,
    lastScreens: num(d.lastScreens),
    lastError: typeof d.lastError === 'string' && d.lastError ? d.lastError : null,
    history,
  }
}

/** 读 <stateDir>/duty.json：没有 / 坏了 / 不是对象 → 默认值（todayScreens:0）。绝不抛。 */
export function readDuty(now = Date.now()) {
  let raw = null
  try { raw = JSON.parse(readFileSync(dutyPath(), 'utf8')) } catch { raw = null }
  return normalizeDuty(raw, now)
}

/** 写 <stateDir>/duty.json（history 截到 20 条）。返回 { ok, duty, error }，绝不抛。 */
export function writeDuty(duty, now = Date.now()) {
  const next = normalizeDuty(duty, now)
  const dirsOk = ensureDirs()
  try {
    writeFileSync(dutyPath(), JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, duty: next }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    return { ok: false, duty: next, error: dirsOk ? msg : (msg + ' (' + dutyPath() + ')') }
  }
}

/**
 * 记一次「跑过一轮」：成功才把屏数累加进 todayScreens；失败也写 lastRunAt
 * （否则失败会每 60 秒重试一次，把日志刷满）。
 * @param {{screens?:number, dir?:string|null, ok?:boolean, error?:string|null, at?:number}} rec
 * @returns {{ok:true,duty:object} | {ok:false,duty:object,error:string}}
 */
export function recordRun({ screens = 0, dir = null, ok = false, error = null, at = Date.now() } = {}) {
  const now = num(at) || Date.now()
  const today = todayKey(now)
  const duty = readDuty(now)                       // 已经按 now 做过跨天归零
  const done = Math.max(0, Math.floor(num(screens)))
  if (duty.todayDate !== today) duty.todayScreens = 0
  duty.todayDate = today
  if (ok) duty.todayScreens += done
  duty.lastRunAt = now
  duty.lastResult = ok ? 'ok' : 'fail'
  duty.lastScreens = done
  duty.lastError = ok ? null : (typeof error === 'string' && error ? error : '未知错误')
  duty.history = [
    { at: now, screens: done, dir: typeof dir === 'string' && dir ? dir : null, ok: !!ok, error: duty.lastError },
    ...duty.history,
  ].slice(0, HISTORY_MAX)
  return writeDuty(duty, now)
}

/**
 * ⭐ 调度判定（纯函数，四种组合可单测）
 * 「跑不跑」= 五条全中：
 *   ① cfg.autoRun === true
 *   ② 当前在 dutyWindow 内
 *   ③ todayScreens < dailyLimit（dailyLimit 为 0 = 永不自动跑）
 *   ④ 距 lastRunAt ≥ dutyIntervalMin 分钟（从没跑过算满足）
 *   ⑤ 当前没有正在跑的 run
 * @returns {{shouldRun:boolean, reasons:string[], checks:object, inWindow:boolean, todayScreens:number, dailyLimit:number, remain:number}}
 */
export function decide({ cfg, duty, now = Date.now(), running = false } = {}) {
  const c = dutyCfg(cfg)
  const d = normalizeDuty(duty, now)
  const windows = parseWindows(c.dutyWindow)
  const inWin = inWindow(windows, now)
  const remain = Math.max(0, c.dailyLimit - d.todayScreens)
  const gapRaw = d.lastRunAt > 0 ? Math.floor((now - d.lastRunAt) / 60000) : null   // null = 从没跑过
  const skew = gapRaw !== null && gapRaw < 0                                        // lastRunAt 在未来：时钟回拨过
  const gapMin = skew ? null : gapRaw       // 回拨了就不拿一个负数去卡人，否则会被永久卡住

  const checks = {
    autoRun: c.autoRun === true,
    inWindow: inWin,
    quota: c.dailyLimit > 0 && d.todayScreens < c.dailyLimit,
    interval: gapMin === null || gapMin >= c.dutyIntervalMin,
    idle: running !== true,
  }
  const passText = {
    autoRun: 'autoRun=true（谷时自动刷已开启）',
    inWindow: '在谷时窗口内（' + (windows.map((w) => w.start + '-' + w.end).join(',') || '窗口为空') + '）',
    quota: '今日额度未满（已刷 ' + d.todayScreens + '/' + c.dailyLimit + ' 屏）',
    interval: gapMin === null
      ? (skew ? '上次记录的时间在未来（时钟回拨过），不设间隔门槛' : '从没跑过，不设间隔门槛')
      : '距上次 ' + gapMin + ' 分钟 ≥ ' + c.dutyIntervalMin + ' 分钟',
    idle: '当前没有正在跑的 run',
  }
  const failText = {
    autoRun: 'autoRun=false（谷时自动刷没开启，不会自己定时跑）',
    inWindow: '不在谷时窗口内（窗口 ' + (windows.map((w) => w.start + '-' + w.end).join(',') || '空') + '，现在 ' + pad2(Math.floor(minutesOfDay(now) / 60)) + ':' + pad2(minutesOfDay(now) % 60) + '）',
    quota: c.dailyLimit === 0
      ? 'dailyLimit=0（额度为 0，只允许手动刷）'
      : '额度已满：今天已刷 ' + d.todayScreens + '/' + c.dailyLimit + ' 屏',
    interval: '距上次只过了 ' + gapMin + ' 分钟，不到 ' + c.dutyIntervalMin + ' 分钟',
    idle: '已经有一轮在跑了',
  }

  const shouldRun = checks.autoRun && checks.inWindow && checks.quota && checks.interval && checks.idle
  const reasons = Object.keys(checks)
    .filter((k) => (shouldRun ? checks[k] : !checks[k]))
    .map((k) => (shouldRun ? passText[k] : failText[k]))

  return { shouldRun, reasons, checks, inWindow: inWin, todayScreens: d.todayScreens, dailyLimit: c.dailyLimit, remain }
}

/**
 * douyin_duty 的 status 返回体（契约字段一个不少，另加几个给设置页用的）。
 * @param {{cfg?:object, duty?:object, now?:number, running?:boolean, compact?:boolean}} o
 */
export function statusOf({ cfg, duty, now = Date.now(), running = false, compact = false } = {}) {
  const c = dutyCfg(cfg)
  const d = normalizeDuty(duty, now)
  const windows = parseWindows(c.dutyWindow)
  const verdict = decide({ cfg, duty: d, now, running })
  const out = {
    ok: true,
    autoRun: c.autoRun === true,
    inWindow: inWindow(windows, now),
    nextWindowAt: nextWindowStart(windows, now),
    windows: windows.map((w) => w.start + '-' + w.end),
    todayScreens: d.todayScreens,
    dailyLimit: c.dailyLimit,
    remain: Math.max(0, c.dailyLimit - d.todayScreens),
    lastRunAt: d.lastRunAt > 0 ? d.lastRunAt : null,
    lastResult: d.lastResult,
    stateFile: dutyPath(),
    // ── 以下是给设置页/排查看的，不是契约必需 ──
    dutyWindow: c.dutyWindow,
    dutyIntervalMin: c.dutyIntervalMin,
    running: running === true,
    lastScreens: d.lastScreens,
    lastError: d.lastError,
    todayDate: d.todayDate,
    shouldRun: verdict.shouldRun,
    reasons: verdict.reasons,
  }
  if (compact) {
    delete out.windows
    delete out.stateFile
    delete out.dutyWindow
  }
  return out
}
