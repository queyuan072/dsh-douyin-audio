#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音视频声音转写工具 (Transcribe Douyin) v1.2.0
==============================================
把抖音视频的声音转成文本：ffmpeg 转 16kHz 单声道 WAV → sherpa-onnx SenseVoice 本地转写。

输入源（可混用）：
  *) 直链 / 分享短链（http/https）—— 需要 yt-dlp
  *) 本地视频/音频文件（.mp4 / .wav / .mp3 ...）
  *) 刷抖音插件清单文件（每行 屏号|标题|直链|本地文件路径，标题里可以有 "|"）

用法:
  python transcribe_douyin.py --file D:/clip.mp4
  python transcribe_douyin.py --file a.mp4 --file b.mp3 --out out.txt
  python transcribe_douyin.py --manifest manifest.txt --json
  python transcribe_douyin.py --manifest list.txt --model-dir D:/models/sense-voice
  python transcribe_douyin.py --file clip.mp4 --threads 8 --start 12 --dur 30 --json

退出码: 0 全部成功 / 1 有条目失败 / 2 用法或环境错误
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

VERSION = "1.2.0"


def _default_threads() -> int:
    """转写线程数：环境变量 DOUYIN_ASR_THREADS > 8。非法值静默回落 8，这里绝不抛。"""
    try:
        val = int(str(os.environ.get("DOUYIN_ASR_THREADS") or "").strip())
        if val > 0:
            return val
    except (TypeError, ValueError):
        pass
    return 8


DEFAULT_THREADS = _default_threads()

# 默认模型目录：跟着用户家目录走，不在源码里钉死某台机器的绝对路径
DEFAULT_MODEL_SUBDIR = os.path.join(
    "models", "sherpa-sense-voice", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
)
# 优先级：--model-dir / --cookies > 环境变量 DOUYIN_MODEL_DIR / DOUYIN_COOKIE_FILE > ~/.dsh 下的默认位置
DEFAULT_MODEL_DIR = os.path.expanduser(
    os.environ.get("DOUYIN_MODEL_DIR") or os.path.join("~", ".dsh", DEFAULT_MODEL_SUBDIR)
)
DEFAULT_COOKIES = os.path.expanduser(
    os.environ.get("DOUYIN_COOKIE_FILE") or os.path.join("~", ".dsh", "cookies", "douyin_cookies.txt")
)
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
)

# Windows 上 stdout 默认 GBK，中文/JSON 打进管道会炸 —— 钉死 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - 非 Windows 或已重定向失败
    pass


def eprint(*parts: object) -> None:
    """进度/日志一律走 stderr，stdout 留给 --json 与正文。"""
    print(*parts, file=sys.stderr, flush=True)


def one_line(text: object, limit: int = 300) -> str:
    """把多行异常压成一行并截断：能进 JSON/清单，又不会把 traceback 铺满。"""
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else "…" + flat[-limit:]


# --------------------------------------------------------------------------
# 临时目录
# --------------------------------------------------------------------------
def pick_temp_root() -> str:
    """
    临时目录必须落在「真的能写」的地方：插件跑在沙箱里时系统 %TEMP% 会被拒写
    （实测 open() 直接 Errno 13 / ffmpeg 开不了输出文件），所以依次试：
      DSH_DOUYIN_TMP → 系统临时目录 → 脚本旁 tmp/ → 当前目录 tmp/，第一个能写的胜出。
    """
    candidates = [
        os.environ.get("DSH_DOUYIN_TMP") or "",
        tempfile.gettempdir(),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp"),
        os.path.join(os.getcwd(), "tmp"),
    ]
    for cand in candidates:
        if not cand:
            continue
        try:
            os.makedirs(cand, exist_ok=True)
            probe = os.path.join(cand, ".dyt_probe")
            with open(probe, "w", encoding="utf-8") as fh:
                fh.write("ok")
            os.remove(probe)
            return cand
        except Exception:
            continue
    return ""


