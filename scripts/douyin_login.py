#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""douyin_login.py —— 抖音登录助手：可见窗口人工登录 / 后台出二维码，成功后导出 netscape cookie

用法:
    python douyin_login.py                                   # 默认 window 模式（= 旧行为）
    python douyin_login.py --mode window [--wait 300] [--out <cookie路径>]
    python douyin_login.py --mode qr --state-dir <登录临时目录> [--wait 300] [--out <cookie路径>]

window 模式（前台可见窗口，人工扫码/验证）:
    打开 https://www.douyin.com/ → 点「登录」→ 你在窗口里扫码/验证
    → 检测到已登录（cookie 里出现 sessionid，或右上角「登录」按钮消失）
    → 导出 netscape cookie 到 --out（默认 ~/.dsh/cookies/douyin_cookies.txt）→ exit 0
    超时 → 写 state.json phase=expired → exit 2

qr 模式（后台 headless 驻留，给设置页出二维码）:
    打开 douyin.com → 点「登录」→ 等二维码出现
    → 每 3 秒把二维码区域截图写到 <state-dir>/qr.png，同时刷新 state.json（phase=waiting）
    → 用户手机扫码确认 → 检测到登录成功 → 导出 cookie → state.json phase=ok → exit 0
    → 二维码失效/超时 → phase=expired → exit 2
    ⚠️ 全程维持同一个浏览器上下文（不关浏览器），否则扫码无法完成。

state.json（<state-dir>/state.json，host 侧 douyin_login_poll 读它）:
    {"phase": "waiting"|"scanned"|"ok"|"expired"|"error",
     "at": <epoch ms>, "message": "<一句话>",
     "cookiePath": "<成功时写的 cookie 路径>", "mode": "window"|"qr"}

cookie 导出优先级: --out > 环境变量 DOUYIN_COOKIE_FILE > ~/.dsh/cookies/douyin_cookies.txt
（写前把旧文件改名成 .bak）

★ 绝不绕过验证码：qr 模式撞上「验证码中间页」直接写 phase=error + 明确 message 并退出，
  不做打码/重试；window 模式则一直是人自己过验证。
★ 所有异常都落成 state.json 的 error 原因，不裸 traceback。

