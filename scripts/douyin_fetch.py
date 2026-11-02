#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音「给定链接 → 精准提取」v1.4.0 (Douyin Fetch)
================================================
和 douyin_scroller.py 的「盲刷推荐流」互补：这里给定一个链接，精准拿一段文本。

两条路，字幕优先：
  1) 字幕：yt-dlp --write-subs --write-auto-subs --sub-langs 'zh.*,zh-Hans,en.*' --skip-download
     → 解析 .vtt / .srt → segments + text，source="subtitle"；**不下载音轨、不跑 ASR**。
  2) 无字幕：yt-dlp 取音轨 → 复用 transcribe_douyin 的分片 + 静音吸附管线 → source="asr"。
  3) 两条都不通（无 yt-dlp / 网络失败 / 私密视频）→ ok=false，reason 写清是哪一步失败。

分段、静音吸附、写 .srt、外部程序探测都直接 import transcribe_douyin 里的实现，不复制一份。

用法:
  python scripts/douyin_fetch.py --url https://www.douyin.com/video/<id>
  python scripts/douyin_fetch.py --url https://v.douyin.com/xxxx/ --srt out.srt
  python scripts/douyin_fetch.py --url <URL> --no-asr            # 只许字幕，没字幕就失败
  python scripts/douyin_fetch.py --url <URL> --no-subtitle       # 跳过字幕，直接下载音轨跑 ASR
  python scripts/douyin_fetch.py --file clip.mp4 --no-asr        # 本地文件 + 同名 .vtt/.srt（测试用）

stdout 只输出一个 JSON 对象（进度一律走 stderr），字段：
  {"ok","url","finalUrl","title","author","duration","source","subtitleLang",
   "text","textLength","truncated","segments","reason","elapsed"}
  · textLength = --max-chars 截断前的原长；truncated = 是否截断（segments 始终保持完整时间轴）
退出码: ok=true → 0；ok=false → 2（沿用本项目其它脚本的约定）
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import transcribe_douyin as td  # noqa: E402  —— 分片/静音吸附/写 srt/工具探测都复用它

VERSION = "1.4.0"

# 字幕语言优先级：中文优先，英文兜底（抖音自身字幕偶尔是 en 自动生成）
SUB_LANGS = "zh.*,zh-Hans,en.*"
SHORT_HOSTS = ("v.douyin.com",)
SHORT_URL_TIMEOUT = 15.0
META_TEMPLATE = "%(title)s|%(uploader)s|%(duration)s"

