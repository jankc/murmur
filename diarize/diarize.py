#!/usr/bin/env python3
"""Speaker diarization helper for murmur, using pyannote community-1 (pyannote.audio 4.x).

Run with the dedicated venv's Python (see README → Diarization):
    ~/.local/share/murmur/diarize-venv/bin/python diarize.py <audio.wav> [--num-speakers N]

Reads HF_TOKEN from the environment (the community-1 model is gated). Prints a JSON object
  {"turns": [{"start": <sec>, "end": <sec>, "speaker": "SPEAKER_00"}, ...]}
to stdout; all logging goes to stderr. This is murmur's diarization engine — whisply does the
transcription, murmur merges the two by timestamp. Kept tiny and dependency-isolated.
"""
import argparse
import json
import os
import sys

MODEL = "pyannote/speaker-diarization-community-1"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--num-speakers", type=int, default=None)
    ap.add_argument("--min-speakers", type=int, default=None)
    ap.add_argument("--max-speakers", type=int, default=None)
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        log("error: HF_TOKEN not set")
        return 2

    import warnings
    warnings.filterwarnings("ignore")
    import torch
    from pyannote.audio import Pipeline

    try:
        pipe = Pipeline.from_pretrained(MODEL, token=token)
    except Exception as e:  # gated repo, bad token, offline, …
        log(f"error: could not load {MODEL}: {e!r}")
        return 3

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    pipe.to(torch.device(device))
    log(f"diarizing {args.audio} with community-1 on {device}")

    kwargs = {}
    if args.num_speakers is not None:
        kwargs["num_speakers"] = args.num_speakers
    if args.min_speakers is not None:
        kwargs["min_speakers"] = args.min_speakers
    if args.max_speakers is not None:
        kwargs["max_speakers"] = args.max_speakers

    out = pipe(args.audio, **kwargs)
    # pyannote.audio 4.x wraps the result; the Annotation exposes itertracks().
    ann = getattr(out, "speaker_diarization", None)
    if ann is None or not hasattr(ann, "itertracks"):
        ann = out if hasattr(out, "itertracks") else getattr(out, "prediction", out)

    turns = [
        {"start": round(seg.start, 3), "end": round(seg.end, 3), "speaker": spk}
        for seg, _, spk in ann.itertracks(yield_label=True)
    ]
    log(f"{len(turns)} turns, {len({t['speaker'] for t in turns})} speaker(s)")
    json.dump({"turns": turns}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
