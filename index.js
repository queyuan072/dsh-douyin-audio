/**
 * dsh-douyin-audio —— 刷抖音 + 音频转写（host 半端）
 * 工具：douyin_scroll / douyin_transcribe / douyin_status / douyin_config
 * 只读查询：douyin_hot / douyin_search / douyin_video / douyin_comments（都走 scripts/douyin_read.py）
 * 通知（② 通知级闸门）：douyin_notes / douyin_messages —— 同样只读，只读页面不发消息、不标已读
 * 轻互动（③A 轻互动级闸门，默认关）：douyin_react —— 点赞 / 取消赞 / 收藏 / 取消收藏，走 scripts/douyin_action.py
 * 装入配置环境（基础能力，不设等级闸门）：douyin_setup —— mode=auto 扫描→复用或装 venv，装完写 pythonPath
 * 登录（基础能力，不设等级闸门）：douyin_login_start / douyin_login_poll
 *   两种模式：window = 弹真窗口人工扫码/过验证；qr = 后台派生脚本抓二维码给设置页扫
 * 谷时自动刷（基础能力，不设等级闸门）：douyin_duty —— status / run / history，
 *   运行痕迹写 <stateDir>/duty.json；apply() 里起一个 60 秒的调度器，五条全中才自己跑一轮
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { ensureDirs, loadCfg, saveCfg, stateDir, log as logLine } from './lib/state.mjs'
import { decide, dutyPath, readDuty, recordRun, statusOf } from './lib/duty.mjs'
import { findPython, runPython, SCRIPT_READ, SCRIPT_SCROLL, SCRIPT_TRANSCRIBE } from './lib/runner.mjs'

export const name = 'douyin-audio'
export const inject = ['webServer', 'tools']

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool || ((o) => o)
const z = hostDeps.z

export const Config = !z ? undefined : z.object({
  count: z.natural().default(3).extra('volatile', true),
  delay: z.number().default(1.5).extra('volatile', true),
  headless: z.boolean().default(true).extra('volatile', true),
  saveAll: z.boolean().default(true).extra('volatile', true),
  downloadTimeout: z.natural().default(300).extra('volatile', true),
  pythonPath: z.string().default('').extra('volatile', true),
  asrThreads: z.natural().default(8).extra('volatile', true),
  autoTranscribe: z.boolean().default(false).extra('volatile', true),
  loginMode: z.string().default('window').extra('volatile', true),
  readHeadless: z.boolean().default(true).extra('volatile', true),
  verifyWait: z.number().default(0).extra('volatile', true),
  // 浏览器通道：msedge（默认）/ chrome / 内置 chromium / firefox / webkit / 自定义项 id（custom-N）
  browserChannel: z.string().default('msedge').extra('volatile', true),
  // 手动添加的浏览器：JSON 数组字符串 [{"id","label","path"}]（用字符串存，避开旧宿主的数组类型兼容问题）
  browserExtras: z.string().default('[]').extra('volatile', true),
  // 谷时自动刷（契约见 lib/duty.mjs）：autoRun 默认 false —— 不开启就绝不自己定时跑
  autoRun: z.boolean().default(false).extra('volatile', true),
  dutyWindow: z.string().default('12:00-14:00,18:00-23:59').extra('volatile', true),
  dailyLimit: z.natural().default(5).extra('volatile', true),
  dutyIntervalMin: z.natural().default(30).extra('volatile', true),
  // 界面布局：classic = 平铺（默认，保持现状）/ tabs = 四标签页；取值不限制，未知值由前端按 classic 处理
  uiLayout: z.string().default('classic').extra('volatile', true),
})

/** asrThreads / autoTranscribe / readHeadless / verifyWait 的缺省值：lib/state.mjs 的 DEFAULTS 里没有这些键，白名单在这一层补齐；
 *  loginMode 两边都有，这里再留一份，防止旧 config.json / 旧 lib 读不到。
 *  readHeadless=true / verifyWait=0 就是历史的「一律无头、不等验证」，默认行为不变 */
const EXTRA_DEFAULTS = {
  asrThreads: 8, autoTranscribe: false, loginMode: 'window', readHeadless: true, verifyWait: 0,
  // 谷时自动刷四键：与 lib/state.mjs 的 DEFAULTS 一致，这里再留一份防旧 lib / 旧 config.json
  autoRun: false, dutyWindow: '12:00-14:00,18:00-23:59', dailyLimit: 5, dutyIntervalMin: 30,
  uiLayout: 'classic',
  // 浏览器通道：msedge（默认）/ chrome / chromium（内置）/ firefox / webkit / 自定义项 id
  browserChannel: 'msedge',
  // 手动添加的浏览器（JSON 数组字符串）：解析失败一律当 []，绝不抛
  browserExtras: '[]',
}

/** 读全配置：插件自己的这两把键在当前层补默认值，其余仍以 config.json / DEFAULTS 为准 */
const cfgAll = () => ({ ...EXTRA_DEFAULTS, ...loadCfg() })

// ── 浏览器通道（--browser-channel）──────────────────────────────────────────
//   只给三个会起浏览器的脚本用：douyin_scroller.py / douyin_read.py / douyin_login.py。
//   transcribe_douyin.py 不起浏览器，别给它传。
/** 五个合法取值；其余一律按 msedge 处理（与 lib/state.mjs 的 DEFAULTS 一致）
 *  候选链：msedge → [msedge, chrome, chromium]；chrome → [chrome, msedge, chromium]；chromium → [chromium]
 *          firefox → [firefox]；webkit → [webkit]
 *  说明：Chromium 系（msedge / chrome / chromium）同一个引擎家族，指纹相近，可互相回退；
 *        firefox / webkit 是不同引擎，静默回退会让人以为在测 Firefox 其实跑的是 Edge —— 由脚本直接报错。 */
export const BROWSER_CHANNELS = ['msedge', 'chrome', 'chromium', 'firefox', 'webkit']

/** 配置里的 browserChannel 规整成合法值；空 / 未知 → 'msedge'（默认行为不变） */
export function browserChannelOf(cfg) {
  const v = String((cfg && cfg.browserChannel) || '').trim().toLowerCase()
  return BROWSER_CHANNELS.includes(v) ? v : 'msedge'
}

/** 配置 → 真正下发给脚本的浏览器参数：{ argv, label, note }
 *    已知内核（五个）        → ['--browser-channel', <值>]
 *    自定义项且路径在        → ['--browser-executable', <该路径>]
 *    自定义项找不到 / 路径不在 → []（一个参数都不传，脚本走自己的默认 msedge 候选链）+ note 说明原因
 *  ⚠️ 自定义项绝不静默变成 Edge 还不吭声：argv 空着也会带一句 note，douyin_status 的 browserNote 就是它 */
export function resolveBrowser(cfg) {
  const raw = String((cfg && cfg.browserChannel) || '').trim()
  const low = raw.toLowerCase()
  // ① 空 / 已知内核 → --browser-channel
  if (!raw || BROWSER_CHANNELS.includes(low)) {
    const v = browserChannelOf(cfg)
    return { argv: ['--browser-channel', v], label: v }
  }
  // ② 值本身就是 exe 路径（快捷方式扫出来的项就是这么存的）→ --browser-executable
  //    也能认出 browserExtras 里的 id
  const extras = parseBrowserExtras(cfg && cfg.browserExtras)
  const hit = extras.find((e) => e.id === low) || null
  const target = hit ? hit.path : (/\.exe$/i.test(raw) || /[\\/]/.test(raw) ? raw : null)
  if (!target) {
    return { argv: [], label: raw, note: '浏览器通道 ' + raw + ' 既不是已知内核、也不在 browserExtras 里 —— 不传浏览器参数（脚本按默认 msedge 候选链走）' }
  }
  let ok = false
  try { ok = existsSync(target) } catch { ok = false }
  const label = 'custom(' + basename(target) + ')'
  if (!ok) return { argv: [], label, note: '浏览器 ' + raw + ' 的可执行文件路径不存在：' + target + ' —— 不传浏览器参数' }
  return { argv: ['--browser-executable', target], label }
}

/** 拼给脚本的 argv 片段：内核走 --browser-channel，自定义项走 --browser-executable（见 resolveBrowser） */
export function browserArgv(cfg) {
  return resolveBrowser(cfg).argv
}

// ── 各内核可用性探测（douyin_status 的 browsers 字段；设置页按它置灰按钮）──────
//   全部 try/catch：探测失败就当没装，绝不把 douyin_status 弄挂。
/** msedge / chrome：按常见安装路径探测（Program Files / Program Files(x86) / LOCALAPPDATA），命中就返回该 exe 路径 */
function findChromiumApp(exe) {
  try {
    const sub = exe === 'msedge.exe'
      ? ['Microsoft', 'Edge', 'Application', exe]
      : ['Google', 'Chrome', 'Application', exe]
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    for (const r of roots) {
      if (!r) continue
      const full = join(r, ...sub)
      if (existsSync(full)) return full
    }
    return null
  } catch { return null }
}

/** chromium / firefox / webkit：看 ms-playwright 目录里有没有对应子目录（chromium-* / firefox-* / webkit-*），命中返回子目录路径 */
function findPlaywrightBrowser(prefix) {
  try {
    const dirs = []
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH)
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'ms-playwright'))
    if (process.env.USERPROFILE) dirs.push(join(process.env.USERPROFILE, 'AppData', 'Local', 'ms-playwright'))
    for (const d of dirs) {
      try {
        if (!existsSync(d)) continue
        const hit = readdirSync(d).find((n) => String(n).startsWith(prefix + '-'))
        if (hit) return join(d, hit)
      } catch { /* 这个目录读不到就看下一个 */ }
    }
    return null
  } catch { return null }
}

/** browserExtras（JSON 数组字符串）→ [{ id, label, path }]；坏 JSON / 不是数组 / 没 path 的元素一律丢掉，绝不抛 */
export function parseBrowserExtras(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    if (!Array.isArray(v)) return []
    const out = []
    for (let i = 0; i < v.length; i++) {
      const x = v[i]
      if (!x || typeof x !== 'object') continue
      const path = String(x.path || '').trim()
      if (!path) continue
      const id = String(x.id || '').trim() || 'custom-' + (out.length + 1)
      out.push({ id, label: String(x.label || '').trim() || '自定义 ' + (out.length + 1), path })
    }
    return out
  } catch { return [] }
}

/** 五个内核 + 手动添加项（extras）装没装：布尔值给老前端兼容，paths 给「名字 + 路径」显示用
 *  extras 的 exists 用 existsSync 探测，取不到就是 false；shortcuts（快捷方式扫出来的）由 douyin_status 补 */
export function probeBrowsers(cfg) {
  const out = {
    msedge: false, chrome: false, chromium: false, firefox: false, webkit: false,
    paths: { msedge: null, chrome: null, chromium: null, firefox: null, webkit: null },
    extras: [], shortcuts: [],
  }
  try { out.paths.msedge = findChromiumApp('msedge.exe') } catch { out.paths.msedge = null }
  try { out.paths.chrome = findChromiumApp('chrome.exe') } catch { out.paths.chrome = null }
  try { out.paths.chromium = findPlaywrightBrowser('chromium') } catch { out.paths.chromium = null }
  try { out.paths.firefox = findPlaywrightBrowser('firefox') } catch { out.paths.firefox = null }
  try { out.paths.webkit = findPlaywrightBrowser('webkit') } catch { out.paths.webkit = null }
  for (const k of BROWSER_CHANNELS) out[k] = !!out.paths[k]
  try {
    out.extras = parseBrowserExtras(cfg && cfg.browserExtras).map((e) => {
      let exists = false
      try { exists = existsSync(e.path) } catch { exists = false }
      return { id: e.id, label: e.label, path: e.path, exists }
    })
  } catch { out.extras = [] }
  return out
}

// ── 开始菜单 / 桌面快捷方式里找浏览器（.lnk 交给 PowerShell 解析，自己不碰 LNK 二进制）──
//   结果按进程缓存：同一次运行只扫一次，用户点【扫描已安装的浏览器】时带 scan:true 才重扫。
/** 文件名（小写、去 .exe）命中即认为是浏览器 —— 别把 QQ / 微信塞进列表 */
export const BROWSER_EXE_NAMES = ['msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium',
  '360se', '360chrome', 'qqbrowser', 'sogoupv', 'ucbrowser']

let lnkScanCache = null

/** 用 PowerShell 一次性解析快捷方式目标：返回 [{ name, path }]；超时 8 秒，失败一律当没扫到（绝不抛） */
function scanLnkTargets() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([])
    const ps = [
      '$sh = New-Object -ComObject WScript.Shell',
      '$dirs = @([IO.Path]::Combine($env:ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"), [IO.Path]::Combine($env:APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"), [IO.Path]::Combine($env:USERPROFILE, "Desktop"), [IO.Path]::Combine($env:PUBLIC, "Desktop"))',
      'Get-ChildItem -Path $dirs -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $t = ""; try { $t = $sh.CreateShortcut($_.FullName).TargetPath } catch { $t = "" }; if ($t) { $t } }',
    ].join('; ')
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return resolve([]) }
    let out = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try { child.stdout.on('data', (d) => { out += d }) } catch { return done([]) }
    child.on('error', () => done([]))
    child.on('close', () => {
      const rows = []
      for (const line of String(out).split(/\r?\n/)) {
        const path = line.trim()
        if (path && /\.exe$/i.test(path)) rows.push({ name: exeBaseName(path), path })
      }
      done(rows)
    })
    setTimeout(() => { try { child.kill() } catch {} ; done([]) }, 8000)
  })
}

/** exe 路径 → 文件名（小写去 .exe）：既用来过名单，也当显示名 */
function exeBaseName(p) {
  const file = String(p).split(/[\\/]/).pop() || ''
  return file.toLowerCase().replace(/\.exe$/, '')
}

/** 快捷方式 → 浏览器列表：按名单过滤、按路径去重（同一条只出现一次）；已知安装路径命中的由 douyin_status 再剔一次 */
/** 快捷方式原始结果 → 浏览器列表：按 exe 名单过滤（QQ / 微信之类丢掉）、按路径去重 */
export function shortcutBrowsers(rows) {
  const seen = new Set()
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.path) continue
    const name = exeBaseName(r.path)
    if (!BROWSER_EXE_NAMES.includes(name)) continue
    const key = String(r.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: name.charAt(0).toUpperCase() + name.slice(1), path: String(r.path) })
  }
  return out
}

