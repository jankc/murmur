#!/usr/bin/env python3
"""Transcription + optional diarization helper for murmur, in one pyannote.audio 4 venv.

Run with the asr venv's Python (see README → ASR engine):
    ~/.local/share/murmur/asr-venv/bin/python asr.py <audio.wav> \
        [--model <hf-repo>] [--language auto|cs|en|…] [--diarize [--num-speakers N]]

Transcribes with mlx-whisper; when --diarize is given, also runs pyannote community-1
(pyannote.audio 4.x) and emits its speaker turns. murmur merges chunks↔turns by timestamp.
HF_TOKEN is read from the environment (the community-1 model is gated) — only needed for
--diarize. Prints a JSON object to stdout; all logging goes to stderr:
    {"language": "cs", "chunks": [{"start": <sec>, "end": <sec>, "text": "…"}, …],
     "turns": [{"start": <sec>, "end": <sec>, "speaker": "SPEAKER_00"}, …]}
`turns` is [] when --diarize is not requested. Kept tiny and dependency-isolated.
"""
import argparse
import json
import os
import sys

DIARIZE_MODEL = "pyannote/speaker-diarization-community-1"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def transcribe(audio: str, model: str, language):
    import mlx_whisper

    log(f"transcribing {audio} with {model} (lang={language or 'auto'})")
    out = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=model,
        word_timestamps=False,
        language=language,
    )
    chunks = []
    for seg in out.get("segments", []):
        text = seg.get("text", "")
        if not isinstance(text, str) or not text.strip():
            continue
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        chunks.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    detected = out.get("language") or language or ""
    log(f"{len(chunks)} chunk(s), language={detected}")
    return detected, chunks


def diarize(audio: str, num_speakers, token: str):
    import warnings

    warnings.filterwarnings("ignore")
    import torch
    from pyannote.audio import Pipeline

    pipe = Pipeline.from_pretrained(DIARIZE_MODEL, token=token)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe.to(torch.device(device))
    log(f"diarizing {audio} with community-1 on {device}")

    kwargs = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers

    out = pipe(audio, **kwargs)
    # pyannote.audio 4.x wraps the result; the Annotation exposes itertracks().
    ann = getattr(out, "speaker_diarization", None)
    if ann is None or not hasattr(ann, "itertracks"):
        ann = out if hasattr(out, "itertracks") else getattr(out, "prediction", out)

    turns = [
        {"start": round(seg.start, 3), "end": round(seg.end, 3), "speaker": spk}
        for seg, _, spk in ann.itertracks(yield_label=True)
    ]
    log(f"{len(turns)} turns, {len({t['speaker'] for t in turns})} speaker(s)")
    return turns


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="mlx-community/whisper-large-v3-turbo")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--diarize", action="store_true")
    ap.add_argument("--num-speakers", type=int, default=None)
    args = ap.parse_args()

    # "auto" (or empty) → let whisper detect; a code like "cs" forces that language.
    language = None if args.language in (None, "", "auto") else args.language

    detected, chunks = transcribe(args.audio, args.model, language)

    turns = []
    if args.diarize:
        token = os.environ.get("HF_TOKEN", "").strip()
        if not token:
            log("error: HF_TOKEN not set")
            return 2
        try:
            turns = diarize(args.audio, args.num_speakers, token)
        except Exception as e:  # gated repo, bad token, offline, MPS issue, …
            # Non-fatal: return the transcript with empty turns so murmur degrades to
            # a plain transcript rather than losing the meeting.
            log(f"warning: diarization failed: {e!r}")
            turns = []

    json.dump({"language": detected, "chunks": chunks, "turns": turns}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