# --------------------------------------------------------------------------
# 外部程序探测
# --------------------------------------------------------------------------
def _dsh_bin_candidates(name: str) -> list[str]:
    home = os.path.expanduser("~")
    return [
        os.path.join(home, ".dsh", "bin", name),
        os.path.join(home, ".dsh", "bin", name + ".exe"),
    ]


def resolve_tool(explicit: str | None, name: str) -> str | None:
    """--ffmpeg/--yt-dlp 给了就用给的；否则 PATH → ~/.dsh/bin 依次探测。"""
    if explicit:
        return explicit if os.path.exists(explicit) else None
    found = shutil.which(name)
    if found:
        return found
    for cand in _dsh_bin_candidates(name):
        if os.path.exists(cand):
            return cand
    return None


# --------------------------------------------------------------------------
# 音视频处理
# --------------------------------------------------------------------------
def to_wav(ffmpeg: str, input_path: str, wav_path: str, timeout: int = 180,
           start: float | None = None, dur: float | None = None) -> None:
    """任意媒体 → 16kHz 单声道 PCM WAV；给了 start/dur 就只截该区间（-ss 定位 / -t 截长）"""
    cmd = [ffmpeg, "-y"]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", input_path]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += [
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-fflags", "+bitexact", "-map_metadata", "-1",
        wav_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
    except subprocess.CalledProcessError as exc:
        tail = one_line((exc.stderr or b"").decode("utf-8", "replace")[-600:])
        raise RuntimeError(f"ffmpeg 转 wav 失败(rc={exc.returncode}): {tail}") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffmpeg 转 wav 超时(>{timeout}s)") from None


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


def probe_duration(ffmpeg: str, media_path: str, timeout: int = 30) -> float | None:
    """媒体时长（秒）。ffprobe 优先，回退解析 ffmpeg 的 Duration 行；取不到就 None —— 不许因此让转写失败。"""
    try:
        ffprobe = resolve_tool(None, "ffprobe")
        if ffprobe:
            cp = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", media_path],
                capture_output=True, timeout=timeout,
            )
            text = (cp.stdout or b"").decode("utf-8", "replace").strip()
            if text and text.lower() != "n/a":
                return round(float(text), 3)
    except Exception:
        pass  # ffprobe 缺失/超时/输出怪 → 走下面的 ffmpeg 兜底
    try:
        cp = subprocess.run([ffmpeg, "-hide_banner", "-i", media_path],
                            capture_output=True, timeout=timeout)
        m = _DURATION_RE.search((cp.stderr or b"").decode("utf-8", "replace"))
        if m:
            return round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 3)
    except Exception:
        pass
    return None


def download(yt_dlp: str, url: str, work_dir: str, cookies: str | None, timeout: int = 300) -> str:
    """视频链接 → 本地 mp4（文件名唯一：两轮同时跑不会互相覆盖）"""
    out = os.path.join(work_dir, f"video_{uuid.uuid4().hex[:10]}.mp4")
    cmd = [yt_dlp, "--no-playlist", "--no-part", "--quiet", "--user-agent", DEFAULT_UA]
    # yt-dlp 收尾会**回写** cookie 文件；直接给原文件会在只读/沙箱环境下 Errno 13 —— 给一份副本
    cookie_copy = ""
    if cookies and os.path.exists(cookies):
        try:
            cookie_copy = os.path.join(work_dir, f"cookies_{uuid.uuid4().hex[:8]}.txt")
            shutil.copyfile(cookies, cookie_copy)
            cmd += ["--cookies", cookie_copy]
        except OSError:
            cookie_copy = ""
    cmd += ["-o", out, url]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
    except subprocess.CalledProcessError as exc:
        tail = one_line((exc.stderr or b"").decode("utf-8", "replace")[-600:])
        raise RuntimeError(f"yt-dlp 下载失败(rc={exc.returncode}): {tail}") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"yt-dlp 下载超时(>{timeout}s)") from None
    finally:
        if cookie_copy:
            try:
                os.remove(cookie_copy)
            except OSError:
                pass
    if not os.path.exists(out):
        raise RuntimeError(f"yt-dlp 没有产出文件: {out}")
    return out