/** 去掉「已知安装路径已经命中」的那些：同一条浏览器只出现一次（已知安装路径优先） */
export function mergeShortcutList(found, paths) {
  const seen = new Set(Object.values(paths || {}).filter(Boolean).map((p) => String(p).toLowerCase()))
  const out = []
  for (const s of Array.isArray(found) ? found : []) {
    if (!s || !s.path) continue
    const key = String(s.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export async function scanShortcuts(force) {
  if (!force && lnkScanCache) return lnkScanCache
  let rows = []
  try { rows = await scanLnkTargets() } catch { rows = [] }
  lnkScanCache = shortcutBrowsers(rows)
  return lnkScanCache
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
}

function safe(v) {
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

/** python 侧实际写入的工作目录（douyin_scroller.py 里 SHOT_DIR = tempdir/douyin） */
const workRoot = () => join(tmpdir(), 'douyin')
const workVideos = () => join(workRoot(), 'videos')
const workManifest = () => join(workRoot(), 'manifest.txt')

/** 视频文件名就是 video_<屏号三位>.mp4（douyin_scroller.py: video_{scrolled:03d}.mp4）—— 屏号对文件，不按时间 */
const screenVideo = (screen) => join(workVideos(), 'video_' + String(screen).padStart(3, '0') + '.mp4')

/**
 * 解析 manifest.txt（douyin_scroller.py 写的）：
 *   表头   "# 抖音刷视频清单 vX.Y 时间"
 *   数据行 "屏号|标题|直链"
 *   无音轨 "# NO_AUDIO screen=N url=..."
 * 只认数据行，按文件里的先后顺序原样返回，**不排序**：屏号是脚本给的，不能用数组下标顶替。
 */
export function parseManifest(text) {
  const rows = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('|')
    if (parts.length < 2) continue
    const screen = Number(parts[0].trim())
    if (!Number.isInteger(screen) || screen <= 0) continue
    rows.push({ screen, title: parts[1].trim(), url: parts.slice(2).join('|').trim() })
  }
  return rows
}

/** 刷完给「人挑」的清单：屏号 → manifest 标题 + videos/ 里那一屏的文件（导出供自检/测试直接验证） */
export function manifestItems() {
  const mpath = workManifest()
  let rows = []
  try { rows = parseManifest(readFileSync(mpath, 'utf8')) } catch { rows = [] }
  const items = rows.map((r) => {
    const file = screenVideo(r.screen)
    let sizeMB = 0
    let hasFile = false
    try { sizeMB = Math.round((statSync(file).size / 1048576) * 100) / 100; hasFile = true } catch { hasFile = false }
    return { screen: r.screen, title: r.title, file: hasFile ? file : null, sizeMB, hasFile }
  })
  const totalMB = Math.round(items.reduce((s, i) => s + i.sizeMB, 0) * 100) / 100
  return { items, totalMB, manifestPath: mpath }
}

/** 从 video_<三位屏号>.mp4 解出屏号；不是这个形状（用户自己传的文件）就给 null，不瞎猜 */
const screenFromFile = (file) => {
  const m = /(?:^|[\\/])video_(\d{3})\.mp4$/i.exec(String(file || '').replace(/\\/g, '/'))
  return m ? Number(m[1]) : null
}

/**
 * 转写结果兜底（纯 BGM 的视频 text 是空串，只告诉人「空」没有用）：
 * 每条补 screen / title（来自 manifest，文件名对不上就都 null）/ hasSpeech，无语音的再加一句 note；
 * 顶层补 summary：{ transcribed: 有语音条数, empty: 无语音条数, totalMB: 选中文件总大小 }。
 */
export function decorateTranscribe(res, files = []) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.items)) return res
  const titles = new Map(manifestItems().items.map((row) => [row.screen, row.title]))
  let transcribed = 0
  let empty = 0
  let totalMB = 0
  const items = res.items.map((it, idx) => {
    const file = String((it && it.source) || files[idx] || '')
    const screen = screenFromFile(file)
    const text = it && typeof it.text === 'string' ? it.text : ''
    const hasSpeech = text.replace(/\s+/g, '').length >= 2
    if (hasSpeech) transcribed += 1
    else empty += 1
    try { totalMB += statSync(file).size / 1048576 } catch { /* 文件不在了就不算 */ }
    const next = {
      ...(it && typeof it === 'object' ? it : {}),
      screen: screen === null ? null : screen,
      title: screen === null ? null : (titles.get(screen) === undefined ? null : titles.get(screen)),
      hasSpeech,
    }
    if (!hasSpeech) next.note = '无语音（纯 BGM 或静音），可看 title 判断内容；需要更多信息可调用 douyin_video 看 tags'
    return next
  })
  return { ...res, items, summary: { transcribed, empty, totalMB: Math.round(totalMB * 100) / 100 } }
}

/** 文件修改时间（文件没了按 0），只用来挑「最新下载的那条」 */
const mtimeMs = (file) => { try { return statSync(file).mtimeMs } catch { return 0 } }

/**
 * 选要转写的文件（douyin_transcribe 与刷完自动转写共用）：
 * screens（按 manifest 屏号）> files（明确路径）> 自动（videos/ 里按修改时间倒序取 limit 个）
 */
function chooseTranscribeFiles(args, limit) {
  const wantScreens = Array.isArray(args.screens)
    ? [...new Set(args.screens.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))]
    : []
  const given = Array.isArray(args.files) ? args.files.filter(Boolean).map(String) : []
  const missingScreens = []
  const files = []
  let order = ''
  if (wantScreens.length) {
    order = 'screens'
    for (const s of wantScreens) {
      const file = screenVideo(s)
      if (existsSync(file)) files.push(file)
      else missingScreens.push(s)
    }
  } else if (given.length) {
    order = 'files'
    files.push(...given)
  } else {
    order = 'mtime-desc'
    const vdir = workVideos()
    if (existsSync(vdir)) {
      files.push(...readdirSync(vdir)
        .filter((name) => /\.(mp4|m4a|wav|mp3)$/i.test(name))
        .map((name) => join(vdir, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        .slice(0, limit))
    }
  }
  return { order, files, wantScreens, missingScreens }
}

/**
 * 跑一次转写脚本（唯一调用点：工具与刷完自动转写都走这里）：
 * 超时按 180 + 300 × 文件数，与 douyin_transcribe 的规则一致；失败不抛，只返回 { ok:false, reason }。
 */
async function runTranscribe(files, { cfg, modelDir, log } = {}) {
  const python = await findPython(log, 'sherpa_onnx', typeof cfg?.pythonPath === 'string' ? cfg.pythonPath : '')
  if (!python) return { ok: false, threads: null, reason: '找不到带 sherpa_onnx 的 Python。可在配置里设置 pythonPath。' }
  const argv = ['--json']
  for (const file of files) argv.push('--file', file)
  if (modelDir) argv.push('--model-dir', String(modelDir))
  // asrThreads 透传成 --threads（transcribe_douyin.py v1.3+ 支持；1..64 夹取，0/非法就不带）
  const threads = Math.max(0, Math.min(Math.round(Number(cfg?.asrThreads) || 0), 64))
  const useThreads = threads > 0
  if (useThreads) argv.push('--threads', String(threads))
  const r = await runPython(python, SCRIPT_TRANSCRIBE, argv, { timeoutSec: 180 + files.length * 300, log, tmpDir: join(stateDir(), 'wavtmp') })
  const txt = String(r.stdout || '').trim()
  const start = txt.indexOf('{')
  let parsed = null
  if (start >= 0) { try { parsed = JSON.parse(txt.slice(start)) } catch {} }
  log?.('transcribe 结束 code=' + r.code + ' threads=' + (useThreads ? threads : 'off') + ' 文件数=' + files.length)
  if (!parsed) {
    return { ok: false, exitCode: r.code, threads: useThreads ? threads : null, reason: '输出不是 JSON', output: tail(txt, 12) || tail(String(r.stderr || ''), 8) }
  }
  return {
    ...parsed,
    ok: r.ok && parsed.ok !== false,
    threads: parsed.threads === undefined ? (useThreads ? threads : null) : parsed.threads,
    exitCode: r.code,
  }
}

/**
 * 刷完顺手转写（只有 autoTranscribe 开着才跑，关着返回 null = 零开销）：
 * 取清单里「有文件」的最新 N 条（按文件修改时间倒序，最多 3 条），失败只影响这个字段，不改 scroll 的 ok。
 */
export async function autoTranscribeLatest(items, cfg, n = 1, log = null) {
  if (!cfg || cfg.autoTranscribe !== true) return null
  const want = Math.max(1, Math.min(Math.round(Number(n) || 1), 3))
  const withFile = (Array.isArray(items) ? items : []).filter((i) => i && i.hasFile && i.file)
  if (!withFile.length) {
    return { ok: false, attempted: 0, threads: null, items: [], reason: '清单里没有已下载的文件（saveAll 关着，或下载全部失败）' }
  }
  const picked = withFile
    .map((i) => ({ i, m: mtimeMs(i.file) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, want)
    .map((x) => x.i)
  const res = await runTranscribe(picked.map((i) => i.file), { cfg, log })
  const lines = (Array.isArray(res.items) ? res.items : []).map((it) => {
    const text = it && typeof it.text === 'string' ? it.text : ''
    return {
      file: it && it.source ? it.source : null,
      text,
      error: it && it.error ? it.error : null,
      hasSpeech: text.replace(/\s+/g, '').length >= 2,
    }
  })
  const out = { ok: res.ok === true, attempted: picked.length, threads: res.threads === undefined ? null : res.threads, items: lines }
  if (res.ok !== true && res.reason) out.reason = String(res.reason)
  return out
}

/** 刷完的返回体：脚本输出 + 清单（items/totalMB/manifestPath）+ autoTranscribe（关着是 null） */
/** 实际刷了几屏：优先读脚本自己打的那行（"  下滑屏数: 3"），没有就看 manifest 行数（脚本每轮 w 覆盖写） */
export function actualScreens(stdout, items) {
  const m = /下滑屏数\s*[:：]\s*(\d+)/.exec(String(stdout || ''))
  if (m) return Number(m[1])
  return Array.isArray(items) ? items.length : 0
}

export async function scrollResult({ ok, code, stdout, stderr, count, cfg, log } = {}) {
  const out = String(stdout || '')
  const mf = manifestItems()
  return {
    ok: !!ok && out.includes('本次刷视频统计'),
    exitCode: code,
    // screens 是**实际**刷到的屏数（脚本输出 / manifest 行数），不是请求的 count ——
    // 撞登录墙 / 验证码被提前挡下时两者不一样，回请求值等于骗人；请求值另存 screensRequested
    screens: actualScreens(out, mf.items),
    screensRequested: count === undefined || count === null ? null : count,
    items: mf.items,
    totalMB: mf.totalMB,
    manifestPath: mf.manifestPath,
    dirs: { root: workRoot(), videos: workVideos() },
    autoTranscribe: await autoTranscribeLatest(mf.items, cfg, 1, log),
    output: tail(out, 18) || tail(String(stderr || ''), 8),
  }
}

/** POST body 上限：超过就掐连接 */
const BODY_MAX = 262144

/** 读 POST body（限 256KB）：超限先 resolve({}) 再 destroy —— destroy 之后 'end'/'error' 可能都不再来 */
function readJson(req) {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    req.on('data', (c) => {
      if (settled) return
      buf += c
      if (buf.length <= BODY_MAX) return
      buf = ''
      done({})
      try { req.destroy() } catch { /* 连接已经断了 */ }
    })
    req.on('end', () => { try { done(JSON.parse(buf || '{}')) } catch { done({}) } })
    req.on('error', () => done({}))
  })
}

// ── 同源鉴权（插件 HTTP 路由唯一的门）───────────────────────────────────────
// 宿主自己的 /api/version 有鉴权，插件挂的 prefix 路由没有：任何本地进程、任何网页
// （跨站表单、text/plain 的简单请求、fetch no-cors）都能打进来执行动作。这里补一道同源门，
// 三种情形放行，其余一律 403 且**不执行任何动作**：
//   ① 带本插件签发的 token（x-dsh-douyin-token，或 GET 的 ?token=）
//   ② Sec-Fetch-Site: same-origin（现代浏览器同源请求必带）
//   ③ Origin 存在且它的 host:port 等于本次请求的 Host
// 三条都不满足（典型：curl / 本地进程 / 无 Origin 的跨站请求）→ 拒绝。
const AUTH_TOKEN_TTL_MS = 10 * 60 * 1000
const AUTH_TOKEN_HEADER = 'x-dsh-douyin-token'
const authTokens = new Map()   // token -> 过期时间戳（只在内存里，进程重启即失效）

/** 签发一个 32 hex token（10 分钟内可复用；顺手清掉过期的，别让 Map 无限长） */
function issueAuthToken() {
  const now = Date.now()
  for (const [t, exp] of authTokens) if (exp <= now) authTokens.delete(t)
  const token = randomBytes(16).toString('hex')
  authTokens.set(token, now + AUTH_TOKEN_TTL_MS)
  return token
}

/** token 还在有效期内？（过期的顺手删掉） */
function authTokenValid(token) {
  const t = String(token || '').trim()
  if (!t) return false
  const exp = authTokens.get(t)
  if (!exp) return false
  if (exp <= Date.now()) { authTokens.delete(t); return false }
  return true
}

/** 取头字段：名字大小写不定（宿主 Node 给的是小写，手搓的桩可能不是） */
function headerOf(req, name) {
  const headers = (req && req.headers) || {}
  const want = String(name).toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== want) continue
    const v = headers[k]
    return Array.isArray(v) ? String(v[0] === undefined ? '' : v[0]) : String(v === undefined || v === null ? '' : v)
  }
  return ''
}

/** 'https://h:1/x' / 'h:1' → 'h:1'（小写；解析不了就是空串） */
function hostOf(value) {
  const s = String(value || '').trim().toLowerCase()
  if (!s) return ''
  try { return new URL(s.includes('://') ? s : 'http://' + s).host.toLowerCase() } catch { return '' }
}

/** 同源判定：{ ok, via } —— via 只进日志/返回体，方便排查「为什么被拦」
 *  规则是「**只按正面证据拒绝**」，不是「没有证据就拒绝」：
 *   - 浏览器发出的跨站请求一定会带 Origin / Sec-Fetch-Site，据此拦截；
 *   - DSH 的界面（Chromium 之外还有桥接通道）可能两个头都不带，那时放行 ——
 *     否则设置页会 403（实测过）。本机进程同样能伪造这两个头，但那已经超出
 *     本路由的威胁模型：本机进程本来就能直接改 config.json。 */
function sameOrigin(req, queryToken) {
  if (authTokenValid(headerOf(req, AUTH_TOKEN_HEADER)) || authTokenValid(queryToken)) return { ok: true, via: 'token' }
  const site = headerOf(req, 'sec-fetch-site').trim().toLowerCase()
  const origin = hostOf(headerOf(req, 'origin'))
  const self = hostOf(headerOf(req, 'host'))
  // 有 Sec-Fetch-Site 就只认 same-origin；same-site 也不行（同域不同端口仍是别的页面）
  if (site) {
    if (site === 'same-origin') return { ok: true, via: 'sec-fetch-site' }
    return { ok: false, via: null, site, origin: origin || null }
  }
  // 有 Origin 就必须等于本请求的 Host
  if (origin) {
    if (origin === self) return { ok: true, via: 'origin' }
    return { ok: false, via: null, site: null, origin }
  }
  // 两个头都没有：不是浏览器页面发起的（curl / Electron 桥接 / 本机进程），放行
  return { ok: true, via: 'no-cross-site-evidence' }
}

/** 数值型配置的硬底线（非法直接拒绝，不夹取） */
const NUMERIC_CFG_RULES = {
  count: { min: 1, label: '屏数' },
  delay: { min: 0, label: '每屏停留秒数' },
  downloadTimeout: { min: 30, label: '单个视频下载超时（秒）' },
}

/** 数值校验：没问题返回 null，有问题返回人话。工具与 HTTP /config 共用一套规则 */
function checkNumericCfg(key, v) {
  const rule = NUMERIC_CFG_RULES[key]
  if (!rule) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < rule.min) {
    return key + '（' + rule.label + '）需 >= ' + rule.min + '，收到 ' + JSON.stringify(v === undefined ? null : v)
  }
  return null
}

function tail(text, n = 12) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join('\n')
}

// ── 登录：目录、脚本、状态文件（host 侧与 scripts/douyin_login.py 的共用契约）──────
// <stateDir>/login/  qr.png（qr 模式每 3 秒覆盖刷新）+ state.json + login.log
// state.json: { phase: waiting|scanned|ok|expired|error, at: epoch ms, message, cookiePath, mode }
const loginDir = () => join(stateDir(), 'login')
const loginQrPath = () => join(loginDir(), 'qr.png')
const loginStatePath = () => join(loginDir(), 'state.json')
const loginLogPath = () => join(loginDir(), 'login.log')

