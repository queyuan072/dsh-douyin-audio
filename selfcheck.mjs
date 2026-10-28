#!/usr/bin/env node
/**
 * selfcheck.mjs —— 本地预检：用**假 ctx 真跑一次 apply()**，把"重启后才发现 entry did not activate"
 * 那类错误提前在本地暴露出来（宿主只会留一句 warning，日志里看不出根因）。
 *
 * 查什么：
 *   a. 恰好注册 14 个工具：douyin_scroll / douyin_transcribe / douyin_status / douyin_config
 *      + douyin_hot / douyin_search / douyin_video / douyin_comments / douyin_note（只读查询）
 *      + douyin_notes / douyin_messages（② 通知，只读）
 *      + douyin_login_start / douyin_login_poll（登录，基础能力不设等级闸门）
 *      + douyin_duty（谷时自动刷，基础能力不设等级闸门）
 *   b. 每个工具都有 description(string) / parameters(对象) / execute(function)
 *   c. 参数 schema 里 type:'object' 的节点必须显式写 additionalProperties
 *      （宿主的 defineTool 会抛 JsonSchemaError ⇒ 整条插件不激活）
 *   d. 模块导出 name === 'douyin-audio'，inject 含 'tools'
 *   e. 能力等级闸门：tierRead=false 时五个只读工具（含图文 douyin_note）返回 TIER_DISABLED；
 *      开回来后放行；tierReact/tierComment=true 时 tierRead 视为生效；基础四工具不受限；
 *      tierNotify=false 时 douyin_notes / douyin_messages 返回 TIER_DISABLED(tier=notify)，
 *      打开后放行（② 通知与 ① 只读互相独立）
 *   g. 浏览器通道 browserChannel：douyin_config 认得这个键，缺省是 msedge；五个取值
 *      msedge / chrome / chromium / firefox / webkit 都认，未知值仍规整成 msedge；
 *      douyin_status 的 browsers 是五个布尔值 + extras 数组（{id,label,path,exists}），
 *      给设置页「只列检测到的浏览器」用；browserExtras 是 JSON 数组字符串，坏 JSON 一律当 []
 *   f. 谷时自动刷 douyin_duty：只认一个 action 参数；**没有任何等级闸门**
 *      （五个等级全关时 action=status 也照常返回 ok:true）；没有 duty.json 时 todayScreens=0、
 *      autoRun 默认 false、windows 按默认窗口解析；action=history 返回 items 数组
 *
 * 用法：node selfcheck.mjs [入口文件，默认 ./index.js]
 * 退出码：0 = 全通过；1 = 有问题（宿主里就是 "entry did not activate"）
 * 不依赖 python、不联网：apply() 只建目录 + 注册工具，探测器要等 execute 才会跑。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const EXPECTED_TOOLS = [
  'douyin_scroll', 'douyin_transcribe', 'douyin_status', 'douyin_config',
  'douyin_hot', 'douyin_search', 'douyin_video', 'douyin_comments', 'douyin_note',
  'douyin_notes', 'douyin_messages',
  'douyin_login_start', 'douyin_login_poll',
  'douyin_duty',
]
const EXPECTED_NAME = 'douyin-audio'

/* 预检不许碰用户真正的 $DSH_HOME：把家目录指到临时目录，跑完删掉。
   必须在 import index.js 之前设 —— lib/state.mjs 的 dshHome() 每次调用都读 process.env.DSH_HOME。 */
const SANDBOX_HOME = join(tmpdir(), 'dsh-douyin-selfcheck-' + process.pid)
process.env.DSH_HOME = SANDBOX_HOME

const problems = []
/** 记一条失败原因（不立刻退出，一次把问题报全） */
function problem(msg) {
  problems.push(msg)
  console.error('  ✗ ' + msg)
}
/** 致命失败：打印原因（含栈帧）+ 退出 1 */
function die(msg, e) {
  console.error('')
  console.error('✗ ' + msg)
  if (e) {
    console.error('  ' + (e.name || 'Error') + ': ' + (e.message || String(e)))
    const frame = String(e.stack || '').split('\n').slice(1, 4).join('\n')
    if (frame) console.error(frame)
  }
  cleanup()
  process.exit(1)
}
function cleanup() {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ }
}

