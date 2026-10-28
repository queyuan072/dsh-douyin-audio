# -*- coding: utf-8 -*-
"""
抖音写操作工具 (Douyin Action) v1.0.0
=====================================
用浏览器自动化**点一个按钮**：视频页的点赞 / 收藏（以及它们的取消）。
除这一个按钮以外什么都不点 —— 不点分享、不点评论图标、不点赞别人的评论、不关注、不发私信。

用法:
    python douyin_action.py --url https://www.douyin.com/video/<id> --action like --json
    python douyin_action.py --url <同上> --action unlike  --json
    python douyin_action.py --url <同上> --action collect --json
    python douyin_action.py --url <同上> --action uncollect --json

输出统一（--json 时 stdout 只有这一行；进度/告警一律走 stderr）:
    成功 {"ok": true,
          "action": "like", "url": "...",
          "before": 1672, "after": 1673, "changed": true,
          "state": "liked", "needLogin": false,
          "clicks": 1, "corrected": false,
          "browser": "msedge", "elapsed": 6.4}
    失败 {"ok": false, "error": "一句话原因", ...}
    state 取值:
      liked / unliked / collected / uncollected = 结束时实测到的状态（= 意图已达成）
      uncertain = 点了两次仍未达到目标状态（也可能一次都没看出变化）
    clicks = 实际点击次数（0/1/2）; corrected = 是否触发了第二次纠正点击
    changed = 最终读数与最初 before 相比是否变化（意图是否达成看 state，不看 changed）

退出码: 0 = 成功（含 changed:false 的「本来就是这样」）; 2 = 失败（含需要登录、验证码、按钮未命中）

意图校正（**不靠 class、不靠 aria-label** —— 真机实测 ariaHits 为空、也没有 action-bar 容器类名）:
  DOM 里读不到「我是否已点赞」，所以不猜当前状态，而是保证**结束状态 = 意图**（最多点 2 次）:
  1. 读 before（innerText 数字）
  2. 点 1 次 -> 先等 1.5 秒、之后每 0.5 秒复读，最多 6 秒 -> after
  3. 意图达成判据：like/collect 要 after > before；unlike/uncollect 要 after < before（相等 = 没看出来 = 未达成）
  4. 未达成 -> 隔 >= 1 秒再点**同一个**按钮 -> 读 after2（以它为准）；判据同样只看方向（after2 与 after 比）
  5. 两次都没达成 -> ok:false、state:'uncertain'、error 写明「两次点击仍未达到目标状态」
  6. 任意一次点击后冒出登录弹窗（[data-e2e] 里出现 login 节点 / 正文出现「登录后」等字样）
     -> 立刻停、不再点第二次、needLogin:true

已知限制（真机实测 / 未验证项，见报告「不确定清单」）:
  * 数字读不出、页面改版时按钮选择器可能全落空 -> 走「按钮没找到」的明确 error，不瞎点。
  * 抖音的点赞数在计数为 0 / 隐藏时可能没有 innerText，此时 before=after=0 -> uncertain。
  * 「已经是点赞状态又要 like」真机上**无法从 DOM 判断**（数字是总数，含别人）—— 所以不做预判，而是做意图校正：
    点完发现方向不对（数字下降）就隔 1 秒再点一次把它点回来，让结束状态等于意图。
    两次都校不回来（比如每次点击都被风控吞掉）就如实返回 ok:false / state:'uncertain'，绝不假装成功。
    页面若提供 aria-pressed / data-pressed / data-active 会先用它短路（真机实测这些属性不存在）。
    unlike/uncollect 且计数为 0 时可以确定「本来就没有」，直接 0 次点击。
  * 不绕过人机验证：撞验证码按 douyin_read.py 的文案报错；--verify-wait N 只是给你 N 秒手动处理的时间。
"""

import argparse
import contextlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# Windows 控制台默认 GBK，打印中文/符号会抛 UnicodeEncodeError —— 钉死 UTF-8（同 douyin_read.py）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DOUYIN_HOST = "https://www.douyin.com"
_DEFAULT_COOKIE_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "cookies", "douyin_cookies.txt")
UA_STRING = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")
# 浏览器候选链：--browser-channel 选首选，其余按下面的顺序兜底（与 douyin_read.py 完全一致）
BROWSER_CHANNELS = ("msedge", "chrome", "chromium", "firefox", "webkit")
CHROMIUM_FAMILY = ("msedge", "chrome", "chromium")

# 人机验证关键词（命中即判定被拦，不做任何绕过）
VERIFY_KEYWORDS = ["请完成下列验证", "完成验证", "人机验证", "验证后继续", "安全验证", "拖动滑块"]
# 登录墙文本信号（未登录访客弹窗）；作为 needLogin 的判据之一
LOGIN_KEYWORDS = ["登录后", "扫码登录", "验证码登录", "密码登录", "暂不登录"]
LOGIN_SELECTOR = '[data-e2e*="login"], [data-e2e*="Login"]'

# 真机实测的按钮选择器（只有 data-e2e 可信）
DIGG_SELECTOR = '[data-e2e="video-player-digg"]'
COLLECT_SELECTOR = '[data-e2e="video-player-collect"]'

