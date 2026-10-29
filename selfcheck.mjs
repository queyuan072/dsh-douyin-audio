#!/usr/bin/env node
/**
 * selfcheck.mjs —— 本地预检：用**假 ctx 真跑一次 apply()**，把"重启后才发现 entry did not activate"
 * 那类错误提前在本地暴露出来（宿主只会留一句 warning，日志里看不出根因）。
 *
 * 查什么：
 *   a. 恰好注册 16 个工具：douyin_scroll / douyin_transcribe / douyin_status / douyin_config
 *      + douyin_hot / douyin_search / douyin_video / douyin_comments / douyin_note（只读查询）
 *      + douyin_notes / douyin_messages（② 通知，只读）
 *      + douyin_react（③A 轻互动：点赞 / 收藏 / 取消，**写操作**，默认关）
 *      + douyin_login_start / douyin_login_poll（登录，基础能力不设等级闸门）
 *      + douyin_duty（谷时自动刷，基础能力不设等级闸门）
 *      + douyin_setup（装入配置环境：auto 扫描→复用或装 venv，基础能力不设等级闸门）
 *   b. 每个工具都有 description(string) / parameters(对象) / execute(function)
 *   c. 参数 schema 里 type:'object' 的节点必须显式写 additionalProperties
 *      （宿主的 defineTool 会抛 JsonSchemaError ⇒ 整条插件不激活）
 *   d. 模块导出 name === 'douyin-audio'，inject 含 'tools'
 *   e. 能力等级闸门：tierRead=false 时五个只读工具（含图文 douyin_note）返回 TIER_DISABLED；
 *      开回来后放行；tierReact/tierComment=true 时 tierRead 视为生效；基础四工具不受限；
 *      tierNotify=false 时 douyin_notes / douyin_messages 返回 TIER_DISABLED(tier=notify)，
 *      打开后放行（② 通知与 ① 只读互相独立）；
 *      tierReact=false 时 douyin_react 返回 TIER_DISABLED(tier=react)，打开后放行到参数校验，
 *      再用桩掉的 runPython 断言 argv 里真拼了动作与 url；
 *      五个等级**全关**时基础工具（douyin_config / douyin_login_poll / douyin_duty）都不受影响；
 *      **能力等级只能由用户在设置页改**：douyin_config set tier* 一律被拒（agent 不许自己解锁）
 *   g. 浏览器通道 browserChannel：douyin_config 认得这个键，缺省是 msedge；五个取值
 *      msedge / chrome / chromium / firefox / webkit 都认，未知值仍规整成 msedge；
 *      douyin_status 的 browsers 是五个布尔值 + extras 数组（{id,label,path,exists}），
 *      给设置页「只列检测到的浏览器」用；browserExtras 是 JSON 数组字符串，坏 JSON 一律当 []
 *   f. 谷时自动刷 douyin_duty：只认一个 action 参数；**没有任何等级闸门**
 *      （五个等级全关时 action=status 也照常返回 ok:true）；没有 duty.json 时 todayScreens=0、
 *      autoRun 默认 false、windows 按默认窗口解析；action=history 返回 items 数组
 *   h. 装入配置环境 douyin_setup：只认一个 mode 参数（auto / scan / minimal / full / minimal-force /
 *      full-force）；**没有任何等级闸门**（五个等级全关也能调）；脚本不存在时给明确 reason；
 *      脚本存在（测试缝换成桩）时 minimal/full/minimal-force 走**后台派生**（--mode / --force-venv 透传、
 *      返回 started:true），MCP 调用的 scan / auto 走**前台同步**；HTTP 的 setup_auto 走**后台派生**
 *      （立刻回 started:true，结果读 env.setupResult）、setup_scan 前台回 inventory、setup_start 透传 mode；
 *      douyin_status 返回体带 env 对象（venv / venvPython / venvUsable / basePython / playwright / sherpa /
 *      canReusePython / setupLog / setupLogTail / setupRunning / setupResult），venv 探测同一次运行只探一次
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
  'douyin_react',
  'douyin_login_start', 'douyin_login_poll',
  'douyin_duty',
  'douyin_setup',
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
/** 捕获 /api/douyin-audio 的路由处理函数（断言 HTTP 分支用：setup_auto 必须走后台派生） */
let webRoute = null
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
  webServer: { register: (route) => { webRoute = route && route.handler ? route.handler : null; return { dispose() {} } } },
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