const entryArg = process.argv[2] || './index.js'
const entryPath = resolve(entryArg)

/* ───────── ① import 插件本体 ───────── */
let mod
try {
  mod = await import(pathToFileURL(entryPath).href)
} catch (e) {
  die('import ' + entryArg + ' 失败（宿主里就是 "failed to import" ⇒ 插件整条不激活）', e)
}

/* ───────── ② 假 ctx：登记到的工具收集起来，日志打到 stderr ───────── */
const registered = []
const toStderr = (level) => (m) => { try { process.stderr.write('[selfcheck/' + level + '] ' + m + '\n') } catch { /* ignore */ } }
const fakeCtx = {
  tools: { register: (t) => { registered.push(t); return t } },
  logger: { info: toStderr('info'), warn: toStderr('warn'), error: toStderr('error'), debug: toStderr('debug') },
  get: () => undefined,          // 宿主里拿不到的东西：返回 undefined 也不许崩
  effect: (fn) => { try { return fn() } catch { return undefined } },
  on: () => ({ dispose() {} }),
  emit: () => {},
  plugin: () => {},
  setTimeout: () => () => {},
  settings: { register: () => ({}) },
  webServer: { register: () => ({ dispose() {} }) },
}

try { mkdirSync(SANDBOX_HOME, { recursive: true }) } catch (e) {
  die('建不出临时家目录 ' + SANDBOX_HOME + '（沙箱不让写？）', e)
}

/* ───────── ③ 真跑一次 apply() ───────── */
try {
  mod.apply(fakeCtx, {})
} catch (e) {
  die('apply() 抛错了 —— 宿主里就是那句 "warning: 1 entry did not activate"（已注册 ' + registered.length + ' 个工具）', e)
}

/* ───────── ④ 断言 ───────── */
const failCountBefore = problems.length
const ok = (...a) => console.log('  ✓ ' + a.join(' '))

// (d) 模块级导出
if (mod.name !== EXPECTED_NAME) problem('导出的 name 是 ' + JSON.stringify(mod.name) + '，应为 ' + JSON.stringify(EXPECTED_NAME))
else ok('name = ' + EXPECTED_NAME)
const inject = Array.isArray(mod.inject) ? mod.inject : []
if (!inject.includes('tools')) problem('inject 里没有 "tools"（现在是 ' + JSON.stringify(mod.inject) + '）')
else ok('inject 含 tools：' + JSON.stringify(mod.inject))

// (a) 工具数量与名字
const names = registered.map((t) => (t && t.name) || String(t))
if (registered.length !== EXPECTED_TOOLS.length) {
  problem('注册了 ' + registered.length + ' 个工具，应为 ' + EXPECTED_TOOLS.length + ' 个：' + JSON.stringify(names))
}
for (const want of EXPECTED_TOOLS) {
  if (!names.includes(want)) problem('少了工具：' + want)
}
for (const extra of names) {
  if (!EXPECTED_TOOLS.includes(extra)) problem('多出未预期的工具：' + extra)
}

// (c) 参数 schema 递归检查（object 必须带 additionalProperties）
/** 一个 schema 节点本身合不合法 */
function checkSchemaNode(node, where) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((v, i) => checkSchemaNode(v, where + '[' + i + ']')); return }

  if (node.type === 'object' && !Object.prototype.hasOwnProperty.call(node, 'additionalProperties')) {
    problem(where + ' 是 { type: "object" } 却没写 additionalProperties —— 宿主 defineTool 会抛 JsonSchemaError')
  }
  for (const [k, v] of Object.entries(node.properties || {})) checkSchemaNode(v, where + '.properties.' + k)
  if (node.items) checkSchemaNode(node.items, where + '.items')
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((v, i) => checkSchemaNode(v, where + '.' + key + '[' + i + ']'))
  }
}

/**
 * parameters 可能有两种形状，两种都要认（宿主 defineTool 会把 map 形状转成 JSON Schema）：
 *   ① JSON Schema 根：{ type:'object', properties:{…}, additionalProperties:… }
 *   ② 字段表：{ 字段名: { type, description, … } }
 */