# action -> 只允许点这一个按钮；多一个都算越界
ACTION_SELECTOR = {
    "like": DIGG_SELECTOR,
    "unlike": DIGG_SELECTOR,
    "collect": COLLECT_SELECTOR,
    "uncollect": COLLECT_SELECTOR,
}
ALLOWED_SELECTORS = (DIGG_SELECTOR, COLLECT_SELECTOR)
# action -> 目标状态的 state 名
TARGET_STATE = {
    "like": "liked",
    "unlike": "unliked",
    "collect": "collected",
    "uncollect": "uncollected",
}
ACTION_VERB = {
    "like": "点赞",
    "unlike": "取消点赞",
    "collect": "收藏",
    "uncollect": "取消收藏",
}

_COUNT_UNITS = {"万": 10000, "w": 10000, "W": 10000, "亿": 100000000,
                "千": 1000, "k": 1000, "K": 1000}
_VIDEO_ID_RE = re.compile(r"/video/(\d{6,})")
_SHORT_HOSTS = ("v.douyin.com",)
_SHORT_URL_TIMEOUT = 15.0
_COOKIE_SETTLE_MS = 1500     # 点击后第一段静置（策略第 3 步：1.5 秒起等）
_POLL_LIMIT_S = 6.0          # 轮询上限（策略第 3 步：最多 6 秒）
_POLL_STEP_MS = 500
_CORRECTION_GAP_S = 1.0      # 两次点击之间的最小间隔（不连点）

# 点击超时（真机实测教训：用 Playwright 默认的 30 秒 actionability 超时，
# 未登录时按钮被登录弹窗遮住，三级兜底会串成 60~70 秒。这里显式给小预算）
_CLICK_TIMEOUT_MS = 5000           # 普通点击
_CLICK_FORCE_TIMEOUT_MS = 3000     # force 点击
_CLICK_TIMEOUT_LOGIN_MS = 1500     # 页面已经有登录墙时：别在 actionability 上耗
_CLICK_FORCE_TIMEOUT_LOGIN_MS = 800
_GOTO_SETTLE_MS = 1200       # 打开页面后的静置（按钮另有 wait_for_selector，不必久等）
_BUTTON_WAIT_MS = 8000       # 等按钮出现的上限（8 秒够用，慢页面也不该拖 30 秒）

_BROWSER_LOGGED = False


# --------------------------------------------------------------------------
# 错误与日志
# --------------------------------------------------------------------------
class StepError(Exception):
    """某一步失败：step 说明卡在哪一步，reason 一句话原因。绝不让 traceback 漏到 stdout。"""

    def __init__(self, step, reason):
        super().__init__("{}: {}".format(step, reason))
        self.step = step
        self.reason = reason


def _brief(exc, limit=240):
    """异常压成一行短句（playwright 的异常常带多行 call log）"""
    try:
        text = " ".join(str(exc).split())
    except Exception:
        text = exc.__class__.__name__
    return text[:limit] or exc.__class__.__name__


def log(msg):
    """进度/告警走 stderr —— stdout 只留 JSON"""
    try:
        sys.stderr.write("[douyin_action] {}\n".format(msg))
        sys.stderr.flush()
    except Exception:
        pass


def log_browser(channel):
    """[browser] 使用 <channel> —— 成功/失败都要有这一行"""
    global _BROWSER_LOGGED
    _BROWSER_LOGGED = True
    try:
        sys.stderr.write("[browser] 使用 {}\n".format(channel))
        sys.stderr.flush()
    except Exception:
        pass


# --------------------------------------------------------------------------
# cookie（与 douyin_read.py 同规则）
# --------------------------------------------------------------------------
def _resolve_cookie_file(cli_cookies=None):
    """优先级：--cookies > 环境变量 DOUYIN_COOKIE_FILE > ~/.dsh/cookies/douyin_cookies.txt"""
    if cli_cookies:
        return os.path.expanduser(cli_cookies)
    env = os.environ.get("DOUYIN_COOKIE_FILE")
    if env:
        return os.path.expanduser(env)
    return _DEFAULT_COOKIE_FILE


def _cookie_records(cookie_file=None):
    """netscape 行 -> playwright context.add_cookies 的记录列表；坏行逐条跳过"""
    path = cookie_file or _resolve_cookie_file()
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for ln in f:
                ln = ln.rstrip("\n")
                if not ln or ln.startswith("#"):
                    continue
                parts = ln.split("\t")
                if len(parts) < 7:
                    continue
                domain, _flag, cpath, secure, expiry, name, value = parts[:7]
                rec = {
                    "name": name,
                    "value": value,
                    "domain": domain,
                    "path": cpath or "/",
                    "secure": str(secure).upper() == "TRUE",
                }
                # ⚠️ 只给「未过期」的 cookie 带 expires：传已过期的 expires 会让 Playwright 丢掉这几条，
                #    抖音服务端看到残缺会话直接回「验证码中间页」（douyin_read.py 真机实测结论）。
                try:
                    exp = int(float(expiry))
                    if exp > 0 and exp > time.time():
                        rec["expires"] = exp
                except Exception:
                    pass
                out.append(rec)
    except Exception:
        return []
    return out


# --------------------------------------------------------------------------
# 数字解析（"1.2万" -> 12000；解析不出就是 0）
# --------------------------------------------------------------------------
def parse_count(text):
    if text is None:
        return 0
    if isinstance(text, bool):
        return 0
    if isinstance(text, (int, float)):
        return int(text)
    s = str(text).strip().replace(",", "").replace("+", "")
    m = re.search(r"(\d+(?:\.\d+)?)\s*([万亿千wWkK]?)", s)
    if not m:
        return 0
    try:
        val = float(m.group(1))
    except ValueError:
        return 0
    return int(val * _COUNT_UNITS.get(m.group(2), 1))