退出码: 0 = cookie 已写好; 2 = 超时/过期/任何失败
"""
import argparse
import contextlib
import json
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DOUYIN_URL = "https://www.douyin.com/"
DEFAULT_OUT = os.path.expanduser("~/.dsh/cookies/douyin_cookies.txt")
QR_NAME = "qr.png"
STATE_NAME = "state.json"
# qr 模式：实测抖音风控判的是「有没有真实窗口」（窗口挪到屏幕外也算真窗口），headless 会直接
# 撞「验证码中间页」。所以后台模式也开真窗口，只是把它放到屏幕外 —— 用户看不见，但风控认。
QR_LAUNCH_ARGS = ["--window-position=-3000,-3000", "--window-size=1200,800"]
QR_VIEWPORT = {"width": 1200, "height": 800}
QR_HEADLESS_NOTE = "已退回 headless（可能撞验证码）"

# 登录态 cookie 名（命中任一即可判定已登录）
SESSION_COOKIE_NAMES = ("sessionid", "sessionid_ss", "sid_tt", "sid_guard")

# 「验证码中间页」关键词（命中即判定被人机验证拦截 —— 不绕过，只如实上报）
VERIFY_KEYWORDS = ("验证码中间页", "请完成下列验证", "完成验证", "人机验证",
                   "安全验证", "拖动滑块", "验证后继续")
# 二维码失效文案
QR_EXPIRED_KEYWORDS = ("二维码已失效", "二维码失效", "二维码已过期")

# 页内：找「登录」按钮并打标记（找到返回 found=True；未找到 = 可能已登录）
_JS_LOGIN_BTN = r"""
() => {
  const KEY = 'data-dsh-login-btn';
  document.querySelectorAll('[' + KEY + ']').forEach((e) => e.removeAttribute(KEY));
  const vis = (e) => {
    try { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; }
    catch (err) { return false; }
  };
  const sels = ['[data-e2e="login-button"]', '[data-e2e="login"]', 'button[class*="login"]',
                'a[class*="login"]', '[class*="login-button"]', '[class*="loginBtn"]'];
  for (const s of sels) {
    for (const e of document.querySelectorAll(s)) {
      if (!vis(e)) continue;
      const t = (e.innerText || '').replace(/\s+/g, '');
      if (t && t.indexOf('登录') < 0) continue;
      e.setAttribute(KEY, '1');
      return { found: true, how: s, text: t.slice(0, 20) };
    }
  }
  const root = document.querySelector('#douyin-header')
            || document.querySelector('[data-e2e="douyin-header"]')
            || document.body;
  if (!root) return { found: false };
  for (const e of root.querySelectorAll('button, a, div, span')) {
    if (!vis(e)) continue;
    const t = (e.textContent || '').replace(/\s+/g, '');
    if (t !== '登录') continue;
    const r = e.getBoundingClientRect();
    if (r.width > 240 || r.height > 84) continue;
    e.setAttribute(KEY, '1');
    return { found: true, how: 'text=登录', text: '登录' };
  }
  return { found: false };
}
"""

# 页内：取面板里那个方形二维码（canvas 或 img，宽高 100~300 且接近正方形）并打标记
_JS_QR_PICK = r"""
() => {
  const KEY = 'data-dsh-qr-pick';
  document.querySelectorAll('[' + KEY + ']').forEach((e) => e.removeAttribute(KEY));
  const vis = (e) => {
    try { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch (err) { return false; }
  };
  let best = null, bestScore = 0;
  for (const e of document.querySelectorAll('canvas, img, svg')) {
    if (!vis(e)) continue;
    let r;
    try { r = e.getBoundingClientRect(); } catch (err) { continue; }
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w < 100 || w > 300 || h < 100 || h > 300) continue;
    const ratio = Math.abs(w - h) / Math.max(w, h);
    if (ratio > 0.2) continue;
    let score = 100 - ratio * 100;
    let hint = '';
    try { hint = (e.getAttribute('src') || '') + ' ' + (e.getAttribute('class') || ''); } catch (err) {}
    if (/qr|code|二维码/i.test(hint)) score += 30;
    if (e.tagName === 'CANVAS') score += 15;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (!best) return { found: false };
  best.setAttribute(KEY, '1');
  const r = best.getBoundingClientRect();
  return { found: true, tag: best.tagName, w: Math.round(r.width), h: Math.round(r.height) };
}
"""

# 页内：正文长度 / 验证码关键词 / 二维码失效文案
_JS_PAGE_PROBE = r"""
(cfg) => {
  const body = document.body ? (document.body.innerText || '') : '';
  const hits = [];
  for (const k of (cfg.verify || [])) { if (body.indexOf(k) >= 0) hits.push(k); }
  const dead = [];
  for (const k of (cfg.expired || [])) { if (body.indexOf(k) >= 0) dead.push(k); }
  let title = '';
  try { title = document.title || ''; } catch (err) {}
  return { title: title, bodyLen: body.length, verify: hits, expired: dead };
}
"""


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def log(msg):
    try:
        sys.stderr.write("[douyin_login] {}\n".format(msg))
        sys.stderr.flush()
    except Exception:
        pass


def _brief(exc, limit=240):
    """异常压成一行短句（playwright 的异常常带多行 call log）"""
    try:
        text = " ".join(str(exc).split())
    except Exception:
        text = exc.__class__.__name__
    return (text[:limit] or exc.__class__.__name__)


def quiet_asyncio_noise():
    """playwright 驱动起不来时，asyncio 在解释器收尾会往 stderr 甩一段 future traceback；压掉它，
    保证失败只剩我们自己那一行原因（state.json 里是同一句话）"""
    try:
        import logging
        logging.getLogger("asyncio").setLevel(logging.CRITICAL)
    except Exception:
        pass


def now_ms():
    return int(time.time() * 1000)


def default_state_dir():
    home = os.environ.get("DSH_HOME")
    base = home if home else os.path.expanduser("~/.dsh")
    return os.path.join(base, "douyin-duty", "login")


def write_state(state_dir, phase, message, cookie_path=None, mode=None):
    """原子写 state.json；任何失败都不许把脚本带崩（host 侧只是读它）"""
    if not state_dir:
        return
    data = {
        "phase": phase,
        "at": now_ms(),
        "message": (message or "")[:400],
        "cookiePath": cookie_path or "",
        "mode": mode or "",
        "browser": _BROWSER_USED,
    }
    path = os.path.join(state_dir, STATE_NAME)
    tmp = path + ".tmp"
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception as exc:
        log("写 state.json 失败: {}".format(_brief(exc, 120)))


def to_netscape(cookies, path):
    """playwright cookies -> netscape 文件（沿用旧实现的格式）；写前把旧文件改名 .bak"""
    lines = [
        "# Netscape HTTP Cookie File",
        "# 由 dsh-douyin-audio/scripts/douyin_login.py 生成（%s）" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "",
    ]
    n = 0
    for c in cookies:
        domain = c.get("domain") or ""
        if not domain:
            continue
        if not domain.startswith("."):
            domain = "." + domain.lstrip(".")
        include_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path_ = c.get("path") or "/"
        secure = "TRUE" if c.get("secure") else "FALSE"
        exp = int(c.get("expires") or 0)
        if exp <= 0:
            exp = int(time.time()) + 86400 * 30
        lines.append("\t".join([domain, include_sub, path_, secure, str(exp),
                                c.get("name") or "", c.get("value") or ""]))
        n += 1
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.exists(path):
        try:
            os.replace(path, path + ".bak")
        except Exception as exc:
            log("备份旧 cookie 失败（继续写新的）: {}".format(_brief(exc, 120)))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return n


# --------------------------------------------------------------------------
# 浏览器动作
# --------------------------------------------------------------------------
@contextlib.contextmanager
def playwright_context():
    """playwright 驱动本身（node 子进程）起不来时，也给一句话原因而不是裸 traceback"""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise RuntimeError("没装 playwright（pip install playwright 后重试）: {}".format(
            _brief(exc, 160)))
    try:
        manager = sync_playwright()
    except Exception as exc:
        raise RuntimeError("无法初始化 playwright: {}".format(_brief(exc, 200)))
    try:
        pw = manager.start()
    except Exception as exc:
        # 驱动没起来就没什么可关的；不调 __exit__，免得 asyncio 收尾时再抛一遍
        raise RuntimeError("无法启动 playwright 驱动（node 子进程）: {}".format(_brief(exc, 240)))
    try:
        yield pw
    finally:
        try:
            manager.__exit__(None, None, None)
        except Exception:
            pass


def open_session(pw, headless, extra_args=None, viewport=None, browser_channel="msedge"):
    """起浏览器 + 上下文 + 抖音首页；失败带步骤名抛出"""
    browser = launch_browser(pw, headless, extra_args=extra_args,
                             browser_channel=browser_channel)
    try:
        ctx = browser.new_context(locale="zh-CN", viewport=viewport) if viewport \
            else browser.new_context(locale="zh-CN")
        page = ctx.new_page()
        page.goto(DOUYIN_URL, wait_until="domcontentloaded", timeout=60000)
        return browser, ctx, page
    except Exception as exc:
        try:
            browser.close()
        except Exception:
            pass
        raise RuntimeError("打开抖音首页失败: {}".format(_brief(exc, 240)))


# 浏览器候选链：--browser-channel 选首选，其余按下面的顺序兜底
BROWSER_CHANNELS = ("msedge", "chrome", "chromium")
# 实际用上的 channel（launch_browser 写，write_state 读进 state.json）
_BROWSER_USED = ""


def browser_candidates(preferred):
    """按用户选择把候选链排好；chromium = 明确要裸浏览器，不再回退（免得以为在测 Chrome）"""
    preferred = preferred if preferred in BROWSER_CHANNELS else "msedge"
    if preferred == "chromium":
        return ["chromium"]
    if preferred == "chrome":
        return ["chrome", "msedge", "chromium"]
    return ["msedge", "chrome", "chromium"]


def _mark_browser(channel):
    """记下实际用上的 channel，并按统一契约在 stderr 打一行"""
    global _BROWSER_USED
    _BROWSER_USED = channel
    try:
        sys.stderr.write("[browser] 使用 {}\n".format(channel))
        sys.stderr.flush()
    except Exception:
        pass


def launch_browser(pw, headless, extra_args=None, browser_channel="msedge"):
    """按 --browser-channel 排好候选链逐个试 launch；全失败才报错（错误里带每一条原因）"""
    errors = []
    if extra_args:
        extra = list(extra_args)
    else:
        extra = ["--autoplay-policy=no-user-gesture-required"] if headless else ["--start-maximized"]
    chain = browser_candidates(browser_channel)
    for channel in chain:
        kwargs = {} if channel == "chromium" else {"channel": channel}
        try:
            browser = pw.chromium.launch(headless=headless, args=list(extra), **kwargs)
        except Exception as exc:
            errors.append("{}: {}".format(channel, _brief(exc, 160)))
            continue
        _mark_browser(channel)
        return browser
    raise RuntimeError("无法启动浏览器（候选链 {}，已逐个试过）：{}".format(
        " / ".join(chain), " | ".join(errors)))


def probe_page(page):
    """读标题/正文长度/验证码关键词；页面已经关掉时返回 None"""
    try:
        return page.evaluate(_JS_PAGE_PROBE,
                             {"verify": list(VERIFY_KEYWORDS),
                              "expired": list(QR_EXPIRED_KEYWORDS)})
    except Exception:
        return None


def is_verify_page(info):
    if not info:
        return False
    title = info.get("title") or ""
    if "验证码中间页" in title:
        return True
    if info.get("verify") and info.get("bodyLen", 0) < 1200:
        return True
    return False


def find_login_button(page):
    try:
        return page.evaluate(_JS_LOGIN_BTN) or {"found": False}
    except Exception:
        return {"found": False}


def open_login_panel(page):
    """点一下「登录」，失败就退回 JS click；返回一句话说明"""
    hit = find_login_button(page)
    if not hit.get("found"):
        return "没找到「登录」按钮（页面结构可能不同）"
    try:
        handle = page.query_selector('[data-dsh-login-btn="1"]')
        if handle:
            handle.click(timeout=5000)
            return "已点「登录」（{}）".format(hit.get("how"))
    except Exception as exc:
        log("原生 click 失败，改用 JS click: {}".format(_brief(exc, 120)))
    try:
        page.evaluate("""() => {
            const e = document.querySelector('[data-dsh-login-btn="1"]');
            if (e) e.click();
        }""")
        return "已用 JS 点「登录」（{}）".format(hit.get("how"))
    except Exception as exc:
        return "点「登录」失败: {}".format(_brief(exc, 160))


def session_cookie(ctx):
    """cookie 里是否有登录态（sessionid 一类，且非空）"""
    try:
        cookies = ctx.cookies()
    except Exception:
        return None, "读不到 cookie"
    for c in cookies:
        name = (c.get("name") or "").lower()
        if name in SESSION_COOKIE_NAMES and (c.get("value") or "").strip():
            if "douyin" in (c.get("domain") or ""):
                return c, "cookie 里有 {}（domain={}）".format(name, c.get("domain"))
    return None, "cookie 里还没有 sessionid"


def logged_in(ctx, page):
    """已登录 = cookie 有 sessionid 或 右上角「登录」按钮消失（且正文足够长）"""
    ck, why = session_cookie(ctx)
    if ck is not None:
        return True, why
    info = probe_page(page)
    if not info:
        return False, "读不到页面（可能已经关掉）"
    if info.get("bodyLen", 0) < 800:
        return False, "正文只有 {} 字，页面还没加载完".format(info.get("bodyLen", 0))
    if not find_login_button(page).get("found"):
        return True, "右上角「登录」按钮已消失（title={}）".format((info.get("title") or "")[:30])
    return False, why


def capture_qr(page, qr_path):
    """到各 frame 里找方形二维码元素 → 截图写 qr_path（先写 .tmp 再 replace，避免读到半个文件）"""
    # ⚠️ Playwright 的 screenshot(path=...) 按扩展名判格式，".tmp" 结尾会报
    #    unsupported mime type ".tmp" —— 临时文件也必须带 .png 后缀
    tmp = qr_path + ".tmp.png"
    for frame in list(getattr(page, "frames", [])):
        try:
            got = frame.evaluate(_JS_QR_PICK) or {"found": False}
        except Exception:
            continue
        if not got.get("found"):
            continue
        try:
            handle = frame.query_selector('[data-dsh-qr-pick="1"]')
            if not handle:
                continue
            handle.screenshot(path=tmp)
            os.replace(tmp, qr_path)
            return {"ok": True, "size": "{}x{}".format(got.get("w"), got.get("h")),
                    "tag": got.get("tag")}
        except Exception as exc:
            log("二维码截图失败: {}".format(_brief(exc, 160)))
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass
            continue
    return {"ok": False}


# --------------------------------------------------------------------------
# 两种模式
# --------------------------------------------------------------------------
def run_window(args, state_dir):
    with playwright_context() as pw:
        browser, ctx, page = open_session(pw, headless=False,
                                          browser_channel=args.browser_channel)
        try:
            log("[1/4] 窗口已打开：请在窗口里点「登录」并扫码/完成验证")
            write_state(state_dir, "waiting", "窗口已打开，请扫码/登录", mode="window")
            time.sleep(3)
            log("      " + open_login_panel(page))

            deadline = time.time() + args.wait
            ok = False
            why = "等待中"
            while time.time() < deadline:
                time.sleep(3)
                info = probe_page(page)
                if is_verify_page(info):
                    why = "还在验证页（title={}）".format((info or {}).get("title", "")[:30])
                    log("      " + why)
                    write_state(state_dir, "waiting", why, mode="window")
                    continue
                ok, why = logged_in(ctx, page)
                log("      " + why)
                write_state(state_dir, "waiting", why, mode="window")
                if ok:
                    break
            if not ok:
                msg = "等超时了（{}s）：{}".format(args.wait, why)
                log("[失败] " + msg)
                write_state(state_dir, "expired", msg, mode="window")
                return 2

            log("[2/4] 已登录（{}），等 5 秒让风控记下这次访问…".format(why))
            write_state(state_dir, "scanned", "已登录，正在导出 cookie", mode="window")
            time.sleep(5)
            n = to_netscape(ctx.cookies(), args.out)
            log("[3/4] 已写入 {} 条 cookie -> {}".format(n, args.out))
            write_state(state_dir, "ok", "已导出 {} 条 cookie".format(n),
                        cookie_path=args.out, mode="window")
            return 0
        finally:
            try:
                browser.close()
            except Exception:
                pass


def open_qr_session(pw, state_dir, browser_channel="msedge"):
    """qr 模式起会话：真窗口 + 挪到屏幕外（headless 会撞验证码）；
    这条起不来才退回 headless=True，并在 state.json 里注明。返回 (browser, ctx, page, note)"""
    try:
        browser, ctx, page = open_session(pw, headless=False,
                                          extra_args=list(QR_LAUNCH_ARGS),
                                          viewport=dict(QR_VIEWPORT),
                                          browser_channel=browser_channel)
        return browser, ctx, page, "后台真窗口（已挪到屏幕外）"
    except Exception as exc:
        log("真窗口起不来（{}），退回 headless".format(_brief(exc, 200)))
        write_state(state_dir, "waiting", QR_HEADLESS_NOTE + "，正在启动浏览器…", mode="qr")
        browser, ctx, page = open_session(pw, headless=True, viewport=dict(QR_VIEWPORT),
                                          browser_channel=browser_channel)
        return browser, ctx, page, QR_HEADLESS_NOTE


def run_qr(args, state_dir):
    qr_path = os.path.join(state_dir, QR_NAME)
    write_state(state_dir, "waiting", "正在启动浏览器…", mode="qr")
    with playwright_context() as pw:
        browser, ctx, page, note = open_qr_session(pw, state_dir, args.browser_channel)
        try:
            log("[1/5] 后台浏览器已就绪（{}），点开登录面板".format(note))
            time.sleep(3)
            log("      " + open_login_panel(page))
            write_state(state_dir, "waiting", "已点开登录面板，等待二维码出现（{}）".format(note),
                        mode="qr")

            deadline = time.time() + args.wait
            last_tick = 0.0
            clicks = 1
            ok = False
            why = "等待中"
            while time.time() < deadline:
                info = probe_page(page)
                # ⚠️ 撞上验证码中间页：写 error 退出，绝不打码/绕验证
                if is_verify_page(info):
                    msg = "被抖音人机验证拦截（title={}），脚本不绕过验证码；" \
                          "请改用 --mode window 在可见窗口里人工处理（{}）".format(
                              (info or {}).get("title", "")[:40], note)
                    log("[失败] " + msg)
                    write_state(state_dir, "error", msg, mode="qr")
                    return 2
                ok, why = logged_in(ctx, page)
                if ok:
                    break
                if info and info.get("expired"):
                    msg = "二维码已失效（{}），请重新发起登录".format(
                        "/".join(info.get("expired")[:2]))
                    log("[失败] " + msg)
                    write_state(state_dir, "expired", msg, mode="qr")
                    return 2

                now = time.time()
                if now - last_tick >= 3:
                    last_tick = now
                    shot = capture_qr(page, qr_path)
                    if shot.get("ok"):
                        msg = "二维码已就绪（{}），请用手机抖音扫码（{}）".format(
                            shot.get("size"), note)
                        write_state(state_dir, "waiting", msg, mode="qr")
                    else:
                        msg = "还在等二维码出现…（{}）".format(note)
                        write_state(state_dir, "waiting", msg, mode="qr")
                        if clicks < 4:
                            clicks += 1
                            log("      没找到二维码，重新点一次「登录」（第 {} 次）".format(clicks))
                            open_login_panel(page)
                time.sleep(0.5)

            if not ok:
                msg = "二维码/登录等超时了（{}s）：{}".format(args.wait, why)
                log("[失败] " + msg)
                write_state(state_dir, "expired", msg, mode="qr")
                return 2

            log("[2/5] 扫码成功（{}），等 5 秒让风控记下这次访问…".format(why))
            write_state(state_dir, "scanned", "已扫码确认，正在导出 cookie", mode="qr")
            time.sleep(5)
            n = to_netscape(ctx.cookies(), args.out)
            log("[3/5] 已写入 {} 条 cookie -> {}".format(n, args.out))
            write_state(state_dir, "ok", "已导出 {} 条 cookie".format(n),
                        cookie_path=args.out, mode="qr")
            return 0
        finally:
            try:
                browser.close()
            except Exception:
                pass


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
def build_parser():
    ap = argparse.ArgumentParser(
        description="抖音登录助手：可见窗口人工登录 / 后台出二维码，成功后导出 netscape cookie",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=("window", "qr"), default="window",
                    help="window=前台可见窗口人工扫码（默认）；qr=后台出二维码图给设置页")
    ap.add_argument("--browser-channel", dest="browser_channel",
                    choices=list(BROWSER_CHANNELS), default="msedge",
                    help="优先用哪个浏览器，默认 msedge（msedge→chrome→内置chromium；"
                         "选 chromium 就只用内置，不再回退）")
    ap.add_argument("--wait", type=int, default=300, help="最多等多少秒，默认 300")
    ap.add_argument("--out", default=None,
                    help="cookie 输出路径（默认取 $DOUYIN_COOKIE_FILE，再退到 "
                         "~/.dsh/cookies/douyin_cookies.txt）")
    ap.add_argument("--state-dir", dest="state_dir", default=None,
                    help="登录临时目录（qr 模式必填，写 state.json 与 qr.png）；"
                         "不填则 qr 默认 $DSH_HOME/douyin-duty/login")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.out = args.out or os.environ.get("DOUYIN_COOKIE_FILE") or DEFAULT_OUT
    args.out = os.path.expanduser(args.out)
    mode = args.mode or "window"
    state_dir = args.state_dir
    if mode == "qr" and not state_dir:
        state_dir = default_state_dir()
    if state_dir:
        state_dir = os.path.abspath(os.path.expanduser(state_dir))

    def fail(message):
        quiet_asyncio_noise()
        log("[失败] " + message)
        if state_dir:
            write_state(state_dir, "error", message, mode=mode)
        return 2

    try:
        if state_dir:
            write_state(state_dir, "waiting", "启动中（mode={}）".format(mode), mode=mode)
        if mode == "qr":
            return run_qr(args, state_dir)
        return run_window(args, state_dir)
    except KeyboardInterrupt:
        return fail("被中断（Ctrl+C）")
    except ImportError as exc:
        return fail("没装 playwright（pip install playwright 后重试）: {}".format(_brief(exc, 160)))
    except Exception as exc:
        return fail(_brief(exc, 300))


if __name__ == "__main__":
    sys.exit(main())
