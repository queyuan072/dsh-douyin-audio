/**
 * dsh-douyin-audio —— 刷抖音 + 音频转写（host 半端）
 * 工具：douyin_scroll / douyin_transcribe / douyin_status / douyin_config
 * 只读查询：douyin_hot / douyin_search / douyin_video / douyin_comments（都走 scripts/douyin_read.py）
 * 通知（② 通知级闸门）：douyin_notes / douyin_messages —— 同样只读，只读页面不发消息、不标已读
 * 登录（基础能力，不设等级闸门）：douyin_login_start / douyin_login_poll
 *   两种模式：window = 弹真窗口人工扫码/过验证；qr = 后台派生脚本抓二维码给设置页扫
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { ensureDirs, loadCfg, saveCfg, stateDir, log as logLine } from './lib/state.mjs'
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
})

/** asrThreads / autoTranscribe / readHeadless / verifyWait 的缺省值：lib/state.mjs 的 DEFAULTS 里没有这些键，白名单在这一层补齐；
 *  loginMode 两边都有，这里再留一份，防止旧 config.json / 旧 lib 读不到。
 *  readHeadless=true / verifyWait=0 就是历史的「一律无头、不等验证」，默认行为不变 */
const EXTRA_DEFAULTS = { asrThreads: 8, autoTranscribe: false, loginMode: 'window', readHeadless: true, verifyWait: 0 }

/** 读全配置：插件自己的这两把键在当前层补默认值，其余仍以 config.json / DEFAULTS 为准 */
const cfgAll = () => ({ ...EXTRA_DEFAULTS, ...loadCfg() })

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
export async function scrollResult({ ok, code, stdout, stderr, count, cfg, log } = {}) {
  const out = String(stdout || '')
  const mf = manifestItems()
  return {
    ok: !!ok && out.includes('本次刷视频统计'),
    exitCode: code,
    screens: count,
    items: mf.items,
    totalMB: mf.totalMB,
    manifestPath: mf.manifestPath,
    dirs: { root: workRoot(), videos: workVideos() },
    autoTranscribe: await autoTranscribeLatest(mf.items, cfg, 1, log),
    output: tail(out, 18) || tail(String(stderr || ''), 8),
  }
}

/** 读 POST body（限 256KB） */
function readJson(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 262144) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
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