/** 登录脚本路径：这里自己拼，不动 lib/runner.mjs（另一个脚本正在改 douyin_login.py） */
const SCRIPT_LOGIN = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'douyin_login.py')
/** 轻互动脚本（③A 档）：CLI 风格与 douyin_read.py 一致 —— 第一位置参数是动作 */
const SCRIPT_ACTION = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'douyin_action.py')

/** 测试缝（只给 selfcheck 用）：把「脚本路径 / 找 Python / 跑脚本」三步换掉，好断言 argv 而不用真起浏览器。
 *  生产路径永远是 SCRIPT_ACTION + findPython + runPython；传 null 或省略就保持/复位成真实现。 */
const REACT_REAL = { script: SCRIPT_ACTION, python: findPython, run: runPython }
const reactDeps = { ...REACT_REAL }
export function __reactDeps(next) {
  for (const k of ['script', 'python', 'run']) {
    if (next && Object.prototype.hasOwnProperty.call(next, k)) reactDeps[k] = next[k] || REACT_REAL[k]
  }
  return { script: reactDeps.script, stubbed: reactDeps.run !== REACT_REAL.run }
}

/** 插件版本：读本插件 package.json 的 version（给设置页顶栏用）；读不到就 null，绝不抛错 */
let pluginVersionCache
function pluginVersion() {
  if (pluginVersionCache !== undefined) return pluginVersionCache
  pluginVersionCache = null
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg && typeof pkg.version === 'string' && pkg.version) pluginVersionCache = pkg.version
  } catch { /* 读不到就是 null：版本号不该把 douyin_status 弄挂 */ }
  return pluginVersionCache
}

/* ── 检查更新 ──────────────────────────────────────────────────────────────
 * 问 npm registry 拿 latest，跟本地 package.json 的 version 比。
 * 只读、不改任何东西；失败不抛错，把原因写成人话返回（离网也能点）。
 * 测试缝 __updateDeps 让 selfcheck 注入假 fetch，避免测试真的联网。 */
const UPDATE_PAGE = 'https://www.npmjs.com/package/dsh-douyin-audio'
const UPDATE_INSTALL = 'npm install dsh-douyin-audio@latest'
const UPDATE_TIMEOUT_MS = 10000
/* 顺序即优先级：双端仓库在前（用户要求「优先从远端双端查」），npm 兜底。
   GitHub / GitCode 都用 contents 接口（返回 base64），解析统一交给 versionFromBody。 */
const UPDATE_SOURCES = [
  // 仓库源：国内 GitCode(AtomGit) 优先（几百毫秒），GitHub 次之。
  // 两个都问、取最高版本 —— 镜像可能落后（曾出现 AtomGit 停在 1.2.0 而 GitHub 已 1.2.3），
  // 只信第一个答的会误报「已是最新」。
  { name: 'AtomGit', kind: 'repo', url: 'https://api.gitcode.com/api/v5/repos/queyuan072/dsh-douyin-audio/contents/package.json?ref=main' },
  { name: 'GitHub', kind: 'repo', url: 'https://api.github.com/repos/queyuan072/dsh-douyin-audio/contents/package.json?ref=main' },
  // 仓库源全都答不上来时才问 npm（境外、常超时，只当兜底）
  { name: 'npm', kind: 'registry', url: 'https://registry.npmjs.org/dsh-douyin-audio/latest' },
]
const __UPDATE_REAL = { fetch: (u, o) => fetch(u, o) }
const updateDeps = { ...__UPDATE_REAL }

export function __updateDeps(next) {
  if (next && Object.prototype.hasOwnProperty.call(next, 'fetch')) updateDeps.fetch = next.fetch || __UPDATE_REAL.fetch
  return { stubbed: updateDeps.fetch !== __UPDATE_REAL.fetch }
}

/** 比较两个 semver（只认 x.y.z 的数字段，预发布后缀忽略）：a>b 返回正数 */
function compareVer(a, b) {
  const parse = (v) => String(v || '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/** 检查更新：{ ok, current, latest?, hasUpdate?, error? } —— 永不抛错 */
async function checkUpdate() {
  const current = pluginVersion()
  const tried = []
  /* 分源查询：双端仓库优先（raw/API 更快也更稳），npm registry 兜底。
     GitHub 走 API 的 contents（返回 base64）；GitCode 有同形的 v5 接口；npm 直接给 version。 */
  let best = null   // { version, source } —— 取所有仓库源里最高的那个
  for (const src of UPDATE_SOURCES) {
    if (src.kind === 'registry' && best) break   // 仓库源已经有答案，npm 就不必问了
    const t0 = Date.now()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), UPDATE_TIMEOUT_MS)
    let res
    try {
      res = await updateDeps.fetch(src.url, { headers: { accept: 'application/json', 'user-agent': 'dsh-douyin-audio-update' }, signal: ac.signal })
    } catch (e) {
      const why = e && e.name === 'AbortError' ? '超时（' + Math.round(UPDATE_TIMEOUT_MS / 1000) + ' 秒）' : ((e && e.message) || '网络问题')
      tried.push({ name: src.name, ok: false, ms: Date.now() - t0, error: why })
      continue
    } finally {
      clearTimeout(timer)
    }
    if (!res || typeof res.ok !== 'boolean') {
      tried.push({ name: src.name, ok: false, ms: Date.now() - t0, error: '没有正常响应' })
      continue
    }
    if (!res.ok) {
      tried.push({ name: src.name, ok: false, ms: Date.now() - t0, error: 'HTTP ' + res.status })
      continue
    }
    let body = null
    try { body = await res.json() } catch {
      tried.push({ name: src.name, ok: false, ms: Date.now() - t0, error: '返回的不是 JSON' })
      continue
    }
    const latest = versionFromBody(body)
    if (!latest) {
      tried.push({ name: src.name, ok: false, ms: Date.now() - t0, error: '没解析出 version' })
      continue
    }
    tried.push({ name: src.name, ok: true, ms: Date.now() - t0, version: latest })
    if (!best || compareVer(latest, best.version) > 0) best = { version: latest, source: src.name }
  }
  if (best) {
    return {
      ok: true,
      current,
      latest: best.version,
      hasUpdate: compareVer(best.version, current) > 0,
      source: best.source,
      tried,
      page: UPDATE_PAGE,
      install: UPDATE_INSTALL,
    }
  }
  return {
    ok: false,
    current,
    latest: null,
    hasUpdate: false,
    tried,
    error: '三个源都没连上：' + tried.map((t) => t.name + '（' + t.error + '）').join('、'),
    page: UPDATE_PAGE,
  }
}

const PLUGIN_NAME = 'dsh-douyin-audio'

/** 本插件是怎么装上的：file: 链接（本机源码）还是 npm 包 —— 决定能不能自己升级 */
function pluginInstallInfo() {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const profileDir = dirname(dirname(pluginDir))          // …/profiles/<profile>/node_modules/<pkg> → profile
  let spec = ''
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const deps = pkg.dependencies || {}
    const dev = pkg.devDependencies || {}
    spec = deps[PLUGIN_NAME] || dev[PLUGIN_NAME] || ''
  } catch { /* 读不到 profile package.json：当未知处理 */ }
  const linked = !spec || /^file:/i.test(spec)
  return { pluginDir, profileDir, spec, linked, mode: linked ? 'linked' : 'npm' }
}

/** 在插件源码目录跑 git pull --ff-only（60 秒上限），把输出带回去 */
function gitPull(pluginDir) {
  return new Promise((resolve) => {
    let out = ''
    const push = (b) => { out += String(b); if (out.length > 8000) out = out.slice(-8000) }
    let child
    try {
      child = spawn('git', ['pull', '--ff-only'], { cwd: pluginDir, windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, code: null, output: String((e && e.message) || e) })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 60000)
    if (child.stdout && child.stdout.on) child.stdout.on('data', push)
    if (child.stderr && child.stderr.on) child.stderr.on('data', push)
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, output: String((e && e.message) || e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: out.trim() }) })
  })
}

/** 在 profile 目录跑 npm install <spec>：file: 依赖是「复制」不是软链，源码拉新后副本不会自动变 */
function npmInstallSpec(profileDir, spec) {
  return new Promise((resolve) => {
    let out = ''
    const push = (b) => { out += String(b); if (out.length > 8000) out = out.slice(-8000) }
    let child
    try {
      child = spawn('npm', ['install', spec, '--no-audit', '--no-fund'], {
        cwd: profileDir, shell: process.platform === 'win32', windowsHide: true,
      })
    } catch (e) {
      return resolve({ ok: false, output: String((e && e.message) || e) })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 180000)
    if (child.stdout && child.stdout.on) child.stdout.on('data', push)
    if (child.stderr && child.stderr.on) child.stderr.on('data', push)
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: String((e && e.message) || e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: out.trim() }) })
  })
}

/** 执行升级：npm 安装 → npm install；源码链接 → git pull（绝不覆盖、绝不删除） */
async function applyUpdate(action) {
  const info = pluginInstallInfo()
  if (info.linked) {
    if (action !== 'pull') {
      return {
        ok: false,
        mode: 'linked',
        need: 'pull',
        spec: info.spec || '(未声明)',
        command: UPDATE_INSTALL,
        pluginDir: info.pluginDir,
        message: '当前是按本机源码链接安装的（profile 里写的是 ' + (info.spec || 'file:…') + '）：'
          + '插件只会在源码目录执行 git pull，不会覆盖或删除任何文件。',
      }
    }
    const r = await gitPull(info.pluginDir)
    if (!r.ok) {
      return {
        ok: false, mode: 'linked', action: 'pull', pluginDir: info.pluginDir, code: r.code, output: r.output,
        message: 'git pull 没成功（退出码 ' + r.code + '）。可能是本地有改动或没网：\n' + r.output,
      }
    }
    // file: 依赖是复制、不是软链 —— 源码拉新后必须让 profile 重装一次，运行中的副本才会跟上
    const sync = await npmInstallSpec(info.profileDir, info.spec)
    return {
      ok: true,
      mode: 'linked',
      action: 'pull',
      pluginDir: info.pluginDir,
      code: r.code,
      output: r.output,
      synced: sync.ok,
      syncOutput: String(sync.output || '').slice(-1200),
      message: (sync.ok
        ? '源码已更新并同步到安装副本。请重启 DSH 生效。'
        : '源码已更新，但同步到安装副本失败（可手动在 profile 目录跑 npm install）。请重启 DSH。')
        + '\n' + r.output,
    }
  }
  const dir = stateDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* 目录已存在 */ }
  const logf = join(dir, 'update.log')
  let fd = null
  try {
    fd = openSync(logf, 'a')
    writeFileSync(logf, '\n=== ' + new Date().toISOString() + '  npm install ' + PLUGIN_NAME + '@latest  (cwd ' + info.profileDir + ')\n')
  } catch { /* 日志打不开也要继续装 */ }
  try {
    const child = spawn('npm', ['install', PLUGIN_NAME + '@latest', '--no-audit', '--no-fund'], {
      cwd: info.profileDir,
      shell: process.platform === 'win32',
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd || 'ignore', fd || 'ignore'],
    })
    child.unref()
    return {
      ok: true,
      started: true,
      mode: 'npm',
      log: logf,
      profileDir: info.profileDir,
      message: '已开始升级（npm install ' + PLUGIN_NAME + '@latest）。装完请重启 DSH 生效，日志在 ' + logf,
    }
  } catch (e) {
    return { ok: false, mode: 'npm', log: logf, message: '启动 npm 失败：' + ((e && e.message) || String(e)) }
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关 */ } }
  }
}

/** 从各源的返回体里取 version：npm 直接给；GitHub/GitCode 的 contents 接口给 base64 content */
function versionFromBody(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.version === 'string' && body.version) return body.version
  const b64 = typeof body.content === 'string' ? body.content.replace(/\s+/g, '') : ''
  if (!b64) return ''
  try {
    const txt = Buffer.from(b64, 'base64').toString('utf8')
    const pkg = JSON.parse(txt)
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch { /* 解不开就当这个源没给 */ }
  return ''
}

/** 登录账号缓存：stateDir/account.json —— whoami 读到的昵称存这儿，界面直接显示 */
function accountFile() {
  return join(stateDir(), 'account.json')
}

function readAccount() {
  try {
    const j = JSON.parse(readFileSync(accountFile(), 'utf8'))
    if (j && typeof j.nick === 'string' && j.nick) return { known: true, nick: j.nick, uid: String(j.uid || ''), at: j.at || null }
  } catch { /* 没有缓存就返回未识别 */ }
  return { known: false, nick: '', uid: '', at: null }
}

function saveAccount(nick, uid) {
  try {
    ensureDirs()
    writeFileSync(accountFile(), JSON.stringify({ nick: String(nick || ''), uid: String(uid || ''), at: new Date().toISOString() }, null, 2))
    return true
  } catch (e) {
    log('账号缓存写入失败: ' + ((e && e.message) || e))
    return false
  }
}

/** cookie 落点：DOUYIN_COOKIE_FILE > ~/.dsh/cookies/douyin_cookies.txt（与脚本默认值一致） */
function loginCookieFile() {
  const env = String(process.env.DOUYIN_COOKIE_FILE || '').trim()
  if (env) return env
  const home = String(process.env.USERPROFILE || process.env.HOME || '')
  return join(home, '.dsh', 'cookies', 'douyin_cookies.txt')
}

/** 读 <stateDir>/login/state.json：没有 / 坏了 / 不是对象 → null（绝不抛） */
function readLoginState() {
  try {
    const st = JSON.parse(readFileSync(loginStatePath(), 'utf8'))
    return st && typeof st === 'object' && !Array.isArray(st) ? st : null
  } catch { return null }
}

/** 登录最多等多久（秒）：传给脚本 --wait；window 模式的超时预算 = 它 + 60s */
const LOGIN_WAIT = 300
/** qr 模式：派生脚本后最多等多久让 qr.png 出现（毫秒），等不到就把日志路径告诉人 */
const LOGIN_QR_READY_MS = 15000

// ── 装入配置环境：<插件根>/venv + 后台派生安装脚本 ─────────────────────────────
// 契约（host 侧与脚本侧共用）：脚本 --json 只往 stdout 打一个信封（进度走 stderr + setup.log）
//   scan    { ok, mode:'scan', pythons:[{path,version,source,hasPlaywright,hasSherpa,usable}],
//             ffmpeg{path,ok,source}, model{…}, cookie{path,exists,count},
//             verdict{canReusePython,reusePath,reuseReason,missing}, elapsed }
//   install { ok, mode, action:'reused'|'installed'|'failed', python, pythonPath, version,
//             playwright, sherpa, ffmpeg{…}, model{…}, missing, nextSteps, log, elapsed, error? }
// 装成功由脚本自己把 <插件根>/venv/Scripts/python.exe 写进配置的 pythonPath（host 不新增配置键）。
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
/**
 * 六个 mode：auto（默认，扫描→复用或安装）/ scan（只体检）**前台同步**；
 * minimal / full / minimal-force / full-force 后台派生（-force = 加 --force-venv，不复用已有 Python）。
 */