# --------------------------------------------------------------------------
# 浏览器（惰性导入 playwright；与 douyin_read.py 行为一致）
# --------------------------------------------------------------------------
_LOOP_FILTER_INSTALLED = False


def _install_loop_noise_filter():
    """playwright 传输层初始化失败时 asyncio 会打印 'Future exception was never retrieved' 回溯；
    装一次静音 handler，让失败只留下我们那一行 error —— 不改变任何行为。"""
    global _LOOP_FILTER_INSTALLED
    if _LOOP_FILTER_INSTALLED:
        return
    _LOOP_FILTER_INSTALLED = True
    try:
        import asyncio

        original = asyncio.new_event_loop

        def _quiet_loop(*a, **kw):
            loop = original(*a, **kw)

            def _handler(loop_, context):
                msg = str(context.get("message") or "")
                if "never retrieved" in msg or context.get("future") is not None:
                    return
                loop_.default_exception_handler(context)

            try:
                loop.set_exception_handler(_handler)
            except Exception:
                pass
            return loop

        asyncio.new_event_loop = _quiet_loop
    except Exception:
        pass


def browser_candidates(preferred):
    """按用户选择把候选链排好。Chromium 家族之间互相回退；firefox / webkit 是不同引擎，
    不装就直接报错，绝不静默退到别的内核（否则你以为在测 firefox，其实跑的是 Edge）"""
    preferred = preferred if preferred in BROWSER_CHANNELS else "msedge"
    if preferred == "chrome":
        return ["chrome", "msedge", "chromium"]
    if preferred == "chromium":
        return ["chromium"]
    if preferred in ("firefox", "webkit"):
        return [preferred]
    return ["msedge", "chrome", "chromium"]


def _require_executable(path):
    """--browser-executable 给了就必须真的存在：不存在直接报错，绝不静默改回 msedge"""
    if not path or not str(path).strip():
        return None
    path = os.path.expanduser(os.path.expandvars(str(path).strip()))
    if not os.path.isfile(path):
        raise RuntimeError("指定的浏览器不存在：{}".format(path))
    return path


def _engine(pw, channel):
    """channel -> (playwright 的浏览器类型对象, launch 时要多带的参数)"""
    if channel == "firefox":
        return pw.firefox, {}
    if channel == "webkit":
        return pw.webkit, {}
    if channel in CHROMIUM_FAMILY and channel != "chromium":
        return pw.chromium, {"channel": channel}
    return pw.chromium, {}


def _launch_error(chain, errors):
    """全链条都失败时的报错；单内核（firefox/webkit）给一句能直接照抄的安装命令"""
    detail = " | ".join(errors)
    if len(chain) == 1 and chain[0] in ("firefox", "webkit"):
        return "无法启动 {}（Playwright 未安装该浏览器内核）：先运行 npx playwright install {}｜{}".format(
            chain[0], chain[0], detail)
    return "无法启动浏览器（候选链 {}）: {}".format(" / ".join(chain), detail)


def launch_browser(pw, preferred, launch_kwargs, executable=None):
    """把候选链逐个试 launch，全失败才报错（错误里带每一条的原因）。返回 (browser, channel)
    给了 executable（用户自选浏览器）就直接用它、不走候选链"""
    custom = _require_executable(executable)
    if custom:
        # executable_path 与 channel 互斥；自选浏览器默认按 Chromium 家族处理
        kwargs = dict(launch_kwargs)
        kwargs.pop("channel", None)
        kwargs["executable_path"] = custom
        try:
            browser = pw.chromium.launch(**kwargs)
        except Exception as exc:
            raise RuntimeError("无法用指定的浏览器启动（{}）: {}".format(custom, _brief(exc, 160)))
        log_browser("custom({})".format(os.path.basename(custom)))
        return browser, "custom({})".format(os.path.basename(custom))
    chain = browser_candidates(preferred)
    errors = []
    for channel in chain:
        engine, extra_kwargs = _engine(pw, channel)
        kwargs = dict(launch_kwargs)
        kwargs.pop("channel", None)
        if channel not in CHROMIUM_FAMILY:
            # --autoplay-policy=... / --window-position=... 是 Chromium 系开关，firefox/webkit 传了起不来
            kwargs.pop("args", None)
        kwargs.update(extra_kwargs)
        try:
            browser = engine.launch(**kwargs)
        except Exception as exc:
            errors.append("{}: {}".format(channel, _brief(exc, 160)))
            continue
        log_browser(channel)
        return browser, channel
    raise RuntimeError(_launch_error(chain, errors))


def _context_kwargs(channel):
    """实际 channel 决定要不要覆盖 UA：只有 msedge 覆盖（伪装成 Edge）；
    chrome/chromium/firefox/webkit 一律用浏览器自己的真 UA（否则 UA 与实际内核对不上）"""
    kwargs = {"viewport": {"width": 1600, "height": 900}, "locale": "zh-CN"}
    if channel == "msedge":
        kwargs["user_agent"] = UA_STRING
    return kwargs