function checkParameters(parameters, toolName) {
  const where = toolName + '.parameters'
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) return
  const looksLikeSchema = typeof parameters.type === 'string'
    || parameters.properties !== undefined
    || parameters.additionalProperties !== undefined
    || parameters.required !== undefined
  if (looksLikeSchema) { checkSchemaNode(parameters, where); return }
  for (const [k, v] of Object.entries(parameters)) checkSchemaNode(v, where + '.' + k)
}

// (b) 每个工具的 spec 完整 + (c) 参数 schema
for (const t of registered) {
  const n = (t && t.name) || '(无名)'
  const before = problems.length
  if (typeof t?.description !== 'string' || !t.description.trim()) problem(n + ' 缺 description（字符串）')
  if (typeof t?.execute !== 'function') problem(n + ' 的 execute 不是函数')
  if (typeof t?.parameters !== 'object' || t.parameters === null || Array.isArray(t.parameters)) {
    problem(n + ' 的 parameters 不是对象（现在是 ' + typeof t?.parameters + '）')
  } else {
    checkParameters(t.parameters, n)
  }
  if (problems.length === before) {
    const fields = Object.keys(t.parameters)
    ok(n + ' ok 字段=' + (fields.length ? fields.join(',') : '(无)'))
  }
}

/* ───────── ⑤ 能力等级闸门（tierRead 默认开；③④ 打开时 ① 视为生效） ───────── */
const READ_TOOLS = ['douyin_hot', 'douyin_search', 'douyin_video', 'douyin_comments', 'douyin_note']
const NOTIFY_TOOLS = ['douyin_notes', 'douyin_messages']
const byName = new Map(registered.map((t) => [t && t.name, t]))
/** 直接写沙箱里的 config.json（$DSH_HOME 已指到临时目录，不碰真家目录） */
const writeCfg = (obj) => {
  try { writeFileSync(join(SANDBOX_HOME, 'douyin-duty', 'config.json'), JSON.stringify(obj), 'utf8') } catch (e) { die('写沙箱 config.json 失败', e) }
}
const callTool = async (n, a) => {
  const t = byName.get(n)
  if (!t || typeof t.execute !== 'function') return { ok: false, reason: '工具不存在: ' + n }
  try { return await t.execute(a || {}) } catch (e) { return { ok: false, reason: 'execute 抛错: ' + String((e && e.message) || e) } }
}

// ① tierRead 关掉：四个只读工具都必须被闸门挡住（闸门在跑脚本之前，零子进程）
writeCfg({ tierRead: false })
for (const n of READ_TOOLS) {
  const r = await callTool(n, { url: 'https://www.douyin.com/video/1', keyword: 'k' })
  if (r && r.code === 'TIER_DISABLED' && r.tier === 'read' && typeof r.reason === 'string' && typeof r.hint === 'string') {
    ok(n + ' 被等级闸门挡住（TIER_DISABLED）')
  } else problem(n + ' 在 tierRead=false 时没被挡住：' + JSON.stringify(r))
}

// ② 基础四工具不受等级限制
const cfgWhileLocked = await callTool('douyin_config', { action: 'get' })
if (cfgWhileLocked && cfgWhileLocked.ok === true) ok('douyin_config 在 tierRead=false 时照常可用（基础工具不限等级）')
else problem('douyin_config 被等级闸门误伤：' + JSON.stringify(cfgWhileLocked))

// ③ tierRead 开回来 → 放行（拿参数校验当探针：它排在闸门之后、跑脚本之前）
writeCfg({ tierRead: true })
const hotOpen = await callTool('douyin_hot', { limit: 99 })
if (hotOpen && hotOpen.code !== 'TIER_DISABLED' && /limit/.test(String(hotOpen.reason || ''))) ok('tierRead=true 放行（走到参数校验这一步）')
else problem('tierRead=true 时没放行：' + JSON.stringify(hotOpen))

// ④ 依赖：③ 或 ④ 打开 → ① 视为生效（不改用户存的值）
writeCfg({ tierRead: false, tierReact: true })
const hotDerived = await callTool('douyin_hot', { limit: 99 })
if (hotDerived && hotDerived.code !== 'TIER_DISABLED') ok('tierReact(③A)=true 时 tierRead 视为生效')
else problem('tierReact=true 没让 tierRead 自动生效：' + JSON.stringify(hotDerived))

