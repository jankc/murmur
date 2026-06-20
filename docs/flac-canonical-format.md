# Change request: make FLAC the canonical recording format

**Status:** implemented · **Audience:** an implementing agent with no prior context · **Scope:** repo-wide but mechanical

> **As-built deviations from this spec** (the plan was followed except where it would have
> introduced a bug):
> - **`recordings.ts move()` preserves the source's actual extension** instead of using the
>   canonical builders. Moving a legacy `.wav` (reprocess, or a hand-dropped recording) to a
>   `.flac` *name* would have renamed WAV bytes into a `.flac` file — corruption. `move()` now
>   relocates the file as-is.
> - **`processedWav`/`failedWav` path builders were removed**, not just retargeted to `.flac`.
>   Those folders hold a mix of FLAC and legacy WAV, so a `.flac`-only builder is a footgun;
>   callers resolve via `locate()`/`move()` (which check both extensions). `inboxWav` stays
>   (canonical target for new recordings); `partialWav` stays (`.wav` raw capture).
> - **`archive.ts durationOf()` was made format-aware** (this site was missing from §5's table):
>   the `(size-44)/32000` PCM math is valid only for raw WAV, so FLAC duration is read via
>   `ffprobe` while legacy `.wav` keeps the fast size calc.

---

## 1. Motivation

Today every recording that reaches the pipeline is a **16 kHz mono `s16le` WAV**. Both capture
backends produce it, the importer produces it, and the rest of the system assumes a `.wav`
extension everywhere. WAV is uncompressed: at 16 kHz mono s16le the `processed/` archive grows
**~115 MB/hour**.

**FLAC is lossless** (identical transcription accuracy) and **~50–60 % smaller** (~50 MB/hour).
All downstream consumers already read FLAC. The goal of this change is to make **FLAC the
canonical archived format** (the bytes that live in `inbox/`, `processed/`, `failed/`) with no
loss of audio quality, no regression in crash-safety, and backward compatibility with the
existing `.wav` back catalogue.

This was scoped after confirming the facts in §2. It is intentionally **not** a multi-format
pipeline (keeping originals as m4a/opus) — that was rejected earlier as too invasive. This is a
single-canonical-format switch: WAV → FLAC.

---

## 2. Established facts (verified against the code)

- **mlx-whisper reads any ffmpeg-decodable format.** `asr/asr.py:33` calls
  `mlx_whisper.transcribe(audio_path, …)`, which decodes via ffmpeg internally. **No change to
  `asr.py` is required** to feed it FLAC.
- **pyannote diarization reads FLAC.** `asr/asr.py:67` calls `pipe(audio_path)`; pyannote loads
  via torchaudio/soundfile, both of which support FLAC. **No change required.**
- **ffmpeg encodes/decodes FLAC natively** (`-c:a flac`), and `volumedetect` (used by
  `measurePeakDb` for the silence check) works on FLAC.
- **Transcripts and summaries are format-independent** — they are derived `.txt`/`.md`. The only
  place the audio extension leaks into them is the Obsidian frontmatter `source:` pointer
  (`archive.ts:59`).
- **Everything else keys off the basename, not the bytes.** The queue, state files, watcher
  dedup, and archiver all operate on `meeting-<stamp>` basenames. The only thing that cares about
  the literal extension is the hardcoded `.wav` string (≈30 sites, enumerated in §5).

---

## 3. Key design decision: capture PCM, convert to FLAC at the boundary

There are two ways to obtain FLAC. **Choose Option A.**

### Option A — convert at finalize (RECOMMENDED)
Keep capturing **raw PCM WAV** into `recordings/.partial/`, and **transcode to FLAC at the
`.partial → inbox/` boundary**. Canonical (`inbox/`, `processed/`, `failed/`) becomes `.flac`;
`.partial/` stays `.wav`.

- **Why:** murmur's whole design leans on crash-recovery (`recorder.finalizeOrphans()` /
  `moveStrayPartial()` rescue an interrupted capture). Raw PCM is maximally salvageable; a FLAC
  killed mid-stream (SIGKILL / host crash) loses its seektable/STREAMINFO total-samples and
  possibly its last frame. Capturing PCM and encoding FLAC only once the capture is *complete*
  keeps recovery operating on robust PCM.
- The **ownscribe backend already transcodes at finalize** (`transcode.ts`), so it only changes
  codec/extension — no new pass.
- The **ffmpeg backend** currently writes PCM straight to `.partial/` and *renames* to inbox.
  Under Option A its finalize becomes a **transcode** (a few seconds of CPU at stop). Acceptable.
- The **importer already transcodes** — it only changes codec/extension.

### Option B — encode FLAC live (NOT recommended)
Change the ffmpeg capture encoder to `-c:a flac` so `.partial/` holds FLAC directly. Simpler
(one arg, no finalize transcode) but it makes the hard-crash recovery path more fragile. Only
adopt if the finalize-transcode CPU on long ffmpeg recordings proves unacceptable.

