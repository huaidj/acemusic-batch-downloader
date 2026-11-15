#!/usr/bin/env python3
"""ACE Radio/成品 MP3 音訊分析：BPM、調性(Camelot)、長度、能量。

只用 numpy + ffmpeg（不裝 librosa）。
用法：python analyze_audio.py <file...> [--seconds 120] [--json]
輸出：JSON array，每筆 {path, ok, duration, bpm, key, camelot, energy}
"""
import json
import math
import os
import subprocess
import sys

import numpy as np

# Windows：由 host/agent 背景呼叫時不要彈出黑色主控台視窗
CREATE_NO_WINDOW = 0x08000000

try:  # 輸出固定 UTF-8，避免中文路徑被主控台編碼吃掉
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

FFMPEG = os.environ.get("ACE_FFMPEG") or "ffmpeg"
FFPROBE = os.environ.get("ACE_FFPROBE") or "ffprobe"

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
CAMELOT_MAJOR = {"C": 8, "G": 9, "D": 10, "A": 11, "E": 12, "B": 1, "F#": 2, "C#": 3, "G#": 4, "D#": 5, "A#": 6, "F": 7}
CAMELOT_MINOR = {"A": 8, "E": 9, "B": 10, "F#": 11, "C#": 12, "G#": 1, "D#": 2, "A#": 3, "F": 4, "C": 5, "G": 6, "D": 7}


def run(cmd, data=None):
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    return subprocess.run(cmd, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def probe_duration(path):
    res = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "json", path])
    try:
        return float(json.loads(res.stdout.decode("utf-8", "ignore"))["format"]["duration"])
    except Exception:
        return None


def decode(path, seconds=120, sr=22050):
    res = run(
        [FFMPEG, "-v", "error", "-i", path, "-t", str(seconds), "-f", "f32le", "-ac", "1", "-ar", str(sr), "pipe:1"]
    )
    audio = np.frombuffer(res.stdout, dtype=np.float32)
    reason = None
    if not len(audio):
        lines = [line.strip() for line in (res.stderr or b"").decode("utf-8", "ignore").splitlines() if line.strip()]
        reason = (lines[0] if lines else "ffmpeg exit " + str(res.returncode))[:200]
    return audio, sr, reason


def estimate_bpm(audio, sr):
    hop, win = 512, 2048
    if len(audio) < win * 8:
        return None
    frames = np.lib.stride_tricks.sliding_window_view(audio, win)[::hop]
    if len(frames) < 8:
        return None
    window = np.hanning(win).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(frames * window, axis=1))
    spectrum = np.log1p(spectrum)
    flux = np.diff(spectrum, axis=0).clip(min=0).sum(axis=1)
    flux = flux - flux.mean()
    if not np.any(flux):
        return None
    fps = sr / hop
    corr = np.correlate(flux, flux, mode="full")[len(flux) - 1 :]
    corr = corr / (corr[0] + 1e-9)
    lag_min = max(2, int(round(fps * 60 / 200)))
    lag_max = min(len(corr) - 2, int(round(fps * 60 / 60)))
    if lag_max <= lag_min:
        return None
    lags = np.arange(lag_min, lag_max + 1).astype(np.float64)
    bpms = fps * 60 / lags
    prior = np.exp(-0.5 * (np.log2(bpms / 120.0) / 0.35) ** 2)
    scores = corr[lag_min : lag_max + 1] * prior
    best = int(np.argmax(scores))
    lag = lags[best]
    # 抛物線細化
    if 0 < best < len(scores) - 1:
        y0, y1, y2 = scores[best - 1], scores[best], scores[best + 1]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-9:
            lag = lag + 0.5 * (y0 - y2) / denom
    bpm = fps * 60 / lag
    # 半速/倍速修正到較合理區間
    while bpm < 82:
        bpm *= 2
    while bpm > 178:
        bpm /= 2
    return float(bpm)


def estimate_key(audio, sr):
    hop, win = 2048, 4096
    if len(audio) < win * 8:
        return None, None, 0.0
    frames = np.lib.stride_tricks.sliding_window_view(audio, win)[::hop]
    window = np.hanning(win).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(frames * window, axis=1)) ** 2
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    mask = (freqs >= 65) & (freqs <= 2000)
    if not np.any(mask):
        return None, None, 0.0
    freqs = freqs[mask]
    spectrum = spectrum[:, mask]
    pitch_classes = np.round(12 * np.log2(freqs / 440.0)).astype(int) % 12
    chroma = np.zeros(12)
    for pc in range(12):
        idx = np.where(pitch_classes == pc)[0]
        if len(idx):
            chroma[pc] = float(spectrum[:, idx].sum())
    total = chroma.sum()
    if total <= 0:
        return None, None, 0.0
    chroma = chroma / total
    best_corr, best = -2.0, None
    for root in range(12):
        for profile, quality in ((MAJOR_PROFILE, "major"), (MINOR_PROFILE, "minor")):
            rotated = np.roll(profile, root)
            corr = float(np.corrcoef(chroma, rotated)[0, 1])
            if corr > best_corr:
                best_corr, best = corr, (root, quality)
    if best is None:
        return None, None, 0.0
    root, quality = best
    key = f"{NOTES[root]}:{'major' if quality == 'major' else 'minor'}"
    camelot = CAMELOT_MAJOR[NOTES[root]] if quality == "major" else CAMELOT_MINOR[NOTES[root]]
    camelot_key = f"{camelot}{'B' if quality == 'major' else 'A'}"
    return key, camelot_key, best_corr


def energy_of(audio):
    if not len(audio):
        return 0.0
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    return round(rms, 5)


def analyze(path, seconds):
    out = {"path": path, "ok": False}
    if not os.path.isfile(path):
        out["error"] = "not found"
        return out
    try:
        duration = probe_duration(path)
        audio, sr, decode_error = decode(path, seconds)
        if not len(audio):
            out["error"] = "decode failed: " + (decode_error or "empty audio stream")
            return out
        bpm = estimate_bpm(audio, sr)
        key, camelot, confidence = estimate_key(audio, sr)
        out.update(
            {
                "ok": True,
                "duration": round(duration, 2) if duration else round(len(audio) / sr, 2),
                "bpm": round(bpm, 1) if bpm else None,
                "key": key,
                "camelot": camelot,
                "keyConfidence": round(confidence, 3),
                "energy": energy_of(audio),
                "size": os.path.getsize(path),
                "mtime": os.path.getmtime(path),
            }
        )
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)
    return out


def main():
    args = sys.argv[1:]
    seconds = 120
    if "--seconds" in args:
        idx = args.index("--seconds")
        seconds = int(args[idx + 1])
        del args[idx : idx + 2]
    files = [a for a in args if not a.startswith("--")]
    results = [analyze(f, seconds) for f in files]
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