@contextlib.contextmanager
def _browser_page(args):
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise StepError("browser", "未安装 playwright（{}）".format(_brief(exc)))

    _install_loop_noise_filter()
    pw = None
    browser = None
    try:
        try:
            pw = sync_playwright().start()
        except Exception as exc:
            raise StepError("browser", "playwright 启动失败: {}".format(_brief(exc)))
        launch_kwargs = {"headless": bool(args.headless)}
        if args.headless:
            launch_kwargs["args"] = ["--autoplay-policy=no-user-gesture-required"]
        elif getattr(args, "window_offscreen", False):
            # 真机实测：headless 打开抖音必吃验证码；可见窗口（且移出屏幕）能过风控。
            launch_kwargs["args"] = ["--window-position=-3000,-3000", "--window-size=1200,900"]
        try:
            browser, channel = launch_browser(pw, args.browser_channel, launch_kwargs,
                                              executable=getattr(args, "browser_executable", None))
        except Exception as exc:
            raise StepError("browser", str(exc))
        args.browser_used = channel
        try:
            ctx = browser.new_context(**_context_kwargs(channel))
        except Exception as exc:
            raise StepError("browser", "无法创建浏览器上下文: {}".format(_brief(exc)))
        records = _cookie_records(args.cookies)
        if records:
            try:
                ctx.add_cookies(records)
                log("已注入 {} 条 cookie".format(len(records)))
            except Exception as exc:
                log("注入 cookie 失败（继续游客态）: {}".format(_brief(exc)))
        else:
            log("没有可用 cookie 文件（游客态继续；点赞/收藏通常需要登录）")
        page = ctx.new_page()
        try:
            page.set_default_timeout(int(args.timeout * 1000))
        except Exception:
            pass
        try:
            yield page
        finally:
            with contextlib.suppress(Exception):
                page.close()
            with contextlib.suppress(Exception):
                ctx.close()
    finally:
        if browser is not None:
            with contextlib.suppress(Exception):
                browser.close()
        if pw is not None:
            with contextlib.suppress(Exception):
                pw.stop()


# --------------------------------------------------------------------------
# 页面小工具
# --------------------------------------------------------------------------
def _page_title(page):
    try:
        return " ".join((page.title() or "").split())
    except Exception:
        return ""


def _body_len(page):
    try:
        return int(page.evaluate(
            "() => (document.body ? (document.body.innerText || '').length : 0)") or 0)
    except Exception:
        return 0


def _body_text(page, limit=20000):
    try:
        return str(page.evaluate(
            "() => (document.body ? (document.body.innerText || '') : '').slice(0, {})".format(limit)) or "")
    except Exception:
        return ""


def _verify_state(page):
    """(是否验证页, 页面标题, 正文长度)。真机实测验证页特征：标题=验证码中间页、正文只剩几个字。"""
    title = _page_title(page)
    body_len = _body_len(page)
    try:
        url = page.url or ""
    except Exception:
        url = ""
    if "/verify" in url or "验证码" in title or "验证" in title:
        return True, title, body_len
    if body_len < 50:
        return True, title, body_len
    body = _body_text(page)
    if [kw for kw in VERIFY_KEYWORDS if kw in (body or "")]:
        return True, title, body_len
    return False, title, body_len


def _verify_message(page):
    """验证页的一句话原因（含页面标题），不是验证页就返回 None"""
    is_verify, title, body_len = _verify_state(page)
    if not is_verify:
        return None
    return "被抖音人机验证拦截（页面标题={}，正文 {} 字）".format(title or "空", body_len)


def _seconds_label(value):
    """4.0 -> "4"，4.5 -> "4.5"（错误文案里要能一眼看出等了几秒）"""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return str(value)
    if abs(num - round(num)) < 1e-6:
        return str(int(round(num)))
    return "{:.1f}".format(num).rstrip("0").rstrip(".")


def _await_verify(page, args, step, verify_hint=None):
    """命中验证页后的处理（文案与 douyin_read.py 一致）。
    --verify-wait 0（默认）：立刻抛 StepError；
    --verify-wait N>0：提示一行后每 2 秒复检，通过就继续，等满 N 秒仍未通过才抛 StepError。
    不点滑块、不绕过：只是给用户手动处理的时间。
    """
    verify_msg = _verify_message(page)
    if not verify_msg:
        return
    wait = float(getattr(args, "verify_wait", 0) or 0)
    if wait <= 0:
        custom = verify_hint(page) if verify_hint else None
        raise StepError(step, custom or verify_msg)
    secs = _seconds_label(wait)
    log("命中人机验证，等你手动处理，最多 {} 秒（{}）".format(secs, verify_msg))
    if getattr(args, "window_offscreen", False):
        log("提示：窗口被移到了屏幕外（--window-offscreen），要手动点滑块得先把窗口拖回来")
    remaining = wait
    while remaining > 0:
        pause = min(2.0, remaining)
        with contextlib.suppress(Exception):
            page.wait_for_timeout(int(round(pause * 1000)))
        remaining -= pause
        is_verify, title, body_len = _verify_state(page)
        if not is_verify:
            log("验证已通过（页面标题={}，正文 {} 字），继续".format(title or "空", body_len))
            return
        if remaining > 0:
            log("仍在验证页，剩余 {} 秒".format(_seconds_label(remaining)))
    custom = verify_hint(page) if verify_hint else None
    raise StepError(step, "命中人机验证，等满 {} 秒仍未通过（{}）".format(secs, custom or verify_msg))