The rest of this document assumes **Option A**.

---

## 4. Centralize the extension (do this first)

Do **not** find-and-replace `.wav`. Introduce one source of truth and route every site through it.

In `src/paths.ts` (or a small new `src/audio.ts`), add:

```ts
export const CANONICAL_AUDIO_EXT = ".flac";        // what NEW recordings are stored as
const KNOWN_AUDIO_EXTS = [".flac", ".wav"];          // recognised in inbox/processed (migration)

/** True if a filename is a recording we should pick up (FLAC, or a legacy WAV). */
export function isRecordingFile(name: string): boolean {
  return KNOWN_AUDIO_EXTS.some((e) => name.toLowerCase().endsWith(e));
}

/** Strip a known recording extension to get the bare basename. */
export function stripAudioExt(name: string): string {
  const lower = name.toLowerCase();
  const ext = KNOWN_AUDIO_EXTS.find((e) => lower.endsWith(e));
  return ext ? name.slice(0, -ext.length) : name;
}
```

Rationale for **two** lists: NEW output is always FLAC (`CANONICAL_AUDIO_EXT`), but **lookups and
filters must accept legacy `.wav`** so the existing back catalogue and any in-flight recordings
keep working without a forced re-transcode.

---

## 5. Edit sites

`.partial/` raw-capture names and ownscribe's internal temp tracks **stay `.wav`** — they are
intermediate PCM, never the canonical artifact. Everything else that names the *canonical* file,
or filters/strips its extension, changes.

### 5a. Path builders — `src/paths.ts`
| Line | Now | Change |
|---|---|---|
| 73 `partialWav` | `${b}.wav` | **KEEP `.wav`** (raw PCM capture target). Add a comment. |
| 74 `inboxWav` | `${b}.wav` | `${b}${CANONICAL_AUDIO_EXT}` |
| 75 `processedWav` | `${b}.wav` | `${b}${CANONICAL_AUDIO_EXT}` |
| 76 `failedWav` | `${b}.wav` | `${b}${CANONICAL_AUDIO_EXT}` |

> Consider renaming the builders (`inboxWav`→`inboxAudio`, etc.) for honesty, but that widens the
> diff; optional.

### 5b. Producers — encode FLAC at finalize
- **`src/transcode.ts`** — the shared helper currently hardcodes `-c:a pcm_s16le` and is named
  `transcodeToWav16k`. Change the codec to `-c:a flac` (keep `-ac 1 -ar 16000`) and rename to
  `transcodeToFlac16k`. Update its two existing callers (ownscribe finalize, importer).
- **`src/recorder.ts`**
  - `RecordingState.outWav` / line 63: the ffmpeg backend still **captures** to
    `.partial/<base>.wav` (PCM). Keep the capture WAV; introduce the FLAC inbox target as a
    separate value computed at finalize.
  - `finalizeState()` (≈170–200): for the **ffmpeg** backend, replace the bare `renameSync` into
    inbox with **transcode** `.partial/<base>.wav` → temp `.flac` → atomic rename into
    `inboxWav(base)` (now `.flac`). For **ownscribe**, retarget its existing transcode to FLAC
    into inbox. Delete the raw `.partial/<base>.wav` after a successful encode (it already cleans
    temps via `cleanupTemps`).
  - Line 158 (orphan auto-stop return path): `${st.base}.wav` → `inboxWav(st.base)`.
  - Line 179 (recovery-hint log string): update the suggested recovery command to
    `-c:a flac … <out>.flac`.
  - `moveStrayPartial()` (≈218–243): the regex at line 221 (`^meeting-…\.wav$`) still matches the
    **raw PCM** stray in `.partial/` — keep `.wav`. But the action must change from *rename* to
    **transcode the stray WAV → `inbox/<base>.flac`** (a crashed ffmpeg capture is raw PCM, not a
    finished FLAC).
  - Lines 103, 220, 243 (`.oa.wav`, `.sys.tmp.wav`, `.mic.tmp.wav`): **NO CHANGE** — ownscribe
    internals.

