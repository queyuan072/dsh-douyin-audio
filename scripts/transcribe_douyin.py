#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音视频声音转写工具 (Transcribe Douyin) v1.3.0
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
  python transcribe_douyin.py --file clip.mp4 --srt out.srt      # 另存 .srt 字幕

分片与切点（v1.3）：
  *) 声音按 --chunk 秒（默认 30）分片喂 SenseVoice——整段一次喂会在超窗后**静默丢内容**；
  *) 切点默认做「静音吸附」：每片多探 2s，在片尾前 10s ~ 片尾后 2s 的能量包络里挑最安静的
     位置下刀（等价 silencedetect=noise=-35dB:d=0.25，但不额外起 ffmpeg）；找不到静音退回硬切。
     --no-snap 可关掉，退回固定硬切（对比用）。
  *) 时长探测失败（probe_duration → None）不回退「整段一次解码」——改盲切推进：每次只解
     chunk 秒、按实际解出的秒数前进，解不出音频即到结尾（--json 信封 durationUnknown=true）；
  *) 单片解码失败不再静默吞掉：失败区间写进 --json 信封 failedRanges，丢片超过 1/3 整段判
     失败（ChunkLossError）——部分内容被丢的结果不许冒充成功。

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

VERSION = "1.3.1"


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
    """媒体时长（秒）。ffprobe 优先，回退解析 ffmpeg 的 Duration 行；取不到就 None —— 调用方按盲切推进，不许因此让转写失败，更不许回退「整段一次解码」。"""
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


CHUNK_SEC = 30.0   # 分片长度：SenseVoice 是离线「单句」模型，整段喂进去会在超窗后静默丢内容

# 分片失败的可信度闸门：丢片 ≤ 1/3 时仍返回文本，但失败区间会写进 --json 信封 failedRanges；
# 超过阈值整段抛 ChunkLossError 判失败——「部分内容被丢」不许伪装成成功。
CHUNK_FAIL_RATIO = 1.0 / 3.0
# 盲切（时长未知）的安全上限：每片 chunk 秒、解到解不出音频为止；触顶说明推进失控，显式报错
BLIND_MAX_CHUNKS = 2000

# ---- 静音吸附切点 ----------------------------------------------------------
# 固定 chunk 秒硬切会把词切两半（输出里能看到「…着，。」「…了。。」这类残句）。
# 做法：每片解码时多探 SNAP_LOOKAHEAD 秒，在 [chunk-SNAP_LEAD_BACK, chunk+SNAP_LOOKAHEAD]
# （chunk=30 → [20s, 32s]）的能量包络里挑最安静处下刀，找不到静音就退回硬切。
# **不为吸附单独扫一遍整段音频**：包络直接算在 _decode_once 已经读出来的 samples 上，
# 所以每片仍然是「一次 ffmpeg + 一次 decode」，长音频不会变慢。
SNAP_LEAD_BACK = 10.0    # 搜索窗口从片尾前多少秒开始（chunk=30 → 20s）
SNAP_LOOKAHEAD = 2.0     # 多探多少秒（chunk=30 → 探到 32s）
SNAP_MIN_CHUNK = 8.0     # 片比这还短就不吸附（窗口会退化成没意义）
SNAP_FRAME_SEC = 0.02    # 能量包络帧长
SNAP_SILENCE_DB = -35.0  # 与 ffmpeg silencedetect=noise=-35dB 同一阈值
SNAP_SILENCE_MIN = 0.25  # 与 d=0.25 同一最短时长
SNAP_DIP_DB = 6.0        # 全段没有达标静音时，「比本区间中位数低 6dB」算局部低洼