const SETUP_MODES = ['auto', 'scan', 'minimal', 'full', 'minimal-force', 'full-force']
/** 安装脚本：按候选名顺序找（脚本侧改名也不至于整块功能哑掉） */
const SETUP_SCRIPTS = ['douyin_setup.py', 'setup_env.py', 'setup.py'].map((f) => join(PLUGIN_ROOT, 'scripts', f))
/** 派生后最多等多久确认「进程起来了」（毫秒）；起来就返回，不等它装完 */
const SETUP_WAIT_MS = 3000
/** setup.log 最近这么久内有动过 = 有安装进程在跑（正在装的时候别让人再点一次） */
const SETUP_ACTIVE_MS = 60000
/** 锁文件超过这么久 = 上一轮崩掉留下的残锁，不再挡人 */
const SETUP_STALE_LOCK_MS = 30 * 60 * 1000
/** scan 是前台同步的：几秒的活，给 2 分钟天花板 */
const SETUP_SCAN_TIMEOUT_S = 120
/** auto 也是前台同步的（扫描 + 装依赖 + 写配置），首次装依赖几分钟，给 30 分钟天花板 */
const SETUP_AUTO_TIMEOUT_S = 1800
/** venv 里两个模块的探测超时：探得到就探，探不动就当没有，别把 douyin_status 拖死 */
const VENV_PROBE_TIMEOUT_MS = 8000
/** 一次问清两个模块（真 import，不是 find_spec）：stdout 打印能 import 的那些 */
const VENV_PROBE_CODE = "ok = []\nfor m in ('playwright', 'sherpa_onnx'):\n    try:\n        __import__(m)\n        ok.append(m)\n    except Exception:\n        pass\nprint(' '.join(ok))"

const setupLogPath = () => join(stateDir(), 'setup.log')
const setupLockPath = () => join(stateDir(), 'setup.lock')
/** host 侧对最近一次 scan 的缓存（脚本的 log 行格式不归我们管，这份才是稳定的数据源） */
const setupScanPath = () => join(stateDir(), 'scan.json')
/** 脚本装完写的结论：{ action, pythonPath, version, hasPlaywright, hasSherpa, ffmpeg, model, missing, nextSteps, at, elapsed } */
const setupResultPath = () => join(stateDir(), 'setup-result.json')
const setupScript = () => setupDeps.script || SETUP_SCRIPTS.find((p) => existsSync(p)) || SETUP_SCRIPTS[0]
const venvRoot = () => setupDeps.venvDir || join(PLUGIN_ROOT, 'venv')
const venvPython = () => join(venvRoot(), process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')

/** 测试缝（只给 selfcheck / 验收脚本用）：脚本路径、venv 位置、后台派生、venv 探测、前台 run 都能换掉，
 *  好断言而不真装环境。生产路径永远是 resolve 出来的 scripts/*.py + spawnSetupBg + probeVenvModules；
 *  传 null 或省略就复位成真实现。 */
const setupDeps = { script: null, venvDir: null, spawn: null, probe: null, run: null }
let venvProbeCache = null   // { key, value }：同一次运行只探一次
export function __setupDeps(next) {
  for (const k of Object.keys(setupDeps)) {
    if (next && Object.prototype.hasOwnProperty.call(next, k)) setupDeps[k] = next[k] || null
  }
  venvProbeCache = null   // 换了探测 / 换了 venv：缓存跟着作废
  return { script: setupScript(), venvDir: venvRoot(), stubbed: !!(setupDeps.spawn || setupDeps.probe || setupDeps.run) }
}

/** mtime（毫秒）；文件不在就是 0 */
const mtimeOf = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }

/** setup.log 的最后 n 行（没有日志就是 []） */
function setupLogTail(n = 20) {
  try {
    return String(readFileSync(setupLogPath(), 'utf8')).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n)
  } catch { return [] }
}

/**
 * 已经在装了？三条判据：
 *   ① 锁文件还在（30 分钟内的，更久当上一轮崩掉的残锁）；
 *   ② setup-result.json 比 setup.log 新 —— 脚本已经写完结论，算结束（不然装完还要白等 60 秒日志窗口）；
 *   ③ setup.log 最近 60 秒内有新行。
 */
function setupRunning() {
  const lock = mtimeOf(setupLockPath())
  if (lock && Date.now() - lock < SETUP_STALE_LOCK_MS) return { running: true, why: '锁文件还在：' + setupLockPath() }
  const last = mtimeOf(setupLogPath())
  if (last && Date.now() - last < SETUP_ACTIVE_MS && mtimeOf(setupResultPath()) < last) {
    return { running: true, why: 'setup.log ' + Math.round((Date.now() - last) / 1000) + ' 秒前还有新行' }
  }
  return { running: false, why: '' }
}

/** 脚本写的安装结论：没有 / 坏了 / 不是对象 → null（绝不抛，UI 只按 null 显示「还没结果」） */
function readSetupResult() {
  try {
    const r = JSON.parse(readFileSync(setupResultPath(), 'utf8'))
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null
    const action = ['reused', 'installed', 'failed'].includes(String(r.action || '')) ? String(r.action) : null
    return {
      action,
      ok: r.ok === false ? false : action !== 'failed',
      pythonPath: typeof r.pythonPath === 'string' && r.pythonPath.trim() ? r.pythonPath.trim() : null,
      version: r.version === undefined || r.version === null ? '' : String(r.version),
      hasPlaywright: r.hasPlaywright === undefined ? null : !!r.hasPlaywright,
      hasSherpa: r.hasSherpa === undefined ? null : !!r.hasSherpa,
      ffmpeg: typeof r.ffmpeg === 'string' ? r.ffmpeg : (r.ffmpeg && typeof r.ffmpeg === 'object' ? (r.ffmpeg.path || null) : null),
      model: typeof r.model === 'string' ? r.model : (r.model && typeof r.model === 'object' ? (r.model.path || null) : null),
      missing: Array.isArray(r.missing) ? r.missing.map(String) : [],
      nextSteps: Array.isArray(r.nextSteps) ? r.nextSteps.map(String) : [],
      at: Number(r.at) || 0,
      elapsed: Number(r.elapsed) || 0,
      error: r.error ? String(r.error) : null,
    }
  } catch { return null }
}

/** venv 是拿哪个 python 建的：优先 pyvenv.cfg 的 home= 行，其次 setup.log 里脚本打的「base python: …」 */
function readBasePython() {
  try {
    const m = /^\s*home\s*=\s*(.+)$/im.exec(readFileSync(join(venvRoot(), 'pyvenv.cfg'), 'utf8'))
    if (m && m[1].trim()) return m[1].trim()
  } catch { /* 没有 pyvenv.cfg 就看日志 */ }
  try {
    const hits = [...String(readFileSync(setupLogPath(), 'utf8')).matchAll(/base python:\s*(.+)/gi)]
    if (hits.length) return hits[hits.length - 1][1].trim()
  } catch { /* 没有日志就是 null */ }
  return null
}

/** setup.log 里最近一次的「复用这个 python」行（脚本 scan 的结论；没有就是 null） */
function reuseFromLog() {
  try {
    const hits = [...String(readFileSync(setupLogPath(), 'utf8')).matchAll(/reuse(?:-| )?python\s*[:=]\s*(.+)/gi)]
    const last = hits.length ? hits[hits.length - 1][1].trim() : ''
    return last || null
  } catch { return null }
}

/** 空探针结果：venv python 不在 / 起不来，都算「两个模块都没有」 */
const NO_MODULES = { playwright: false, sherpa: false }

/** 起子进程 import 两个模块：8 秒超时，失败当没有（探测绝不把 douyin_status 弄挂） */
function probeVenvModules(pythonPath) {
  return new Promise((resolve) => {
    let child = null
    let timer = null
    let settled = false
    const done = (v) => { if (!settled) { settled = true; try { clearTimeout(timer) } catch { /* ignore */ } resolve(v) } }
    try {
      child = spawn(pythonPath, ['-c', VENV_PROBE_CODE], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch { return done(NO_MODULES) }
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => done(NO_MODULES))
    child.on('close', (code) => {
      const hit = new Set(String(out).split(/[\s,]+/).filter(Boolean))
      done(code === 0 ? { playwright: hit.has('playwright'), sherpa: hit.has('sherpa_onnx') } : NO_MODULES)
    })
    timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } ; done(NO_MODULES) }, VENV_PROBE_TIMEOUT_MS)
    timer.unref?.()
    return undefined
  })
}

/**
 * venv 里两个模块就绪没。venv python 不在就零子进程直接 false/false；
 * 在的话**同一次运行只探一次**（缓存 key 带 setup.log 的 mtime —— 装完日志一变就重探，
 * 否则「刚装完还是 false」会让人以为装失败了）。
 */
async function venvModules() {
  const py = venvPython()
  if (!existsSync(py)) return NO_MODULES
  const key = py + '|' + mtimeOf(setupLogPath())
  if (venvProbeCache && venvProbeCache.key === key) return venvProbeCache.value
  const probe = setupDeps.probe || probeVenvModules
  let value = NO_MODULES
  try { value = (await probe(py)) || NO_MODULES } catch { value = NO_MODULES }
  venvProbeCache = { key, value }
  return value
}

/** 起安装脚本用哪个 python：配置 pythonPath → DSH 自带 runtime 的 python → 环境变量 → 命令名。
 *  带路径分隔符的必须真存在（否则就是拿旧路径白跑一遍）；裸命令名交给 PATH 自己找。 */
function setupPythonCandidates(extra) {
  const list = []
  const push = (p) => {
    const s = typeof p === 'string' ? p.trim() : ''
    if (!s || list.includes(s)) return
    if ((s.includes('/') || s.includes('\\')) && !existsSync(s)) return
    list.push(s)
  }
  const home = String(process.env.USERPROFILE || process.env.HOME || '')
  push(extra)
  if (home) {
    try {
      for (const d of readdirSync(join(home, '.dsh', 'dsh-runtimes'))) {
        push(join(home, '.dsh', 'dsh-runtimes', d, 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python'))
      }
    } catch { /* 没有 .dsh/dsh-runtimes 就算了 */ }
  }
  push(process.env.DSH_PYTHON)
  push(process.env.PYTHON3)
  push(process.env.PYTHON)
  push('python3')
  push('python')
  return list
}

/** 后台派生安装脚本：stdout/stderr 一起重定向到 setup.log，起来就返回（最多等 SETUP_WAIT_MS）。 */
function spawnSetupBg(python, script, argv) {
  return new Promise((resolve) => {
    let fd = null
    let child = null
    let timer = null
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; try { clearTimeout(timer) } catch { /* ignore */ } resolve(v) } }
    try {
      try { mkdirSync(stateDir(), { recursive: true }); fd = openSync(setupLogPath(), 'a') } catch { fd = null }
      const stdio = fd === null ? ['ignore', 'ignore', 'ignore'] : ['ignore', fd, fd]
      child = spawn(python, [script, ...argv], {
        cwd: dirname(script),
        env: process.env,
        stdio,
        detached: true,        // 工具返回 / 宿主退出都不带走它
        windowsHide: true,
      })
    } catch (e) {
      try { if (fd !== null) closeSync(fd) } catch { /* ignore */ }
      return finish({ ok: false, pid: null, spawnError: true, reason: String((e && e.message) || e) })
    }
    // 子进程已经继承了这个 fd，父进程这份必须关掉，不然日志句柄一直挂着
    try { if (fd !== null) closeSync(fd) } catch { /* ignore */ }
    child.once('spawn', () => {
      try { child.unref() } catch { /* ignore */ }
      finish({ ok: true, pid: child.pid || null, reason: null })
    })
    child.once('error', (e) => finish({
      ok: false, pid: child.pid || null,
      reason: String((e && e.message) || e),
      spawnError: !!(e && (e.code === 'ENOENT' || e.code === 'EPERM')),
    }))
    // 3 秒还没 error：就当它跑起来了（detached 进程不会有更明确的信号）
    timer = setTimeout(() => {
      try { child.unref() } catch { /* ignore */ }
      finish({ ok: true, pid: child.pid || null, reason: null })
    }, SETUP_WAIT_MS)
    timer.unref?.()
    return undefined
  })
}

/** 把脚本的 JSON 信封规整成设置页直接能画的一张表（scan 与 install 两种形状都吃）。
 *  脚本侧契约（scripts/douyin_setup.py）：
 *    scan   → { ok, mode:'scan', pythons:[{path,version,source,hasPlaywright,hasSherpa,usable}],
 *               ffmpeg:{path,ok,source}, model:{path,ok,source}, cookie:{path,exists,count},
 *               verdict:{canReusePython,reusePath,reuseReason,missing}, elapsed }
 *    install→ { ok, mode, action:'reused'|'installed'|'failed', python:'<路径>', version,
 *               playwright:bool, sherpa:bool, ffmpeg{…}, model{…}, missing, reusedPython, configWritten, elapsed } */
function normalizeScan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  /** 路径字段：字符串 / {path} 对象 / '（未找到）' 占位都能吃，占位一律当 null */
  const asPath = (v) => {
    const s = v && typeof v === 'object' ? (v.path || v.dir || '') : v
    const t = typeof s === 'string' ? s.trim() : ''
    return t && !/未找到/.test(t) ? t : null
  }
  const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : null)
  const verdict = r.verdict && typeof r.verdict === 'object' ? r.verdict : {}
  const pythons = Array.isArray(r.pythons) ? r.pythons.filter((p) => p && typeof p === 'object') : []
  const reusePath = asPath(verdict.reusePath) || asPath(r.reusedPython) || asPath(r.python)
  const listed = (reusePath && pythons.find((p) => asPath(p.path) === reusePath))
    || pythons.find((p) => p.usable === true) || pythons[0] || null
  const pyPath = reusePath || asPath(r.pythonPath) || asPath(listed && listed.path)
  const pyFlags = { playwright: bool('playwright'), sherpa: bool('sherpa') }
  const hasPy = !!(pyPath || listed || pyFlags.playwright !== null || pyFlags.sherpa !== null)
  const py = hasPy ? {
    path: pyPath || '',
    version: String((listed && listed.version) || r.version || '').trim(),
    playwright: pyFlags.playwright !== null ? pyFlags.playwright
      : (listed && typeof listed.hasPlaywright === 'boolean' ? listed.hasPlaywright : null),
    sherpa: pyFlags.sherpa !== null ? pyFlags.sherpa
      : (listed && typeof listed.hasSherpa === 'boolean' ? listed.hasSherpa : null),
    source: String((listed && listed.source) || r.basePythonSource || r.pythonSource || '').trim(),
  } : null
  const ck = r.cookie && typeof r.cookie === 'object' ? r.cookie : null
  const action = ['reused', 'installed', 'failed', 'started'].includes(String(r.action || '')) ? String(r.action) : null
  const canReuse = verdict.canReusePython === true || r.canReusePython === true
    || !!(py && py.playwright === true && py.sherpa === true)
  return {
    ok: r.ok !== false,
    mode: typeof r.mode === 'string' ? r.mode : null,
    action,
    python: py,
    pythons: pythons.map((p) => ({
      path: asPath(p.path) || '',
      version: String(p.version || '').trim(),
      usable: p.usable === true,
      playwright: p.hasPlaywright === true,
      sherpa: p.hasSherpa === true,
      source: String(p.source || '').trim(),
    })),
    canReusePython: canReuse,
    reusePythonPath: reusePath || null,
    reuseReason: String(verdict.reuseReason || '').trim(),
    missingPackages: [
      ...(py && py.playwright === false ? ['playwright'] : []),
      ...(py && py.sherpa === false ? ['sherpa-onnx'] : []),
    ],
    ffmpeg: asPath(r.ffmpeg),
    model: asPath(r.model || r.modelDir),
    cookie: {
      path: asPath(ck && ck.path),
      exists: !!(ck && ck.exists),
      count: Number(ck && ck.count) || 0,
    },
    venv: asPath(r.venv) || null,
    missing: Array.isArray(r.missing) ? r.missing.map(String) : [],
    log: asPath(r.log) || null,
    error: r.error ? String(r.error) : (Array.isArray(r.errors) && r.errors.length ? String(r.errors[0]) : null),
    elapsed: Number(r.elapsed) || 0,
  }
}