### 5c. Lookup / filter / strip sites — route through §4 helpers
| File:line | Now | Change |
|---|---|---|
| `recordings.ts:24` | glob `**/${base}.wav` | glob **both** `.flac` and `.wav` (legacy) |
| `recordings.ts:40` | `basename(input, ".wav")` | `stripAudioExt(input)` |
| `recordings.ts` `locate()` inbox/failed checks | `inboxWav`/`failedWav` only | check FLAC **then** legacy `.wav` for each location |
| `cli.ts:71` (`newestRecording`) | `endsWith(".wav")` | `isRecordingFile(e)` |
| `cli.ts:82, 396` | `basename(wavPath, ".wav")` | `stripAudioExt(...)` |
| `cli.ts:369` (`retry-failed` filter) | `endsWith(".wav")` | `isRecordingFile(f)` |
| `cli.ts:382` | `failedWav(basename(n,".wav"))` | dispatch the **actual** file path (`join(failedDir, n)`), since a legacy entry may be `.wav` |
| `queue.ts:64` | `basename(wavPath, ".wav")` | `stripAudioExt(...)` |
| `watcher.ts:21, 61` | `endsWith(".wav")` | `isRecordingFile(...)` |
| `status.ts:50` (failed count) | `endsWith(".wav")` | `isRecordingFile(...)` |
| `import.ts:87, 105` | `.import-tmp/${base}.wav` + log | `${base}${CANONICAL_AUDIO_EXT}`; call `transcodeToFlac16k` |
| `archive.ts:59` | `source: ${base}.wav` | point at the **actual** stored ext (resolve via `locate`, or `${base}${CANONICAL_AUDIO_EXT}` for new) |

> `worker.ts:126,133` and `control.ts:78` matched the grep only via `wavPath`/`wavArg` variable
> names — **no behavioural `.wav` literal there.** Optional cosmetic rename only.

### 5d. Docs / comments (cosmetic but expected)
- `README.md` lines 8, 84, 157 (`inbox/*.wav`, "each new `.wav`", frontmatter `source:` example).
- `asr/asr.py:5` usage comment (`<audio.wav>`).
- Comment-only `.wav` mentions: `recorder.ts:3,12,167,219`, `paths.ts:18`, `import.ts:3`,
  `recordings.ts:35`, `cli.ts:101`, `watcher.ts:1` — update prose to say FLAC where it describes
  the canonical artifact.

---

## 6. Backward compatibility / migration

- **No back-catalogue re-transcode required.** Existing `processed/<month>/*.wav` stay as-is and
  remain findable because every lookup accepts both extensions (§4, §5c).
- **In-flight state** (`queue.json` entries whose `wavPath` ends `.wav`) keeps resolving — ASR
  decodes any format, and `stripAudioExt` handles either extension.
- **Mixed archive is expected and fine.** Old recordings are `.wav`, new ones `.flac`;
  `reprocess`, `status`, `retry-failed`, and `locate` all handle the mix.
- Re-transcoding old WAVs to FLAC is **out of scope** (optional one-off script later).

---

## 7. Test plan

**Unit (`bun test`, follow `src/pure.test.ts` style):**
- `stripAudioExt`: `meeting-X.flac` / `.wav` / `.m4a` / no-ext → bare basename.
- `isRecordingFile`: true for `.flac` and `.wav`, false for `.txt`/`.md`/`.partial`.
- Existing `parseStamp`/`monthOf` tests are extension-agnostic and must stay green.

**Type + suite:** `cd src && bunx tsc --noEmit -p tsconfig.json` (exit 0) and `bun test` (all green).

**Manual end-to-end (per backend):**
1. `RECORD_BACKEND=ffmpeg` → `murmur record` / `murmur stop`. Assert `inbox/meeting-*.flac`
   exists, `.partial/` left clean, and `ffprobe -show_entries stream=codec_name,sample_rate,channels`
   reports `flac / 16000 / 1`.
2. Same for `RECORD_BACKEND=ownscribe`.
3. Let the daemon process one: assert transcript `.txt` + summary `.md` are produced and the file
   lands in `processed/<YYYY-MM>/meeting-*.flac`.
4. `murmur import` a JPR file → `inbox/*.flac`.
5. **Legacy compat:** drop a hand-made `meeting-2020-01-01_00-00-00.wav` into `inbox/` → it is
   still picked up and processed; `murmur reprocess` of an existing `processed/*.wav` still finds
   it via `locate`.
6. **Crash-recovery (Option A guarantee):** start an ffmpeg recording, `kill -9` it, restart the
   daemon → `finalizeOrphans`/`moveStrayPartial` transcodes the raw `.partial/*.wav` into
   `inbox/*.flac` with no data loss.

---

## 8. Trade-offs (for reviewer awareness)

- **Quality:** none — FLAC is lossless; transcription is byte-for-byte equivalent input to ASR.
- **Storage:** ~50–60 % smaller archive. The win.
- **CPU:** negligible FLAC decode per ASR run (dwarfed by inference); plus a finalize transcode on
  the **ffmpeg** backend (Option A) — a few seconds at stop for long recordings.
- **Crash-safety:** preserved by Option A (capture PCM, encode at finalize). Option B regresses it.
- **Manual audition:** WAV QuickLook-previews everywhere; FLAC playback works in modern macOS but
  spacebar-preview is less reliable. Minor.

---

## 9. Out of scope
- Keeping source originals (m4a/opus) as a second archived format (multi-format pipeline).
- Making the codec/sample-rate env-configurable (this CR hardcodes FLAC / 16 kHz mono).
- Re-transcoding the existing `.wav` back catalogue.
