# Retake

Record it once. Retake does the rest.

Retake is a desktop video editor for people who record long tutorials in one go: a screen recording, often a separate voice track, sometimes a camera. Point it at the folder. It lines your voice up with your screen, makes a first cut with AI (retakes, false starts, dead air and "I'll be back when it's done" are gone), finds and blurs anything private on screen, and gives you a transcript and a timeline to finish the edit yourself, like any editor.

Everything runs on your computer. Your footage never leaves it, except the transcript text that goes to the AI you choose.

## What it does

1. **Footage.** Reads the folder and works out what each file is: screen recording, voice track, camera, or something to leave out. Each voice is paired with its picture and lined up by sound, including the jumps where the two recorders were paused a moment apart.
2. **First cut.** Transcribes every take (Whisper, on your machine) and asks your AI editor which words to keep and in what order. It keeps the last good attempt at each sentence, cuts lines meant for the editor, adds chapters, writes a title and description, and leaves notes on anything worth checking.
3. **Edit.** A full editor, laid out like CapCut: tools on the left, preview in the middle, settings for whatever is selected on the right, and a timeline with Text, Overlay, Video and Audio tracks.
   - **Transcript**: click a word to jump there, drag across words and press Delete to cut them, or R to bring them back. Double-click a word to fix how it is spelled in captions.
   - **Captions**: twelve animated looks (pop, karaoke, word box, highlighter, neon, one word at a time and more), made from your words, following every cut, burned into the export. Size, position, colours, font, words per caption.
   - **Text**: ten styles with entrances (pop, rise, slide, typewriter). Drag text in the preview to move it; scroll over it to resize. Title cards, chapter labels and lower thirds for tutorials.
   - **Media and audio**: bring in B-roll, pictures, music and sound effects (drag files onto the window). Pictures and clips go full screen or picture in picture; music can loop and duck under your voice. Twelve built-in sound effects are made on your computer.
   - **Clips**: speed (0.25x to 4x, voice keeps its pitch), volume and mute, twelve colour filters plus brightness, contrast, saturation, warmth, vignette and sharpen, and framing: fit or fill, blurred background, zoom and pan, and a slow Ken Burns push.
   - **Transitions**: twelve, from crossfade and dip to black to slide, wipe, zoom and circle, on any cut or all of them.
   - **Shape**: 16:9, 9:16, 1:1 or 4:5, switched any time. Face-cam footage fills a portrait frame; screen recordings sit on a blurred copy of themselves.
   - Split, delete, duplicate, snapping, undo and redo for everything; it saves as you go.
4. **Privacy.** Reads the kept footage ten frames a second wherever the picture changes, and blurs emails, phone numbers, API keys and tokens, password prompts, links with long IDs, file pickers, recent-project lists, desktop icons, link previews, and any words you add yourself. Each find is shown on its frame with a switch. You can draw your own blurs.
5. **Export.** Renders at full quality (1080p in the shape you chose, your footage's frame rate, loudness levelled for YouTube, optional fade in and out), then **reads the finished video back** to check that nothing private is still readable. Captions (.srt) and a YouTube chapters list are saved next to it.

## Who makes the first cut

Choose in Settings:

| Option | What it uses | Cost |
|---|---|---|
| Claude Code (default) | The Claude Code installed on this computer, run headless | Your existing Claude plan |
| Claude API key | Your Anthropic key | Per video, on your Anthropic account |
| Groq | A free Groq key (`openai/gpt-oss-120b`) | Free tier |
| Built-in rules | No AI: drops filler-only phrases and obvious retakes | Free, offline |

If the AI isn't available or fails, Retake falls back to the built-in rules and says so.

## Run it

Needs Windows 10 or 11 (macOS and Linux should work but are untested), Python 3.11+, ffmpeg on the PATH, and Node 20+ to build the interface.

```powershell
pip install -r requirements.txt
cd web; npm install; npm run build; cd ..
python -m retake
```

`Start Retake.cmd` does the last step without a console window. `python -m retake --browser` opens it in your browser instead of its own window.

For development, run the engine with `python -m retake --no-window --port 8765` and the interface with `cd web; npm run dev`.

## How it is built

```
retake/            the engine (Python, FastAPI on 127.0.0.1)
  project.py       a project is a folder; everything Retake makes goes in <folder>/.retake/
  analysis.py      transcription (faster-whisper) and voice-to-picture sync
  brain/           the AI editors and the built-in rules, all returning the same JSON
  edit.py          kept words -> clips, cut on the quietest moment, long pauses shortened
  privacy.py       OCR scan of the kept footage, and the read-back leak check
  render.py        clips -> finished MP4: speed, colour, framing, transitions, overlays, music, captions
  captions.py      caption and text layout with the real fonts, written as one ASS file for libass
  looks.py         caption templates, text styles, filters and transitions, shared with the preview
  assets.py        imported media (files stay where they are)
  sfx.py           the built-in sound effects, synthesised on first use
  graphics.py      labels, lower thirds and title cards
  jobs.py          one background job at a time, with progress
  app.py           the local API the window talks to
web/               the interface (React, TypeScript, Vite)
```

A few things the engine gets right that matter:

- **Screen recordings store a frame only when something changes.** Seeking straight to a moment can show the wrong frame, so every cut decodes from up to 20 seconds earlier and trims back. The privacy scan uses the same decoder as the renderer, so a blur lands exactly where the renderer puts the frame.
- **Two recorders paused separately drift apart in jumps**, not smoothly. Sync finds each jump from the sound and places it at the right moment; a clip never crosses one.
- **Brief redraws are caught.** A terminal can reprint a password prompt for a fraction of a second. The scan reads text again whenever the picture changes, and carries a find forward across small changes, so one misread doesn't open a gap.
- **The preview and the export draw captions from the same layout.** The engine places every caption word with the export's fonts; the window draws those positions, so what you see while editing is what gets burned in.
- **Transitions don't change the timing.** A transition is centred on its cut and borrows a few frames from either side, so captions and overlays stay where they were.
- **Nothing is trusted blindly.** The finished file is read back with OCR before Retake calls it done.

## Privacy notes

- Footage, proxies, transcripts and renders stay in the project folder.
- Only the transcript text is sent to the AI editor you choose.
- API keys are stored in `%APPDATA%\Retake\settings.json` and are never sent back to the interface.

## Status

Private, version 0.1.

## Fonts

The caption and text fonts are in `retake/assets/fonts`: Poppins, Anton, Bebas Neue, Bangers, Archivo Black and DM Serif Display under the SIL Open Font License (`LICENSE-OFL.txt`), and Permanent Marker and Luckiest Guy under the Apache License 2.0 (`LICENSE-Apache.txt`).