_TS = r"(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}"
_CUE_RE = re.compile(r"^\s*(" + _TS + r")\s*-->\s*(" + _TS + r")")
_TS_RE = re.compile(r"^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$")
_TAG_RE = re.compile(r"<[^>]*>")
_ENTITIES = (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
             ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&"))
_LANG_IN_NAME_RE = re.compile(r"\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.(?:vtt|srt)$", re.I)


class FetchError(RuntimeError):
    """带「哪一步」的失败：reason 必须能看出是字幕探测、下载音轨还是转写挂了。"""

    def __init__(self, step: str, detail: str) -> None:
        super().__init__(f"{step}: {detail}")
        self.step = step
        self.detail = detail

    def reason(self) -> str:
        return f"{self.step}失败（{self.detail}）"


# --------------------------------------------------------------------------
# 链接归一化：短链先解析成最终地址
# --------------------------------------------------------------------------
def normalize_url(raw: str) -> str:
    """补协议头 + 去掉分享文案里粘在链接后面的字。"""
    url = (raw or "").strip()
    if not url:
        return url
    m = re.search(r"https?://[^\s]+", url)
    if m:
        url = m.group(0)
    elif re.match(r"^(?:v|www|m)\.douyin\.com/", url, re.I):
        url = "https://" + url
    return url


def resolve_short_url(url: str, timeout: float = SHORT_URL_TIMEOUT) -> tuple[str, str]:
    """v.douyin.com 短链 → 落地地址。返回 (最终地址, 备注)；失败沿用原地址、绝不抛。"""
    try:
        parts = urllib.parse.urlsplit(url)
    except Exception:
        return url, "地址无法解析"
    if (parts.hostname or "").lower() not in SHORT_HOSTS:
        return url, ""
    req = urllib.request.Request(url, method="GET",
                                 headers={"User-Agent": td.DEFAULT_UA,
                                          "Referer": "https://www.douyin.com/"})
    try:
        opener = urllib.request.build_opener()
        with opener.open(req, timeout=timeout) as resp:
            final = (resp.geturl() or "").strip()
            with contextlib.suppress(Exception):
                resp.read(2048)  # 只取落地地址，不把整页拉下来
    except Exception as exc:
        return url, f"短链解析失败({td.one_line(exc, 120)})"
    if not final.startswith("http") or final.rstrip("/") == url.rstrip("/"):
        return url, "短链没有跳转（可能已失效）"
    return final, ""


# --------------------------------------------------------------------------
# 字幕解析：vtt / srt → [(start, end, text)]
# --------------------------------------------------------------------------
def _parse_ts(text: str) -> float:
    m = _TS_RE.match(text.strip())
    if not m:
        return 0.0
    hh, mm, ss, ms = m.groups()
    frac = float("0." + ms)
    return int(hh or 0) * 3600 + int(mm) * 60 + int(ss) + frac


def clean_cue_text(raw: str) -> str:
    """去掉 <c>/<00:00:01.000> 之类的行内标记与实体，压成一行。"""
    text = _TAG_RE.sub("", raw or "")
    for src, dst in _ENTITIES:
        text = text.replace(src, dst)
    return " ".join(text.split())


def _cues_from_blocks(blocks: list[list[str]]) -> list[tuple[float, float, list[str]]]:
    """块 → [(start, end, [逐行文本])]。保留「行」是因为自动字幕的重复是按行滚动的。"""
    cues: list[tuple[float, float, list[str]]] = []
    for lines in blocks:
        times = None
        body: list[str] = []
        for line in lines:
            if times is None:
                m = _CUE_RE.match(line)
                if m:
                    times = (_parse_ts(m.group(1)), _parse_ts(m.group(2)))
                continue
            body.append(line)
        if times is None:
            continue
        cleaned = [clean_cue_text(line) for line in body]
        cleaned = [line for line in cleaned if line]
        if cleaned:
            cues.append((times[0], times[1], cleaned))
    return cues


def parse_vtt(text: str) -> list[tuple[float, float, list[str]]]:
    """WEBVTT → cues。跳过 WEBVTT 头 / NOTE / STYLE / REGION 块与时间轴设置。"""
    blocks: list[list[str]] = []
    cur: list[str] = []
    skip_block = False
    for line in (text or "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not line.strip():
            if cur and not skip_block:
                blocks.append(cur)
            cur, skip_block = [], False  # 空行同时结束「跳过的头部块」，否则首条 cue 会被吞
            continue
        head = line.strip()
        if not cur and (head.startswith("WEBVTT") or head.startswith("NOTE")
                        or head.startswith("STYLE") or head.startswith("REGION")
                        or head.startswith("Kind:") or head.startswith("Language:")):
            skip_block = True
            continue
        cur.append(line)
    if cur and not skip_block:
        blocks.append(cur)
    return _cues_from_blocks(blocks)


def parse_srt(text: str) -> list[tuple[float, float, list[str]]]:
    """SRT → cues。序号行由 _cues_from_blocks 自然忽略。"""
    blocks: list[list[str]] = []
    cur: list[str] = []
    for line in (text or "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not line.strip():
            if cur:
                blocks.append(cur)
                cur = []
            continue
        cur.append(line)
    if cur:
        blocks.append(cur)
    return _cues_from_blocks(blocks)


def parse_subtitle_text(text: str, filename: str = "") -> list[tuple[float, float, list[str]]]:
    """按扩展名优先、内容兜底选解析器（yt-dlp 也会产出 .srt）。"""
    if str(filename).lower().endswith(".srt"):
        return parse_srt(text)
    if str(filename).lower().endswith(".vtt"):
        return parse_vtt(text)
    return parse_srt(text) if re.search(r"^\s*\d+\s*$", (text or "")[:400], re.M) else parse_vtt(text)


# --------------------------------------------------------------------------
# cues → segments：滚动字幕去重 + 时间单调
# --------------------------------------------------------------------------
def build_segments(cues: list[tuple[float, float, list[str]]]) -> list[dict]:
    """
    自动字幕的「滚动重复」有两层，都要去：
      · 行级：本 cue 的行如果上一条 cue 已经显示过，就不再算新内容
        （YouTube 式 [A] → [A, B] → [B] 会退化成 A、B 两句，不会 A、A B、B）；
      · 文本级：整条等于/接在上一条尾部 → 只延长时长；以上一条开头 → 用更长的取代。
    结果是 text 拼接无重复行，start 天然单调（末尾再 clamp 一层兜底）。
    """
    segs: list[dict] = []
    prev_lines: list[str] = []
    for start, end, lines in cues:
        start = max(0.0, float(start))
        span = max(0.001, float(end) - start)
        fresh = [line for line in (lines or []) if line and line not in prev_lines]
        prev_lines = [line for line in (lines or []) if line]
        text = " ".join(fresh).strip()
        if segs:
            last = segs[-1]
            last_end = last["start"] + last["dur"]
            if not text or text == last["text"] or last["text"].endswith(text):
                last["dur"] = round(max(last_end, start + span) - last["start"], 3)
                continue
            if text.startswith(last["text"]):
                last["text"] = text
                last["dur"] = round(max(last_end, start + span) - last["start"], 3)
                continue
        elif not text:
            continue
        segs.append({"start": round(start, 3), "dur": round(span, 3), "text": text})
    # 时间单调：后一段不得早于前一段起点
    floor = 0.0
    for seg in segs:
        if seg["start"] < floor:
            seg["start"] = round(floor, 3)
        floor = max(floor, seg["start"])
    return segs


def _sub_lang_rank(name: str) -> int:
    m = _LANG_IN_NAME_RE.search(name or "")
    lang = (m.group(1).lower() if m else "")
    if lang.startswith("zh-hans") or lang == "zh":
        return 0
    if lang.startswith("zh"):
        return 1
    if lang.startswith("en"):
        return 2
    return 3


def _lang_of(name: str) -> str:
    m = _LANG_IN_NAME_RE.search(name or "")
    return m.group(1) if m else ""


def pick_subtitle_file(files: list[str]) -> str:
    """同一次下载可能落多个语言：按 中文 > 英文 > 其它、vtt > srt 选一条。"""
    subs = [f for f in files if f.lower().endswith((".vtt", ".srt"))]
    if not subs:
        return ""
    return sorted(subs, key=lambda p: (_sub_lang_rank(os.path.basename(p)),
                                       0 if p.lower().endswith(".vtt") else 1,
                                       os.path.basename(p)))[0]


def subtitle_sidecars(media_path: str) -> list[str]:
    """--file 测试/本地用法：取同目录下同名（或以文件名打头）的 .vtt/.srt。"""
    path = os.path.abspath(media_path)
    folder = os.path.dirname(path) or "."
    stem = os.path.splitext(os.path.basename(path))[0]
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    out = []
    for name in names:
        if not name.lower().endswith((".vtt", ".srt")):
            continue
        if name.startswith(stem + ".") or os.path.splitext(name)[0] == stem:
            out.append(os.path.join(folder, name))
    return out


# --------------------------------------------------------------------------
# 外部命令
# --------------------------------------------------------------------------
def _run(cmd: list[str], timeout: int, step: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise FetchError(step, f"找不到可执行文件 {cmd[0]}") from None
    except subprocess.TimeoutExpired:
        raise FetchError(step, f"超时(>{timeout}s)") from None


_YTDLP_HINTS = (
    ("Fresh cookies", "yt-dlp 的抖音解析要签名参数，本机 cookie 通不过（不是登录问题）"),
    ("Unsupported URL", "yt-dlp 没有该地址的 extractor（抖音图文 /note/ 页就是这样）"),
    ("Private", "视频是私密的（需要作者授权）"),
    ("unavailable", "视频已删除或不可用"),
    ("Sign in", "需要登录态：cookie 失效或没给 --cookies"),
    ("HTTP Error 4", "服务端 4xx：地址失效或触发风控"),
)

def hint_for(tail: str) -> str:
    """把 yt-dlp 的 stderr 归到一句人话，方便 reason 直接看出怎么办。"""
    low = (tail or "").lower()
    for needle, hint in _YTDLP_HINTS:
        if needle.lower() in low:
            return hint
    return ""


def _ytdlp_fail(step: str, cp: subprocess.CompletedProcess) -> "FetchError":
    tail = td.one_line((cp.stderr or b"").decode("utf-8", "replace")[-600:], 400)
    hint = hint_for(tail)
    detail = f"yt-dlp 退出码 {cp.returncode}: {tail or '(无 stderr)'}"
    return FetchError(step, f"{detail}｜{hint}" if hint else detail)


def _cookie_copy(cookies: str | None, work_dir: str) -> tuple[list[str], str]:
    """yt-dlp 收尾会回写 cookie 文件；给原文件在只读/沙箱环境会 Errno 13 —— 给副本。"""
    arg: list[str] = []
    copy_path = ""
    if cookies and os.path.exists(cookies):
        try:
            copy_path = os.path.join(work_dir, f"cookies_{os.getpid()}.txt")
            shutil.copyfile(cookies, copy_path)
            arg = ["--cookies", copy_path]
        except OSError:
            copy_path = ""
    return arg, copy_path


def probe_subtitles(yt_dlp: str, url: str, work_dir: str, cookies: str | None,
                    timeout: int = 180) -> tuple[list[str], dict]:
    """只下字幕（--skip-download）。返回 (落盘的字幕文件, 元数据)。"""
    meta_path = os.path.join(work_dir, "meta.txt")
    cookie_arg, cookie_copy = _cookie_copy(cookies, work_dir)
    cmd = [yt_dlp, "--no-playlist", "--no-warnings", "--skip-download",
           "--write-subs", "--write-auto-subs", "--sub-langs", SUB_LANGS,
           "--sub-format", "vtt/srt/best", "--retries", "1",
           "--user-agent", td.DEFAULT_UA,
           "-o", os.path.join(work_dir, "sub.%(id)s.%(ext)s"),
           "--print-to-file", META_TEMPLATE, meta_path]
    cmd += cookie_arg
    cmd.append(url)
    try:
        cp = _run(cmd, timeout, "字幕探测")
    finally:
        if cookie_copy:
            with contextlib.suppress(OSError):
                os.remove(cookie_copy)
    meta = read_meta(meta_path)
    files = sorted(os.path.join(work_dir, n) for n in os.listdir(work_dir)
                   if n.lower().endswith((".vtt", ".srt")))
    if cp.returncode != 0 and not files:
        raise _ytdlp_fail("字幕探测", cp)
    return files, meta


def download_audio(yt_dlp: str, url: str, work_dir: str, cookies: str | None,
                   timeout: int = 300) -> str:
    """只取音轨：bestaudio → 16k 不需要，先落 wav 交给分片管线（转写侧会再规整）。"""
    out = os.path.join(work_dir, f"audio_{os.getpid()}.%(ext)s")
    cookie_arg, cookie_copy = _cookie_copy(cookies, work_dir)
    cmd = [yt_dlp, "--no-playlist", "--no-warnings", "--retries", "1",
           "--user-agent", td.DEFAULT_UA,
           "-f", "bestaudio/best", "-x", "--audio-format", "wav",
           "-o", out] + cookie_arg + [url]
    try:
        cp = _run(cmd, timeout, "下载音轨")
    finally:
        if cookie_copy:
            with contextlib.suppress(OSError):
                os.remove(cookie_copy)
    if cp.returncode != 0:
        raise _ytdlp_fail("下载音轨", cp)
    for name in sorted(os.listdir(work_dir)):
        if name.startswith(os.path.basename(out).split("%(ext)s")[0]):
            return os.path.join(work_dir, name)
    raise FetchError("下载音轨", "yt-dlp 没有产出音频文件")


def read_meta(path: str) -> dict:
    """--print-to-file 的一行 title|uploader|duration；取不到就当没有。"""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            line = fh.read().strip().split("\n")[0]
    except OSError:
        return {}
    if not line:
        return {}
    parts = line.split("|")
    if len(parts) < 3:  # 标题里可能自带 "|"，从右往左切
        parts = [line, "", ""]
    title, uploader, duration = "|".join(parts[:-2]), parts[-2], parts[-1]
    meta = {"title": "" if title in ("NA", "None") else title.strip(),
            "author": "" if uploader in ("NA", "None") else uploader.strip()}
    try:
        meta["duration"] = round(float(duration), 3)
    except (TypeError, ValueError):
        meta["duration"] = None
    return meta


def run_asr(media_path: str, model_dir: str, threads: int, chunk: float,
            snap: bool, tmp_root: str) -> tuple[str, list[dict]]:
    """复用 transcribe_douyin：load_recognizer + 分片/静音吸附 + segments_out。"""
    ffmpeg = td.resolve_tool(None, "ffmpeg")
    if not ffmpeg:
        raise FetchError("本地转写", "找不到 ffmpeg（PATH 与 ~/.dsh/bin 都没有）")
    if not model_dir or not os.path.isdir(model_dir):
        raise FetchError("本地转写", f"SenseVoice 模型目录不存在: {model_dir}")
    try:
        recognizer = td.load_recognizer(model_dir, threads)
    except Exception as exc:
        raise FetchError("本地转写", td.one_line(exc, 300)) from None
    segments: list[dict] = []
    try:
        text = td.transcribe_media(recognizer, ffmpeg, media_path, tmp_root,
                                   chunk=chunk, segments_out=segments, snap=snap)
    except Exception as exc:
        raise FetchError("本地转写", td.one_line(exc, 300)) from None
    return text, segments


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def truncate_text(text: str, limit: int | None) -> tuple[str, int, bool]:
    """
    --max-chars 只截 text：segments 保持完整时间轴（下游要能照原样做 .srt/跳转），
    同时回报截断前的原长与是否截断，调用方才能诚实标注「被截断了」。
    """
    total = len(text or "")
    if not limit or limit <= 0 or total <= limit:
        return (text or ""), total, False
    return text[:limit], total, True


def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="douyin_fetch.py",
        description=f"抖音「给定链接 → 精准提取」v{VERSION}：字幕优先，没字幕才下载音轨跑 ASR",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("stdout 只输出一个 JSON 对象（进度走 stderr）：\n"
                '  {"ok","url","finalUrl","title","author","duration","source",\n'
                '   "subtitleLang","text","textLength","truncated","segments","reason","elapsed"}\n'
                "退出码: ok=true → 0；ok=false → 2\n"
                "示例:\n"
                "  douyin_fetch.py --url https://www.douyin.com/video/7xxxxxxxxxxxxxxxx\n"
                "  douyin_fetch.py --url https://v.douyin.com/xxxx/ --srt out.srt\n"
                "  douyin_fetch.py --url <URL> --no-asr\n"
                "  douyin_fetch.py --url <URL> --no-subtitle\n"
                "  douyin_fetch.py --file clip.mp4 --no-asr   # 本地文件 + 同名 .vtt/.srt\n"),
    )
    ap.add_argument("--url", dest="url", default=None, metavar="URL",
                    help="视频/图文链接（支持 v.douyin.com 短链、/video/<id>、/note/<id>）")
    ap.add_argument("--file", dest="file", default=None, metavar="PATH",
                    help="本地媒体文件（测试/离线用；字幕取同目录同名 .vtt/.srt，取代 --url）")
    ap.add_argument("--json", dest="as_json", action="store_true",
                    help="显式声明输出 JSON（stdout 本来就只有 JSON；保留给调用方统一写法）")
    ap.add_argument("--no-asr", dest="no_asr", action="store_true",
                    help="只允许字幕路径：没有字幕就 ok=false（reason='没有可用字幕且已禁用 ASR'）")
    ap.add_argument("--no-subtitle", dest="no_subtitle", action="store_true",
                    help="关掉字幕优先，跳过 yt-dlp 字幕抓取直接下载音轨跑 ASR")
    ap.add_argument("--srt", dest="srt", default=None, metavar="PATH",
                    help="把 segments 另存为标准 .srt 字幕（复用 transcribe_douyin.write_srt）")
    ap.add_argument("--max-chars", dest="max_chars", type=int, default=0, metavar="N",
                    help="text 最多保留 N 个字符（0/不给 = 不截断）；segments 保持完整时间轴，"
                         "并回报 textLength（截断前原长）与 truncated")
    ap.add_argument("--cookies", dest="cookies", default=td.DEFAULT_COOKIES, metavar="FILE",
                    help=f"yt-dlp 用的 cookie 文件（存在才带；默认 {td.DEFAULT_COOKIES}）")
    ap.add_argument("--model-dir", dest="model_dir", default=td.DEFAULT_MODEL_DIR, metavar="DIR",
                    help=f"SenseVoice 模型目录（默认 {td.DEFAULT_MODEL_DIR}）")
    ap.add_argument("--threads", dest="threads", type=int, default=td.DEFAULT_THREADS, metavar="N",
                    help=f"本地转写线程数（默认 {td.DEFAULT_THREADS}）")
    ap.add_argument("--chunk", dest="chunk", type=float, default=td.CHUNK_SEC, metavar="SEC",
                    help=f"ASR 分片长度（秒，默认 {td.CHUNK_SEC:g}）")
    ap.add_argument("--no-snap", dest="no_snap", action="store_true",
                    help="关掉静音吸附，退回固定 chunk 秒硬切（对比用）")
    ap.add_argument("--ffmpeg", dest="ffmpeg", default=None, metavar="EXE",
                    help="ffmpeg 路径（默认自动探测 PATH 与 ~/.dsh/bin）")
    ap.add_argument("--yt-dlp", dest="yt_dlp", default=None, metavar="EXE",
                    help="yt-dlp 路径（默认自动探测 PATH 与 ~/.dsh/bin）")
    ap.add_argument("--timeout", dest="timeout", type=int, default=300, metavar="SEC",
                    help="单步外部命令超时（秒，默认 300）")
    ap.add_argument("--keep-temp", dest="keep_temp", action="store_true",
                    help="保留临时目录（排查字幕/音频落盘位置时用）")
    ap.add_argument("--version", action="version", version=f"douyin_fetch.py {VERSION}")
    args = ap.parse_args(argv)

    started = time.time()
    result: dict = {"ok": False, "url": args.url or args.file or "", "title": "",
                    "source": "none", "text": "", "textLength": 0, "truncated": False,
                    "segments": [], "elapsed": 0.0}
    errors: list[str] = []

    def finish(code: int) -> int:
        result["elapsed"] = round(time.time() - started, 3)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return code

    def fail(reason: str) -> int:
        result["ok"] = False
        result["reason"] = reason
        td.eprint(f"[失败] {reason}")
        return finish(2)

    if args.no_subtitle and args.no_asr:
        return fail("--no-subtitle 与 --no-asr 互相矛盾：前者只走 ASR，后者只走字幕")
    if not args.url and not args.file:
        return fail("没给输入：用 --url <链接> 或 --file <本地媒体>")
    if args.file and not os.path.exists(args.file):
        return fail(f"本地文件不存在: {args.file}")

    tmp_root = td.pick_temp_root()
    if not tmp_root:
        return fail("找不到可写的临时目录（%TEMP%、脚本旁 tmp/、当前目录 tmp/ 都写不进）")
    tempfile.tempdir = tmp_root
    work_dir = tempfile.mkdtemp(prefix="dyt-fetch-", dir=tmp_root)
    td.eprint(f"[环境] 临时目录={work_dir}")

    try:
        # ---------- 1. 链接归一化（短链 → 落地地址） ----------
        final_url = ""
        if args.file:
            media = os.path.abspath(args.file)
            final_url = media
            result["url"] = args.file
            result["title"] = os.path.splitext(os.path.basename(media))[0]
            result["finalUrl"] = media
            cookies = None
            yt_dlp = None
        else:
            url = normalize_url(args.url)
            result["url"] = url
            final_url, note = resolve_short_url(url)
            if note:
                td.eprint(f"[提示] {note}")
            if final_url != url:
                td.eprint(f"[链接] {url} -> {final_url}")
            result["finalUrl"] = final_url
            media = ""
            cookies = args.cookies if (args.cookies and os.path.exists(args.cookies)) else None
            yt_dlp = td.resolve_tool(args.yt_dlp, "yt-dlp")
            if not yt_dlp:
                errors.append("探测 yt-dlp 失败（PATH 与 ~/.dsh/bin 都没有，可用 --yt-dlp 指定）")
                td.eprint(f"[警告] {errors[-1]}")

        # ---------- 2. 字幕优先（--no-subtitle 直接跳过） ----------
        sub_files: list[str] = []
        meta: dict = {}
        if args.no_subtitle:
            td.eprint("[字幕] --no-subtitle：跳过字幕抓取，直接下载音轨跑 ASR")
        elif args.file:
            sub_files = subtitle_sidecars(media)
            if sub_files:
                td.eprint(f"[字幕] 本地同名字幕 {len(sub_files)} 个: "
                          + ", ".join(os.path.basename(p) for p in sub_files))
        elif yt_dlp:
            try:
                sub_files, meta = probe_subtitles(yt_dlp, final_url, work_dir, cookies,
                                                  timeout=min(args.timeout, 180))
                result["title"] = meta.get("title") or ""
                result["author"] = meta.get("author") or None
                if meta.get("duration"):
                    result["duration"] = meta["duration"]
                if sub_files:
                    td.eprint(f"[字幕] yt-dlp 落盘 {len(sub_files)} 个: "
                              + ", ".join(os.path.basename(p) for p in sub_files))
            except FetchError as exc:
                errors.append(exc.reason())
                td.eprint(f"[警告] {exc.reason()}")

        picked = pick_subtitle_file(sub_files)
        if picked:
            try:
                with open(picked, "r", encoding="utf-8", errors="replace") as fh:
                    raw = fh.read()
            except OSError as exc:
                errors.append(f"读取字幕失败（{td.one_line(exc, 160)}）")
                raw = ""
            segs = build_segments(parse_subtitle_text(raw, picked))
            if segs:
                text, total_len, cut = truncate_text("\n".join(s["text"] for s in segs),
                                                     args.max_chars)
                result.update({"ok": True, "source": "subtitle", "text": text,
                               "textLength": total_len, "truncated": cut,
                               "segments": segs, "subtitleLang": _lang_of(picked) or "und"})
                result.pop("reason", None)
                if "duration" not in result:
                    result["duration"] = round(max(s["start"] + s["dur"] for s in segs), 3)
                td.eprint(f"[字幕] 解析出 {len(segs)} 段 / {len(text)} 字"
                          f"（{os.path.basename(picked)}）")
                if args.srt:
                    n = td.write_srt(args.srt, segs)
                    td.eprint(f"[字幕] 已写 .srt {n} 条: {args.srt}")
                return finish(0)
            errors.append(f"字幕文件没有可用分段（{os.path.basename(picked)}）")
            td.eprint(f"[警告] {errors[-1]}")

        # ---------- 3. 没字幕 → ASR ----------
        if args.no_asr:
            return fail("没有可用字幕且已禁用 ASR")

        if args.file:
            media_path = media
        else:
            if not yt_dlp:
                return fail("；".join(errors) or "找不到 yt-dlp，无法拿到音频")
            try:
                media_path = download_audio(yt_dlp, final_url, work_dir, cookies,
                                            timeout=args.timeout)
                td.eprint(f"[音轨] 已下载 {media_path}")
            except FetchError as exc:
                errors.append(exc.reason())
                return fail("；".join(errors))

        ffmpeg = td.resolve_tool(args.ffmpeg, "ffmpeg")
        if ffmpeg:
            dur = td.probe_duration(ffmpeg, media_path)
            if dur:
                result.setdefault("duration", dur)
        try:
            text, segs = run_asr(media_path, args.model_dir, args.threads, args.chunk,
                                 not args.no_snap, work_dir)
        except FetchError as exc:
            errors.append(exc.reason())
            return fail("；".join(errors))
        if not text.strip():
            errors.append("ASR 没有解出任何文字")
            return fail("；".join(errors))
        text, total_len, cut = truncate_text(text, args.max_chars)
        result.update({"ok": True, "source": "asr", "text": text,
                       "textLength": total_len, "truncated": cut, "segments": segs})
        result.pop("reason", None)
        td.eprint(f"[ASR] {len(segs)} 片 / {total_len} 字" + ("（text 已按 --max-chars 截断）" if cut else ""))
        if args.srt:
            n = td.write_srt(args.srt, segs)
            td.eprint(f"[ASR] 已写 .srt {n} 条: {args.srt}")
        return finish(0)
    finally:
        if not args.keep_temp:
            shutil.rmtree(work_dir, ignore_errors=True)
        else:
            td.eprint(f"[保留] 临时目录未删除: {work_dir}")


def main() -> int:
    try:
        return run()
    except KeyboardInterrupt:
        td.eprint("[中断] 用户取消")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