writeCfg({ tierRead: false, tierComment: true })
const hotDerived2 = await callTool('douyin_hot', { limit: 99 })
if (hotDerived2 && hotDerived2.code !== 'TIER_DISABLED') ok('tierComment(③B)=true 时 tierRead 视为生效')
else problem('tierComment=true 没让 tierRead 自动生效：' + JSON.stringify(hotDerived2))

// ⑤ tierNotify 关着：两个通知工具都必须被闸门挡住（② 通知独立于 ① 只读）
writeCfg({ tierRead: true, tierNotify: false })
for (const n of NOTIFY_TOOLS) {
  const r = await callTool(n, { limit: 5 })
  if (r && r.code === 'TIER_DISABLED' && r.tier === 'notify' && typeof r.reason === 'string' && typeof r.hint === 'string') {
    ok(n + ' 被等级闸门挡住（TIER_DISABLED / tier=notify）')
  } else problem(n + ' 在 tierNotify=false 时没被挡住：' + JSON.stringify(r))
}

// ⑥ tierNotify 开回来 → 放行（同样拿参数校验当探针：它排在闸门之后、跑脚本之前）
writeCfg({ tierRead: true, tierNotify: true })
const notesOpen = await callTool('douyin_notes', { limit: 99 })
if (notesOpen && notesOpen.code !== 'TIER_DISABLED' && /limit/.test(String(notesOpen.reason || ''))) {
  ok('tierNotify=true 放行 douyin_notes（走到参数校验这一步）')
} else problem('tierNotify=true 时没放行：' + JSON.stringify(notesOpen))
writeCfg({})

/* ───────── ⑥ 图文工具：存在 + 参数契约（① 只读） ───────── */
const noteTool = byName.get('douyin_note')
if (!noteTool || typeof noteTool.execute !== 'function') problem('少了工具：douyin_note')
else {
  const fields = Object.keys(noteTool.parameters || {})
  if (fields.join(',') !== 'url') problem('douyin_note 的参数应只有 url，现在是 ' + JSON.stringify(fields))
  else ok('douyin_note 存在（参数 url）')
}

/* ───────── ⑦ 登录工具：存在 + 参数契约（基础能力，不受等级限制） ───────── */
const loginStart = byName.get('douyin_login_start')
if (!loginStart || typeof loginStart.execute !== 'function') problem('少了工具：douyin_login_start')
else {
  const fields = Object.keys(loginStart.parameters || {})
  if (fields.join(',') !== 'mode') problem('douyin_login_start 的参数应只有 mode，现在是 ' + JSON.stringify(fields))
  else ok('douyin_login_start 存在（参数 mode）')
}

const loginPoll = byName.get('douyin_login_poll')
if (!loginPoll || typeof loginPoll.execute !== 'function') problem('少了工具：douyin_login_poll')
else {
  const fields = Object.keys(loginPoll.parameters || {})
  if (fields.length !== 0) problem('douyin_login_poll 不该有参数，现在是 ' + JSON.stringify(fields))
  else ok('douyin_login_poll 存在（无参数）')
}

/* ───────── ⑧ 谷时自动刷（douyin_duty）：无等级闸门 + action 参数 ───────── */
const dutyTool = byName.get('douyin_duty')
if (!dutyTool || typeof dutyTool.execute !== 'function') problem('少了工具：douyin_duty')
else {
  const fields = Object.keys(dutyTool.parameters || {})
  if (fields.join(',') !== 'action') problem('douyin_duty 的参数应只有 action，现在是 ' + JSON.stringify(fields))
  else ok('douyin_duty 存在（参数 action）')

  // 五个等级全关：基础能力照常可用（闸门不该覆盖它）
  writeCfg({ tierRead: false, tierNotify: false, tierReact: false, tierComment: false, tierPublish: false })
  const dst = await callTool('douyin_duty', { action: 'status' })
  if (dst && dst.ok === true && dst.code !== 'TIER_DISABLED') ok('douyin_duty 无等级闸门（五个等级全关也能 status）')
  else problem('douyin_duty 被等级闸门挡住了：' + JSON.stringify(dst))

  // 没有 duty.json 也要给默认值：todayScreens=0 / autoRun=false / 默认窗口解析正确
  if (dst && dst.todayScreens === 0 && dst.autoRun === false) ok('没有 duty.json 时 todayScreens=0 / autoRun=false')
  else problem('duty_status 的默认值不对：' + JSON.stringify(dst))
  if (dst && Array.isArray(dst.windows) && dst.windows.length === 2 && dst.windows[0] === '12:00-14:00' && typeof dst.inWindow === 'boolean') {
    ok('默认谷时窗口解析正确：' + JSON.stringify(dst.windows) + '（inWindow=' + dst.inWindow + '）')
  } else problem('谷时窗口解析不对：' + JSON.stringify(dst && dst.windows))

  const dhi = await callTool('douyin_duty', { action: 'history' })
  if (dhi && dhi.ok === true && Array.isArray(dhi.items)) ok('douyin_duty history 返回 items 数组（' + dhi.items.length + ' 条）')
  else problem('douyin_duty history 形状不对：' + JSON.stringify(dhi))
}