def _frame_db(samples, sr: int, lo: float, hi: float):
    """[lo, hi] 按 SNAP_FRAME_SEC 分帧算 dBFS 包络 → (dB 数组, 帧长秒, 首帧绝对起点秒)"""
    import numpy as np

    hop = max(1, int(SNAP_FRAME_SEC * sr))
    a = min(max(0, int(lo * sr)), len(samples))
    b = min(len(samples), int(hi * sr))
    if b - a < hop * 2:
        return np.zeros(0, dtype=np.float32), hop / float(sr), a / float(sr)
    frames = (b - a) // hop
    seg = samples[a:a + frames * hop].reshape(frames, hop).astype(np.float32)
    rms = np.sqrt(np.mean(seg * seg, axis=1) + 1e-12)
    return 20.0 * np.log10(rms + 1e-9), hop / float(sr), a / float(sr)


def _longest_run(mask) -> tuple[int, int] | None:
    """布尔序列里最长连续 True 段的下标区间 [start, end)；没有就 None。"""
    best: tuple[int, int] | None = None
    run_at: int | None = None
    for i, flag in enumerate(mask):
        if flag and run_at is None:
            run_at = i
        elif not flag and run_at is not None:
            if best is None or i - run_at > best[1] - best[0]:
                best = (run_at, i)
            run_at = None
    if run_at is not None and (best is None or len(mask) - run_at > best[1] - best[0]):
        best = (run_at, len(mask))
    return best


def _pick_quiet_cut(samples, sr: int, lo: float, hi: float) -> float | None:
    """
    [lo, hi] 里最安静的切点（相对 samples 起点的秒数）；找不到就 None（调用方退回硬切）。

    等价于 silencedetect=noise=-35dB:d=0.25 的判定，但不用再起一次 ffmpeg：
      ① 先按 -35dBFS 找 >= 0.25s 的静音区间，取最长那段的中点；
      ② 整段都没达标静音时，放宽成「比本区间中位数低 6dB」的局部低洼（>= 0.15s）；
      ③ 两条都不满足 → None（硬切）。
    """
    import numpy as np

    db, frame_sec, t0 = _frame_db(samples, sr, lo, hi)
    if db.size == 0:
        return None
    run = _longest_run(db < SNAP_SILENCE_DB)
    if run and (run[1] - run[0]) * frame_sec >= SNAP_SILENCE_MIN:
        return t0 + (run[0] + run[1]) / 2.0 * frame_sec
    floor = float(db.min())
    if float(np.median(db)) - floor >= SNAP_DIP_DB:
        run = _longest_run(db <= floor + SNAP_DIP_DB)
        if run and (run[1] - run[0]) * frame_sec >= 0.15:
            return t0 + (run[0] + run[1]) / 2.0 * frame_sec
    return None


def _decode_once(recognizer, ffmpeg: str, media_path: str, tmp_root: str,
                 start: float | None = None, dur: float | None = None,
                 snap: tuple[float, float] | None = None) -> tuple[str, float, bool]:
    """
    转一段并解码一次 → (文本, 实际消耗时长秒, 是否吸附到静音)。

    snap=(lo, hi)：wav 探到 hi 秒，在 [lo, hi] 里挑最安静处下刀，**只解切点之前的部分**，
    下一片从切点接着走 —— 既不多起 ffmpeg，也不会丢音。
    """
    import numpy as np
    import soundfile as sf

    wav_path = os.path.join(tmp_root, f"dyt_{uuid.uuid4().hex[:10]}.wav")
    try:
        to_wav(ffmpeg, media_path, wav_path, start=start,
               dur=(snap[1] if snap else dur))
        samples, sr = sf.read(wav_path, dtype="float32", always_2d=False)
        if sr != 16000:
            raise RuntimeError(f"采样率不是 16k: {sr}")
        if getattr(samples, "ndim", 1) > 1:  # 双声道兜底
            samples = samples.mean(axis=1)
        samples = np.ascontiguousarray(samples, dtype=np.float32)
        used, snapped = len(samples) / float(sr), False
        if snap and dur:
            cut = _pick_quiet_cut(samples, sr, snap[0], min(snap[1], used))
            if cut is not None:
                cut = min(max(cut, dur * 0.5), used)  # 别切到片长一半之前，也别超出已解出的音频
                samples = samples[: int(cut * sr)]
                used, snapped = len(samples) / float(sr), True
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples)
        recognizer.decode_stream(stream)
        return stream.result.text.strip(), used, snapped
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass


class ChunkLossError(RuntimeError):
    """分片丢失超阈值（或盲切推进失败）：整段转写不可信，显式判失败，绝不冒充成功。"""


def transcribe_media(recognizer, ffmpeg: str, media_path: str, tmp_root: str,
                     start: float | None = None, dur: float | None = None,
                     chunk: float = CHUNK_SEC, segments_out: list | None = None,
                     snap: bool = True, stats_out: dict | None = None) -> str:
    """
    媒体文件 → 转写文本。

    ⚠️ 必须分片：SenseVoice 把几十分钟音频整段塞进一次 decode_stream，超出模型窗口后
    会**静默丢弃**后面的内容（退出码照样 0）。实测同一段 120s 音频：整段解码只出 37 字，
    30s 分片出 177 字，且分片更快（3s vs 8s）。这里按 chunk 切片逐段解码再拼接。

    分段：给了 segments_out(list) 就把每片的 {"start","dur","text"} append 进去
    （start 相对媒体起点，秒）。不传时返回值/行为与从前完全一致 —— 仍是 str。
    snap=False 关掉静音吸附，退回固定 chunk 秒硬切。

    可信度（v1.3.1，修 P1 静默失败）：
      *) 时长探测失败（probe_duration → None）**不回退**「整段一次解码」——那是历史丢内容
         bug 的复活通道。改盲切推进：每次只解 chunk 秒，按实际解出的秒数 t += used 前进，
         解不出音频（used≈0）即到结尾；stats_out["durationUnknown"] = True 标记这条降级路径。
      *) 单片解码失败不再静默吞掉：失败区间记进 stats_out["failedRanges"]（{"start","dur",
         "error"}），失败片占比或丢秒占比 ≥ CHUNK_FAIL_RATIO（1/3）时抛 ChunkLossError 整段
         判失败 —— douyin_fetch.py 复用本函数，同样拿到显式失败而不是残缺文本的 ok:true。
      *) stats_out(dict) 在 finally 里写回本次分片统计（异常路径也写）：durationUnknown /
         chunksTotal / chunksFailed / coveredSeconds / failedSeconds / emptySeconds /
         spanSeconds / failedRanges。解出空音频（音轨比容器短等）单独记 emptySeconds 不算
         失败，但 spanSeconds 与 coveredSeconds 的差会在信封里暴露未覆盖区间。
    """
    stats: dict = {"durationUnknown": False, "chunksTotal": 0, "chunksFailed": 0,
                   "coveredSeconds": 0.0, "failedSeconds": 0.0, "emptySeconds": 0.0,
                   "spanSeconds": 0.0, "failedRanges": []}
    try:
        total = dur if dur is not None else probe_duration(ffmpeg, media_path)
        base = float(start or 0.0)
        segs: list = [] if segments_out is None else segments_out
        parts: list[str] = []
        lookahead = SNAP_LOOKAHEAD if (snap and chunk >= SNAP_MIN_CHUNK) else 0.0
        lead_back = min(SNAP_LEAD_BACK, chunk * 0.5)  # 片很短时窗口别倒到片头之前

        # 单片快速路径：**时长已知**且不长（或显式 --chunk 0 的旧行为）才允许一次解完。
        # 时长未知绝不走这里——整段单次解码超窗后会静默丢内容，不许它借「探测失败」复活。
        if total is not None and total <= chunk * 1.5:
            stats["chunksTotal"] = 1
            try:
                text, used, _ = _decode_once(recognizer, ffmpeg, media_path, tmp_root,
                                             start=start, dur=dur)
            except Exception as exc:
                stats["chunksFailed"] = 1
                stats["failedRanges"].append({"start": round(base, 3), "dur": None,
                                              "error": one_line(exc, 160)})
                raise
            stats["coveredSeconds"] = used
            stats["spanSeconds"] = used
            if used <= 0.05:  # 一个采样都没解出来：区间里没有音频数据，不能当「成功且无话」
                raise ChunkLossError(
                    f"区间 {base:.0f}s 起 +{(dur or 0):.0f}s 没有解出任何音频数据"
                    f"（音轨缺失或区间越界），无可转写内容")
            if text:
                segs.append({"start": round(base, 3), "dur": round(used, 3), "text": text})
            return text

        if total is None:
            # ---- 盲切推进：时长未知，解到「解不出音频」为止；推进只信实际解出的秒数 ----
            stats["durationUnknown"] = True
            eprint(f"[时长] 探测失败（ffprobe / ffmpeg Duration 都没给出），按 {chunk:g}s 盲切推进")
            t, idx = base, 0
            while True:
                if idx >= BLIND_MAX_CHUNKS:
                    raise ChunkLossError(
                        f"盲切推进已解 {idx} 片（每片 {chunk:g}s）仍未到音频结尾，推进异常，中止")
                win = (max(0.0, chunk - lead_back), chunk + lookahead) if lookahead else None
                try:
                    piece, used, snapped = _decode_once(recognizer, ffmpeg, media_path,
                                                        tmp_root, start=t, dur=chunk, snap=win)
                except Exception as exc:
                    # 盲切没有「名义时长」兜底：这片起失败，其后音频是否被覆盖无法证明，必须显式失败
                    stats["chunksTotal"] = idx + 1
                    stats["chunksFailed"] = 1
                    stats["failedRanges"].append({"start": round(t, 3), "dur": None,
                                                  "error": one_line(exc, 160)})
                    raise ChunkLossError(
                        f"盲切模式（时长未知）下片 {idx + 1}（{t:.0f}s 起）解码失败: "
                        f"{one_line(exc, 160)}；已成功覆盖 {stats['coveredSeconds']:.0f}s，"
                        f"其后音频是否转出无法证明，整段结果不可信") from None
                if used <= 0.05:  # 这段没解出音频 = 到结尾（或起点越界）
                    break
                idx += 1
                stats["chunksTotal"] = idx
                stats["coveredSeconds"] = round(stats["coveredSeconds"] + used, 3)
                if piece:
                    parts.append(piece)
                    segs.append({"start": round(t, 3), "dur": round(used, 3), "text": piece})
                eprint(f"      片 {idx}: {t:.1f}s +{used:.1f}s"
                       f"（{'静音吸附' if snapped else '硬切'}，名义 {chunk:.1f}s）→ {len(piece)} 字")
                t += used
                if not snapped and used < chunk - 0.2:
                    break  # 没吸附却比请求短 → 音频在这片中间就结束了，这就是最后一片
            stats["spanSeconds"] = round(t - base, 3)
            return "\n".join(parts)

        # ---- 时长已知：按 chunk 循环，单片失败记账不静默，丢片超阈值整段判失败 ----
        end = base + float(total)
        idx = 0
        t = base
        while t < end - 0.2:
            idx += 1
            stats["chunksTotal"] = idx
            nominal = min(chunk, end - t)
            win = None
            # 只有「后面还有不止一片」时才值得吸附：最后一片本来就到结尾了
            if lookahead and (end - t) > chunk + 0.2:
                win = (max(0.0, chunk - lead_back), chunk + lookahead)
            try:
                piece, used, snapped = _decode_once(recognizer, ffmpeg, media_path, tmp_root,
                                                    start=t, dur=nominal, snap=win)
            except Exception as exc:  # 单片失败不毁掉整段，但必须记账进信封——不许静默
                stats["chunksFailed"] += 1
                stats["failedSeconds"] = round(stats["failedSeconds"] + nominal, 3)
                stats["failedRanges"].append({"start": round(t, 3), "dur": round(nominal, 3),
                                              "error": one_line(exc, 160)})
                eprint(f"      片 {idx} 失败（{t:.0f}s +{nominal:.0f}s）: {one_line(str(exc), 120)}")
                piece, used, snapped = "", nominal, False
            else:
                if used <= 0.05:  # 解出空音频（音轨比容器短/数据缺失/区间越界）：显式记账，不算失败
                    stats["emptySeconds"] = round(stats["emptySeconds"] + nominal, 3)
                    used = nominal  # 空片也按名义推进，否则死循环
                else:
                    stats["coveredSeconds"] = round(stats["coveredSeconds"] + used, 3)
            if piece:
                parts.append(piece)
                segs.append({"start": round(t, 3), "dur": round(used, 3), "text": piece})
            eprint(f"      片 {idx}: {t:.1f}s +{used:.1f}s"
                   f"（{'静音吸附' if snapped else '硬切'}，名义 {nominal:.1f}s）→ {len(piece)} 字")
            t += used
        stats["spanSeconds"] = round(float(total), 3)

        if stats["chunksFailed"]:
            lost_ratio = stats["chunksFailed"] / stats["chunksTotal"]
            attempted = stats["coveredSeconds"] + stats["failedSeconds"] + stats["emptySeconds"]
            sec_ratio = (stats["failedSeconds"] / attempted) if attempted > 0 else 0.0
            if max(lost_ratio, sec_ratio) >= CHUNK_FAIL_RATIO:
                ranges = "；".join(f"{r['start']:.0f}s+{r['dur']:.0f}s"
                                   for r in stats["failedRanges"][:5])
                more = f" 等 {len(stats['failedRanges'])} 片" if len(stats["failedRanges"]) > 5 else ""
                raise ChunkLossError(
                    f"{stats['chunksFailed']}/{stats['chunksTotal']} 分片解码失败"
                    f"（丢失约 {stats['failedSeconds']:.0f}s / {attempted:.0f}s，"
                    f"≥{CHUNK_FAIL_RATIO:.0%} 阈值），转写结果不可信，已放弃整段文本: {ranges}{more}")
        if stats["coveredSeconds"] <= 0.0:
            raise ChunkLossError(
                f"整个区间（{base:.0f}s 起 +{float(total):.0f}s）没有解出任何音频数据"
                f"（音轨缺失或区间越界），无可转写内容")
        return "\n".join(parts)
    finally:
        if stats_out is not None:
            stats_out.clear()
            stats_out.update(stats)


