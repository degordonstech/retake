# Architecture

Retake has two halves that talk over HTTP on `127.0.0.1`:

- **The backend** (`retake/`, Python): projects, transcription, sync, the AI first cut, the privacy scan, the ffmpeg export, and a local API.
- **The interface** (`web/`, React and TypeScript): the editor, plus Retake's own rendering engine (`web/src/engine/`), which draws the preview and makes Fast exports.

The desktop app is the backend plus a [pywebview](https://pywebview.flowrl.com/) window (WebView2 on Windows) showing the interface it serves.

```
retake/
  main.py          start the backend and the window; single instance; logging
  app.py           the local API (FastAPI) and static files
  config.py        settings and the project list, in %APPDATA%\Retake
  project.py       a project is a folder; Retake's work goes in <folder>/.retake/
  media.py         ffmpeg and ffprobe: probing, audio, proxies, thumbnails, frame windows
  analysis.py      transcription (faster-whisper) and voice-to-picture sync
  brain/           the AI editors and the built-in rules, all returning one JSON shape
  edit.py          kept words -> clips, cut on the quietest moment
  privacy.py       OCR scan of the kept footage, blur areas, the read-back leak check
  captions.py      caption and text layout with the real fonts; the ASS subtitle file
  looks.py         caption templates, text styles, filters, transitions and shapes
  render.py        the ffmpeg export
  assets.py        imported media (files stay where they are)
  sfx.py           built-in sound effects, synthesised on first use
  jobs.py          one background job at a time, with progress
web/src/
  pages/           home, settings, the project shell
  steps/           Footage, Privacy, Export
  editor/          the editor: model, timeline, transcript, panels, inspector, player
  engine/          scene, decoding, compositor, text, audio, export
```

## Concepts

- **Source**: one media file. Its role is screen, voice, camera or skip.
- **Take**: one stretch of narration and the picture that goes with it: a voice source plus, optionally, a video source at a time offset. A camera recording is a take whose voice and video are the same file.
- **Offsets**: video time = voice time + offset. Two recorders paused separately drift apart in jumps, so a take stores a list of `[voice_time, offset]` steps found from the sound. A clip never crosses a jump.
- **Clip**: a stretch of a take on the main Video track, in the take's voice time (`a` to `b`), with its speed, volume, colour, framing and the transition into it. A title card is a clip with its own duration.
- **Items**: text and graphics (`overlays`), pictures and video over the main track (`media`), and sounds (`audio`), each with a start and a duration on the timeline.

The main track is magnetic: clips play one after another, so a clip's place on the timeline is the sum of the lengths before it. A clip's length on the timeline is `(b - a) / speed`.

The full schema is in [project-format.md](project-format.md).

## The editing flow

1. **Prepare** (`jobs.run_prepare`): preview copies for files the window can't play, thumbnail sprites, transcription with word timings (fitted to measured silences), and sync of each voice with its screen recording.
2. **First cut** (`jobs.run_autoedit`): the transcript goes to the chosen AI editor with the system prompt in `brain/__init__.py`. It answers with the words to keep, chapters, notes, corrections, a title and a description. `edit.build_clips` turns kept words into clips, cutting at the quietest 10 ms near each boundary and shortening long pauses.
3. **Just edit** (`jobs.run_quickstart`): no transcription. Every file becomes its own take and goes on the timeline whole.
4. **Editing** happens in the window. The edit autosaves to the backend 600 ms after each change. Undo and redo live in the window.
5. **Privacy scan** (`jobs.run_scan`): reads the kept footage at 10 frames a second wherever the picture changes, with Windows OCR. Finds are grouped into runs with boxes. Blur areas come from the finds you keep plus any you draw.
6. **Export**: either path below.

## Rendering engine (web/src/engine)

The preview and Fast export are drawn by the same code, so what you see is what you get.

- **scene.ts** compiles the edit into layers once per change: the main clips with their file-time mapping, framing, colour, blur areas and transition windows; overlays; graphics; text. `mainAt(t)` says which clips are on screen and whether a transition is under way.
- **media.ts** decodes frames exactly with WebCodecs through [Mediabunny](https://mediabunny.dev/). Each video keeps one decoder that reads forward while playing and seeks on a jump. Screen recordings store a frame only when something changes, so a seek asks for the frame on screen at that moment, which may be seconds old. The newest request wins; older frames are closed as soon as they're replaced, so memory stays flat. Consecutive clips alternate between two decoders, so a transition can show two moments of one recording, and the next clip is decoded just before its cut.
- **gl.ts** is a WebGL2 compositor with premultiplied alpha. One shader draws a picture into a rectangle with crop, rotation (phone video stores it separately), rounded corners, colour adjustment, vignette and blur. A second shader blends two offscreen frames for the twelve transitions.
- **text.ts** draws captions and styled text on a 2D canvas, from the timing rules in `looks.ts`.
- **renderer.ts** draws one moment: the main clip or a transition, privacy blurs, overlays, graphics, text and captions, and fades.
- **audio.ts** mixes sound in one-second windows: voice clips (speed changes use a waveform-similarity overlap-add stretch that keeps pitch), music and effects, ducking under the voice, and loudness measured to ITU-R BS.1770 and levelled to -14 LUFS.
- **export.ts** draws every frame, waits for exact frames, encodes video and audio with WebCodecs and writes an MP4 with Mediabunny, streaming the file in pieces to the backend (`/stream-render`).

## ffmpeg export (retake/render.py)

1. **Pieces**: each clip is cut, blurred, retimed, coloured and framed for the output size, and cached by a hash of everything that affects it. Where a transition joins two clips, a short piece is made from the end of one and the start of the next (borrowing picture from just outside each clip) and blended with `xfade`, so the timing never shifts.
2. **Final pass**: the pieces are joined; B-roll, graphics, captions and text (one ASS file drawn by libass with the bundled fonts), music with sidechain ducking, and loudness normalisation are applied in one filter graph.
3. **Read-back check**: the finished file is read with OCR and anything private still readable is reported.

Screen recordings are read from up to 20 seconds before each cut and trimmed back, because seeking straight to a moment can show the wrong frame in a recording that only stores changes. The privacy scan uses the same decoding, so a blur lands exactly where the renderer puts the frame.

## Captions

The backend lays out captions (`captions.layout`) with the real fonts: words grouped into captions (by count, pauses, sentence ends and fit), lines balanced, every word given its own position. The window draws from that same layout, and the export writes it to an ASS subtitle file where every word is its own positioned event, so a single word can pop, glow or sit in a box without the line moving. libass sizes fonts by their Windows ascent and descent, so sizes are converted from em with each font's ratio.

## Jobs

`jobs.py` runs one job at a time on a worker thread: `prepare`, `autoedit`, `quickstart`, `scan`, `render`. Jobs read the project when they start and save with `project.commit`, which applies their changes to the latest saved project, so edits made in the window while a job runs are kept.

## The desktop window

`main.py` starts the API on port 8765 (or a free port) and opens the window. A second launch brings the open window forward. Each run clears WebView2 processes left on Retake's data folder by a previous crash, and a window that hasn't loaded after 25 seconds falls back to the browser. Files dragged onto the window are passed to the page with their full paths.