def _resolve_short_url(url, timeout=_SHORT_URL_TIMEOUT):
    """v.douyin.com 短链 -> 最终落地 URL（urllib 跟随跳转）。
    只做一次 GET 拿最终 URL：不保存 cookie、不读页面正文，失败就把原地址原样返回。"""
    raw = (url or "").strip()
    if not raw:
        return raw
    candidate = raw
    if re.match(r"^v\.douyin\.com/", candidate):
        candidate = "https://" + candidate
    try:
        parts = urllib.parse.urlsplit(candidate)
    except Exception:
        return raw
    if (parts.hostname or "").lower() not in _SHORT_HOSTS:
        return raw
    req = urllib.request.Request(candidate, method="GET",
                                 headers={"User-Agent": UA_STRING,
                                          "Referer": DOUYIN_HOST + "/"})
    opener = urllib.request.build_opener()  # 默认 opener：不装 cookie jar，不留任何凭证
    try:
        with opener.open(req, timeout=timeout) as resp:
            final = (resp.geturl() or "").strip()
            with contextlib.suppress(Exception):
                resp.read(2048)  # 读一点点就断开，不把落地页整个拉下来
    except Exception as exc:
        log("短链解析失败（{}），沿用原地址: {}".format(_brief(exc, 120), candidate))
        return raw
    if not final.startswith("http"):
        log("短链解析没拿到有效地址（{}），沿用原地址".format(_brief(final, 120) or "空"))
        return raw
    if final.rstrip("/") == candidate.rstrip("/"):
        log("短链没有跳转（可能已失效），沿用原地址: {}".format(candidate))
        return raw
    log("短链已解析: {} -> {}".format(candidate, final))
    return final


def _video_url(raw):
    """接受完整 URL、/video/<id>、裸 id 或短链，统一成可打开的地址"""
    if not raw:
        raise StepError("url", "缺少 --url")
    raw = raw.strip()
    if re.fullmatch(r"\d{6,}", raw):
        return "{}/video/{}".format(DOUYIN_HOST, raw)
    m = _VIDEO_ID_RE.search(raw)
    if m:
        return "{}/video/{}".format(DOUYIN_HOST, m.group(1))
    if raw.startswith("http") or re.match(r"^v\.douyin\.com/", raw):
        return raw  # 短链交给 _goto 里的 _resolve_short_url
    raise StepError("url", "无法识别的视频地址: {}".format(raw[:120]))


def _goto(page, url, args, step, verify_hint=None):
    """打开页面；被验证页挡住就抛 StepError"""
    url = _resolve_short_url(url)
    log("打开 {}".format(url))
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=int(args.timeout * 1000))
    except Exception as exc:
        raise StepError(step, "打开页面失败: {}".format(_brief(exc)))
    try:
        page.wait_for_timeout(_GOTO_SETTLE_MS)
    except Exception:
        pass
    _await_verify(page, args, step, verify_hint)
    return url


# --------------------------------------------------------------------------
# 按钮读写（只用 data-e2e；不碰 class、不碰 aria-label）
# --------------------------------------------------------------------------
def _locator(page, selector):
    try:
        return page.locator(selector).first
    except Exception as exc:
        raise StepError("locate", "无法定位 {}: {}".format(selector, _brief(exc)))


def _present(page, selector):
    try:
        return int(page.locator(selector).count()) > 0
    except Exception:
        return False


def _read_count(page, selector):
    """读按钮 innerText 里的数字（点赞数 / 收藏数）。读不到就是 0。"""
    loc = _locator(page, selector)
    text = ""
    for attempt in (1, 2):
        try:
            text = loc.inner_text(timeout=4000)
            break
        except Exception as exc:
            if attempt == 2:
                log("读不到 {} 的文本（{}），按 0 计".format(selector, _brief(exc, 120)))
            else:
                with contextlib.suppress(Exception):
                    page.wait_for_timeout(300)
    return parse_count(text)


_PRESSED_JS = """(sel) => {
  try {
    const e = document.querySelector(sel);
    if (!e) return null;
    const attrs = ['aria-pressed', 'data-pressed', 'data-active'];
    for (const a of attrs) {
      const v = e.getAttribute(a);
      if (v !== null) {
        const s = String(v).toLowerCase();
        return (s === 'true' || s === '1') ? true : ((s === 'false' || s === '0') ? false : null);
      }
    }
    return null;
  } catch (err) { return null; }
}"""

_JS_CLICK = """(sel) => {
  try {
    const e = document.querySelector(sel);
    if (!e) return false;
    e.click();
    return true;
  } catch (err) { return false; }
}"""


def _pressed_hint(page, selector):
    """按钮是否已处于「按下」态：只认 aria-pressed / data-pressed / data-active 这类非 class 标记。
    真机实测这些属性都不存在 -> 返回 None（未知），此时一律靠 before/after 判定。"""
    try:
        val = page.evaluate(_PRESSED_JS, selector)
    except Exception:
        return None
    return val if isinstance(val, bool) else None


def _login_present(page):
    """(是否有 login 节点, 命中的正文关键词)。真机未登录访客页可能一进来就有弹窗，所以要分「点击前/后」比较。"""
    nodes = 0
    try:
        nodes = int(page.locator(LOGIN_SELECTOR).count())
    except Exception:
        nodes = 0
    body = _body_text(page)
    hits = [kw for kw in LOGIN_KEYWORDS if kw in (body or "")]
    return nodes, hits