# --------------------------------------------------------------------------
# 分段 → .srt
# --------------------------------------------------------------------------
def _fmt_ts(sec: float) -> str:
    """秒 → srt 时间戳 HH:MM:SS,mmm"""
    ms = int(round(max(0.0, float(sec)) * 1000))
    hh, ms = divmod(ms, 3600000)
    mm, ms = divmod(ms, 60000)
    ss, ms = divmod(ms, 1000)
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def write_srt(path: str, segments: list) -> int:
    """分段落 → 标准 .srt（序号 / HH:MM:SS,mmm --> HH:MM:SS,mmm / 文本）。返回写了多少条。"""
    out_dir = os.path.dirname(os.path.abspath(path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    blocks: list[str] = []
    for seg in segments or []:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        begin = float(seg.get("start") or 0.0)
        span = max(0.001, float(seg.get("dur") or 0.0))
        blocks.append(f"{len(blocks) + 1}\n{_fmt_ts(begin)} --> {_fmt_ts(begin + span)}\n{text}\n")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(blocks))
    return len(blocks)


def _srt_for(path: str, index: int) -> str:
    """多个条目共用一次 --srt 时，按条目序号插到扩展名前（a.srt → a.1.srt）。"""
    root, ext = os.path.splitext(path)
    return f"{root}.{index}{ext or '.srt'}"


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
                    help="把结果以 JSON 打到 stdout: {ok, threads, items:[{source,text,error,duration,segments,chunksTotal,chunksFailed,coveredSeconds,failedSeconds,emptySeconds,spanSeconds,failedRanges,durationUnknown}], model, elapsed}")
    ap.add_argument("--chunk", dest="chunk", type=float, default=CHUNK_SEC, metavar="SEC",
                    help=f"分片长度（秒，默认 {CHUNK_SEC:g}）；0 = 不分片、整段一次解码（旧行为，长音频会静默丢内容）")
    ap.add_argument("--srt", dest="srt", default=None, metavar="PATH",
                    help="把分段落另存为标准 .srt 字幕（相对/绝对路径都行；多个条目时写成 PATH.1.srt 这种带序号的）")
    ap.add_argument("--no-snap", dest="no_snap", action="store_true",
                    help="关掉静音吸附，切点退回固定 chunk 秒硬切（对比用，正常不用给）")
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

    # 本地文件已存在时不需要下载（清单同时给直链与本地路径时以本地为准）
    need_url = any(it["url"] and not (it["local"] and os.path.exists(it["local"])) for it in items)
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
        entry = {"source": it["source"], "text": "", "error": None, "duration": None,
                 "segments": []}
        if it["local"] and os.path.exists(it["local"]):  # 本地文件当场量时长：模型不可用时也能报
            entry["duration"] = probe_duration(ffmpeg, it["local"])
        if model_error:
            entry["error"] = f"模型不可用: {model_error}"
            failing += 1
            result["items"].append(entry)
            texts.append(f"{it.get('screen') or '-'}|{it.get('title') or os.path.basename(it['source'])}|[转写失败] {entry['error']}")
            continue
        chunk_stats: dict = {}
        try:
            if not tmp_root:
                raise RuntimeError("没有可写的临时目录（可用 DSH_DOUYIN_TMP 指定）")
            media, downloaded = it["local"], ""
            if media and os.path.exists(media):
                pass  # 本地文件就在手边：不再为同一段声音下载一遍
            elif it["url"]:
                downloaded = download(yt_dlp, it["url"], tmp_root, args.cookies)
                media = downloaded
            elif media:
                raise RuntimeError(f"文件不存在: {media}")
            else:
                raise RuntimeError("既没有直链，本地文件也不存在")
            try:
                if entry["duration"] is None:  # 下载来的媒体只能到这一步才量
                    entry["duration"] = probe_duration(ffmpeg, media)
                chunk = max(0.0, float(getattr(args, "chunk", CHUNK_SEC) or 0.0))
                entry["text"] = transcribe_media(recognizer, ffmpeg, media, tmp_root,
                                                start=args.start, dur=args.dur,
                                                chunk=(chunk if chunk > 0 else 10 ** 9),
                                                segments_out=entry["segments"],
                                                snap=not getattr(args, "no_snap", False),
                                                stats_out=chunk_stats)
            finally:
                if downloaded:
                    try:
                        os.remove(downloaded)
                    except OSError:
                        pass
            entry.update(chunk_stats)  # 分片统计进信封：durationUnknown/chunksFailed/failedRanges…
            text = entry["text"]
            eprint(f"      → {text[:120]}")
        except Exception as exc:  # 不裸 traceback：异常文本进 error 字段
            entry.update(chunk_stats)  # 失败路径同样带上分片统计（若有）——丢片不许静默
            entry["error"] = one_line(f"{type(exc).__name__}: {exc}", 400)
            failing += 1
            eprint(f"      → 转写失败: {entry['error']}")
        if args.srt:
            if entry["segments"]:
                srt_path = args.srt if len(items) == 1 else _srt_for(args.srt, idx)
                try:
                    eprint(f"      [srt] {write_srt(srt_path, entry['segments'])} 条 → {srt_path}")
                except Exception as exc:  # 字幕写不出来不该把已经转好的文本算失败
                    eprint(f"      [srt] 写失败: {type(exc).__name__}: {exc}")
            else:
                eprint("      [srt] 这条没有分段文本，跳过")
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
