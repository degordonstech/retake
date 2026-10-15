# Retake

Retake is a free desktop video editor. You can drop in clips and edit them yourself, or hand it a folder of long screen recordings and let it make the first cut.

I built it because editing my own tutorials took longer than recording them. I record in one go: screen, voice on a separate recorder, sometimes my face. Then I'd spend hours lining the voice up with the screen, cutting every "wait, let me do that again", and scrubbing frame by frame to blur API keys and emails I'd shown by accident. Retake does that part. Then it gives you a normal editor to finish the video your way.

It runs on your computer. Your footage stays there.

## What you can do with it

Edit like you would anywhere else. There's a timeline with text, overlay, video and audio tracks. You can split, trim, reorder and undo anything, and it saves as you go. You can also edit by text: delete a sentence from the transcript and it's gone from the video.

Make it look good. There are twelve animated caption styles, built from what you said and following every cut. You get text with pop, slide and typewriter entrances, and twelve transitions and twelve colour filters. Clips can run from 0.25x to 4x and keep your voice's pitch. You can zoom into code with a slow Ken Burns push, and switch between 16:9, 9:16, 1:1 and 4:5 whenever you like.

Add media. Drop in B-roll full screen or picture in picture, and add music that gets quieter while you talk. There are built-in sound effects, generated on your machine, so there's no licence to worry about. Sound is levelled to YouTube's loudness target.

Let it edit long recordings. Give it a folder with your screen recordings, voice tracks and camera footage. It works out which is which and syncs each voice to its screen, even when the two recorders were paused at slightly different times. An AI then cuts the retakes, false starts and dead air, adds chapters, and suggests a title and description. You review it on the timeline like any other edit.

Keep private things private. It reads your screen recordings and blurs emails, phone numbers, API keys, password prompts and anything else you tell it to watch for. After export it reads the finished video back to check nothing slipped through.

## Getting started

You need Windows 10 or 11, Python 3.11+, Node 20+, and ffmpeg on your PATH. macOS and Linux should work, but I haven't tested them.

```powershell
git clone https://github.com/degordonstech/retake.git
cd retake
pip install -r requirements.txt
cd web; npm install; npm run build; cd ..
python -m retake
```

Next time, double-click `Start Retake.cmd`. Add `--browser` to open it in your browser instead of its own window.

Then click **New video** and pick your files, or drag them onto the window. To have the AI make a first cut, turn on **AI first cut** before you add them, or start from a folder of recordings.

The first time you transcribe, it downloads a speech model of about 500 MB.

## The AI part is optional

You pick who makes the first cut in Settings:

| Option | What it needs | What it costs |
|---|---|---|
| Claude Code (default) | Claude Code installed on your computer | Your existing Claude plan |
| Claude API | An Anthropic API key | Pay per use, on your Anthropic account |
| Groq | A free Groq key | Nothing on the free tier |
| Built-in rules | Nothing | Nothing. It trims obvious retakes and filler without AI |

Only the transcript text is sent, and only to the one you picked. If you edit by hand, nothing leaves your computer.

## Two ways to export

**Export video** renders everything with ffmpeg at full quality. Then it reads the result back with OCR to make sure nothing private is visible.

**Fast export** renders in the app's own engine on your graphics card. Blurs are still applied, but the read-back check is skipped.

## Docs

- [User guide](docs/user-guide.md): every tool and shortcut
- [How it works](docs/architecture.md)
- [Working on Retake](docs/development.md)
- [Project files](docs/project-format.md)
- [Local API](docs/api.md)
- [Privacy](docs/privacy.md)
- [Contributing](CONTRIBUTING.md)

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). For security problems, see [SECURITY.md](SECURITY.md) and please don't open a public issue.

## Credits

Retake stands on some excellent open source work: [ffmpeg](https://ffmpeg.org), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Mediabunny](https://mediabunny.dev), [pywebview](https://pywebview.flowrl.com), [FastAPI](https://fastapi.tiangolo.com), [React](https://react.dev) and [libass](https://github.com/libass/libass). The caption fonts come from [Google Fonts](https://fonts.google.com). Their licences are listed in [NOTICE](NOTICE).

## License

Apache License 2.0. See [LICENSE](LICENSE).

Copyright 2026 Godwin Danjuma.