# --------------------------------------------------------------------------
# 模型
# --------------------------------------------------------------------------
def load_recognizer(model_dir: str, threads: int = DEFAULT_THREADS):
    """加载 SenseVoice；缺文件/缺依赖都转成带说明的 RuntimeError。"""
    model_onnx = os.path.join(model_dir, "model.int8.onnx")
    model_onnx2 = os.path.join(model_dir, "model.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")
    if not os.path.isdir(model_dir):
        raise RuntimeError(f"模型目录不存在: {model_dir}")
    if not os.path.exists(model_onnx):
        if os.path.exists(model_onnx2):
            model_onnx = model_onnx2
        else:
            raise RuntimeError(f"模型目录里没有 model.int8.onnx / model.onnx: {model_dir}")
    if not os.path.exists(tokens):
        raise RuntimeError(f"模型目录里没有 tokens.txt: {model_dir}")
    try:
        import sherpa_onnx  # 延迟导入：--help / 参数校验不需要它
    except Exception as exc:
        raise RuntimeError(f"无法导入 sherpa_onnx: {type(exc).__name__}: {exc}") from None
    try:
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model_onnx,
            tokens=tokens,
            num_threads=threads,
            use_itn=True,
            language="zh",
            debug=False,
        )
    except Exception as exc:
        raise RuntimeError(f"SenseVoice 初始化失败: {type(exc).__name__}: {exc}") from None


def transcribe_media(recognizer, ffmpeg: str, media_path: str, tmp_root: str,
                     start: float | None = None, dur: float | None = None) -> str:
    """
    媒体文件 → 转写文本。
    wav 直接落在 tmp_root 下、用唯一文件名，**不新建子目录**：
    某些沙箱只允许写「子进程启动前就存在」的目录，运行时 mkdtemp 出来的子目录会被拒。
    """
    import numpy as np
    import soundfile as sf

    wav_path = os.path.join(tmp_root, f"dyt_{uuid.uuid4().hex[:10]}.wav")
    try:
        to_wav(ffmpeg, media_path, wav_path, start=start, dur=dur)
        samples, sr = sf.read(wav_path, dtype="float32", always_2d=False)
        if sr != 16000:
            raise RuntimeError(f"采样率不是 16k: {sr}")
        if getattr(samples, "ndim", 1) > 1:  # 双声道兜底
            samples = samples.mean(axis=1)
        samples = np.ascontiguousarray(samples, dtype=np.float32)
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples)
        recognizer.decode_stream(stream)
        return stream.result.text.strip()
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass


# --------------------------------------------------------------------------
# 清单解析（原版 ln.split("|") 在标题含竖线时会错位 —— 这里改用「锚定 + 只切必要刀数」）
# --------------------------------------------------------------------------
_URL_RE = re.compile(r"https?://[^\s|<>\"']+")
_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|/|\.{1,2}[\\/]|[^\s|]+\.(?:mp4|mov|mkv|webm|mp3|m4a|wav|aac|flac|ogg|opus))$", re.I)


def _looks_like_path(text: str) -> bool:
    return bool(text) and bool(_PATH_RE.match(text.strip()))