/* ───────── ⑦-bis 轻互动 douyin_react：存在 + 参数契约 + ③A 闸门 + argv ───────── */
const setReactDeps = (o) => (typeof mod.__reactDeps === 'function' ? mod.__reactDeps(o) : null)
if (typeof mod.__reactDeps !== 'function') problem('index.js 没导出 __reactDeps 测试缝（argv 没法断言）')
const reactTool = byName.get('douyin_react')
if (!reactTool || typeof reactTool.execute !== 'function') problem('少了工具：douyin_react')
else {
  const fields = Object.keys(reactTool.parameters || {})
  if (fields.join(',') !== 'url,action') problem('douyin_react 的参数应是 url + action，现在是 ' + JSON.stringify(fields))
  else ok('douyin_react 存在（参数 url + action）')

  // ③A 默认关：先被闸门挡住（闸门在跑脚本之前，零子进程）
  writeCfg({ tierRead: true, tierReact: false })
  const reactClosed = await callTool('douyin_react', { url: 'https://www.douyin.com/video/1', action: 'like' })
  if (reactClosed && reactClosed.code === 'TIER_DISABLED' && reactClosed.tier === 'react'
    && typeof reactClosed.reason === 'string' && typeof reactClosed.hint === 'string') {
    ok('tierReact=false 时 douyin_react 返回 TIER_DISABLED(tier=react)')
  } else problem('tierReact=false 时 douyin_react 没被挡住：' + JSON.stringify(reactClosed))

  // 五个等级全关：别的工具不受影响（基础工具本来就不设闸门）
  writeCfg({ tierRead: false, tierNotify: false, tierReact: false, tierComment: false, tierPublish: false })
  const cfgLocked = await callTool('douyin_config', { action: 'get' })
  const pollLocked = await callTool('douyin_login_poll', {})
  if (cfgLocked && cfgLocked.ok === true && pollLocked && pollLocked.code !== 'TIER_DISABLED') {
    ok('五个等级全关时 douyin_config / douyin_login_poll 照常可用')
  } else problem('五个等级全关时别的工具被误伤：' + JSON.stringify([cfgLocked, pollLocked]))

  // tierReact 打开 → 放行（拿参数校验当探针：它排在闸门之后、跑脚本之前）
  writeCfg({ tierReact: true })
  const badUrl = await callTool('douyin_react', { url: 'not-a-url', action: 'like' })
  if (badUrl && badUrl.code !== 'TIER_DISABLED' && /url/.test(String(badUrl.reason || ''))) {
    ok('tierReact=true 放行（url 非法时走到参数校验）')
  } else problem('tierReact=true 时没放行：' + JSON.stringify(badUrl))

  // 能力等级只能由用户在设置页改：douyin_config 必须**拒绝** tier*（agent 自己解锁 = 闸门白设）
  writeCfg({})
  const setReact = await callTool('douyin_config', { action: 'set', key: 'tierReact', value: 'true' })
  const getReact = await callTool('douyin_config', { action: 'get' })
  const reactNow = getReact && getReact.ok === true && getReact.config ? getReact.config.tierReact : undefined
  if (setReact && setReact.ok === false && /能力等级只能由用户在设置页修改/.test(String(setReact.error || ''))) {
    ok('douyin_config set tierReact=true 被拒：' + setReact.error)
  } else problem('douyin_config 居然改动了能力等级：' + JSON.stringify(setReact))
  if (reactNow !== true) ok('被拒之后 loadCfg 里 tierReact 还是 ' + JSON.stringify(reactNow) + '（没被偷偷写进去）')
  else problem('tierReact 被写进 config.json 了：' + JSON.stringify(reactNow))
  const setTierRead = await callTool('douyin_config', { action: 'set', key: 'tierRead', value: 'false' })
  if (setTierRead && setTierRead.ok === false && /能力等级/.test(String(setTierRead.error || ''))) {
    ok('douyin_config set tierRead=false 同样被拒（所有 tier* 一视同仁）')
  } else problem('tierRead 没被拒：' + JSON.stringify(setTierRead))
  // 后面几条断言要闸门是开着的：直接写 config.json（等价于用户在设置页把开关点开，不是 agent 那条路）
  writeCfg({ tierRead: true, tierReact: true })

  const badAction = await callTool('douyin_react', { url: 'https://www.douyin.com/video/1', action: 'zap' })
  if (badAction && badAction.code !== 'TIER_DISABLED' && /action/.test(String(badAction.reason || ''))) {
    ok('action 不在四个取值内被拒（like / unlike / collect / uncollect）')
  } else problem('非法 action 没被拒：' + JSON.stringify(badAction))

  // 桩掉「找 Python + 跑脚本」：断言工具层真拼了 argv（含动作与 url），不真起浏览器
  const stubScript = join(SANDBOX_HOME, 'douyin_action_stub.py')
  try { writeFileSync(stubScript, '# stub：selfcheck 只拿来过 existsSync\n', 'utf8') } catch { /* 写不出来下面的断言会自己报 */ }
  const seenArgv = []
  setReactDeps({
    script: stubScript,
    python: async () => 'stub-python',
    run: async (python, script, argv, opts) => {
      seenArgv.push({ python, script, argv: argv.slice(), timeoutSec: opts && opts.timeoutSec })
      return {
        ok: true, code: 0, stderr: '',
        stdout: JSON.stringify({ ok: true, action: 'like', before: 1671, after: 1672, changed: true, state: 'liked', needLogin: false }),
      }
    },
  })
  writeCfg({ tierReact: true, browserChannel: 'msedge' })
  const REACT_URL = 'https://www.douyin.com/video/123456'
  const reactRan = await callTool('douyin_react', { url: REACT_URL, action: 'like' })
  const lastCall = seenArgv.length ? seenArgv[seenArgv.length - 1] : null
  const lastArgv = lastCall ? lastCall.argv : []
  if (lastArgv[lastArgv.indexOf('--action') + 1] === 'like' && lastArgv[lastArgv.indexOf('--url') + 1] === REACT_URL
    && lastArgv.includes('--json')) {
    ok('桩掉 runPython：argv 带 --action like 与 --url → ' + JSON.stringify(lastArgv))
  } else problem('douyin_react 的 argv 不对：' + JSON.stringify(lastArgv))
  if (reactRan && reactRan.ok === true && reactRan.before === 1671 && reactRan.after === 1672
    && reactRan.changed === true && reactRan.state === 'liked' && reactRan.needLogin === false && reactRan.exitCode === 0) {
    ok('脚本 JSON 原样透出（ok / action / before / after / changed / state / needLogin）')
  } else problem('douyin_react 没把脚本 JSON 透出：' + JSON.stringify(reactRan))

  // 只读那套参数照样生效：readHeadless=false → --no-headless；verifyWait=30 → --verify-wait 30 + 预算加时
  writeCfg({ tierReact: true, readHeadless: false, verifyWait: 30 })
  await callTool('douyin_react', { url: REACT_URL, action: 'collect' })
  const argvOpt = seenArgv.length ? seenArgv[seenArgv.length - 1].argv : []
  const budget = seenArgv.length ? seenArgv[seenArgv.length - 1].timeoutSec : 0
  if (argvOpt[argvOpt.indexOf('--action') + 1] === 'collect' && argvOpt.includes('--no-headless')
    && argvOpt[argvOpt.indexOf('--verify-wait') + 1] === '30' && budget >= 150 + 30 + 15) {
    ok('沿用 runRead 那套参数：' + JSON.stringify(argvOpt) + '（预算 ' + budget + 's）')
  } else problem('douyin_react 没沿用 readHeadless / verifyWait：' + JSON.stringify(argvOpt) + ' 预算 ' + budget)

  // 复位测试缝：生产路径回到 scripts/douyin_action.py + findPython + runPython
  const depReset = setReactDeps({ script: null, python: null, run: null })
  if (depReset && depReset.stubbed === false && /douyin_action\.py$/.test(String(depReset.script))) ok('测试缝已复位（生产路径 = 真 runPython）')
  else problem('测试缝没复位：' + JSON.stringify(depReset))
  writeCfg({})
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

/* ───────── ⑧-bis 装入配置环境 douyin_setup：无闸门 + mode 透传 + HTTP 后台派生 + status.env ───────── */
const setupTool = byName.get('douyin_setup')
if (!setupTool || typeof setupTool.execute !== 'function') problem('少了工具：douyin_setup')
else {
  const fields = Object.keys(setupTool.parameters || {})
  if (fields.join(',') !== 'mode') problem('douyin_setup 的参数应只有 mode，现在是 ' + JSON.stringify(fields))
  else ok('douyin_setup 存在（参数 mode）')

  const setSetupDeps = (o) => (typeof mod.__setupDeps === 'function' ? mod.__setupDeps(o) : null)
  if (typeof mod.__setupDeps !== 'function') problem('index.js 没导出 __setupDeps 测试缝（argv 没法断言）')

  // 五个等级全关：基础能力照常可用；mode 非法也只会撞参数校验，不许被闸门挡
  writeCfg({ tierRead: false, tierNotify: false, tierReact: false, tierComment: false, tierPublish: false })
  const setupNoGate = await callTool('douyin_setup', { mode: 'bogus' })
  if (setupNoGate && setupNoGate.code !== 'TIER_DISABLED' && /mode 只能是/.test(String(setupNoGate.reason))) {
    ok('douyin_setup 无等级闸门（五个等级全关也能调）')
  } else problem('douyin_setup 被等级闸门挡住了：' + JSON.stringify(setupNoGate))
  for (const want of ['auto', 'scan', 'minimal', 'full', 'minimal-force', 'full-force']) {
    if (!String((setupNoGate && setupNoGate.reason) || '').includes(want)) problem('douyin_setup 的 mode 列表里少了 ' + want)
  }

  // 脚本不存在 → 明确 reason（先换脚本缝，绝不碰真的 scripts/douyin_setup.py）
  const noSetupScript = join(SANDBOX_HOME, 'no-such-setup.py')
  setSetupDeps({ script: noSetupScript })
  const setupNoScript = await callTool('douyin_setup', { mode: 'minimal' })
  if (setupNoScript && setupNoScript.ok === false && /安装脚本不存在/.test(String(setupNoScript.reason))) {
    ok('脚本不存在时给明确 reason（' + String(setupNoScript.reason).slice(0, 40) + '…）')
  } else problem('脚本不存在时没说清：' + JSON.stringify(setupNoScript))

  // 桩脚本 + 桩派生：后台派生只调一次、mode 透传、返回 started:true
  const stubSetup = join(SANDBOX_HOME, 'stub_setup.py')
  try { writeFileSync(stubSetup, '# stub\n', 'utf8') } catch (e) { die('写桩安装脚本失败', e) }
  const setupSpawned = []
  setSetupDeps({ script: stubSetup, spawn: async (py, script, argv) => { setupSpawned.push({ py, script, argv }); return { ok: true, pid: 4242 } } })
  const setupStarted = await callTool('douyin_setup', { mode: 'full' })
  if (setupStarted && setupStarted.started === true && setupSpawned.length === 1) ok('后台派生被调用一次，返回 started:true')
  else problem('后台派生没按预期：' + JSON.stringify(setupStarted) + ' 次数=' + setupSpawned.length)
  const setupFullArgv = setupSpawned.length ? setupSpawned[0].argv : []
  if (setupFullArgv[setupFullArgv.indexOf('--mode') + 1] === 'full') ok('mode=full 透传 --mode full')
  else problem('mode=full 没透传：' + JSON.stringify(setupFullArgv))
  if (setupStarted && /setup\.log$/.test(String(setupStarted.log))) ok('返回里带安装日志：' + setupStarted.log)
  else problem('返回里没有 setup.log 路径：' + JSON.stringify(setupStarted && setupStarted.log))

  setupSpawned.length = 0
  await callTool('douyin_setup', { mode: 'minimal-force' })
  const setupForceArgv = setupSpawned.length ? setupSpawned[0].argv : []
  if (setupForceArgv.includes('--force-venv') && setupForceArgv[setupForceArgv.indexOf('--mode') + 1] === 'minimal') {
    ok('mode=minimal-force 透传 --mode minimal --force-venv')
  } else problem('minimal-force 没透传 --force-venv：' + JSON.stringify(setupForceArgv))
  setupSpawned.length = 0

  // MCP 调的 scan / auto 走前台同步：一个后台进程都不许派生
  const setupFront = []
  const scanEnvelope = {
    ok: true, mode: 'scan',
    pythons: [{ path: 'C:\\stub\\python.exe', version: '3.12.14', source: 'dsh-runtimes', usable: true, hasPlaywright: true, hasSherpa: true }],
    ffmpeg: { path: null, ok: false, source: null },
    model: { path: null, ok: false, source: null },
    cookie: { path: '', exists: false, count: 0 },
    verdict: { canReusePython: true, reusePath: 'C:\\stub\\python.exe', reuseReason: '桩', missing: ['ffmpeg'] },
  }
  const foregroundSeam = async (script, argv) => {
    setupFront.push(argv)
    return argv.includes('--scan') ? scanEnvelope : { ok: true, mode: 'auto', action: 'reused', python: 'C:\\stub\\python.exe', version: '3.12.14', playwright: true, sherpa: true }
  }
  setSetupDeps({ script: stubSetup, run: foregroundSeam })
  const setupScan = await callTool('douyin_setup', { mode: 'scan' })
  if (setupScan && setupScan.mode === 'scan' && setupScan.canReusePython === true && setupSpawned.length === 0) {
    ok('工具调 mode=scan 走前台同步（没派生后台进程），回 inventory')
  } else problem('scan 没走前台：' + JSON.stringify(setupScan))
  if (setupFront.length === 1 && setupFront[0].includes('--scan') && setupFront[0].includes('--log')) ok('scan 的 argv 是 --scan --json --log <setup.log>')
  else problem('scan argv 不对：' + JSON.stringify(setupFront))
  const setupAuto = await callTool('douyin_setup', { mode: 'auto' })
  if (setupAuto && setupAuto.action === 'reused' && setupSpawned.length === 0) ok('工具调 mode=auto 走前台同步并回 action=reused')
  else problem('auto 没走前台 / 没回 action：' + JSON.stringify(setupAuto))

  // HTTP：setup_auto 必须**后台派生**（几分钟的长请求会被宿主 HTTP 掐断，掐断后用户看到失败、脚本其实还在跑）
  const frontBefore = setupFront.length
  const spawnedHttp = []
  setSetupDeps({
    script: stubSetup,
    spawn: async (py, script, argv) => { spawnedHttp.push({ py, script, argv }); return { ok: true, pid: 777 } },
    run: async (script, argv) => {
      if (argv.includes('--scan')) return scanEnvelope
      throw new Error('setup_auto 不该走前台 runPython')
    },
  })
  /* 打路由：默认按「浏览器同源请求」发（同源门要 Sec-Fetch-Site / Origin / token 三选一），
     headers 显式给就能构造跨站 / 无 Origin / 带 token 的请求。返回 { status, body }。 */
  const routeRaw = (method, url, body, headers) => new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: headers || { host: '127.0.0.1:59944', 'sec-fetch-site': 'same-origin' },
      on(ev, fn) {
        if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') fn()
        return this
      },
    }
    let out = null
    const res = { statusCode: 0, setHeader() {}, end(text) { try { out = JSON.parse(text) } catch { out = text } } }
    Promise.resolve(webRoute(req, res)).then(
      () => resolve({ status: res.statusCode, body: out }),
      (e) => resolve({ status: res.statusCode, body: { error: String((e && e.message) || e) } }),
    )
  })
  /* 老用法：只要 body（同源 setup_* 那几条断言照旧） */
  const callRoute = async (method, url, body) => (await routeRaw(method, url, body)).body
  if (typeof webRoute !== 'function') problem('没捕获到 /api/douyin-audio 路由')
  else {
    /* ── 同源门（C1）：不同源又没有 token 的请求必须先 403，且**动作不执行** ── */
    const HOST = '127.0.0.1:59944'
    const bareH = { host: HOST }                                     // curl / 本地进程：没有 Origin 也没有 Sec-Fetch-Site
    const evilH = { host: HOST, origin: 'https://evil.example' }     // 审查报告里复现的那个请求
    const evilSiteH = { host: HOST, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
    const sameH = { host: HOST, 'sec-fetch-site': 'same-origin' }    // 设置页真正发的形状

    // a. 既无 Origin 也无 Sec-Fetch-Site → 放行（Electron 桥接/本机进程的形状；
    //    DSH 设置页就是这么发的，拦了会 403 —— 真实踩过）
    const bareRun = await routeRaw('POST', '/api/douyin-audio/run', { action: 'duty_status' }, bareH)
    if (bareRun.status === 200 && bareRun.body && bareRun.body.ok === true) {
      ok('POST /run 不带 Origin / Sec-Fetch-Site → 放行（设置页与桥接通道需要这条路）')
    } else problem('无跨站证据的 POST /run 被误拦：' + JSON.stringify(bareRun))

    // b. 跨站 Origin → 403（没有 Sec-Fetch-Site 也一样）
    const evilRun = await routeRaw('POST', '/api/douyin-audio/run', { action: 'duty_status' }, evilH)
    if (evilRun.status === 403) ok('POST /run 带 Origin: https://evil.example → 403')
    else problem('跨站 Origin 的 POST /run 没被挡住：' + JSON.stringify(evilRun))
    const evilCfg = await routeRaw('GET', '/api/douyin-audio/config', undefined, evilSiteH)
    if (evilCfg.status === 403) ok('GET /config 跨站（sec-fetch-site: cross-site）→ 403')
    else problem('跨站还能读配置：' + JSON.stringify(evilCfg))
    const siteCrossCfg = await routeRaw('GET', '/api/douyin-audio/config', undefined, { host: HOST, 'sec-fetch-site': 'same-site' })
    if (siteCrossCfg.status === 403) ok('GET /config 带 sec-fetch-site: same-site（同域不同端口）→ 403')
    else problem('same-site 被放过了：' + JSON.stringify(siteCrossCfg))

    // c. token 端点本身也过同源门；同源才发 token
    const crossToken = await routeRaw('GET', '/api/douyin-audio/token', undefined, { host: HOST, origin: 'https://evil.example' })
    if (crossToken.status === 403) ok('GET /token 跨站 Origin → 403（token 端点自己也过门）')
    else problem('跨站还能取 token：' + JSON.stringify(crossToken))
    const tokRes = await routeRaw('GET', '/api/douyin-audio/token', undefined, sameH)
    const token = tokRes.status === 200 && tokRes.body && typeof tokRes.body.token === 'string' ? tokRes.body.token : ''
    if (/^[0-9a-f]{32}$/.test(token)) ok('GET /token 带 Sec-Fetch-Site: same-origin → 200，token 是 32 hex')
    else problem('GET /token 同源没拿到 token：' + JSON.stringify(tokRes))

    // d. 带正确 token → 放行并真的执行；乱写的 token 不顶用
    const tokRun = await routeRaw('POST', '/api/douyin-audio/run', { action: 'duty_status' }, { host: HOST, 'x-dsh-douyin-token': token })
    if (tokRun.status === 200 && tokRun.body && tokRun.body.ok === true) {
      ok('带正确 x-dsh-douyin-token 的 POST /run → 200 且 duty_status 真的跑了')
    } else problem('带 token 的 POST /run 没执行：' + JSON.stringify(tokRun))
    const fakeRun = await routeRaw('POST', '/api/douyin-audio/run', { action: 'duty_status' },
      { host: HOST, origin: 'https://evil.example', 'x-dsh-douyin-token': 'deadbeefdeadbeef' })
    if (fakeRun.status === 403) ok('跨站 + 乱写 token → 403（假 token 不顶用）')
    else problem('假 token 也放行了：' + JSON.stringify(fakeRun))
    // ?token=（给 <img> 那种带不了请求头的地方）
    const qsRun = await routeRaw('POST', '/api/douyin-audio/run?token=' + token, { action: 'duty_status' }, { host: HOST })
    if (qsRun.status === 200) ok('?token= 查询参数也认（<img> 带不了请求头）')
    else problem('查询参数里的 token 不认：' + JSON.stringify(qsRun))

    // e. Origin 的 host:port 等于本次 Host → 放行（浏览器同源 POST 就是这么发的）
    const originSame = await routeRaw('GET', '/api/douyin-audio/sysinfo', undefined, { host: HOST, origin: 'http://' + HOST })
    if (originSame.status === 200) ok('Origin 与 Host 同源（不带 Sec-Fetch-Site）→ 200，设置页刷新不受影响')
    else problem('同源 Origin 被误拦：' + JSON.stringify(originSame))

    /* ── 检查更新（GET /update）：注入假 fetch，绝不真联网 ── */
    if (typeof mod.__updateDeps !== 'function') {
      problem('index.js 没导出 __updateDeps 测试缝（检查更新会真联网）')
    } else {
      const fakeRes = (obj) => ({ ok: true, status: 200, json: async () => obj })
      // 1) registry 有新版本 → hasUpdate true
      mod.__updateDeps({ fetch: async () => fakeRes({ version: '99.99.99' }) })
      const upNew = await callRoute('GET', '/api/douyin-audio/update')
      if (upNew && upNew.ok === true && upNew.latest === '99.99.99' && upNew.hasUpdate === true && /^\d+\.\d+\.\d+/.test(String(upNew.current))) {
        ok('GET /update：远端更新时 hasUpdate=true（current=' + upNew.current + ' → latest=' + upNew.latest + '）')
      } else problem('检查更新判断有误：' + JSON.stringify(upNew))
      // 2) registry 版本旧于本地 → hasUpdate false
      mod.__updateDeps({ fetch: async () => fakeRes({ version: '0.0.1' }) })
      const upOld = await callRoute('GET', '/api/douyin-audio/update')
      if (upOld && upOld.ok === true && upOld.hasUpdate === false) ok('GET /update：远端更旧时 hasUpdate=false')
      else problem('更旧也报有更新：' + JSON.stringify(upOld))
      // 2.5) GitHub 走 contents（base64）→ 也要能解析出真实版本号
      const b64 = Buffer.from(JSON.stringify({ name: 'dsh-douyin-audio', version: '88.88.88' }), 'utf8').toString('base64')
      mod.__updateDeps({ fetch: async () => fakeRes({ type: 'file', encoding: 'base64', content: b64 }) })
      const upB64 = await callRoute('GET', '/api/douyin-audio/update')
      if (upB64 && upB64.ok === true && upB64.latest === '88.88.88') ok('GET /update：contents 的 base64 内容能解出版本（88.88.88）')
      else problem('base64 内容解不出：' + JSON.stringify(upB64))
      // 2.6) 第一个源挂掉 → 自动落到第二个源
      let call = 0
      mod.__updateDeps({ fetch: async () => { call += 1; if (call === 1) throw new Error('ECONNRESET'); return fakeRes({ version: '77.77.77' }) } })
      const upFallback = await callRoute('GET', '/api/douyin-audio/update')
      if (upFallback && upFallback.ok === true && upFallback.latest === '77.77.77' && upFallback.source && upFallback.source !== 'AtomGit') {
        ok('GET /update：首个源失败会自动换源（落到 ' + upFallback.source + '）')
      } else problem('换源没生效：' + JSON.stringify(upFallback))
      // 3) 网络炸了 → 不抛错，返回 ok:false + 人话
      mod.__updateDeps({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND') } })
      const upFail = await callRoute('GET', '/api/douyin-audio/update')
      if (upFail && upFail.ok === false && typeof upFail.error === 'string' && upFail.error.length > 4) {
        ok('GET /update：连不上时返回 ok:false 且不抛错（' + upFail.error.slice(0, 28) + '…）')
      } else problem('检查更新遇到网络错误没兜住：' + JSON.stringify(upFail))
      mod.__updateDeps({ fetch: null })   // 还原成真 fetch
    }

    // f. HTTP /config 写 tier*：跨站 403，同源放行（那是用户自己在设置页点开关）
    writeCfg({ tierReact: false })
    const tierCross = await routeRaw('POST', '/api/douyin-audio/config', { key: 'tierReact', value: true }, evilSiteH)
    if (tierCross.status === 403) ok('跨站 Origin 的 HTTP /config 写 tierReact → 403')
    else problem('跨站能写 tierReact：' + JSON.stringify(tierCross))
    const tierSame = await routeRaw('POST', '/api/douyin-audio/config', { key: 'tierReact', value: true }, sameH)
    if (tierSame.status === 200 && tierSame.body && tierSame.body.ok === true
      && tierSame.body.config && tierSame.body.config.tierReact === true) {
      ok('同源的 HTTP /config 能写 tierReact（设置页那条路没被堵）')
    } else problem('同源 HTTP /config 写 tierReact 失败：' + JSON.stringify(tierSame))
    writeCfg({ tierReact: false })
    // g. 数值底线走 HTTP 也生效（与 douyin_config 同一套规则）
    const httpCount0 = await routeRaw('POST', '/api/douyin-audio/config', { key: 'count', value: 0 }, sameH)
    if (httpCount0.status === 400 && /count/.test(String((httpCount0.body || {}).error || ''))) {
      ok('HTTP /config count=0 → 400（数值底线 count>=1）')
    } else problem('HTTP /config 放过了 count=0：' + JSON.stringify(httpCount0))
    writeCfg({})

    const httpAuto = await callRoute('POST', '/api/douyin-audio/run', { action: 'setup_auto' })
    if (httpAuto && httpAuto.ok === true && httpAuto.started === true && httpAuto.action === 'started' && httpAuto.mode === 'auto') {
      ok('HTTP setup_auto 立刻回 started:true / action=started / mode=auto')
    } else problem('HTTP setup_auto 返回不对：' + JSON.stringify(httpAuto))
    if (spawnedHttp.length === 1 && spawnedHttp[0].argv[spawnedHttp[0].argv.indexOf('--mode') + 1] === 'auto') {
      ok('HTTP setup_auto 走后台派生（argv 带 --mode auto）：' + JSON.stringify(spawnedHttp[0].argv))
    } else problem('HTTP setup_auto 没走后台派生：' + JSON.stringify(spawnedHttp.map((x) => x.argv)))
    if (setupFront.length === frontBefore) ok('HTTP setup_auto 没走前台 runPython')
    else problem('HTTP setup_auto 走了前台（前台调用 ' + setupFront.length + ' 次）')
    const httpScan = await callRoute('POST', '/api/douyin-audio/run', { action: 'setup_scan' })
    if (httpScan && httpScan.mode === 'scan') ok('HTTP setup_scan 走前台同步回 inventory')
    else problem('HTTP setup_scan 不对：' + JSON.stringify(httpScan))
    const httpStart = await callRoute('POST', '/api/douyin-audio/run', { action: 'setup_start', mode: 'minimal' })
    if (httpStart && httpStart.started === true && httpStart.mode === 'minimal') ok('HTTP setup_start 把 mode 透传给 douyin_setup')
    else problem('HTTP setup_start 不对：' + JSON.stringify(httpStart))
  }
  setSetupDeps({ script: null, spawn: null, run: null, probe: null, venvDir: null })

  // douyin_status.env：结构 + venv 探测缓存（桩 venv，绝不真起子进程）
  const fakeVenv = join(SANDBOX_HOME, 'venv')
  try {
    mkdirSync(join(fakeVenv, 'Scripts'), { recursive: true })
    writeFileSync(join(fakeVenv, 'Scripts', 'python.exe'), 'stub', 'utf8')
    writeFileSync(join(fakeVenv, 'pyvenv.cfg'), 'home = C:\\stub-base\\python\nversion = 3.12.14\n', 'utf8')
  } catch (e) { die('造假 venv 失败', e) }
  let envProbes = 0
  setSetupDeps({ venvDir: fakeVenv, probe: async () => { envProbes += 1; return { playwright: true, sherpa: true } } })
  const stWithEnv = await callTool('douyin_status', {})
  const envObj = stWithEnv && stWithEnv.env
  if (envObj && typeof envObj === 'object' && !Array.isArray(envObj)) ok('douyin_status 返回 env 对象')
  else problem('douyin_status 没有 env 对象：' + JSON.stringify(envObj))
  const envKeys = ['venv', 'venvPython', 'venvUsable', 'playwright', 'sherpa', 'setupLog', 'setupLogTail',
    'canReusePython', 'reusePythonPath', 'setupRunning', 'setupResult']
  const envLost = envObj ? envKeys.filter((k) => !(k in envObj)) : envKeys
  if (!envLost.length) ok('env 字段齐（' + envKeys.join(' / ') + '）')
  else problem('env 少了字段：' + envLost.join(','))
  if (envObj && envObj.venv === true && envObj.venvUsable === true && /python\.exe$/.test(String(envObj.venvPython))) {
    ok('env.venv / venvUsable / venvPython 对得上（venv 桩）')
  } else problem('env.venv* 不对：' + JSON.stringify({ venv: envObj && envObj.venv, venvUsable: envObj && envObj.venvUsable, venvPython: envObj && envObj.venvPython }))
  if (envObj && envObj.basePython === 'C:\\stub-base\\python') ok('env.basePython 读 pyvenv.cfg 的 home：' + envObj.basePython)
  else problem('env.basePython 不对：' + JSON.stringify(envObj && envObj.basePython))
  if (envObj && Array.isArray(envObj.setupLogTail)) ok('env.setupLogTail 是数组（' + envObj.setupLogTail.length + ' 行）')
  else problem('env.setupLogTail 不是数组：' + JSON.stringify(envObj && envObj.setupLogTail))
  await callTool('douyin_status', {})
  if (envProbes === 1) ok('venv 探测有缓存：两次 status 只探一次')
  else problem('venv 探测没缓存（探了 ' + envProbes + ' 次）')

  // env.setupRunning / env.setupResult：后台安装的进度与结论（前端轮询就靠这两个字段）
  const resultPath = join(SANDBOX_HOME, 'douyin-duty', 'setup-result.json')
  try { rmSync(resultPath, { force: true }) } catch { /* 本来就没有 */ }
  const envNoResult = (await callTool('douyin_status', {})).env
  if (envNoResult && envNoResult.setupRunning === false && envNoResult.setupResult === null) {
    ok('没有 setup-result.json 时 env.setupRunning=false / setupResult=null')
  } else problem('没有 setup-result.json 时 env 不对：' + JSON.stringify({ running: envNoResult && envNoResult.setupRunning, result: envNoResult && envNoResult.setupResult }))
  try {
    writeFileSync(resultPath, JSON.stringify({
      action: 'reused', pythonPath: 'C:\\x\\python.exe', version: '3.13.2',
      hasPlaywright: true, hasSherpa: true, ffmpeg: null, model: null, missing: [], nextSteps: [], at: Date.now(), elapsed: 2.1,
    }), 'utf8')
  } catch (e) { die('写桩 setup-result.json 失败', e) }
  const envReused = (await callTool('douyin_status', {})).env
  if (envReused && envReused.setupResult && envReused.setupResult.action === 'reused'
    && envReused.setupResult.pythonPath === 'C:\\x\\python.exe' && envReused.setupResult.version === '3.13.2'
    && envReused.setupRunning === false) {
    ok('env.setupResult.action=reused（pythonPath / version 都读到了）')
  } else problem('env.setupResult 读得不对：' + JSON.stringify(envReused && envReused.setupResult))
  if (envReused && envReused.canReusePython === true) ok('reused 之后 env.canReusePython=true（徽章/按钮跟着变）')
  else problem('reused 之后 canReusePython 没变 true：' + JSON.stringify(envReused && envReused.canReusePython))
  try {
    writeFileSync(resultPath, JSON.stringify({ action: 'failed', error: 'pip install 两次都失败（网络）', missing: ['playwright'], at: Date.now() }), 'utf8')
  } catch (e) { die('写桩 setup-result.json（失败态）失败', e) }
  const envFailed = (await callTool('douyin_status', {})).env
  if (envFailed && envFailed.setupResult && envFailed.setupResult.action === 'failed'
    && /两次都失败/.test(String(envFailed.setupResult.error))) {
    ok('env.setupResult.action=failed（error 原样带回）')
  } else problem('failed 结论没读到：' + JSON.stringify(envFailed && envFailed.setupResult))
  try { writeFileSync(resultPath, '{ 坏 JSON', 'utf8') } catch { /* ignore */ }
  const envBroken = (await callTool('douyin_status', {})).env
  if (envBroken && envBroken.setupResult === null) ok('setup-result.json 坏了 → setupResult=null（不抛）')
  else problem('坏 JSON 没吞掉：' + JSON.stringify(envBroken && envBroken.setupResult))
  try { rmSync(resultPath, { force: true }) } catch { /* ignore */ }
  setSetupDeps({ venvDir: null, probe: null })
  writeCfg({})
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

/* ───────── ⑨-ter 数值底线：count>=1 / delay>=0 / downloadTimeout>=30（非法直接拒，不夹取）───────── */
const numCases = [
  { key: 'count', value: '0', want: false, why: 'count=0 被拒（屏数 >= 1）' },
  { key: 'count', value: '2', want: true, why: 'count=2 允许' },
  { key: 'delay', value: '0', want: true, why: 'delay=0 允许（>= 0）' },
  { key: 'delay', value: '-1', want: false, why: 'delay=-1 被拒' },
  { key: 'downloadTimeout', value: '10', want: false, why: 'downloadTimeout=10 被拒（>= 30）' },
  { key: 'downloadTimeout', value: '30', want: true, why: 'downloadTimeout=30 允许（下限刚好）' },
]
for (const c of numCases) {
  const r = await callTool('douyin_config', { action: 'set', key: c.key, value: c.value })
  if (r && r.ok === c.want) ok(c.why)
  else problem(c.why.replace(/^(.*)被拒.*$/, '$1') + '结果不对：' + JSON.stringify(r))
}
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