/* ───────── ⑨ 界面布局键：uiLayout（字符串，默认 classic）───────── */
const cfgLayoutSet = await callTool('douyin_config', { action: 'set', key: 'uiLayout', value: 'tabs' })
if (cfgLayoutSet && cfgLayoutSet.ok === true) ok('douyin_config 认得 uiLayout 这个键')
else problem('douyin_config 不认 uiLayout：' + JSON.stringify(cfgLayoutSet))
// get 走 cfgAll() → loadCfg()：读回来是 tabs 才说明真的落盘且读得回
const cfgLayoutGet = await callTool('douyin_config', { action: 'get' })
if (cfgLayoutGet && cfgLayoutGet.ok === true && cfgLayoutGet.config && cfgLayoutGet.config.uiLayout === 'tabs') {
  ok('set uiLayout=tabs 后 loadCfg 读回来是 tabs')
} else problem('uiLayout 存/读不一致：' + JSON.stringify(cfgLayoutGet && cfgLayoutGet.config && cfgLayoutGet.config.uiLayout))
writeCfg({})

/* ───────── ⑨-bis 浏览器通道键：browserChannel（默认 msedge）───────── */
// 先看缺省值：config.json 是空的，走 DEFAULTS / EXTRA_DEFAULTS 那一层
const cfgBrowserDefault = await callTool('douyin_config', { action: 'get' })
const dfltChannel = cfgBrowserDefault && cfgBrowserDefault.ok === true && cfgBrowserDefault.config
  ? cfgBrowserDefault.config.browserChannel
  : undefined
if (dfltChannel === 'msedge') ok('douyin_config 认得 browserChannel（默认 msedge）')
else problem('browserChannel 的默认值应为 msedge，现在是 ' + JSON.stringify(dfltChannel))

const cfgBrowserSet = await callTool('douyin_config', { action: 'set', key: 'browserChannel', value: 'chrome' })
if (cfgBrowserSet && cfgBrowserSet.ok === true) ok('douyin_config 认 browserChannel 这个键（set chrome 没被当未知键拒掉）')
else problem('douyin_config 不认 browserChannel：' + JSON.stringify(cfgBrowserSet))
// get 走 cfgAll() → loadCfg()：读回来是 chrome 才说明真的落盘且读得回
const cfgBrowserGet = await callTool('douyin_config', { action: 'get' })
if (cfgBrowserGet && cfgBrowserGet.ok === true && cfgBrowserGet.config && cfgBrowserGet.config.browserChannel === 'chrome') {
  ok('set browserChannel=chrome 后 loadCfg 读回来是 chrome')
} else problem('browserChannel 存/读不一致：' + JSON.stringify(cfgBrowserGet && cfgBrowserGet.config && cfgBrowserGet.config.browserChannel))
writeCfg({})

/* ───────── ⑨-ter 扩展内核：五个取值 + douyin_status.browsers ───────── */
const FIVE = ['msedge', 'chrome', 'chromium', 'firefox', 'webkit']
const channels = Array.isArray(mod.BROWSER_CHANNELS) ? mod.BROWSER_CHANNELS : []
if (channels.length === FIVE.length && FIVE.every((k) => channels.includes(k))) ok('BROWSER_CHANNELS 是五个取值：' + channels.join(' / '))
else problem('BROWSER_CHANNELS 不是五个取值：' + JSON.stringify(channels))

