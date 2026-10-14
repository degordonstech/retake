"""Make the edit with the user's own Anthropic API key."""

from __future__ import annotations

import json


def ask(system: str, prompt: str, schema: dict, settings: dict) -> dict:
    import anthropic

    key = settings.get("anthropic_key")
    if not key:
        raise RuntimeError("No Anthropic API key saved")
    client = anthropic.Anthropic(api_key=key)
    # Long transcripts plus thinking can run past a plain request's timeout,
    # so stream and collect the final message.
    with client.messages.stream(
        model=settings.get("anthropic_model") or "claude-opus-5-5",
        max_tokens=32000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
    ) as stream:
        msg = stream.get_final_message()
    text = next(b.text for b in msg.content if b.type == "text")
    return json.loads(text)
