# Retake

Record it once. Retake does the rest.

Retake is a desktop video editor for people who record long tutorials in one go: a screen recording, often a separate voice track, sometimes a camera. Point it at the folder. It lines your voice up with your screen, makes a first cut with AI (retakes, false starts, dead air and "I'll be back when it's done" are gone), finds and blurs anything private on screen, and gives you a transcript and a timeline to finish the edit yourself, like any editor.

Everything runs on your computer. Your footage never leaves it, except the transcript text that goes to the AI you choose.

## What it does

1. **Footage.** Reads the folder and works out what each file is: screen recording, voice track, camera, or something to leave out. Each voice is paired with its picture and lined up by sound, including the jumps where the two recorders were paused a moment apart.
2. **First cut.** Transcribes every take (Whisper, on your machine) and asks your AI editor which words to keep and in what order. It keeps the last good attempt at each sentence, cuts lines meant for the editor, adds chapters, writes a title and description, and leaves notes on anything worth checking.
3. **Edit.** A three-panel editor:
   - **Transcript**: click a word to jump there, drag across words and press Delete to cut them, or R to bring them back.
   - **Preview**: plays the edit with your labels on it.
   - **Timeline**: drag clips to reorder, drag edges to trim, S to split, title cards, chapter labels, lower thirds and captions. Undo and redo for everything; it saves as you go.
4. **Privacy.** Reads the kept footage ten frames a second wherever the picture changes, and blurs emails, phone numbers, API keys and tokens, password prompts, links with long IDs, file pickers, recent-project lists, desktop icons, link previews, and any words you add yourself. Each find is shown on its frame with a switch. You can draw your own blurs.
5. **Export.** Renders at full quality (1080p, your footage's frame rate, loudness levelled for YouTube), then **reads the finished video back** to check that nothing private is still readable. Captions (.srt) and a YouTube chapters list are saved next to it.

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
  render.py        clips -> finished MP4, graphics, captions, chapters
  graphics.py      labels, lower thirds, captions and title cards
  jobs.py          one background job at a time, with progress
  app.py           the local API the window talks to
web/               the interface (React, TypeScript, Vite)
```

A few things the engine gets right that matter:

- **Screen recordings store a frame only when something changes.** Seeking straight to a moment can show the wrong frame, so every cut decodes from up to 20 seconds earlier and trims back. The privacy scan uses the same decoder as the renderer, so a blur lands exactly where the renderer puts the frame.
- **Two recorders paused separately drift apart in jumps**, not smoothly. Sync finds each jump from the sound and places it at the right moment; a clip never crosses one.
- **Brief redraws are caught.** A terminal can reprint a password prompt for a fraction of a second. The scan reads text again whenever the picture changes, and carries a find forward across small changes, so one misread doesn't open a gap.
- **Nothing is trusted blindly.** The finished file is read back with OCR before Retake calls it done.

## Privacy notes

- Footage, proxies, transcripts and renders stay in the project folder.
- Only the transcript text is sent to the AI editor you choose.
- API keys are stored in `%APPDATA%\Retake\settings.json` and are never sent back to the interface.

## Status

Private, version 0.1.
