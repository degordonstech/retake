# Privacy

Retake is built for people who record their own screen, so it treats what is on that screen as private by default.

## What leaves your computer

| What | Where it goes | When |
|---|---|---|
| The transcript text (words and their numbers, no audio or video) | The AI editor you chose: Anthropic for Claude Code or a Claude key, Groq for a Groq key | Only when making an AI first cut |
| Nothing | | With the built-in rules, or when you edit by hand |
| A request for the speech model | Hugging Face, to download the Whisper model | The first time you transcribe with each model size |

Your recordings, preview copies, transcripts, edits and exports stay on your computer. Transcription (faster-whisper), the screen reading (Windows OCR), the editing engine and both exporters all run locally.

The local API listens on `127.0.0.1` only, so other computers on your network can't reach it.

## Keys

API keys are stored in `%APPDATA%\Retake\settings.json`, readable by your Windows account. They are never sent back to the window after saving and never written to a project.

## What the privacy scan looks for

The scan reads every kept clip that has a picture at ten frames a second wherever the picture changes, and carries each find across small changes so a single misread doesn't leave a gap.

| Kind | Examples |
|---|---|
| Email addresses | `name@example.com` |
| Phone numbers | Long runs of digits (11 to 17 characters), with or without a leading +, spaces or dashes |
| Keys and tokens | Keys in the formats used by OpenAI, Anthropic and other `sk-` keys, Stripe, GitHub, AWS, Google, Slack, and web tokens (JWTs) |
| Password prompts | Anything typed after a password label, even when the label is misread |
| Links with long IDs | Share links, invite links, document links |
| File pickers and recent lists | Folder names and recent-project lists |
| Desktop icons and link previews | The desktop, and (in screen recordings) the link a browser shows in the corner on hover |
| Your words | Anything you add under **Private words** in Settings |

Every find is shown on its frame with a switch, and you can draw your own blurs. The scan runs again before export whenever the edit has changed.

## The read-back check

**Export video** reads the finished file back with OCR and lists anything private that is still readable (emails, phone numbers, keys, links with IDs, your words), with its time. Labels such as "Password:" stay readable by design; what follows them is blurred.

**Fast export** applies the same blurs but doesn't run the read-back check. Use **Export video** when you need that check.

## Limits

- OCR can miss text that is very small, blurred by motion, or moving (for example while scrolling). Check the privacy step for long scrolling sections and draw a blur if needed.
- Keys in other formats aren't recognised. Add anything specific to **Private words**.
- Only what is on screen is checked. Retake doesn't listen for private things said out loud.