/** 最近一次 scan 的缓存（没有 / 坏了就是 null） */
function readScanCache() {
  try {
    const j = JSON.parse(readFileSync(setupScanPath(), 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? normalizeScan(j) : null
  } catch { return null }
}

/**
 * 前台同步跑一次安装脚本（scan / auto 这种「要拿结论」的）：按候选 python 逐个试、解析 --json 信封。
 * 解析不出 JSON 且解释器本身起不来（code 为 null）才换下一个；脚本跑了但输出不对就别再试。
 */
async function runSetupForeground(argv, log, timeoutSec) {
  const script = setupScript()
  if (!script || !existsSync(script)) {
    return { ok: false, reason: '安装脚本不存在: ' + (script || '(没找到)'), script: script || null, candidates: SETUP_SCRIPTS }
  }
  const seam = setupDeps.run
  if (typeof seam === 'function') {
    const norm = normalizeScan(await seam(script, argv, setupPythonCandidates(cfgAll().pythonPath)))
    try { writeFileSync(setupScanPath(), JSON.stringify(norm, null, 2), 'utf8') } catch { /* 缓存写不了不影响返回 */ }
    return { ...norm, script }
  }
  const tried = []
  for (const py of setupPythonCandidates(cfgAll().pythonPath)) {
    const r = await runPython(py, script, argv, { timeoutSec, log })
    const out = String(r.stdout || '')
    const at = out.indexOf('{')
    let parsed = null
    if (at >= 0) { try { parsed = JSON.parse(out.slice(at)) } catch { parsed = null } }
    if (parsed) {
      const norm = normalizeScan(parsed)
      try { writeFileSync(setupScanPath(), JSON.stringify(norm, null, 2), 'utf8') } catch { /* 缓存写不了不影响返回 */ }
      return { ...norm, script, pythonUsed: py }
    }
    tried.push({ python: py, exitCode: r.code, reason: tail(String(r.stderr || ''), 3) })
    if (r.code !== null) break
  }
  return {
    ok: false,
    script,
    reason: '安装脚本没跑起来（' + ((tried[tried.length - 1] && tried[tried.length - 1].reason) || '没有可用的 Python') + '）',
    hint: '先装 Python（或把 pythonPath 配到一个 python.exe）再试',
    tried,
  }
}

/** 扫描结果 + 轻量兜底：能不能直接复用一个现成的 python（不跑 import 探测，status 不该为此变慢） */
function reuseSnapshot(scan, venvUsable, result) {
  const out = { canReusePython: false, reusePythonPath: null, reuseSource: null, reuseVerified: false }
  if (scan && scan.canReusePython && scan.reusePythonPath) {
    out.canReusePython = true; out.reusePythonPath = scan.reusePythonPath; out.reuseSource = 'scan'; out.reuseVerified = true
  }
  // 脚本刚给的结论（setup-result.json）：装/复用成功就等于「现在有能用的 python」
  if (!out.canReusePython && result && result.action && result.action !== 'failed' && result.pythonPath
    && result.hasPlaywright !== false && result.hasSherpa !== false) {
    out.canReusePython = true; out.reusePythonPath = result.pythonPath; out.reuseSource = 'result'; out.reuseVerified = true
  }
  if (venvUsable) {
    // 插件自己的 venv 就绪 = 最直接的「复用」（按钮点下去就是把 venv python 写进 pythonPath）
    out.canReusePython = true; out.reusePythonPath = venvPython(); out.reuseSource = 'venv'; out.reuseVerified = true
  }
  if (out.canReusePython) return out
  const fromLog = reuseFromLog()
  if (fromLog) { out.reusePythonPath = fromLog; out.reuseSource = 'log'; out.reuseVerified = true; return out }
  // 只确认「存在」的候选：来源标签给设置页看，但不算 canReusePython（没验过模块，别把安装按钮锁死）
  const cands = setupPythonCandidates(cfgAll().pythonPath)
  const found = cands.find((p) => p.includes('/') || p.includes('\\'))
  out.reusePythonPath = found || (cands[0] || null)
  out.reuseSource = found ? 'path' : 'command'
  return out
}

/** douyin_status.env：设置页「环境与诊断」页照这个画 */
async function envSnapshot() {
  const py = venvPython()
  const pyExists = existsSync(py)
  const mods = await venvModules()
  const venvUsable = !!(pyExists && mods.playwright && mods.sherpa)
  const scan = readScanCache()
  const result = readSetupResult()
  const reuse = reuseSnapshot(scan, venvUsable, result)
  const busy = setupRunning()
  return {
    venv: existsSync(venvRoot()),
    venvPython: pyExists ? py : null,
    venvUsable,
    basePython: readBasePython(),
    playwright: !!mods.playwright,
    sherpa: !!mods.sherpa,
    canReusePython: reuse.canReusePython,
    reusePythonPath: reuse.reusePythonPath,
    reuseSource: reuse.reuseSource,
    reuseVerified: reuse.reuseVerified,
    scan,
    setupScript: setupScript(),
    setupLog: setupLogPath(),
    setupLogTail: setupLogTail(20),
    // 后台安装的进度与结论：前端靠这两个字段轮询（setupRunning 变 false 就读 setupResult）
    setupRunning: busy.running,
    setupWhy: busy.why,
    setupResult: result,
  }
}

export function apply(ctx, config = {}) {
  ensureDirs()
  const log = (m) => { try { ctx.logger?.info?.('[douyin-audio] ' + m) } catch {} ; try { logLine(m) } catch {} }
  const merged = () => {
    const base = cfgAll()
    const over = {}
    for (const k of ['count', 'delay', 'headless', 'saveAll', 'downloadTimeout', 'pythonPath', 'asrThreads', 'autoTranscribe', 'loginMode', 'readHeadless', 'verifyWait',
      'autoRun', 'dutyWindow', 'dailyLimit', 'dutyIntervalMin', 'uiLayout', 'browserChannel', 'browserExtras']) {
      let v = config ? config[k] : undefined
      if (v && typeof v === 'object' && 'value' in v) v = v.value
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') over[k] = v
    }
    return { ...base, ...over }
  }
  // ── 浏览器参数下发（--browser-channel / --browser-executable）────────────
  // 旧版脚本可能一个都不认（argparse 会 unrecognized arguments 直接退出码 2），
  // 所以先问一次 --help，两个参数分别判断、互不牵连。
  // 每个 (python, 脚本) 每进程只问一次。
  const browserFlagCache = new Map()
  async function browserFlags(python, script) {
    const key = python + '|' + script
    let acc = browserFlagCache.get(key)
    if (acc === undefined) {
      const r = await runPython(python, script, ['--help'], { timeoutSec: 30, log })
      const text = String(r.stdout || '') + String(r.stderr || '')
      // --help 自己都跑不起来（依赖缺 / 脚本坏）就当它认：真跑时的报错比这里更说明问题
      acc = r.ok === true
        ? { channel: text.includes('--browser-channel'), exe: text.includes('--browser-executable') }
        : { channel: true, exe: true }
      browserFlagCache.set(key, acc)
      if (!acc.channel && !acc.exe) log('脚本不认浏览器参数（旧版），本次不带: ' + script)
      else if (!acc.exe) log('脚本不认 --browser-executable（旧版），自定义浏览器这条会落空: ' + script)
    }
    return acc
  }
  /** 按脚本真正认得的参数拼 argv 片段（自定义项走 --browser-executable，与内核参数互不牵连） */
  async function browserArgvFor(python, script, cfg) {
    const acc = await browserFlags(python, script)
    const argv = browserArgv(cfg)
    if (!argv.length) return []
    if (argv[0] === '--browser-channel') return acc.channel ? argv : []
    if (argv[0] === '--browser-executable') return acc.exe ? argv : []
    return []
  }

  // ── 能力等级（四档闸门）──────────────────────────────────
  // ① 只读 / ② 通知 / ③A 轻互动 / ③B 评论 / ④ 发布。基础四工具（刷屏/转写/自检/配置）不受等级限制。
  // 默认值与 lib/state.mjs 的 DEFAULTS 一致；这里再留一份兜底，config.json 里缺键也能判断。
  const TIER_DEFAULTS = { tierRead: true, tierNotify: false, tierReact: false, tierComment: false, tierPublish: false }
  const TIER_LABEL = { read: '只读', notify: '通知', react: '轻互动', comment: '评论', publish: '发布' }
  const TIER_KEY = { read: 'tierRead', notify: 'tierNotify', react: 'tierReact', comment: 'tierComment', publish: 'tierPublish' }

  /** 四个等级键的当前值（缺失键按默认值）；③ 或 ④ 打开时 ① 视为生效，但不改用户存的值 */
  function getTiers() {
    const cfg = loadCfg() || {}
    const out = {}
    for (const [key, dflt] of Object.entries(TIER_DEFAULTS)) {
      const v = cfg[key]
      out[key] = v === undefined || v === null || v === '' ? dflt : (typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true')
    }
    if (out.tierReact || out.tierComment || out.tierPublish) out.tierRead = true
    return out
  }

  /** 闸门：等级未开返回拒绝结构，开了返回 null。name 只进日志，不进返回值 */
  function requireTier(name, tier) {
    const key = TIER_KEY[tier]
    if (!key) return null
    if (getTiers()[key]) return null
    log('能力等级拒绝: ' + name + ' 需要 ' + key)
    return {
      ok: false,
      code: 'TIER_DISABLED',
      tier,
      reason: '该能力属于「' + TIER_LABEL[tier] + '」，当前未开启',
      hint: '在设置页「能力等级」打开 ' + key + '（这一档只能由用户自己开：douyin_config 会拒绝改 tier*）',
    }
  }

  // 宿主只接受无损 JSON：undefined / NaN / 函数 / 循环引用都会让工具调用直接失败
  const byName = new Map()
  const tool = (spec) => {
    const wrapped = defineTool({
      ...spec,
      output: spec.output || textOutput,
      async execute(args) { return safe(await spec.execute(args)) },
    })
    byName.set(spec.name, wrapped)
    return ctx.tools.register(wrapped)
  }

  /**
   * 刷一轮的核心（douyin_scroll 与谷时自动刷共用）。
   * 参数优先级：工具入参 > 配置 > 硬默认值；返回体与 douyin_scroll 一直以来的形状完全一致。
   */
  async function runScroll(args, cfg) {
    const python = await findPython(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
    if (!python) return { ok: false, reason: '找不到带 playwright 的 Python。可在配置里设置 pythonPath。' }
    const count = Math.max(1, Math.min(Number(args.count) || cfg.count || 3, 200))
    const delay = Math.max(0.5, Math.min(Number(args.delay) || cfg.delay || 1.5, 30))
    const headless = args.headless !== undefined ? !!args.headless : !!cfg.headless
    const saveAll = args.saveAll !== undefined ? !!args.saveAll : !!cfg.saveAll
    const downloadTimeout = Number(cfg.downloadTimeout) || 300
    const argv = ['--tab', 'recommend', '--count', String(count), '--delay', String(delay),
      '--download-timeout', String(downloadTimeout)]
    if (headless) argv.push('--headless')
    if (saveAll) argv.push('--save-all')
    argv.push('--work-dir', workRoot())
    argv.push(...(await browserArgvFor(python, SCRIPT_SCROLL, cfg)))
    // 父进程预算：每屏 = 停留 + 启动/滚动杂项 12s + **一次下载超时**（取 max(默认 300, downloadTimeout)）。
    // 原来漏了下载那一项：逐屏下载慢的时候脚本还在跑，父进程先把超时打到底，返回体就成了假失败。
    const budget = count * (delay + 12 + Math.max(300, downloadTimeout)) + 120
    const r = await runPython(python, SCRIPT_SCROLL, argv, { timeoutSec: budget, log })
    log('scroll 结束 code=' + r.code)
    // 返回体由 scrollResult 统一拼：清单 + autoTranscribe（关着是 null）
    return scrollResult({ ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, count, cfg, log })
  }

  // ── 1. 刷抖音 ─────────────────────────────────────────────
  tool({
    name: 'douyin_scroll',
    description: '刷抖音推荐页：自动下滑 N 屏、逐屏截图、并把每屏视频下载到本地（自动确保含音轨，无音轨会标记 NO_AUDIO）。刷完返回统计。',
    parameters: {
      count: { type: 'number', description: '下滑屏数，默认取插件配置（3）' },
      delay: { type: 'number', description: '每屏停留秒数，默认 1.5' },
      headless: { type: 'boolean', description: '是否后台运行（不弹窗），默认 true' },
      saveAll: { type: 'boolean', description: '是否逐屏下载视频，默认 true' },
    },
    async execute(args) {
      const cfg = merged()
      return runScroll(args, cfg)
    },
  })

  // ── 2. 转写 ───────────────────────────────────────────────
  tool({
    name: 'douyin_transcribe',
    description: '把已下载的抖音视频/音频转成文字（本地 SenseVoice，不联网）。优先按 screens（manifest 屏号，如 [3,7]）选文件；也可给 files（明确路径）；都不给就自动扫 videos/ 下最近的文件（按修改时间倒序，返回里标注 order:"mtime-desc"）。',
    parameters: {
      files: { type: 'array', description: '要转写的文件路径数组；留空则自动取 videos/ 目录下的 .mp4' },
      screens: { type: 'array', description: '按 manifest 的屏号转写（如 [3,7]），取 videos/video_<屏号三位>.mp4；优先级高于 files' },
      modelDir: { type: 'string', description: '可选：SenseVoice 模型目录，留空用脚本默认值' },
      limit: { type: 'number', description: '自动模式（不给 screens / files）时最多处理几个文件，默认 3' },
    },
    async execute(args) {
      const cfg = merged()
      const limit = Math.max(1, Math.min(Number(args.limit) || 3, 20))
      const chosen = chooseTranscribeFiles(args, limit)
      const meta = {
        order: chosen.order,
        screens: chosen.wantScreens.length ? chosen.wantScreens : undefined,
        missingScreens: chosen.missingScreens.length ? chosen.missingScreens : undefined,
      }
      if (!chosen.files.length) {
        return {
          ...meta,
          ok: false,
          manifestPath: workManifest(),
          reason: chosen.wantScreens.length
            ? '这些屏号在 videos/ 里没有对应文件（先跑 douyin_scroll 并开启 saveAll 下载）'
            : '没有可转写的文件（先跑 douyin_scroll 并开启下载）',
        }
      }
      // 空结果（纯 BGM）也靠 title 兜底，让「这条到底是什么」说得清
      const res = await runTranscribe(chosen.files, { cfg, modelDir: args.modelDir, log })
      return { ...meta, ...decorateTranscribe(res, chosen.files) }
    },
  })

  // ── 3. 自检 ───────────────────────────────────────────────
  tool({
    name: 'douyin_status',
    description: '自检抖音插件运行条件：Python(playwright) / Python(sherpa_onnx) / ffmpeg / 模型目录 / cookie 文件 / 脚本是否存在，并报告状态目录占用、五个浏览器内核 + 手动添加项 + 快捷方式发现的浏览器（browsers）是否装好。env 字段是「装入配置环境」的状态（venv / venvUsable / basePython / canReusePython / setupRunning / setupResult / setupLog 尾部）。scan=true 会重扫开始菜单 / 桌面里的 .lnk，否则用本次运行已扫到的缓存。',
    parameters: { scan: { type: 'boolean', description: 'true = 重扫一次快捷方式（开始菜单 / 桌面里的 .lnk），否则用本次运行已扫到的缓存' } },
    async execute(args) {
      const cfg = merged()
      const pyScroll = await findPython(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
      const pyAsr = await findPython(log, 'sherpa_onnx', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
      const ff = [join(process.env.USERPROFILE || '', '.dsh', 'bin', 'ffmpeg.exe')].find((p) => existsSync(p)) || null
      const modelDir = process.env.DOUYIN_MODEL_DIR || join(process.env.USERPROFILE || '', '.dsh', 'models', 'sherpa-sense-voice', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')
      const cookie = join(process.env.USERPROFILE || '', '.dsh', 'cookies', 'douyin_cookies.txt')
      const sdir = stateDir()
      const vdir = workVideos()
      const videos = existsSync(vdir) ? readdirSync(vdir).filter((f) => /\.mp4$/i.test(f)) : []
      const browsers = probeBrowsers(cfg)
      // 快捷方式扫出来的浏览器：按路径去重，且剔掉「已知安装路径已经命中」的那些（同一条只出现一次）
      try {
        browsers.shortcuts = mergeShortcutList(await scanShortcuts(!!(args && args.scan)), browsers.paths)
      } catch { browsers.shortcuts = [] }
      return {
        ok: !!(pyScroll && pyAsr && ff && existsSync(modelDir)),
        version: pluginVersion(),
        pythonScroll: pyScroll || '(未找到，需带 playwright)',
        pythonAsr: pyAsr || '(未找到，需带 sherpa_onnx)',
        ffmpeg: ff || '(未找到)',
        modelDir: { path: modelDir, exists: existsSync(modelDir) },
        cookie: { path: cookie, exists: existsSync(cookie) },
        account: readAccount(),
    scripts: { scroll: existsSync(SCRIPT_SCROLL), transcribe: existsSync(SCRIPT_TRANSCRIBE), read: existsSync(SCRIPT_READ) },
        // 五个内核 + 手动添加项 + 快捷方式发现的浏览器（设置页按它列可选内核）
        browsers,
        // 当前 browserChannel 的解析说明：自定义项路径不在 / id 不存在时在这里说清（正常情况是空串）
        browserNote: resolveBrowser(cfg).note || '',
        // 装入配置环境的状态（设置页「环境与诊断」页 + 顶栏「环境」徽章都看它）
        env: await envSnapshot(),
        stateDir: sdir,
        workDir: workRoot(),
        videos,
        cfg,
      }
    },
  })

  /**
   * 后台派生一次安装（\`douyin_setup\` 的 minimal/full/*-force 与 HTTP 的 setup_auto 共用）：
   * detached + stdio 全量重定向到 setup.log，确认进程起来就返回，**不等它装完**。
   * 结果由脚本写 \`<状态目录>/setup-result.json\`，再由 douyin_status.env.setupResult 读回去。
   */
  async function startSetupBg(mode) {
    const venv = venvRoot()
    const setupLog = setupLogPath()
    const script = setupScript()
    if (!script || !existsSync(script)) {
      return { ok: false, mode, action: 'failed', reason: '安装脚本不存在: ' + (script || '(没找到)'), script: script || null, venv, log: setupLog, candidates: SETUP_SCRIPTS }
    }
    const busy = setupRunning()
    if (busy.running) {
      return { ok: false, mode, action: 'failed', reason: '已经有一个安装进程在跑', why: busy.why, venv, log: setupLog, hint: '看 setup.log 末尾，或者等它结束再点一次' }
    }
    const base = mode === 'auto' ? 'auto' : (mode === 'full' || mode === 'full-force' ? 'full' : 'minimal')
    const argv = ['--mode', base, ...(mode.endsWith('-force') ? ['--force-venv'] : []), '--json', '--log', setupLog]
    const spawnBg = setupDeps.spawn || spawnSetupBg
    const tried = []
    let last = null
    for (const py of setupPythonCandidates(cfgAll().pythonPath)) {
      const r = await spawnBg(py, script, argv)
      tried.push({ python: py, ok: !!r.ok, pid: r.pid || null, reason: r.reason || null })
      if (r.ok) {
        venvProbeCache = null   // 环境要变了：探测缓存作废
        log('setup ' + mode + ' 已在后台启动 pid=' + r.pid + ' python=' + py)
        return {
          ok: true, started: true, mode, action: 'started', python: py, pid: r.pid || null, venv, log: setupLog,
          hint: '装完调用 douyin_status 看结果（env.setupRunning 变 false 后看 env.setupResult）',
        }
      }
      last = r
      if (!r.spawnError) break   // 不是「解释器找不到」就别一个个试下去
    }
    return {
      ok: false, mode, action: 'failed',
      reason: '安装没起来：' + ((last && last.reason) || '没有可用的 Python'),
      hint: '先装 Python（或把 pythonPath 配到一个 python.exe）再试',
      tried, venv, log: setupLog,
    }
  }

  // ── 3-bis. 装入配置环境（基础能力，**不设等级闸门**）───────────────
  /**
   * 六个 mode：
   *   auto           扫描 → 有可用 Python 就复用并把路径写进 pythonPath → 没有就建 venv 装依赖 → 写配置
   *                  ⚠️ 工具调用是**前台同步**（等完拿 action）；设置页那条 HTTP 路（setup_auto）走
   *                     startSetupBg —— 后台派生、立刻回 started，结果由脚本写 setup-result.json 再由
   *                     env.setupRunning / env.setupResult 读回去（长请求会被宿主 HTTP 掐断，所以界面不能等）
   *   scan           只体检、不改动（前台同步，回 inventory）
   *   minimal/full   后台派生去装（detached，起来就返回；full 另含 ffmpeg 与模型下载）
   *   *-force        同上再加 --force-venv（强制新建 venv，不复用已有 Python）
   * 装完由脚本自己把 <插件根>/venv/Scripts/python.exe 写进配置的 pythonPath —— host 不新增配置键。
   */
  tool({
    name: 'douyin_setup',
    description: '给插件配运行环境（基础能力，不设等级闸门）。mode=auto（默认）：先扫描，有可用 Python 就复用它并把路径写进 pythonPath，没有就在 <插件根>/venv 建独立 venv 装 playwright + sherpa-onnx，返回 action=reused|installed|failed；mode=scan：只体检不改动，返回 inventory（Python 路径/版本/playwright/sherpa、ffmpeg、模型、cookie 条数）；mode=minimal / full / minimal-force / full-force：后台派生去装（full 另含 ffmpeg 下到 <状态目录>/bin、SenseVoice 模型下到 <状态目录>/models），起来就返回 started:true，进度写 <状态目录>/setup.log（几分钟）。装完调用 douyin_status 看 env。',
    parameters: {
      mode: { type: 'string', description: 'auto（默认：扫描→复用或安装）/ scan（只体检）/ minimal（venv + playwright + sherpa）/ full（另含 ffmpeg 与模型）/ minimal-force 或 full-force（强制新建 venv，不复用）' },
    },
    async execute(args) {
      const given = args.mode === undefined || args.mode === null || args.mode === '' ? '' : String(args.mode).trim().toLowerCase()
      const mode = given || 'auto'
      const venv = venvRoot()
      const setupLog = setupLogPath()
      if (!SETUP_MODES.includes(mode)) {
        return { ok: false, mode, reason: 'mode 只能是 ' + SETUP_MODES.join(' / ') + '，收到 ' + JSON.stringify(given), modes: SETUP_MODES }
      }
      const script = setupScript()
      const missingScript = { ok: false, action: 'failed', mode, reason: '安装脚本不存在: ' + (script || '(没找到)'), script: script || null, venv, log: setupLog, candidates: SETUP_SCRIPTS }
      if (!script || !existsSync(script)) return missingScript

      // scan / auto：前台同步，要拿结论（auto 还要回 action）
      if (mode === 'scan' || mode === 'auto') {
        log('setup ' + mode + ' 开始')
        const argv = mode === 'scan'
          ? ['--scan', '--json', '--log', setupLog]
          : ['--mode', 'auto', '--json', '--log', setupLog]
        const r = await runSetupForeground(argv, log, mode === 'scan' ? SETUP_SCAN_TIMEOUT_S : SETUP_AUTO_TIMEOUT_S)
        const out = { ...r, mode, venv, log: setupLog }
        if (mode === 'auto') {
          // 脚本没给 action 就按结果推：装不成就 failed，能复用就 reused
          if (!out.action) out.action = r.ok === false ? 'failed' : (r.canReusePython ? 'reused' : 'installed')
          out.ok = out.action !== 'failed'
          if (out.action === 'installed') venvProbeCache = null   // 刚装完：缓存里的 false 不能再信
        }
        log('setup ' + mode + ' 结束 ok=' + out.ok + (out.action ? ' action=' + out.action : '') + (out.reason ? ' reason=' + out.reason : ''))
        return out
      }

      // 其余四个：后台派生，起来就返回，不等它装完
      return startSetupBg(mode)
    },
  })

  // ── 只读查询：hot / search / video / comments / note ─────────────
  // 契约（scripts/douyin_read.py）：一律 --json，stdout 只有一个 JSON 对象，进度走 stderr。
  // 这几个工具只读：不点赞、不关注、不收藏、不评论、不发布。
  const READ_ORDERS = ['totalrank', 'click', 'pubdate']
  const READ_TIMEOUT = { hot: 120, search: 150, video: 150, comments: 180, notes: 150, messages: 180 }
  /** 只读工具的公共补充说明：撞验证码时怎么自救（配置写在 lib/state.mjs + EXTRA_DEFAULTS 那一层） */
  const HINT = '可用配置 readHeadless/verifyWait 切到可见窗口并在人工过验证后继续。'

  /** limit：不给就取默认；给了就必须是 1-50 的整数（越界直接报错，不夹取） */
  const checkLimit = (v, dflt) => {
    if (v === undefined || v === null || v === '') return { value: dflt }
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1 || n > 50) return { error: 'limit 需是 1-50 的整数，收到 ' + JSON.stringify(v) }
    return { value: n }
  }

  /** url：必须 http(s) */
  const checkUrl = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim()
    if (!s) return { error: 'url 必填，形如 https://www.douyin.com/video/<id>' }
    if (!/^https?:\/\//i.test(s)) return { error: 'url 必须是 http(s) 链接，收到 ' + s }
    return { value: s }
  }

  /** 跑一次只读子命令：从 stdout 第一个 { 开始解析，脚本的 ok:false 原样带回 */
  async function runRead(sub, extra, timeoutSec) {
    if (!existsSync(SCRIPT_READ)) return { ok: false, reason: '只读脚本不存在: ' + SCRIPT_READ }
    const cfg = merged()
    const python = await findPython(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
    if (!python) return { ok: false, reason: '找不到带 playwright 的 Python。可在配置里设置 pythonPath。' }
    // 可见窗口 / 人工过验证：两把键都取默认值时一个参数都不多传，argv 与历史完全一致
    const argv = [sub, ...extra, '--json']
    if (cfg.readHeadless === false) argv.push('--no-headless')
    const wait = Math.max(0, Math.round(Number(cfg.verifyWait) || 0))
    if (wait > 0) argv.push('--verify-wait', String(wait))
    argv.push(...(await browserArgvFor(python, SCRIPT_READ, cfg)))
    // 人工过验证的时间要落在预算里，否则窗口刚弹出来就被 taskkill
    const budget = timeoutSec + (wait > 0 ? wait + 15 : 0)
    const r = await runPython(python, SCRIPT_READ, argv, { timeoutSec: budget, log })
    const out = String(r.stdout || '')
    log(sub + ' 结束 code=' + r.code)
    let parsed = null
    const start = out.indexOf('{')
    if (start >= 0) { try { parsed = JSON.parse(out.slice(start)) } catch {} }
    if (!parsed) {
      return { ok: false, exitCode: r.code, reason: '脚本输出不是 JSON（子命令 ' + sub + ' 那一步）', output: tail(out, 12) || tail(r.stderr, 8) }
    }
    if (parsed.ok === false) return { ...parsed, exitCode: r.code }
    if (!r.ok) return { ok: false, exitCode: r.code, reason: '脚本退出码非 0，输出可能不完整', items: parsed.items || [], output: tail(r.stderr, 8) }
    return { ...parsed, ok: true, exitCode: r.code }
  }

  // ── 4a. 热榜（只读）───────────────────────────────────────
  tool({
    name: 'douyin_hot',
    description: '抖音热榜（只读）：取当前热门条目，返回 rank/title/hot/url。不点赞、不关注、不评论。' + HINT,
    parameters: {
      limit: { type: 'number', description: '取几条，1-50，默认 20' },
    },
    async execute(args) {
      const deny = requireTier('douyin_hot', 'read')
      if (deny) return deny
      const lim = checkLimit(args.limit, 20)
      if (lim.error) return { ok: false, reason: lim.error }
      return runRead('hot', ['--limit', String(lim.value)], READ_TIMEOUT.hot)
    },
  })

  // ── 4b. 搜索（只读）───────────────────────────────────────
  tool({
    name: 'douyin_search',
    description: '抖音搜索视频（只读）：返回 title/author/like/url/duration。可指定排序（综合/播放/最新）与条数。' + HINT,
    parameters: {
      keyword: { type: 'string', description: '搜索关键词（必填）' },
      limit: { type: 'number', description: '取几条，1-50，默认 20' },
      order: { type: 'string', description: '排序：totalrank（综合，默认）/ click（播放）/ pubdate（最新）' },
    },
    async execute(args) {
      const deny = requireTier('douyin_search', 'read')
      if (deny) return deny
      const keyword = String(args.keyword === undefined || args.keyword === null ? '' : args.keyword).trim()
      if (!keyword) return { ok: false, reason: 'keyword 必填' }
      const order = args.order === undefined || args.order === null || args.order === ''
        ? 'totalrank'
        : String(args.order).trim()
      if (!READ_ORDERS.includes(order)) {
        return { ok: false, reason: 'order 只能是 ' + READ_ORDERS.join(' / ') + '，收到 ' + order, orders: READ_ORDERS }
      }
      const lim = checkLimit(args.limit, 20)
      if (lim.error) return { ok: false, reason: lim.error }
      return runRead('search', ['--keyword', keyword, '--limit', String(lim.value), '--order', order], READ_TIMEOUT.search)
    },
  })

  // ── 4c. 视频详情（只读）───────────────────────────────────
  tool({
    name: 'douyin_video',
    description: '抖音视频详情（只读）：返回 title/author/desc/like/comment/share/url/tags[]，以及 music（{name,author} 或 null）与 musicNote。' + HINT,
    parameters: {
      url: { type: 'string', description: '视频页链接，如 https://www.douyin.com/video/<id>' },
    },
    async execute(args) {
      const deny = requireTier('douyin_video', 'read')
      if (deny) return deny
      const u = checkUrl(args.url)
      if (u.error) return { ok: false, reason: u.error }
      const r = await runRead('video', ['--url', u.value], READ_TIMEOUT.video)
      const item = Array.isArray(r.items) && r.items.length ? r.items[0] : null
      if (!item) return r
      // music 由脚本原样给出（{name,author} 或 null）；拿不到就明说，不编
      const music = item.music === undefined ? null : item.music
      const out = { ...r, music }
      if (music === null) out.musicNote = '页面未提供音乐信息（未登录时抖音不渲染音乐名）'
      return out
    },
  })

  // ── 4d. 评论（只读）───────────────────────────────────────
  tool({
    name: 'douyin_comments',
    description: '抖音视频评论（只读）：返回 user/text/like/time。只读页面，不发表任何评论。' + HINT,
    parameters: {
      url: { type: 'string', description: '视频页链接，如 https://www.douyin.com/video/<id>' },
      limit: { type: 'number', description: '取几条评论，1-50，默认 30' },
    },
    async execute(args) {
      const deny = requireTier('douyin_comments', 'read')
      if (deny) return deny
      const u = checkUrl(args.url)
      if (u.error) return { ok: false, reason: u.error }
      const lim = checkLimit(args.limit, 30)
      if (lim.error) return { ok: false, reason: lim.error }
      return runRead('comments', ['--url', u.value, '--limit', String(lim.value)], READ_TIMEOUT.comments)
    },
  })

  // ── 4d-2. 图文详情（只读）─────────────────────────────────
  // 短链 https://v.douyin.com/xxx/ 常跳到 /note/<id>（图文，不是视频）：video 那支读不出正文，
  // 所以单开一个子命令 note（页面标记是 [data-e2e="note-detail"]）。同 ① 只读闸门。
  tool({
    name: 'douyin_note',
    description: '抖音图文详情（只读）：短链/图文页（/note/<id>）返回 title/author/desc/publishTime/like/comment/share/collect/images[]。不点赞、不收藏、不评论。' + HINT,
    parameters: {
      url: { type: 'string', description: '图文页或短链，如 https://www.douyin.com/note/<id> 或 https://v.douyin.com/xxxx/' },
    },
    async execute(args) {
      const deny = requireTier('douyin_note', 'read')
      if (deny) return deny
      const u = checkUrl(args.url)
      if (u.error) return { ok: false, reason: u.error }
      return runRead('note', ['--url', u.value], READ_TIMEOUT.video)
    },
  })

  // ── 4e. 通知摘要（② 通知，只读）─────────────────────────────
  // 与只读那几件同一套信封；区别只在闸门档位（notify）与页面（登录后才有的通知页）。
  tool({
    name: 'douyin_notes',
    description: '抖音通知摘要（只读，能力等级② 通知）：取点赞/评论/@我的/关注的摘要，返回 type/user/text/time/url。只读页面，不点已读、不回复、不点赞、不回关。',
    parameters: {
      limit: { type: 'number', description: '取几条，1-50，默认 20' },
    },
    async execute(args) {
      const deny = requireTier('douyin_notes', 'notify')
      if (deny) return deny
      const lim = checkLimit(args.limit, 20)
      if (lim.error) return { ok: false, reason: lim.error }
      return runRead('notes', ['--limit', String(lim.value)], READ_TIMEOUT.notes)
    },
  })

  // ── 4f. 私信会话列表（② 通知，只读）────────────────────────
  tool({
    name: 'douyin_messages',
    description: '抖音私信会话列表摘要（只读，能力等级② 通知）：返回 user/lastText/time/unread。只看会话列表，不打开对话、不发消息、不标记已读。',
    parameters: {
      limit: { type: 'number', description: '取几条会话，1-50，默认 20' },
    },
    async execute(args) {
      const deny = requireTier('douyin_messages', 'notify')
      if (deny) return deny
      const lim = checkLimit(args.limit, 20)
      if (lim.error) return { ok: false, reason: lim.error }
      return runRead('messages', ['--limit', String(lim.value)], READ_TIMEOUT.messages)
    },
  })

  // ── 4f-bis. 轻互动：点赞 / 取消赞 / 收藏 / 取消收藏（③A 轻互动级闸门）────────
  /**
   * 契约（scripts/douyin_action.py，与脚本 argparse 对齐）：动作走 --action，其余沿用 douyin_read.py 那一套：
   *   python douyin_action.py --url U --action <like|unlike|collect|uncollect> --json
   *     [--no-headless] [--verify-wait N] [--browser-channel C | --browser-executable P]
   * stdout 只有一个 JSON 对象 { ok, action, before, after, changed, state, needLogin }，原样透出。
   * 状态判定在脚本里：点之前读一次 [data-e2e="video-player-digg"] 的 innerText 数字，点完等
   * 1.5–2.5s（必要时轮询到 6s）再读一次比大小 —— 不靠 class、不靠 aria-label（真机实测都没有）。
   */
  const REACT_ACTIONS = ['like', 'unlike', 'collect', 'uncollect']
  const REACT_TIMEOUT = 150
  const REACT_HINT = '③A 是写操作：会以你的账号点赞/收藏。抖音对高频互动有风控，建议一天几次、别批量刷。'

  /** 跑一次动作子命令：argv 拼装与 runRead 一致（闸门与参数校验在调用方先做完） */
  async function runAction(action, url) {
    if (!existsSync(reactDeps.script)) return { ok: false, reason: '动作脚本不存在（插件版本过旧？）' }
    const cfg = merged()
    const python = await reactDeps.python(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
    if (!python) return { ok: false, reason: '找不到带 playwright 的 Python。可在配置里设置 pythonPath。' }
    const argv = ['--url', url, '--action', action, '--json']
    if (cfg.readHeadless === false) argv.push('--no-headless')
    const wait = Math.max(0, Math.round(Number(cfg.verifyWait) || 0))
    if (wait > 0) argv.push('--verify-wait', String(wait))
    argv.push(...(await browserArgvFor(python, reactDeps.script, cfg)))
    // 点完还要等状态变化，超时基数比只读高；人工过验证的时间也要落进预算
    const budget = REACT_TIMEOUT + (wait > 0 ? wait + 15 : 0)
    const r = await reactDeps.run(python, reactDeps.script, argv, { timeoutSec: budget, log })
    const out = String(r.stdout || '')
    log('react ' + action + ' 结束 code=' + r.code)
    let parsed = null
    const start = out.indexOf('{')
    if (start >= 0) { try { parsed = JSON.parse(out.slice(start)) } catch {} }
    if (!parsed) {
      return { ok: false, exitCode: r.code, action, reason: '脚本输出不是 JSON（动作 ' + action + ' 那一步）', output: tail(out, 12) || tail(r.stderr, 8) }
    }
    return { ...parsed, exitCode: r.code }
  }

  tool({
    name: 'douyin_react',
    description: '点赞 / 取消赞 / 收藏 / 取消收藏（**写操作**，能力等级③A 轻互动，默认关）：返回脚本的 ok / action / before / after / changed / state / needLogin。不评论、不关注、不发布。' + REACT_HINT,
    parameters: {
      url: { type: 'string', description: '视频页链接，如 https://www.douyin.com/video/<id>' },
      action: { type: 'string', description: '动作：like（点赞）/ unlike（取消赞）/ collect（收藏）/ uncollect（取消收藏）' },
    },
    async execute(args) {
      const deny = requireTier('douyin_react', 'react')
      if (deny) return deny
      const u = checkUrl(args.url)
      if (u.error) return { ok: false, reason: u.error }
      const action = String(args.action === undefined || args.action === null ? '' : args.action).trim().toLowerCase()
      if (!action) return { ok: false, reason: 'action 必填：' + REACT_ACTIONS.join(' / '), actions: REACT_ACTIONS }
      if (!REACT_ACTIONS.includes(action)) return { ok: false, reason: 'action 只能是 ' + REACT_ACTIONS.join(' / ') + '，收到 ' + action, actions: REACT_ACTIONS }
      return runAction(action, u.value)
    },
  })

  // ── 4g. 登录（基础能力，**不设等级闸门**：读不到登录态，上面那些工具一个都用不了）──
  /**
   * 后台派生登录脚本、**不等它结束**（qr 模式要它一直驻留到扫码完成）：
   * stdout/stderr 一起重定向到 <stateDir>/login/login.log，父进程 unref 后立刻返回。
   * 不用 runPiped / runPython 那种等待式调用，否则会卡住整个工具调用。
   */
  function spawnLoginBg(python, argv, log) {
    return new Promise((resolve) => {
      let fd = null
      let child = null
      let settled = false
      const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
      try {
        try { fd = openSync(loginLogPath(), 'a') } catch { fd = null }
        const stdio = fd === null ? ['ignore', 'ignore', 'ignore'] : ['ignore', fd, fd]
        child = spawn(python, [SCRIPT_LOGIN, ...argv], {
          cwd: dirname(SCRIPT_LOGIN),
          stdio,
          detached: true,        // 父进程退出/工具返回都不带走它
          windowsHide: true,
        })
      } catch (e2) {
        try { if (fd !== null) closeSync(fd) } catch { /* ignore */ }
        return finish({ ok: false, pid: null, reason: String((e2 && e2.message) || e2) })
      }
      // 子进程已经继承了这个 fd，父进程这份必须关掉，不然日志句柄一直挂着
      try { if (fd !== null) closeSync(fd) } catch { /* ignore */ }
      child.on('error', (e2) => finish({ ok: false, pid: child.pid || null, reason: String((e2 && e2.message) || e2) }))
      try { child.unref() } catch { /* ignore */ }
      // 给 spawn 的异步 error（EPERM 之类）200ms 冒头的机会，之后就当它跑起来了
      setTimeout(() => finish({ ok: true, pid: child.pid || null, reason: null }), 200)
    })
  }

  tool({
    name: 'douyin_login_start',
    description: '开始抖音登录（基础能力，不设等级闸门）。mode=window：前台弹一个可见的 Edge 窗口，你在窗口里扫码/过验证，脚本检测到已登录后导出 cookie（最多等 5 分钟）；mode=qr：后台派生脚本，把二维码抓成 <stateDir>/login/qr.png 给设置页显示，用手机抖音扫码，再用 douyin_login_poll 看进度。',
    parameters: {
      mode: { type: 'string', description: '登录方式：window（真窗口，推荐）/ qr（后台抓二维码）；不给就取配置 loginMode' },
    },
    async execute(args) {
      const cfg = merged()
      const given = args.mode === undefined || args.mode === null || args.mode === '' ? '' : String(args.mode).trim()
      const mode = (given || String(cfg.loginMode || 'window')).toLowerCase()
      if (mode !== 'window' && mode !== 'qr') {
        return { ok: false, mode, reason: 'mode 只能是 window / qr，收到 ' + JSON.stringify(given || cfg.loginMode) }
      }
      if (!existsSync(SCRIPT_LOGIN)) return { ok: false, mode, reason: '登录脚本不存在: ' + SCRIPT_LOGIN }
      const python = await findPython(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
      if (!python) return { ok: false, mode, reason: '找不到带 playwright 的 Python。可在配置里设置 pythonPath。' }
      const cookiePath = loginCookieFile()
      try { mkdirSync(loginDir(), { recursive: true }) } catch { /* 建不了后面写文件会报，工具不崩 */ }

      if (mode === 'window') {
        // 后台派生 + douyin_login_poll 轮询：前台等满 5 分钟会把宿主 HTTP / 工具调用掐断，
        // 掐断后用户看到「登录失败」，而窗口其实还开着。先写一份 boot 状态给 poll 兜着，
        // cookie 一落地（mtime 比 startedAt 新）poll 就报 phase=ok。
        const startedAt = Date.now()
        const boot = { phase: 'waiting', at: startedAt, message: '窗口已打开：在里面扫码 / 过验证', cookiePath: null, mode: 'window' }
        try { writeFileSync(loginStatePath(), JSON.stringify(boot, null, 2), 'utf8') } catch { /* poll 读不到会说没状态 */ }
        const winArgv = ['--mode', 'window', '--wait', String(LOGIN_WAIT), '--out', cookiePath,
          ...(await browserArgvFor(python, SCRIPT_LOGIN, cfg))]
        const sp = await spawnLoginBg(python, winArgv, log)
        if (!sp.ok) {
          return { ok: false, mode, stateFile: loginStatePath(), log: loginLogPath(), cookiePath,
            reason: '后台派生登录脚本失败：' + sp.reason }
        }
        log('login(window) 已派生 pid=' + sp.pid + '，日志 ' + loginLogPath())
        return {
          ok: true,
          started: true,
          mode,
          phase: 'waiting',
          pid: sp.pid,
          stateFile: loginStatePath(),
          cookiePath,
          log: loginLogPath(),
          hint: '窗口已经弹出：扫码 / 过验证后调用 douyin_login_poll 看进度（phase=ok 就是成功，cookie 已落盘）',
        }
      }

      // qr：先把上一轮的痕迹清掉（旧 qr.png 会被当成新码，旧 state.json=ok 会让 poll 直接说已登录）
      const qrPath = loginQrPath()
      try { rmSync(qrPath, { force: true }) } catch { /* 删不掉就交给脚本覆盖 */ }
      const startedAt = Date.now()
      const boot = { phase: 'waiting', at: startedAt, message: '正在启动浏览器…', cookiePath: null, mode: 'qr' }
      try { writeFileSync(loginStatePath(), JSON.stringify(boot, null, 2), 'utf8') } catch { /* poll 读不到会说没状态 */ }
      const qrArgv = ['--mode', 'qr', '--state-dir', loginDir(), '--wait', String(LOGIN_WAIT), '--out', cookiePath,
        ...(await browserArgvFor(python, SCRIPT_LOGIN, cfg))]
      const sp = await spawnLoginBg(python, qrArgv, log)
      if (!sp.ok) {
        return { ok: false, mode, qrPath, stateFile: loginStatePath(), reason: '后台派生登录脚本失败：' + sp.reason, log: loginLogPath() }
      }
      log('login(qr) 已派生 pid=' + sp.pid + '，日志 ' + loginLogPath())

      const deadline = Date.now() + LOGIN_QR_READY_MS
      let ready = false
      while (Date.now() < deadline) {
        if (existsSync(qrPath)) { ready = true; break }
        const st = readLoginState()
        if (st && (st.phase === 'error' || st.phase === 'expired')) {
          return { ok: false, mode, qrPath, stateFile: loginStatePath(), phase: st.phase, pid: sp.pid, reason: String(st.message || '二维码没出来'), log: loginLogPath() }
        }
        await new Promise((res) => setTimeout(res, 300))
      }
      if (!ready) {
        return { ok: false, mode, qrPath, stateFile: loginStatePath(), phase: 'waiting', pid: sp.pid, log: loginLogPath(),
          reason: '等了 ' + LOGIN_QR_READY_MS / 1000 + 's 还没等到 qr.png（脚本可能还在起浏览器，稍后调 douyin_login_poll 再看；日志见 log 字段）' }
      }
      const st = readLoginState() || boot
      return {
        ok: true,
        mode,
        qrPath,
        stateFile: loginStatePath(),
        imageUrl: '/api/douyin-audio/qr',
        phase: String(st.phase || 'waiting'),
        pid: sp.pid,
        log: loginLogPath(),
        hint: '用手机抖音扫这张二维码，然后调用 douyin_login_poll',
      }
    },
  })

  tool({
    name: 'douyin_login_poll',
    description: '查登录进度（配合 douyin_login_start 的 qr 模式）：读 <stateDir>/login/state.json，返回 phase（waiting 还没扫 / scanned 已扫码待确认 / ok 成功 / expired 二维码过期 / error 出错）、loggedIn、cookiePath、message、at。ok 只在 phase=ok 时为 true。',
    parameters: {},
    async execute() {
      const stateFile = loginStatePath()
      const qrPath = loginQrPath()
      const hasQr = existsSync(qrPath)
      const st = readLoginState()
      if (!st) {
        return {
          ok: false, phase: 'none', loggedIn: false, cookiePath: null, message: '还没有登录状态：先调用 douyin_login_start',
          at: null, mode: null, stateFile, qrPath, hasQr,
        }
      }
      let phase = String(st.phase || '') || 'waiting'
      // window 模式的脚本只写 cookie、不写 state.json：cookie 比本次开始时间新（留 1s 容差）= 已经登上了
      if (phase !== 'ok' && phase !== 'error' && phase !== 'expired') {
        const startedAt = Number(st.at) || 0
        try {
          if (startedAt && statSync(loginCookieFile()).mtimeMs >= startedAt - 1000) phase = 'ok'
        } catch { /* cookie 还没写出来：继续按 state.json 说的报 */ }
      }
      const atNum = Number(st.at)
      const at = st.at === undefined || st.at === null || st.at === '' || !Number.isFinite(atNum) ? null : atNum
      const cookie = st.cookiePath === undefined || st.cookiePath === null || st.cookiePath === ''
        ? (phase === 'ok' ? loginCookieFile() : null)
        : String(st.cookiePath)
      return {
        ok: phase === 'ok',
        phase,
        loggedIn: phase === 'ok',
        cookiePath: cookie,
        message: st.message === undefined || st.message === null ? '' : String(st.message),
        at,
        mode: st.mode === 'qr' || st.mode === 'window' ? st.mode : null,
        stateFile,
        qrPath,
        hasQr,
      }
    },
  })

  // ── 谷时自动刷（基础能力，不设等级闸门）────────────────────────────
  // 「跑不跑」的判定是 lib/duty.mjs 的纯函数 decide()，这里只管：加锁 -> 真刷一轮 -> 记账。
  let dutyRunning = false                     // 正在跑的 run（调度器和手动 run 共用这把锁）

  /** 立刻跑一轮并在 duty.json 记账（工具 action=run 与定时触发共用）。绝不抛。 */
  async function runDutyOnce() {
    const t0 = Date.now()
    const cfg = merged()
    if (dutyRunning) {
      return { ok: false, busy: true, screens: 0, dir: workRoot(), elapsedMs: 0,
        reason: '已经有一轮在跑了，等它跑完', duty: statusOf({ cfg, duty: readDuty(), running: true, compact: true }) }
    }
    dutyRunning = true
    let dir = workRoot()
    try {
      const r = await runScroll({}, cfg)                    // 屏数/停留/后台/下载全部取配置
      const ok = !!(r && r.ok)
      const screens = ok ? Math.max(0, Number(r.screens) || 0) : 0
      if (r && r.dirs && r.dirs.root) dir = r.dirs.root
      const error = ok ? null : String((r && (r.reason || r.output)) || '刷一轮失败')
      const rec = recordRun({ screens, dir, ok, error, at: Date.now() })
      if (rec.ok === false) log('duty.json 写不进去: ' + rec.error)
      log('谷时一轮结束 ok=' + ok + ' screens=' + screens + ' 今天累计 ' + rec.duty.todayScreens + ' 屏')
      return { ok, screens, dir, elapsedMs: Date.now() - t0,
        duty: statusOf({ cfg, duty: rec.duty, running: false, compact: true }) }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      log('谷时一轮异常: ' + msg)
      let duty = readDuty()
      try { duty = recordRun({ screens: 0, dir, ok: false, error: msg, at: Date.now() }).duty } catch { /* 记不上账也不许崩 */ }
      return { ok: false, screens: 0, dir, elapsedMs: Date.now() - t0, reason: msg,
        duty: statusOf({ cfg, duty, running: false, compact: true }) }
    } finally {
      dutyRunning = false
    }
  }

  tool({
    name: 'douyin_duty',
    description: '谷时自动刷的开关与运行痕迹（基础能力，不设等级闸门）。action=status 看今天刷了几屏 / 在不在谷时窗口 / 下一次窗口几点；action=run 立刻按配置刷一轮并把结果记进 duty.json；action=history 看最近 20 条运行记录。',
    parameters: {
      action: { type: 'string', description: 'status（默认，看状态）/ run（立刻刷一轮）/ history（看运行记录）' },
    },
    async execute(args) {
      const action = String(args.action || 'status').trim().toLowerCase()
      const cfg = merged()
      if (action === 'history') {
        const d = readDuty()
        return { ok: true, items: d.history, total: d.history.length, stateFile: dutyPath() }
      }
      if (action === 'run') return runDutyOnce()
      if (action !== 'status') {
        return { ok: false, reason: '未知 action: ' + action + '（只认 status / run / history）', stateFile: dutyPath() }
      }
      return statusOf({ cfg, duty: readDuty(), running: dutyRunning })
    },
  })

  // ── HTTP 接口（给 Web UI 设置页用）─────────────────────────
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-audio',
      handler: async (req, res) => {
        const send = (code, obj) => {
          try { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)) } catch {}
        }
        try {
          const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
          const sub = reqUrl.pathname.replace(/^\/api\/douyin-audio/, '') || '/'
          // 同源门在最前面：不满足就 403，**后面一个分支都不走**（动作绝不执行）
          const gate = sameOrigin(req, reqUrl.searchParams.get('token'))
          if (!gate.ok) {
            log('HTTP 拒绝（不是同一来源：' + (gate.origin ? 'origin=' + gate.origin + ' ' : '')
              + (gate.site ? 'sec-fetch-site=' + gate.site : '没有 Origin / Sec-Fetch-Site') + '）: '
              + String(req.method || '') + ' ' + sub)
            try { if (typeof req.resume === 'function') req.resume() } catch { /* 把 body 丢掉，别把连接挂住 */ }
            return send(403, { ok: false, error: 'forbidden: cross-origin or missing token' })
          }
          // token 端点：本身也过同源门（否则等于没加）。设置页挂载时取一次，之后带 x-dsh-douyin-token。
          if (req.method === 'GET' && sub === '/token') {
            return send(200, { ok: true, token: issueAuthToken(), expiresInMs: AUTH_TOKEN_TTL_MS, header: AUTH_TOKEN_HEADER })
          }
          if (req.method === 'GET' && sub === '/config') return send(200, { ok: true, config: merged() })
          // 检查更新：问 npm registry 比版本。只读、8 秒超时、失败也是 HTTP 200（把原因写在 error 里）
          if (req.method === 'GET' && sub === '/update') {
            const info = pluginInstallInfo()
            return send(200, { ...(await checkUpdate()), mode: info.mode, installCommand: UPDATE_INSTALL })
          }
          // 只读：给设置页显示「本机几核」，线程数输入框的上限靠它（拿不到 core 的旧宿主由前端降级）
          if (req.method === 'GET' && sub === '/account') return send(200, { ok: true, ...readAccount() })
          if (req.method === 'GET' && sub === '/sysinfo') {
            let cores = 0
            let totalMemGB = 0
            let plat = ''
            let architecture = ''
            try { cores = cpus().length } catch { cores = 0 }
            try { totalMemGB = Math.round((totalmem() / 1073741824) * 10) / 10 } catch { totalMemGB = 0 }
            try { plat = platform() } catch { plat = '' }
            try { architecture = arch() } catch { architecture = '' }
            return send(200, { ok: true, cores, platform: plat, arch: architecture, totalMemGB })
          }
          // 二维码图片：设置页 <img src="/api/douyin-audio/qr?t=…"> 直接显示（同源门放行；
          // <img> 带不了请求头，所以同源判据之外也认 ?token=）
          if (req.method === 'GET' && sub === '/qr') {
            let png = null
            try { png = readFileSync(loginQrPath()) } catch { png = null }
            if (!png || !png.length) {
              return send(404, { ok: false, error: '二维码还没生成（先调用 douyin_login_start 的 qr 模式）', qrPath: loginQrPath(), stateFile: loginStatePath() })
            }
            try {
              res.statusCode = 200
              res.setHeader('content-type', 'image/png')
              res.setHeader('cache-control', 'no-store')
              res.end(png)
            } catch { /* 连接已经断了 */ }
            return undefined
          }
          // 谷时自动刷的只读查询：设置页「日常」页拿状态 / 运行记录（等价 douyin_duty）
          if (req.method === 'GET' && sub === '/duty') {
            const dutyTool = byName.get('douyin_duty')
            if (!dutyTool) return send(500, { ok: false, error: 'douyin_duty 没注册上' })
            const action = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('action') || 'status'
            return send(200, await dutyTool.execute({ action }))
          }
          const body = req.method === 'POST' ? await readJson(req) : {}
          // 升级：只在用户在确认弹窗里点了「立即升级」后才会走到这里
          if (req.method === 'POST' && sub === '/update') {
            const act = String(body.action || '')
            if (act === 'apply' || act === 'pull') return send(200, await applyUpdate(act))
          }
          if (req.method === 'POST' && sub === '/config') {
            const cfg = cfgAll()
            const key = String(body.key || '')
            if (!(key in cfg)) return send(400, { ok: false, error: '未知配置键: ' + key })
            let v = body.value
            if (typeof cfg[key] === 'boolean') v = String(v).toLowerCase() === 'true'
            else if (typeof cfg[key] === 'number') v = Number(v)
            if (typeof cfg[key] === 'number' && Number.isNaN(v)) return send(400, { ok: false, error: 'value 不是数字' })
            // 数值底线与 douyin_config 同一套（count>=1 / delay>=0 / downloadTimeout>=30）
            const badNum = checkNumericCfg(key, v)
            if (badNum) return send(400, { ok: false, error: badNum })
            cfg[key] = v
            const r = saveCfg(cfg)
            return r && r.ok === false ? send(500, { ok: false, error: r.error }) : send(200, { ok: true, config: cfg })
          }
          if (req.method === 'POST' && sub === '/run') {
            const action = String(body.action || '')
            // duty_* 是 douyin_duty 的三个 action（POST /run {action:'duty_status'|'duty_run'|'duty_history'}）
            const DUTY_ACTIONS = { duty_status: 'status', duty_run: 'run', duty_history: 'history' }
            if (Object.prototype.hasOwnProperty.call(DUTY_ACTIONS, action)) {
              const dutyTool = byName.get('douyin_duty')
              if (!dutyTool) return send(500, { ok: false, error: 'douyin_duty 没注册上' })
              return send(200, await dutyTool.execute({ action: DUTY_ACTIONS[action] }))
            }
            // whoami：读当前登录账号（个人页昵称），结果存进 stateDir/account.json
            if (action === 'whoami') {
              const r = await runRead('whoami', [], 90)
              if (!r || r.ok === false) {
                return send(200, { ok: false, error: (r && (r.error || r.reason)) || '没读到账号' })
              }
              const item = Array.isArray(r.items) && r.items[0] ? r.items[0] : {}
              const nick = String(item.nickname || '')
              const uid = String(item.uid || '')
              if (!nick) return send(200, { ok: false, error: '脚本没给昵称' })
              saveAccount(nick, uid)
              return send(200, { ok: true, nick, uid, at: new Date().toISOString() })
            }
            // setup_* 是 douyin_setup 的界面入口
            //   setup_auto → **后台派生**（detached），立刻回 started:true —— 首次装依赖几分钟，
            //                长请求会被宿主 HTTP 掐断，掐断后用户看到失败、脚本其实还在跑；结果读 env.setupResult
            //   setup_scan → 前台同步（几秒，要拿 inventory）
            //   setup_start → 前台走工具（minimal/full/*-force 内部就是后台派生，立刻回 started）
            if (action === 'setup_auto') {
              return send(200, await startSetupBg('auto'))
            }
            if (action === 'setup_scan' || action === 'setup_start') {
              const setupTool = byName.get('douyin_setup')
              if (!setupTool) return send(500, { ok: false, error: 'douyin_setup 没注册上' })
              const mode = action === 'setup_start' ? body.mode : 'scan'
              return send(200, await setupTool.execute({ mode }))
            }
            const t = byName.get('douyin_' + action)
            if (!t) return send(400, { ok: false, error: '未知 action: ' + action })
            return send(200, await t.execute(body))
          }
          return send(404, { ok: false, error: 'not found: ' + sub })
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message ? e.message : e) })
        }
      },
    }), 'douyin-audio: /api/douyin-audio 路由')
    log('HTTP 接口已挂载: /api/douyin-audio/{config,run,sysinfo,qr,duty,token}（同源鉴权：Sec-Fetch-Site / Origin / x-dsh-douyin-token；run 认得 status / scroll / login_* / duty_* / setup_*）')
  } catch (e) { log('HTTP 路由没挂上: ' + (e && e.message ? e.message : e)) }

  // ── 谷时自动刷调度：每 60 秒判定一次（apply 时启动，dispose 时清掉）──────
  // 五条全中才触发一轮后台刷：autoRun && 在窗口内 && 额度未满 && 间隔够 && 没有正在跑的 run。
  // 判定用 lib/duty.mjs 的纯函数 decide()；触发失败只写日志，绝不让调度器把插件带崩。
  const DUTY_TICK_MS = 60000
  try {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          const cfg = merged()
          const now = Date.now()
          const verdict = decide({ cfg, duty: readDuty(now), now, running: dutyRunning })
          if (!verdict.shouldRun) return
          log('谷时自动刷触发：' + verdict.reasons.join('；'))
          Promise.resolve(runDutyOnce())
            .then((r) => log('谷时自动刷结束 ok=' + r.ok + ' screens=' + r.screens + ' elapsedMs=' + r.elapsedMs + (r.reason ? ' reason=' + r.reason : '')))
            .catch((e) => log('谷时自动刷异常: ' + (e && e.message ? e.message : e)))
        } catch (e) {
          log('调度判定异常（定时器继续跑）: ' + (e && e.message ? e.message : e))
        }
      }, DUTY_TICK_MS)
      try { timer.unref?.() } catch { /* 没有 unref 也不影响 */ }
      return () => { try { clearInterval(timer) } catch { /* ignore */ } }
    }, 'douyin-audio: 谷时自动刷调度')
    log('谷时自动刷调度已就绪（每 ' + DUTY_TICK_MS / 1000 + ' 秒判定一次；autoRun=false 时永不触发）')
  } catch (e) { log('谷时自动刷调度没起来: ' + (e && e.message ? e.message : e)) }

  // ── 4. 配置 ───────────────────────────────────────────────
  tool({
    name: 'douyin_config',
    description: '读取或修改抖音插件配置（存于状态目录 config.json）。action=get 返回当前配置；action=set 改一个键。',
    parameters: {
      action: { type: 'string', description: 'get 或 set' },
      key: { type: 'string', description: 'set 时必填：count / delay / headless / saveAll / downloadTimeout / pythonPath / asrThreads / autoTranscribe / loginMode（window 或 qr）/ readHeadless（只读工具是否后台运行，默认 true）/ verifyWait（命中验证时最多等多少秒，默认 0）/ autoRun（谷时自动刷，默认 false）/ dutyWindow（谷时窗口，默认 12:00-14:00,18:00-23:59）/ dailyLimit（每天最多几屏，默认 5）/ dutyIntervalMin（两次自动刷最少间隔分钟，默认 30）/ uiLayout（界面布局：classic 平铺 / tabs 四标签页，默认 classic）/ browserChannel（浏览器通道：msedge 默认 Edge / chrome 本机 Chrome / chromium 内置 / firefox / webkit / 自定义项 id；后两者要先 npx playwright install）/ browserExtras（手动添加的浏览器，JSON 数组字符串 [{"id","label","path"}]）' },
      value: { type: 'string', description: 'set 时必填：新值（布尔用 true/false，数字直接写）' },
    },
    async execute(args) {
      const cfg = cfgAll()
      if ((args.action || 'get') === 'get') return { ok: true, config: cfg, stateDir: stateDir() }
      const key = String(args.key || '')
      // 能力等级（tier*）**只能由用户在设置页改**：agent 能自己解锁的话，闸门等于没设。
      // 设置页那条 HTTP /config 路照旧能写 tier*（那是用户自己点的开关，而且要过同源鉴权）。
      if (Object.prototype.hasOwnProperty.call(TIER_DEFAULTS, key)) {
        log('拒绝 agent 修改能力等级: ' + key)
        return {
          ok: false,
          error: '能力等级只能由用户在设置页修改',
          key,
          hint: '设置页「能力等级」那一节由用户自己点；douyin_config 只改基础配置',
        }
      }
      if (!(key in cfg)) return { ok: false, reason: '未知配置键: ' + key, keys: Object.keys(cfg) }
      let v = args.value
      if (typeof cfg[key] === 'boolean') v = String(v).toLowerCase() === 'true'
      else if (typeof cfg[key] === 'number') v = Number(v)
      if (typeof cfg[key] === 'number' && Number.isNaN(v)) return { ok: false, reason: 'value 不是数字' }
      const badNum = checkNumericCfg(key, v)
      if (badNum) return { ok: false, error: badNum }
      cfg[key] = v
      saveCfg(cfg)
      return { ok: true, config: cfg }
    },
  })
}
