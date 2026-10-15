# Retake

A desktop video editor that can also make the first cut for you.

Drop in your videos and edit them like any editor: a timeline, transitions, animated captions, text, music, filters, speed, zoom and every common shape from YouTube to Shorts. Or point Retake at a folder of long tutorial recordings and let it do the slow part: it lines up a separate voice track with the screen recording, cuts the retakes, false starts and dead air with AI, finds and blurs anything private on screen, and hands you the result on the same timeline.

Everything runs on your computer. Your footage never leaves it. The only thing sent anywhere is the transcript text, and only to the AI editor you choose.

## Features

**Editing**
- Timeline with Text, Overlay, Video and Audio tracks. Split, trim, reorder, duplicate, snapping, undo and redo for everything. Saves as you go.
- Edit by text: every word of the transcript is clickable. Select words and press Delete to cut them; press R to bring them back.
- Clip speed from 0.25x to 4x (voice keeps its pitch), volume and mute.
- Twelve colour filters plus brightness, contrast, saturation, warmth, vignette and sharpen.
- Framing: fit or fill, blurred background, zoom and pan, and a slow Ken Burns push.
- Twelve transitions, including crossfade, dip to black, slide, wipe, zoom and circle.
- 16:9, 9:16, 1:1 and 4:5, switched at any time.

**Captions and text**
- Twelve animated caption looks (pop, karaoke, word box, highlighter, neon, one word at a time and more), made from your words and following every cut.
- Ten text styles with entrances (pop, rise, slide, typewriter). Drag text in the preview to place it, scroll to resize it.
- Title cards, chapter labels and lower thirds for tutorials. Chapters are exported as a YouTube chapter list.
- Fix a misheard word once and it is fixed everywhere.

**Media and sound**
- B-roll, pictures and clips, full screen or picture in picture with rounded corners.
- Music that loops to fill and ducks under your voice. Twelve built-in sound effects, made on your computer.
- Voice cleanup and loudness levelled to the YouTube target (-14 LUFS).

**For tutorial recordings**
- Pairs each voice track with its screen recording and lines them up by sound, including the jumps where two recorders were paused a moment apart.
- An AI first cut: keeps the last good take of each sentence, removes lines meant for the editor and long waits, adds chapters, writes a title and description, and leaves notes on anything worth checking.
- Privacy: reads the screen wherever it changes and blurs emails, phone numbers, API keys, password prompts, links with long IDs, file pickers and any words you add. After export it reads the finished video back to check nothing private is still visible.

**Two ways to export**
- **Export video** renders with ffmpeg at full quality and runs the privacy read-back check.
- **Fast export** renders in the window with Retake's own engine on your graphics chip. Blurs are applied; the read-back check is not run.

## Install

Retake needs Windows 10 or 11 (macOS and Linux should work but are untested), Python 3.11 or newer, ffmpeg on the PATH, and Node 20 or newer to build the interface.

```powershell
git clone https://github.com/degordonstech/retake.git
cd retake
pip install -r requirements.txt
cd web; npm install; npm run build; cd ..
python -m retake
```

`Start Retake.cmd` starts it without a console window. `python -m retake --browser` opens it in your browser instead of its own window.

The first transcription downloads a Whisper speech model (about 500 MB for the default `small` model).

## Start a video

- **New video**: click it on the home screen or drag files onto the window. The files go straight onto the timeline. Turn on **AI first cut** first if you want Retake to edit them for you.
- **From a folder of recordings**: choose a folder that holds your screen recordings, voice tracks and camera footage. Retake works out which file is which, pairs them, and makes the first cut.

See the [user guide](docs/user-guide.md) for every tool and shortcut.

## Who makes the first cut

Chosen in Settings:

| Option | What it uses | Cost |
|---|---|---|
| Claude Code (default) | The Claude Code installed on this computer, run headless | Your existing Claude plan |
| Claude API key | Your Anthropic key | Per video, on your Anthropic account |
| Groq | A free Groq key (`openai/gpt-oss-120b`) | Free tier |
| Built-in rules | No AI: drops filler-only phrases and obvious retakes | Free, offline |

If the AI isn't available or fails, Retake falls back to the built-in rules and says so.

## Documentation

- [User guide](docs/user-guide.md): every tool, panel and shortcut.
- [Architecture](docs/architecture.md): how the engine, the editor and the exporters fit together.
- [Development](docs/development.md): running from source, testing safely, and conventions.
- [Project format](docs/project-format.md): what is stored in a project and where.
- [Local API](docs/api.md): the endpoints the window uses.
- [Privacy](docs/privacy.md): what stays on your computer and how the blurring works.
- [Contributing](CONTRIBUTING.md)

## Fonts

The caption and text fonts are in `retake/assets/fonts`: Poppins, Anton, Bebas Neue, Bangers, Archivo Black and DM Serif Display under the SIL Open Font License (`LICENSE-OFL.txt`), and Permanent Marker and Luckiest Guy under the Apache License 2.0 (`LICENSE-Apache.txt`). Space Grotesk and JetBrains Mono are under the SIL Open Font License.

## License

Not yet licensed for reuse. Copyright Godwin Danjuma. All rights reserved.