def parse_manifest_line(raw: str) -> dict:
    """
    清单行 → {screen, title, url, local}

    格式: 屏号|标题|直链|本地文件路径（后两段至少有一段；标题里允许出现 "|"）

    原版用 ln.split("|") 取 parts[0..2]：标题里有 "|" 时 title 只拿到前半截，
    直链被挤到 parts[3] 而 url 取成了标题碎片 —— 整行错位。

    新做法只切「位置确定」的那几刀：
      ① 用正则锚定直链（http(s):// 后面的连续非竖线非空白字符），
         它左边的全部 = "屏号|标题"，它右边的剩余 = 本地文件路径；
      ② 剩下的 "屏号|标题" 只从**左边**切 1 刀（partition）：
         第 1 段是屏号，其余全部是标题 ⇒ 标题里的竖线原样保留；
      ③ 没有直链时从**右边** rsplit 1 刀剥出本地路径，再切一次屏号，
         这样哪怕标题里全是竖线也不会错位。
    """
    line = raw.strip().rstrip("|").strip()  # 先切掉行尾的空字段（...| 这种）
    screen, title, url, local = "", "", "", ""

    match = _URL_RE.search(line)
    if match:
        url = match.group(0)
        head = line[: match.start()].rstrip().rstrip("|").rstrip()
        local = line[match.end():].strip().lstrip("|").strip()
    else:
        left, sep, right = line.rpartition("|")
        if sep and _looks_like_path(right):
            head, local = left.strip(), right.strip()
        else:
            head, local = line, ""

    screen_part, sep, title_part = head.partition("|")
    if sep:
        screen, title = screen_part.strip(), title_part.strip()
    else:
        # 只有一段：当成本地文件或直链，屏号/标题留空
        if not url and not local:
            if _looks_like_path(screen_part.strip()):
                local = screen_part.strip()
            else:
                url = screen_part.strip()
        else:
            title = screen_part.strip()

    return {"screen": screen, "title": title, "url": url, "local": local}


# --------------------------------------------------------------------------
# 输入收集
# --------------------------------------------------------------------------
def build_items(args) -> list[dict]:
    items: list[dict] = []

    targets = list(args.file or [])
    if args.target:
        targets.insert(0, args.target)
    for t in targets:
        t = (t or "").strip()
        if not t:
            continue
        if _URL_RE.match(t):
            items.append({"source": t, "screen": "", "title": "", "url": t, "local": ""})
        else:
            items.append({"source": t, "screen": "", "title": "", "url": "", "local": t})

    for manifest in args.manifests or []:
        if not os.path.exists(manifest):
            raise FileNotFoundError(f"清单不存在: {manifest}")
        with open(manifest, "r", encoding="utf-8-sig") as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        eprint(f"[清单] {manifest} 共 {len(lines)} 条")
        for ln in lines:
            rec = parse_manifest_line(ln)
            if not (rec["url"] or rec["local"]):
                eprint(f"[跳过] 无法解析出链接/路径: {ln[:80]}")
                continue
            source = rec["url"] or rec["local"]
            items.append({
                "source": source,
                "screen": rec["screen"],
                "title": rec["title"],
                "url": rec["url"],
                "local": rec["local"],
            })
    return items