def _click_budgets(timeout_s=30.0, login_wall=False):
    """(普通点击超时ms, force 点击超时ms)。
    默认 5s / 3s；页面已经有登录墙时缩到 1.5s / 0.8s（反正点不进去，别耗）。
    两者都被 --timeout 封顶：--timeout 给得更小时预算跟着变小。"""
    cap_ms = int(max(0.5, float(timeout_s or 30.0)) * 1000)
    if login_wall:
        return min(_CLICK_TIMEOUT_LOGIN_MS, cap_ms), min(_CLICK_FORCE_TIMEOUT_LOGIN_MS, cap_ms)
    return min(_CLICK_TIMEOUT_MS, cap_ms), min(_CLICK_FORCE_TIMEOUT_MS, cap_ms)


def _click_button(page, selector, action, timeout_s=30.0, login_wall=False):
    """只点这一个按钮。三级尝试都只作用于它自己：普通点击 -> force 点击 -> 元素自身 .click()。
    每级都带显式短超时并记录本级耗时 —— 绝不让 Playwright 默认 30 秒超时把关卡串成 70 秒。"""
    if selector not in ALLOWED_SELECTORS:
        raise StepError(action, "内部保护：拒绝点击非目标按钮 {}".format(selector))
    loc = _locator(page, selector)
    normal_ms, force_ms = _click_budgets(timeout_s, login_wall)
    errors = []
    if login_wall:
        log("页面已有登录墙，点击预算收短为 {}ms / {}ms".format(normal_ms, force_ms))

    started = time.monotonic()
    try:
        loc.click(timeout=normal_ms)
        log("点击方式: 普通点击（{}，{}ms）".format(selector, normal_ms))
        return "normal"
    except Exception as exc:
        errors.append("normal({}ms, {:.1f}s): {}".format(
            normal_ms, time.monotonic() - started, _brief(exc, 140)))
        log("普通点击没成（{}ms 内），改用 force".format(normal_ms))

    started = time.monotonic()
    try:
        loc.click(timeout=force_ms, force=True)
        log("点击方式: force 点击（{}，{}ms）".format(selector, force_ms))
        return "force"
    except Exception as exc:
        errors.append("force({}ms, {:.1f}s): {}".format(
            force_ms, time.monotonic() - started, _brief(exc, 140)))
        log("force 点击也没成（{}ms 内），改用元素自身 .click()".format(force_ms))

    started = time.monotonic()
    try:
        if page.evaluate(_JS_CLICK, selector):
            log("点击方式: 元素自身 .click()（{}，{:.1f}s）".format(
                selector, time.monotonic() - started))
            return "js"
        errors.append("js({:.1f}s): 元素不存在".format(time.monotonic() - started))
    except Exception as exc:
        errors.append("js({:.1f}s): {}".format(time.monotonic() - started, _brief(exc, 140)))
    raise StepError(action, "点击失败（三级兜底都失败）: {}".format(" | ".join(errors)))


def _wait_change(page, selector, baseline, login_probe=None):
    """点完之后的读数：先等 1.5 秒，再每 0.5 秒复读一次，最多 6 秒。
    读数离开 baseline 就立刻返回；login_probe 一旦返回 True（冒出了登录墙）也立刻返回，
    别再对着一个点不动的按钮空等 6 秒。"""
    with contextlib.suppress(Exception):
        page.wait_for_timeout(_COOKIE_SETTLE_MS)
    after = _read_count(page, selector)
    if after != baseline:
        return after
    if login_probe is not None and login_probe():
        log("冒出登录拦截，停止轮询（不再空等）")
        return after
    waited = _COOKIE_SETTLE_MS / 1000.0
    while waited < _POLL_LIMIT_S:
        with contextlib.suppress(Exception):
            page.wait_for_timeout(_POLL_STEP_MS)
        waited += _POLL_STEP_MS / 1000.0
        after = _read_count(page, selector)
        if after != baseline:
            return after
        if login_probe is not None and login_probe():
            log("冒出登录拦截，停止轮询（不再空等）")
            return after
    return after


def _payload(action, url, before, after, changed, state, need_login=False, error=None,
             clicks=0, corrected=False):
    payload = {
        "ok": error is None,
        "action": action,
        "url": url,
        "before": before,
        "after": after,
        "changed": bool(changed),
        "state": state,
        "needLogin": bool(need_login),
        "clicks": int(clicks),
        "corrected": bool(corrected),
    }
    if error is not None:
        payload["error"] = error
    return payload


def _intent_met(action, prev, now):
    """这一次点击有没有把状态推向意图：like/collect 要数字变大，unlike/uncollect 要数字变小。
    相等 = 看不出变化 = 未达成（不猜）。"""
    if now == prev:
        return False
    if action in ("like", "collect"):
        return now > prev
    return now < prev


def _login_appeared(page, pre_nodes, pre_hits):
    """点击后登录信号是否变多了（节点数或正文关键词命中数）—— 轮询里用作「别等了」的探针。"""
    post_nodes, post_hits = _login_present(page)
    return (post_nodes > pre_nodes) or (len(post_hits) > len(pre_hits))


def _login_reason(page, pre_nodes, pre_hits, prev, after):
    """点击后是否出现登录拦截；命中返回一句原因，否则 None。
    「点击后才冒出」才算；点击前就有但点击完全没反应，也按需要登录处理（否则会把登录墙误判成 uncertain）。"""
    post_nodes, post_hits = _login_present(page)
    appeared = (post_nodes > pre_nodes) or (len(post_hits) > len(pre_hits))
    if appeared or ((post_nodes or post_hits) and after == prev):
        return "登录弹窗节点 {}->{}，正文关键词 {}->{}".format(
            pre_nodes, post_nodes, pre_hits or "无", post_hits or "无")
    return None


