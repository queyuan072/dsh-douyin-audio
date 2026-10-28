/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩：**配置、运行数据、日志都放插件自己的家** —— `$DSH_HOME/douyin-duty/`，
 * 绝不写进插件包目录（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * ⭐ 硬规矩：**这一层一个异常都不许往外抛**。
 *    宿主的 apply() 第一行就是 ensureDirs()；它一抛，整条 plugic entry 直接不激活
 *    （DSH 只留一句 "entry did not activate"），而不是降级运行。
 *    所以：建目录失败 → 返回 false + ensureDirsError() 里留原因；
 *          写日志失败 → 静默；读配置失败 → 返回默认值；写配置失败 → 返回 { ok:false, error }。
 *
 * 目录形状：
 *   $DSH_HOME/douyin-duty/
 *     config.json    用户配置（loadCfg / saveCfg）
 *     douyin.log     运行日志（log，超过 2MB 轮转成 douyin.log.1）
 *     videos/        下载下来的视频
 *     shots/         截图
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 家目录：$DSH_HOME，回退 ~/.dsh（连 homedir() 都拿不到时退相对路径，绝不抛） */
export function dshHome() {
  try {
    const h = process.env.DSH_HOME
    if (h && h.trim()) return h
  } catch { /* 环境变量读不到就走兜底 */ }
  try { return join(homedir(), '.dsh') } catch { return '.dsh' }
}

/** 插件的家：$DSH_HOME/douyin-duty（只算路径，不建目录） */
export function stateDir() {
  try { return join(dshHome(), 'douyin-duty') } catch { return 'douyin-duty' }
}

/** 配置里每个字段的缺省值 —— 想改默认行为改这里 */
export const DEFAULTS = {
  count: 3,                 // 一轮刷几屏
  delay: 1.5,               // 每屏停留秒数
  headless: true,           // 无头浏览器
  saveAll: true,            // 存全部视频还是挑着存
  downloadTimeout: 300,     // 单个视频下载超时（秒）
  transcribeModel: '',      // 转写模型；空 = 用宿主默认
  pythonPath: '',           // Python 解释器路径；空 = 自动探测
  // ── 能力等级（五个开关，默认只开①只读）────────────────────────────────
  //   ① / ② / ③A / ③B / ④ 逐级加权限；基础功能（刷屏/转写/自检/配置）不受等级限制。
  //   ③ 拆成两档：③A 可撤回（点赞收藏）、③B 公开不可撤回（评论回复）。
  //   依赖：③A / ③B / ④ 任一打开时，① 视为自动生效（这里**不**偷偷改用户存的值）。
  tierRead: true,           // ① 只读：热榜 / 搜索 / 视频详情 / 评论列表
  tierNotify: false,        // ② 通知：读私信、通知摘要
  tierReact: false,         // ③A 轻互动：点赞、收藏（可撤回）
  tierComment: false,       // ③B 评论：发评论、回复（公开，发出去收不回）
  tierPublish: false,       // ④ 发布：上传视频到抖音
  // ── 本地转写 ───────────────────────────────────────────────────────────
  asrThreads: 8,            // 本地转写用的线程数
  autoTranscribe: false,    // 刷完是否自动转写（默认关：先给清单让人挑）
  // ── 登录 ───────────────────────────────────────────────────────────────
  loginMode: 'window',      // 登录方式：window（真窗口，推荐）/ qr（后台抓二维码到设置页扫）
  // ── 谷时自动刷（契约见 lib/duty.mjs；运行痕迹写 <stateDir>/duty.json，用户不用填）──
  //   默认 autoRun=false：不开启就绝不自己定时跑，行为与升级前一致。
  autoRun: false,                                   // 谷时自动刷：true 才由插件自己定时跑
  dutyWindow: '12:00-14:00,18:00-23:59',            // 谷时窗口，逗号分隔多个 HH:MM-HH:MM
  dailyLimit: 5,                                    // 每天最多刷几屏（0 = 不自动跑，但仍可手动跑）
  dutyIntervalMin: 30,                              // 两次自动刷之间至少隔多少分钟
  // ── 浏览器通道（三个会起浏览器的脚本：scroll / read / login）─────────────
  //   msedge（默认，与历史一致）/ chrome / chromium（内置，容易被风控）
  //   脚本侧候选链：msedge → [msedge, chrome, 内置chromium]；chrome → [chrome, msedge, 内置chromium]；
  //                 chromium → [内置chromium]（用户明确要裸浏览器，不再回退）
  browserChannel: 'msedge',
  // ── 界面 ───────────────────────────────────────────────────────────────
  uiLayout: 'classic',      // 界面布局：classic = 平铺（默认，保持现状）/ tabs = 四标签页
}

export function cfgPath() {
  return join(stateDir(), 'config.json')
}

export function logPath() {
  return join(stateDir(), 'douyin.log')
}

// 最近一次 ensureDirs() 的失败原因（成功时清空），供 index.js 写进日志 / 设置页显示
let lastDirsError = null

/** 把异常压成一行可读文本；code 已经在 message 里就不重复加 */
function errText(e) {
  const code = e?.code || 'ERROR'
  const msg = String(e?.message ?? e)
  return msg.startsWith(code) ? msg : `${code}: ${msg}`
}

/** 上次 ensureDirs() 为什么失败：成功返回 null，失败返回 '消息'（含路径） */
export function ensureDirsError() {
  return lastDirsError
}

/**
 * 建好家目录与两个子目录（videos / shots），幂等。
 * @returns {boolean} true = 三个目录都在；false = 建不出来（原因见 ensureDirsError()）
 * 绝不抛异常。
 */
export function ensureDirs() {
  let dir
  try {
    dir = stateDir()
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'videos'), { recursive: true })
    mkdirSync(join(dir, 'shots'), { recursive: true })
    lastDirsError = null
    return true
  } catch (e) {
    lastDirsError = `${errText(e)} (${dir || '?'})`
    return false
  }
}

/** 读配置：读不到 / 解析失败 / 不是对象 → 返回 DEFAULTS 的拷贝。绝不抛。 */
export function loadCfg() {
  let raw = null
  try { raw = JSON.parse(readFileSync(cfgPath(), 'utf8')) } catch { raw = null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS }
  return { ...DEFAULTS, ...raw }
}

/**
 * 写配置：先补齐缺省字段再落盘，保证 config.json 里字段是全的。
 * @returns {{ok:true,cfg:object} | {ok:false,error:string}} 绝不抛。
 */
export function saveCfg(cfg) {
  const next = { ...DEFAULTS, ...(cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}) }
  const dirsOk = ensureDirs()                      // 失败也继续试写：万一目录其实已存在
  try {
    writeFileSync(cfgPath(), JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, cfg: next }
  } catch (e) {
    // 建目录失败时以那个原因为准：写文件只会报 ENOENT，指错方向
    return { ok: false, error: dirsOk ? errText(e) : (lastDirsError || errText(e)) }
  }
}

const MAX_LOG = 2 * 1024 * 1024   // 2MB

/** 追加一行日志（带时间戳）；超过 2MB 先把现有一份挪成 .1，只留一份历史。绝不抛。 */
export function log(line) {
  try {
    ensureDirs()
    const file = logPath()
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG) {
        const old = file + '.1'
        try { rmSync(old, { force: true }) } catch { /* 删不掉就继续尝试覆盖 */ }
        renameSync(file, old)
      }
    } catch { /* 轮转失败不能挡住写日志 */ }
    appendFileSync(file, `[${new Date().toISOString()}] ${String(line)}\n`, 'utf8')
    return true
  } catch { return false }   // 写不了日志就算了，绝不影响主流程
}