// 规整：五个值原样返回，未知值仍按 msedge（不认识的通道不能把脚本带偏）
const normBad = typeof mod.browserChannelOf === 'function' ? mod.browserChannelOf({ browserChannel: 'not-a-channel' }) : null
if (normBad === 'msedge') ok('browserChannelOf 把未知值规整成 msedge')
else problem('browserChannelOf 没把未知值规整成 msedge：' + JSON.stringify(normBad))
const normKept = FIVE.filter((k) => typeof mod.browserChannelOf === 'function' && mod.browserChannelOf({ browserChannel: k }) !== k)
if (normKept.length === 0) ok('browserChannelOf 原样保留五个合法取值')
else problem('browserChannelOf 把合法值改掉了：' + JSON.stringify(normKept))

// 新增的两个内核能存能读（旧宿主只认三个，这里就是回归点）
for (const ch of ['firefox', 'webkit']) {
  const setR = await callTool('douyin_config', { action: 'set', key: 'browserChannel', value: ch })
  const getR = await callTool('douyin_config', { action: 'get' })
  const now = getR && getR.ok === true && getR.config ? getR.config.browserChannel : undefined
  if (setR && setR.ok === true && now === ch) ok('browserChannel 认得 ' + ch + '（存进去、读回来都是它）')
  else problem('browserChannel 不认 ' + ch + '：读回来是 ' + JSON.stringify(now))
}
writeCfg({})

/* 手动添加的浏览器 browserExtras：JSON 数组字符串（用字符串存，避开旧宿主的数组类型兼容问题） */
const cfgExtrasDefault = await callTool('douyin_config', { action: 'get' })
const extrasDflt = cfgExtrasDefault && cfgExtrasDefault.ok === true && cfgExtrasDefault.config ? cfgExtrasDefault.config.browserExtras : undefined
if (extrasDflt === '[]') ok('douyin_config 认得 browserExtras（默认字符串 []）')
else problem('browserExtras 的默认值应为字符串 "[]"，现在是 ' + JSON.stringify(extrasDflt))

// 坏 JSON 必须被吞掉（绝不抛），好 JSON 要能解析出 id / label / path
let badParse = null
try { badParse = mod.parseBrowserExtras('{不是 JSON') } catch (e) { badParse = 'THREW: ' + e.message }
if (Array.isArray(badParse) && badParse.length === 0) ok('parseBrowserExtras 把坏 JSON 吞成空数组（不抛）')
else problem('parseBrowserExtras 遇到坏 JSON 没吞掉：' + JSON.stringify(badParse))
const goodParse = typeof mod.parseBrowserExtras === 'function'
  ? mod.parseBrowserExtras(JSON.stringify([{ id: 'custom-1', label: '公司装的 Chrome', path: 'C:/x/chrome.exe' }, { id: 'custom-2', path: '' }]))
  : null
if (Array.isArray(goodParse) && goodParse.length === 1 && goodParse[0].id === 'custom-1' && goodParse[0].label === '公司装的 Chrome' && goodParse[0].path === 'C:/x/chrome.exe') {
  ok('parseBrowserExtras 解析出 id / label / path（没 path 的项被丢掉）')
} else problem('parseBrowserExtras 解析不对：' + JSON.stringify(goodParse))

const cfgExtrasSet = await callTool('douyin_config', { action: 'set', key: 'browserExtras', value: JSON.stringify([{ id: 'custom-1', label: '自定义 A', path: 'C:/x/a.exe' }]) })
const cfgExtrasGet = await callTool('douyin_config', { action: 'get' })
const extrasBack = cfgExtrasGet && cfgExtrasGet.ok === true && cfgExtrasGet.config ? cfgExtrasGet.config.browserExtras : undefined
if (cfgExtrasSet && cfgExtrasSet.ok === true && extrasBack === JSON.stringify([{ id: 'custom-1', label: '自定义 A', path: 'C:/x/a.exe' }])) {
  ok('set browserExtras 后 loadCfg 原样读回来')
} else problem('browserExtras 存/读不一致：' + JSON.stringify(extrasBack))