def perform(page, args, action, url=None):
    """对当前页面执行一次写操作并返回信封（不含 browser / elapsed，由 main 补齐）。
    不启动浏览器、不打开页面 —— 便于用假 page 桩做分支测试。"""
    step = str(action or "action")
    if action not in ACTION_SELECTOR:
        raise StepError(step, "未知动作: {}".format(action))
    selector = ACTION_SELECTOR[action]
    target_state = TARGET_STATE[action]
    verb = ACTION_VERB[action]

    if not _present(page, selector):
        raise StepError(step, "按钮没找到（{} 未命中；页面可能不是视频页，或抖音改版了）".format(selector))

    before = _read_count(page, selector)
    log("{} 前：{} = {}".format(verb, selector, before))
    pre_nodes, pre_hits = _login_present(page)
    pressed = _pressed_hint(page, selector)
    if pressed is not None:
        log("页面提供了按下标记：{}".format(pressed))

    want_pressed = action in ("like", "collect")
    if pressed is not None and pressed == want_pressed:
        log("按钮已处于目标状态（非 class 标记），不重复点击")
        return _payload(action, url, before, before, False, target_state, clicks=0)

    if pressed is None and action in ("unlike", "uncollect") and before == 0:
        log("计数为 0，本来就没{}，不点击".format(verb[2:] if len(verb) > 2 else verb))
        return _payload(action, url, 0, 0, False, target_state, clicks=0)

    timeout_s = getattr(args, "timeout", 30.0)
    login_wall = bool(pre_nodes or pre_hits)   # 页面上已经有登录提示：点击预算收短，别在 actionability 上耗
    login_error = ("需要登录：点击后弹出了登录窗口（{}），未登录状态不能{}；"
                   "请先扫码登录（douyin_login_start）后重试")
    # 已有登录墙时更不用等：数字不动就是被墙挡住（_login_reason 会判 needLogin），
    # 真机实测这一条把「未登录」场景从 70 秒压到十几秒
    probe = lambda: login_wall or _login_appeared(page, pre_nodes, pre_hits)

    # ---- 第 1 次点击 ----
    _click_button(page, selector, action, timeout_s=timeout_s, login_wall=login_wall)
    clicks = 1
    clicked_at = time.monotonic()
    after = _wait_change(page, selector, before, login_probe=probe)
    if after == before:
        log("第 1 次点击后仍是 {}（等满 {} 秒无变化）".format(after, _seconds_label(_POLL_LIMIT_S)))

    reason = _login_reason(page, pre_nodes, pre_hits, before, after)
    if reason:
        log("判定需要登录（{}），停止后续点击".format(reason))
        return _payload(action, url, before, after, after != before, "uncertain", need_login=True,
                        clicks=clicks, corrected=False, error=login_error.format(reason, verb))

    if _intent_met(action, before, after):
        return _payload(action, url, before, after, after != before, target_state,
                        clicks=clicks, corrected=False)

    # ---- 方向不对：隔 >=1 秒再点同一个按钮，把状态纠正回意图 ----
    first = after
    gap = _CORRECTION_GAP_S - (time.monotonic() - clicked_at)
    if gap > 0:
        log("纠正点击前再等 {} 秒（不连点）".format(_seconds_label(gap)))
        with contextlib.suppress(Exception):
            page.wait_for_timeout(int(gap * 1000))
    log("第 1 次点击方向不对（{} -> {}），再点一次纠正到「{}」".format(before, first, target_state))
    _click_button(page, selector, action, timeout_s=timeout_s, login_wall=login_wall)
    clicks = 2
    after = _wait_change(page, selector, first, login_probe=probe)
    if after == first:
        log("第 2 次点击后仍是 {}（等满 {} 秒无变化）".format(after, _seconds_label(_POLL_LIMIT_S)))

    reason = _login_reason(page, pre_nodes, pre_hits, first, after)
    if reason:
        log("判定需要登录（{}），停止后续点击".format(reason))
        return _payload(action, url, before, after, after != before, "uncertain", need_login=True,
                        clicks=clicks, corrected=True, error=login_error.format(reason, verb))

    if _intent_met(action, first, after):
        log("纠正成功：{} -> {}".format(first, after))
        return _payload(action, url, before, after, after != before, target_state,
                        clicks=clicks, corrected=True)

    log("纠正失败：{} -> {}，两次点击都没达到目标状态".format(first, after))
    return _payload(action, url, before, after, after != before, "uncertain",
                    clicks=clicks, corrected=True,
                    error="两次点击仍未达到目标状态（{}：{} -> {} -> {}）".format(verb, before, first, after))


def run(args):
    """打开视频页 -> 定位按钮 -> 按状态判定策略执行"""
    action = args.action
    url = _video_url(args.url)
    with _browser_page(args) as page:
        opened = _goto(page, url, args, action)
        if action in ("like", "collect"):
            with contextlib.suppress(Exception):
                _login_wall_note(page, action)
        try:
            page.wait_for_selector(ACTION_SELECTOR[action],
                                   timeout=min(_BUTTON_WAIT_MS, int(args.timeout * 1000)))
        except Exception:
            pass  # 交给 perform 给明确文案
        return perform(page, args, action, url=opened)