def _label(item: dict) -> str:
    parts = [p for p in (item.get("screen"), item.get("title")) if p]
    return " | ".join(parts) if parts else item["source"]


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="transcribe_douyin.py",
        description=f"抖音视频声音转写工具 v{VERSION}（ffmpeg → sherpa-onnx SenseVoice）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "清单文件每行: 屏号|标题|直链|本地文件路径\n"
            "  · 标题里可以有 \"|\"（解析只切必要刀数，不会错位）\n"
            "  · 直链与本地路径至少给一个；以 # 开头的行忽略\n"
            "示例:\n"
            "  transcribe_douyin.py --file clip.mp4 --out out.txt\n"
            "  transcribe_douyin.py --manifest list.txt --json\n"
        ),
    )
    ap.add_argument("target", nargs="?", help="可选：单个媒体文件或视频直链（兼容旧用法）")
    ap.add_argument("--file", dest="file", action="append", metavar="PATH",
                    help="本地媒体文件，可重复给多次")
    ap.add_argument("--files", "--manifest", dest="manifests", action="append", metavar="LIST",
                    help="清单文件（屏号|标题|直链|本地文件路径），可重复给多次")
    ap.add_argument("--out", dest="out", metavar="PATH", default=None,
                    help="把文本结果写到这个文件（不给就打到 stdout）")
    ap.add_argument("--json", dest="as_json", action="store_true",
                    help="把结果以 JSON 打到 stdout: {ok, threads, items:[{source,text,error,duration}], model, elapsed}")
    ap.add_argument("--threads", dest="threads", type=int, default=DEFAULT_THREADS, metavar="N",
                    help=f"本地转写线程数（默认取环境变量 DOUYIN_ASR_THREADS，再默认 {DEFAULT_THREADS}）")
    ap.add_argument("--start", dest="start", type=float, default=None, metavar="SEC",
                    help="只转写从该秒数开始的区间（可选；给了就用 ffmpeg -ss 截取）")
    ap.add_argument("--dur", dest="dur", type=float, default=None, metavar="SEC",
                    help="转写区间长度（秒，可选；给了就用 ffmpeg -t 截取）")
    ap.add_argument("--model-dir", dest="model_dir", default=DEFAULT_MODEL_DIR, metavar="DIR",
                    help=f"SenseVoice 模型目录（默认 {DEFAULT_MODEL_DIR}）")
    ap.add_argument("--ffmpeg", dest="ffmpeg", default=None, metavar="EXE",
                    help="ffmpeg 路径（默认自动探测 PATH 与 ~/.dsh/bin）")
    ap.add_argument("--yt-dlp", dest="yt_dlp", default=None, metavar="EXE",
                    help="yt-dlp 路径（默认自动探测；只在给了 URL 时才需要）")
    ap.add_argument("--cookies", dest="cookies", default=DEFAULT_COOKIES, metavar="FILE",
                    help="yt-dlp 用的 cookie 文件（存在才带；默认 ~/.dsh/cookies/douyin_cookies.txt）")
    ap.add_argument("--version", action="version", version=f"transcribe_douyin.py {VERSION}")
    args = ap.parse_args(argv)

    started = time.time()
    result = {"ok": False, "threads": args.threads, "items": [],
              "model": os.path.basename(os.path.normpath(args.model_dir)), "elapsed": 0.0}

    def finish(code: int) -> int:
        result["elapsed"] = round(time.time() - started, 3)
        if args.as_json:
            print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        return code

    if args.threads < 1:
        eprint("[错误] --threads 至少为 1")
        return finish(2)
    if args.start is not None and args.start < 0:
        eprint("[错误] --start 不能为负")
        return finish(2)
    if args.dur is not None and args.dur <= 0:
        eprint("[错误] --dur 必须大于 0")
        return finish(2)

    try:
        items = build_items(args)
    except FileNotFoundError as exc:
        eprint(f"[错误] {exc}")
        return finish(2)

    if not items:
        eprint("[错误] 没给任何输入：用 --file <文件> 或 --manifest/--files <清单>")
        ap.print_help(sys.stderr)
        return finish(2)

    ffmpeg = resolve_tool(args.ffmpeg, "ffmpeg")
    if not ffmpeg:
        eprint("[错误] 找不到 ffmpeg：请装到 PATH 或用 --ffmpeg 指定")
        for it in items:
            result["items"].append({"source": it["source"], "text": "", "error": "找不到 ffmpeg"})
        return finish(2)

    need_url = any(it["url"] for it in items)
    yt_dlp = resolve_tool(args.yt_dlp, "yt-dlp") if need_url else None
    if need_url and not yt_dlp:
        eprint("[错误] 清单里有直链，但找不到 yt-dlp：请装到 PATH 或用 --yt-dlp 指定")
        for it in items:
            result["items"].append({"source": it["source"], "text": "", "error": "找不到 yt-dlp"})
        return finish(2)

    tmp_root = pick_temp_root()
    if tmp_root:
        tempfile.tempdir = tmp_root
    else:
        eprint("[警告] 找不到可写的临时目录：转写可能失败")

    eprint(f"[环境] ffmpeg={ffmpeg}" + (f"  yt-dlp={yt_dlp}" if yt_dlp else ""))
    eprint(f"[环境] 模型目录={args.model_dir}")
    eprint(f"[环境] 临时目录={tmp_root or '(不可写)'}")
    eprint(f"[环境] 线程数={args.threads}"
           + (f"  区间={args.start or 0:.3f}s+{args.dur:.3f}s" if args.dur is not None
              else (f"  起点={args.start:.3f}s" if args.start is not None else "")))

    failing = 0
    recognizer = None
    model_error = ""
    try:
        recognizer = load_recognizer(args.model_dir, threads=args.threads)
        eprint("[模型] SenseVoice 已加载")
    except Exception as exc:
        model_error = one_line(exc, 300)
        eprint(f"[错误] {model_error}")

    texts: list[str] = []
    for idx, it in enumerate(items, 1):
        label = _label(it)
        eprint(f"[{idx}/{len(items)}] {label}")
        entry = {"source": it["source"], "text": "", "error": None, "duration": None}
        if it["local"] and os.path.exists(it["local"]):  # 本地文件当场量时长：模型不可用时也能报
            entry["duration"] = probe_duration(ffmpeg, it["local"])
        if model_error:
            entry["error"] = f"模型不可用: {model_error}"
            failing += 1
            result["items"].append(entry)
            texts.append(f"{it.get('screen') or '-'}|{it.get('title') or os.path.basename(it['source'])}|[转写失败] {entry['error']}")
            continue
        try:
            if not tmp_root:
                raise RuntimeError("没有可写的临时目录（可用 DSH_DOUYIN_TMP 指定）")
            media, downloaded = it["local"], ""
            if it["url"]:
                downloaded = download(yt_dlp, it["url"], tmp_root, args.cookies)
                media = downloaded
            elif not os.path.exists(media):
                raise RuntimeError(f"文件不存在: {media}")
            try:
                if entry["duration"] is None:  # 下载来的媒体只能到这一步才量
                    entry["duration"] = probe_duration(ffmpeg, media)
                entry["text"] = transcribe_media(recognizer, ffmpeg, media, tmp_root,
                                                start=args.start, dur=args.dur)
            finally:
                if downloaded:
                    try:
                        os.remove(downloaded)
                    except OSError:
                        pass
            text = entry["text"]
            eprint(f"      → {text[:120]}")
        except Exception as exc:  # 不裸 traceback：异常文本进 error 字段
            entry["error"] = one_line(f"{type(exc).__name__}: {exc}", 400)
            failing += 1
            eprint(f"      → 转写失败: {entry['error']}")
        result["items"].append(entry)
        title = it.get("title") or os.path.basename(it["source"]).rsplit(".", 1)[0]
        screen = it.get("screen") or "-"
        body = entry["text"] if not entry["error"] else f"[转写失败] {entry['error']}"
        texts.append(f"{screen}|{title}|{body}")

    if args.out:
        try:
            out_dir = os.path.dirname(os.path.abspath(args.out))
            if out_dir:
                os.makedirs(out_dir, exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(f"# 抖音刷视频声音转写结果 v{VERSION}\n")
                fh.write("\n".join(texts))
                fh.write("\n")
            eprint(f"[完成] 结果已写: {args.out}")
        except Exception as exc:
            eprint(f"[错误] 写输出文件失败: {type(exc).__name__}: {exc}")
            result["ok"] = False
            return finish(1)
    elif not args.as_json:
        print(f"# 抖音刷视频声音转写结果 v{VERSION}")
        print("\n".join(texts))

    result["ok"] = failing == 0
    if failing:
        eprint(f"[完成] {len(items) - failing}/{len(items)} 成功，{failing} 条失败")
        return finish(1)
    eprint(f"[完成] {len(items)}/{len(items)} 全部成功")
    return finish(0)


def main() -> int:
    try:
        return run()
    except KeyboardInterrupt:
        eprint("[中断] 用户取消")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