// douyin_status.browsers：五个布尔值 + extras 数组（每项 { id, label, path, exists }）
const stProbe = await callTool('douyin_status', {})
const br = stProbe && stProbe.browsers
const extrasOk = !!br && Array.isArray(br.extras)
  && br.extras.length === 1
  && br.extras[0].id === 'custom-1' && br.extras[0].label === '自定义 A'
  && br.extras[0].path === 'C:/x/a.exe' && br.extras[0].exists === false
if (br && typeof br === 'object' && !Array.isArray(br) && FIVE.every((k) => typeof br[k] === 'boolean')) {
  ok('douyin_status.browsers 五个内核都是布尔值：' + JSON.stringify(FIVE.reduce((o, k) => ({ ...o, [k]: br[k] }), {})))
} else problem('douyin_status.browsers 形状不对（应五个布尔值）：' + JSON.stringify(br))
if (extrasOk) ok('douyin_status.browsers.extras 带 id / label / path / exists（不存在的路径 exists=false）')
else problem('douyin_status.browsers.extras 不对：' + JSON.stringify(br && br.extras))
writeCfg({})

/* ───────── ⑨-quater 自定义浏览器：argv 走 --browser-executable ───────── */
// 造一个真实存在的 exe 桩：existsSync 为真才会下发 --browser-executable
const fakeExe = join(SANDBOX_HOME, 'fake-chrome.exe')
try { writeFileSync(fakeExe, 'stub', 'utf8') } catch { /* 写不出来下面的断言会自己报 */ }
const RB = (o) => (typeof mod.resolveBrowser === 'function' ? mod.resolveBrowser(o) : null)

// h. 自定义项路径存在 → ['--browser-executable', path]，且绝不带 --browser-channel
const rbH = RB({ browserChannel: 'custom-1', browserExtras: JSON.stringify([{ id: 'custom-1', label: '假 Chrome', path: fakeExe }]) })
const argvH = (rbH && Array.isArray(rbH.argv)) ? rbH.argv : null
if (argvH && argvH.length === 2 && argvH[0] === '--browser-executable' && argvH[1] === fakeExe && !argvH.includes('--browser-channel')) {
  ok('自定义浏览器走 --browser-executable（不带 --browser-channel）：' + JSON.stringify(argvH))
} else problem('自定义浏览器的 argv 不对：' + JSON.stringify(rbH))

// 快捷方式扫出来的项：值就是一个 exe 路径 → 同一套 argv
const rbH2 = RB({ browserChannel: fakeExe, browserExtras: '[]' })
if (rbH2 && rbH2.argv && rbH2.argv[0] === '--browser-executable' && rbH2.argv[1] === fakeExe) {
  ok('值是 exe 路径时也走 --browser-executable：' + JSON.stringify(rbH2.argv))
} else problem('exe 路径值没走 --browser-executable：' + JSON.stringify(rbH2))

// 已知内核仍然走 --browser-channel
const rbK = RB({ browserChannel: 'firefox', browserExtras: '[]' })
if (rbK && rbK.argv && rbK.argv[0] === '--browser-channel' && rbK.argv[1] === 'firefox') ok('已知内核仍走 --browser-channel firefox')
else problem('已知内核的 argv 不对：' + JSON.stringify(rbK))

// i. 自定义 id 不存在 / 路径不存在 → 一个浏览器参数都不传，但要有 note（绝不静默变 Edge）
let rbI = null
try { rbI = RB({ browserChannel: 'custom-9', browserExtras: '[]' }) } catch (e) { rbI = 'THREW: ' + e.message }
if (rbI && rbI !== 'THREW' && Array.isArray(rbI.argv) && rbI.argv.length === 0 && typeof rbI.note === 'string' && rbI.note) {
  ok('browserChannel 指向不存在的自定义 id → 不传参数 + note：' + rbI.note)
} else problem('不存在的自定义 id 处理不对：' + JSON.stringify(rbI))
const rbI2 = RB({ browserChannel: 'custom-1', browserExtras: JSON.stringify([{ id: 'custom-1', label: '没了', path: join(SANDBOX_HOME, 'nope.exe') }]) })
if (rbI2 && Array.isArray(rbI2.argv) && rbI2.argv.length === 0 && typeof rbI2.note === 'string' && rbI2.note) {
  ok('自定义项路径不存在 → 不传参数 + note：' + rbI2.note)
} else problem('路径不存在的自定义项处理不对：' + JSON.stringify(rbI2))