def _login_wall_note(page, action):
    """点击前就那么一眼：有登录墙就提示一句（不阻断 —— 详情页对游客也会弹，判据见 perform）"""
    nodes, hits = _login_present(page)
    if nodes or hits:
        log("页面已有登录提示（节点 {}，关键词 {}），若点击无效会按需要登录返回".format(
            nodes, hits or "无"))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        prog="douyin_action.py",
        description="抖音写操作工具：只点视频页的点赞 / 收藏按钮（like / unlike / collect / uncollect），"
                    "除此之外不点任何东西",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("示例:\n"
                "  python douyin_action.py --url https://www.douyin.com/video/<id> --action like --json\n"
                "  python douyin_action.py --url https://www.douyin.com/video/<id> --action uncollect --json\n"
                "  python douyin_action.py --url <id> --action collect --no-headless --verify-wait 60\n"
                "\n"
                "输出: 成功 {ok:true, action, url, before, after, changed, state, needLogin,\n"
                "             clicks, corrected, browser, elapsed}\n"
                "      失败 {ok:false, error, ...} 退出码 2\n"),
    )
    ap.add_argument("--url", required=True, metavar="URL",
                    help="视频地址 https://www.douyin.com/video/<id>（也接受裸 id 与 v.douyin.com 短链）")
    ap.add_argument("--action", required=True, choices=sorted(ACTION_SELECTOR),
                    help="like=点赞 / unlike=取消点赞 / collect=收藏 / uncollect=取消收藏")
    ap.add_argument("--cookies", default=None, metavar="FILE",
                    help="抖音 cookie 文件（默认取环境变量 DOUYIN_COOKIE_FILE，"
                         "再退回 ~/.dsh/cookies/douyin_cookies.txt）")
    ap.add_argument("--headless", dest="headless", action="store_true", default=True,
                    help="后台运行不显示窗口（默认开）")
    ap.add_argument("--no-headless", dest="headless", action="store_false",
                    help="显示浏览器窗口（调试用）")
    ap.add_argument("--verify-wait", dest="verify_wait", type=float, default=0.0, metavar="SEC",
                    help="命中人机验证后最多等多少秒让你手动处理；默认 0 = 立刻报错退出")
    ap.add_argument("--window-offscreen", dest="window_offscreen", action="store_true",
                    help="配合 --no-headless：把浏览器窗口移到屏幕外（真机实测可过风控且不打扰桌面）")
    ap.add_argument("--browser-channel", dest="browser_channel",
                    choices=list(BROWSER_CHANNELS), default="msedge",
                    help="优先用哪个浏览器内核，默认 msedge（msedge→chrome→内置chromium，"
                         "Chromium 家族之间互相回退；firefox / webkit 需先 npx playwright install，不装就报错、不回退）")
    ap.add_argument("--browser-executable", dest="browser_executable", default=None, metavar="PATH",
                    help="用指定的浏览器可执行文件启动（覆盖 --browser-channel：按 Chromium 内核处理、"
                         "不回退；路径不存在直接报错）")
    ap.add_argument("--timeout", type=float, default=30.0, metavar="SEC",
                    help="单步超时秒数，默认 30")
    ap.add_argument("--json", action="store_true",
                    help="stdout 只输出一行 JSON（进度信息走 stderr）")
    args = ap.parse_args(argv)
    args.timeout = max(3.0, min(float(args.timeout), 300.0))
    args.verify_wait = max(0.0, min(float(getattr(args, "verify_wait", 0) or 0), 300.0))
    return args


def browser_used(args):
    """实际用上的 channel；还没启动成功（早失败）就回报请求的那个"""
    if args is None:
        return "msedge"
    return getattr(args, "browser_used", None) or getattr(args, "browser_channel", "msedge")


def _emit(payload, as_json):
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    if not payload.get("ok"):
        print("失败: {}".format(payload.get("error")))
        return
    print("{}: {} -> {} ({}{})".format(
        payload.get("action"), payload.get("before"), payload.get("after"),
        payload.get("state"), "，已变化" if payload.get("changed") else "，未变化"))


def main(argv=None):
    start = time.time()
    args = None
    payload = None
    try:
        args = parse_args(argv)
        payload = run(args)
    except StepError as exc:
        payload = {"ok": False, "error": "{}: {}".format(exc.step, exc.reason), "needLogin": False}
    except KeyboardInterrupt:
        payload = {"ok": False, "error": "已中断", "needLogin": False}
    except Exception as exc:
        payload = {"ok": False, "error": "未预期错误: {}".format(_brief(exc)), "needLogin": False}
    if payload is None:
        payload = {"ok": False, "error": "未预期错误：没有结果", "needLogin": False}

    channel = browser_used(args)
    payload["browser"] = channel
    payload["elapsed"] = round(time.time() - start, 2)
    payload.setdefault("action", getattr(args, "action", None) if args is not None else None)
    payload.setdefault("url", getattr(args, "url", None) if args is not None else None)
    payload.setdefault("before", None)
    payload.setdefault("after", None)
    payload.setdefault("changed", False)
    payload.setdefault("state", "uncertain")
    payload.setdefault("needLogin", False)
    payload.setdefault("clicks", 0)
    payload.setdefault("corrected", False)

    if not _BROWSER_LOGGED:
        log_browser(channel)  # 早失败（没到 launch）也要有这一行

    as_json = bool(getattr(args, "json", False)) if args is not None else False
    _emit(payload, as_json)
    return 0 if payload.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
