#!/usr/bin/env node
/**
 * selfcheck.mjs —— 本地预检：用**假 ctx 真跑一次 apply()**，把"重启后才发现 entry did not activate"
 * 那类错误提前在本地暴露出来（宿主只会留一句 warning，日志里看不出根因）。
 *
 * 查什么：
 *   a. 恰好注册 13 个工具：douyin_scroll / douyin_transcribe / douyin_status / douyin_config
 *      + douyin_hot / douyin_search / douyin_video / douyin_comments / douyin_note（只读查询）
 *      + douyin_notes / douyin_messages（② 通知，只读）
 *      + douyin_login_start / douyin_login_poll（登录，基础能力不设等级闸门）
 *   b. 每个工具都有 description(string) / parameters(对象) / execute(function)
 *   c. 参数 schema 里 type:'object' 的节点必须显式写 additionalProperties
 *      （宿主的 defineTool 会抛 JsonSchemaError ⇒ 整条插件不激活）
 *   d. 模块导出 name === 'douyin-audio'，inject 含 'tools'
 *   e. 能力等级闸门：tierRead=false 时五个只读工具（含图文 douyin_note）返回 TIER_DISABLED；
 *      开回来后放行；tierInteract=true 时 tierRead 视为生效；基础四工具不受限；
 *      tierNotify=false 时 douyin_notes / douyin_messages 返回 TIER_DISABLED(tier=notify)，
 *      打开后放行（② 通知与 ① 只读互相独立）
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
writeCfg({ tierRead: false, tierInteract: true })
const hotDerived = await callTool('douyin_hot', { limit: 99 })
if (hotDerived && hotDerived.code !== 'TIER_DISABLED') ok('tierInteract=true 时 tierRead 视为生效')
else problem('tierInteract=true 没让 tierRead 自动生效：' + JSON.stringify(hotDerived))

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

/* ───────── ⑧ 结论 ───────── */
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