export function apply(ctx, config = {}) {
  ensureDirs()
  const log = (m) => { try { ctx.logger?.info?.('[douyin-audio] ' + m) } catch {} ; try { logLine(m) } catch {} }
  const merged = () => {
    const base = cfgAll()
    const over = {}
    for (const k of ['count', 'delay', 'headless', 'saveAll', 'downloadTimeout', 'pythonPath', 'asrThreads', 'autoTranscribe', 'loginMode', 'readHeadless', 'verifyWait']) {
      let v = config ? config[k] : undefined
      if (v && typeof v === 'object' && 'value' in v) v = v.value
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') over[k] = v
    }
    return { ...base, ...over }
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
      hint: '在设置页「能力等级」打开 ' + key + '，或调用 douyin_config 设置该键',
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
      const python = await findPython(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
      if (!python) return { ok: false, reason: '找不到带 playwright 的 Python。可在配置里设置 pythonPath。' }
      const count = Math.max(1, Math.min(Number(args.count) || cfg.count || 3, 200))
      const delay = Math.max(0.5, Math.min(Number(args.delay) || cfg.delay || 1.5, 30))
      const headless = args.headless !== undefined ? !!args.headless : !!cfg.headless
      const saveAll = args.saveAll !== undefined ? !!args.saveAll : !!cfg.saveAll
      const argv = ['--tab', 'recommend', '--count', String(count), '--delay', String(delay),
        '--download-timeout', String(cfg.downloadTimeout || 300)]
      if (headless) argv.push('--headless')
      if (saveAll) argv.push('--save-all')
      argv.push('--work-dir', workRoot())
      const budget = count * (delay + 12) + 120
      const r = await runPython(python, SCRIPT_SCROLL, argv, { timeoutSec: budget, log })
      log('scroll 结束 code=' + r.code)
      // 返回体由 scrollResult 统一拼：清单 + autoTranscribe（关着是 null）
      return scrollResult({ ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, count, cfg, log })
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
    description: '自检抖音插件运行条件：Python(playwright) / Python(sherpa_onnx) / ffmpeg / 模型目录 / cookie 文件 / 脚本是否存在，并报告状态目录占用。',
    parameters: {},
    async execute() {
      const cfg = merged()
      const pyScroll = await findPython(log, 'playwright', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
      const pyAsr = await findPython(log, 'sherpa_onnx', typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '')
      const ff = [join(process.env.USERPROFILE || '', '.dsh', 'bin', 'ffmpeg.exe')].find((p) => existsSync(p)) || null
      const modelDir = process.env.DOUYIN_MODEL_DIR || join(process.env.USERPROFILE || '', '.dsh', 'models', 'sherpa-sense-voice', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')
      const cookie = join(process.env.USERPROFILE || '', '.dsh', 'cookies', 'douyin_cookies.txt')
      const sdir = stateDir()
      const vdir = workVideos()
      const videos = existsSync(vdir) ? readdirSync(vdir).filter((f) => /\.mp4$/i.test(f)) : []
      return {
        ok: !!(pyScroll && pyAsr && ff && existsSync(modelDir)),
        version: pluginVersion(),
        pythonScroll: pyScroll || '(未找到，需带 playwright)',
        pythonAsr: pyAsr || '(未找到，需带 sherpa_onnx)',
        ffmpeg: ff || '(未找到)',
        modelDir: { path: modelDir, exists: existsSync(modelDir) },
        cookie: { path: cookie, exists: existsSync(cookie) },
        scripts: { scroll: existsSync(SCRIPT_SCROLL), transcribe: existsSync(SCRIPT_TRANSCRIBE), read: existsSync(SCRIPT_READ) },
        stateDir: sdir,
        workDir: workRoot(),
        videos,
        cfg,
      }
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
        log('login(window) 开始: ' + python)
        const r = await runPython(python, SCRIPT_LOGIN,
          ['--mode', 'window', '--wait', String(LOGIN_WAIT), '--out', cookiePath],
          { timeoutSec: LOGIN_WAIT + 60, log, tmpDir: join(stateDir(), 'wavtmp') })
        const loggedIn = !!r.ok && existsSync(cookiePath)
        log('login(window) 结束 code=' + r.code + ' loggedIn=' + loggedIn)
        const out = { ok: !!r.ok, mode, loggedIn, cookiePath, exitCode: r.code, script: SCRIPT_LOGIN }
        if (!r.ok) {
          out.reason = r.code === 2
            ? '窗口里等超时了（' + LOGIN_WAIT + 's 内没检测到登录）'
            : '登录脚本退出码 ' + r.code
          out.output = tail(String(r.stdout || '') + '\n' + String(r.stderr || ''), 10)
        }
        return out
      }

      // qr：先把上一轮的痕迹清掉（旧 qr.png 会被当成新码，旧 state.json=ok 会让 poll 直接说已登录）
      const qrPath = loginQrPath()
      try { rmSync(qrPath, { force: true }) } catch { /* 删不掉就交给脚本覆盖 */ }
      const startedAt = Date.now()
      const boot = { phase: 'waiting', at: startedAt, message: '正在启动浏览器…', cookiePath: null, mode: 'qr' }
      try { writeFileSync(loginStatePath(), JSON.stringify(boot, null, 2), 'utf8') } catch { /* poll 读不到会说没状态 */ }
      const sp = await spawnLoginBg(python,
        ['--mode', 'qr', '--state-dir', loginDir(), '--wait', String(LOGIN_WAIT), '--out', cookiePath], log)
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
      const phase = String(st.phase || '') || 'waiting'
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
          const sub = new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/^\/api\/douyin-audio/, '') || '/'
          if (req.method === 'GET' && sub === '/config') return send(200, { ok: true, config: merged() })
          // 只读：给设置页显示「本机几核」，线程数输入框的上限靠它（拿不到 core 的旧宿主由前端降级）
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
          // 二维码图片：设置页 <img src="/api/douyin-audio/qr?t=…"> 直接显示（同源、无需鉴权）
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
          const body = req.method === 'POST' ? await readJson(req) : {}
          if (req.method === 'POST' && sub === '/config') {
            const cfg = cfgAll()
            const key = String(body.key || '')
            if (!(key in cfg)) return send(400, { ok: false, error: '未知配置键: ' + key })
            let v = body.value
            if (typeof cfg[key] === 'boolean') v = String(v).toLowerCase() === 'true'
            else if (typeof cfg[key] === 'number') v = Number(v)
            if (typeof cfg[key] === 'number' && Number.isNaN(v)) return send(400, { ok: false, error: 'value 不是数字' })
            cfg[key] = v
            const r = saveCfg(cfg)
            return r && r.ok === false ? send(500, { ok: false, error: r.error }) : send(200, { ok: true, config: cfg })
          }
          if (req.method === 'POST' && sub === '/run') {
            const action = String(body.action || '')
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
    log('HTTP 接口已挂载: /api/douyin-audio/{config,run,sysinfo,qr}')
  } catch (e) { log('HTTP 路由没挂上: ' + (e && e.message ? e.message : e)) }

  // ── 4. 配置 ───────────────────────────────────────────────
  tool({
    name: 'douyin_config',
    description: '读取或修改抖音插件配置（存于状态目录 config.json）。action=get 返回当前配置；action=set 改一个键。',
    parameters: {
      action: { type: 'string', description: 'get 或 set' },
      key: { type: 'string', description: 'set 时必填：count / delay / headless / saveAll / downloadTimeout / pythonPath / asrThreads / autoTranscribe / loginMode（window 或 qr）/ readHeadless（只读工具是否后台运行，默认 true）/ verifyWait（命中验证时最多等多少秒，默认 0）' },
      value: { type: 'string', description: 'set 时必填：新值（布尔用 true/false，数字直接写）' },
    },
    async execute(args) {
      const cfg = cfgAll()
      if ((args.action || 'get') === 'get') return { ok: true, config: cfg, stateDir: stateDir() }
      const key = String(args.key || '')
      // tier* 四键即使 config.json 里还没有也允许写：等级开关不能被「未知配置键」挡住
      const isTierKey = Object.prototype.hasOwnProperty.call(TIER_DEFAULTS, key)
      if (!(key in cfg) && !isTierKey) return { ok: false, reason: '未知配置键: ' + key, keys: Object.keys(cfg) }
      let v = args.value
      if (isTierKey || typeof cfg[key] === 'boolean') v = String(v).toLowerCase() === 'true'
      else if (typeof cfg[key] === 'number') v = Number(v)
      if (typeof cfg[key] === 'number' && Number.isNaN(v)) return { ok: false, reason: 'value 不是数字' }
      cfg[key] = v
      saveCfg(cfg)
      return { ok: true, config: cfg }
    },
  })
}
