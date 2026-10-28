/**
 * lib/runner.mjs —— 找 Python、跑脚本（带沙箱降级）
 * 先试 stdio pipe；若被沙箱拒绝（spawn EPERM），退回 cmd 重定向到文件再读。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPT_SCROLL = join(HERE, '..', 'scripts', 'douyin_scroller.py')
export const SCRIPT_TRANSCRIBE = join(HERE, '..', 'scripts', 'transcribe_douyin.py')
export const SCRIPT_READ = join(HERE, '..', 'scripts', 'douyin_read.py')

export function pythonCandidates(extra) {
  const list = []
  const push = (p) => { if (typeof p === 'string' && p.trim() && !list.includes(p)) list.push(p) }
  push(extra)
  push(process.env.DSH_PYTHON)
  push(process.env.PYTHON3)
  push(process.env.PYTHON)
  push('python3')
  push('python')
  return list
}

function probeOne(py, mod) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(py, ['-c', 'import ' + mod + ';print("ok")'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch { return resolve(false) }
    let out = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0 && out.includes('ok')))
    setTimeout(() => { try { child.kill() } catch {} ; done(false) }, 15000)
  })
}

export async function findPython(log, mod = 'playwright', extra) {
  for (const py of pythonCandidates(extra)) {
    if (await probeOne(py, mod)) { log?.('使用 Python: ' + py + ' (带 ' + mod + ')'); return py }
  }
  return null
}

function runPiped(python, script, args, timeoutSec, env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
    } catch (e) { return resolve({ ok: false, code: null, stdout: '', stderr: String(e.message), spawnError: true }) }
    let out = '', err = '', settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
      try { child.kill() } catch {}
      done({ ok: false, code: null, stdout: out, stderr: '超时 ' + timeoutSec + 's' })
    }, timeoutSec * 1000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, code: null, stdout: out, stderr: String(e.message), spawnError: true }) })
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, code, stdout: out, stderr: err }) })
  })
}

async function runViaCmd(python, script, args, timeoutSec, env) {
  const outFile = join(tmpdir(), 'douyin-run-' + Date.now() + '.log')
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'
  const line = q(python) + ' ' + q(script) + ' ' + args.map(q).join(' ') + ' > ' + q(outFile) + ' 2>&1'
  const code = await new Promise((resolve) => {
    const child = spawn('cmd', ['/c', line], { stdio: 'ignore', windowsHide: true, env })
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve(null) }, timeoutSec * 1000)
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (c) => { clearTimeout(timer); resolve(c) })
  })
  let text = ''
  try { text = readFileSync(outFile, 'utf8') } catch {}
  try { unlinkSync(outFile) } catch {}
  return { ok: code === 0, code, stdout: text, stderr: '' }
}

/** 给子进程注入必需环境：沙箱下系统 %TEMP% 常不可写，用插件自己的 tmp */
function childEnv(tmpDir) {
  const env = { ...process.env }
  if (tmpDir) {
    env.DSH_DOUYIN_TMP = tmpDir
    try { mkdirSync(tmpDir, { recursive: true }) } catch { /* 建不了就让脚本自己降级 */ }
  }
  return env
}

export async function runPython(python, script, args, { timeoutSec = 600, log, tmpDir } = {}) {
  if (!existsSync(script)) return { ok: false, code: null, stdout: '', stderr: '脚本不存在: ' + script }
  log?.('执行: ' + python + ' ' + script + ' ' + args.join(' '))
  let r = await runPiped(python, script, args, timeoutSec, childEnv(tmpDir))
  if (r.spawnError) {
    log?.('pipe 模式被拒（' + r.stderr + '），改用 cmd 重定向')
    r = await runViaCmd(python, script, args, timeoutSec, childEnv(tmpDir))
  }
  return r
}