// douyin_status 要把这件事说清楚（browserNote），而且不许抛
writeCfg({ browserChannel: 'custom-9', browserExtras: '[]' })
const stNote = await callTool('douyin_status', {})
if (stNote && typeof stNote.browserNote === 'string' && stNote.browserNote) ok('douyin_status.browserNote 说清了回退原因：' + stNote.browserNote)
else problem('douyin_status.browserNote 是空的 / 没这个字段：' + JSON.stringify(stNote && stNote.browserNote))
// 正常配置（msedge）时 browserNote 是空串，不打扰
writeCfg({ browserChannel: 'msedge', browserExtras: '[]' })
const stClean = await callTool('douyin_status', {})
if (stClean && stClean.browserNote === '') ok('browserChannel=msedge 时 browserNote 是空串')
else problem('msedge 时 browserNote 应为空串：' + JSON.stringify(stClean && stClean.browserNote))

/* ───────── ⑨-quinquies 快捷方式扫描：名单过滤 + 去重 ───────── */
const SB = (rows) => (typeof mod.shortcutBrowsers === 'function' ? mod.shortcutBrowsers(rows) : null)
// k. chrome.exe 留下、wechat.exe 丢掉
const filtered = SB([
  { name: 'Google Chrome', path: 'C:/Users/u/Desktop/chrome.exe' },
  { name: '微信', path: 'C:/Users/u/Desktop/wechat.exe' },
  { name: 'QQ', path: 'C:/Users/u/Desktop/QQ.exe' },
])
if (Array.isArray(filtered) && filtered.length === 1 && /chrome/i.test(filtered[0].path)) {
  ok('快捷方式按名单过滤：chrome 留下，wechat / QQ 丢掉（' + JSON.stringify(filtered) + '）')
} else problem('快捷方式没过名单：' + JSON.stringify(filtered))

// 同路径两条 → 只留一条
const dedup = SB([
  { name: 'Chrome', path: 'C:/a/chrome.exe' },
  { name: 'Chrome 快捷方式', path: 'C:/A/Chrome.exe' },
])
if (Array.isArray(dedup) && dedup.length === 1) ok('同一路径的快捷方式只留一条（大小写不敏感）')
else problem('快捷方式去重不对：' + JSON.stringify(dedup))

// l. 同路径既被已知安装路径命中、又被快捷方式命中 → 只出现一次
const merged = typeof mod.mergeShortcutList === 'function'
  ? mod.mergeShortcutList([{ name: 'Chrome', path: 'C:/a/chrome.exe' }, { name: 'Firefox', path: 'C:/a/firefox.exe' }], { chrome: 'C:/a/chrome.exe' })
  : null
if (Array.isArray(merged) && merged.length === 1 && /firefox/i.test(merged[0].path)) {
  ok('已知安装路径已命中的那条不再重复出现（只剩 firefox）')
} else problem('已知路径与快捷方式没去重：' + JSON.stringify(merged))

// browsers.shortcuts 永远是数组（扫不到 / 非 Windows 时是空数组，不是 undefined）
const stShort = await callTool('douyin_status', {})
if (stShort && stShort.browsers && Array.isArray(stShort.browsers.shortcuts)) {
  ok('douyin_status.browsers.shortcuts 是数组（' + stShort.browsers.shortcuts.length + ' 条）')
} else problem('douyin_status.browsers.shortcuts 不是数组：' + JSON.stringify(stShort && stShort.browsers && stShort.browsers.shortcuts))
writeCfg({})

/* ───────── ⑩ 结论 ───────── */
if (problems.length > failCountBefore) {
  console.error('')
  console.error('✗ 预检失败：' + (problems.length - failCountBefore) + ' 处问题（上面的 ✗ 行）')
  cleanup()
  process.exit(1)
}

console.log('')
console.log('✓ 预检通过：' + registered.length + ' 个工具')
for (const n of names) console.log('    - ' + n)
console.log('（不碰真家目录：本次 DSH_HOME = ' + SANDBOX_HOME + '）')
cleanup()
process.exit(0)
