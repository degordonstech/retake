import { useEffect, useState } from "react";
import { Bot, Check, KeyRound, Loader2, Lock, Palette, Plus, Sparkles, Terminal, X, Zap } from "lucide-react";
import { api, media } from "../api";
import type { Settings } from "../types";
import { useToast } from "../ui";

const BRAINS = [
  { id: "claude_code", name: "Claude Code", icon: Terminal, desc: "Uses the Claude Code on this computer, on your own plan. Best edits, no extra cost." },
  { id: "anthropic", name: "Claude API key", icon: KeyRound, desc: "Your own Anthropic key. Works without Claude Code installed. Billed per video." },
  { id: "groq", name: "Groq (free tier)", icon: Zap, desc: "A free Groq key. Fast and free, a little less careful on subtle cuts." },
  { id: "none", name: "Built-in rules", icon: Bot, desc: "No AI and no internet. Cuts filler and obvious retakes only." },
] as const;

export default function SettingsPage() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [anthropicKey, setAnthropicKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [word, setWord] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings().then(setS);
    api.brainStatus().then(setStatus).catch(() => {});
  }, []);

  if (!s) return <div className="page"><div className="page-inner muted row"><Loader2 size={16} className="spin" /> Loading</div></div>;

  const save = async (changes: Partial<Settings>, msg = "Saved") => {
    setSaving(true);
    try {
      const next = await api.saveSettings(changes);
      setS(next);
      api.brainStatus().then(setStatus).catch(() => {});
      toast(msg, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setSaving(false);
    }
  };

  const addWord = () => {
    const w = word.trim();
    if (!w || s.private_words.includes(w)) return setWord("");
    save({ private_words: [...s.private_words, w] }, `Retake will blur "${w}" wherever it appears`);
    setWord("");
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 880 }}>
        <div className="col" style={{ gap: 6, marginBottom: 28 }}>
          <span className="eyebrow">Settings</span>
          <h1>How Retake works for you</h1>
        </div>

        {/* AI */}
        <section className="card pad col" style={{ gap: 16, marginBottom: 18 }}>
          <div className="row"><Sparkles size={18} color="var(--accent)" /><h2>Who makes the first cut</h2></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            {BRAINS.map((b) => {
              const on = s.brain === b.id;
              const st = status[b.id];
              const I = b.icon;
              return (
                <button key={b.id} className="panel" onClick={() => save({ brain: b.id }, `${b.name} will make your first cuts`)}
                  style={{ textAlign: "left", padding: 14, cursor: "pointer", borderColor: on ? "var(--accent)" : undefined,
                    boxShadow: on ? "0 0 0 1px var(--accent)" : undefined, display: "flex", gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center", flex: "none",
                    background: on ? "var(--accent-soft)" : "var(--raised-2)", color: on ? "var(--accent)" : "var(--text-2)" }}>
                    <I size={18} />
                  </div>
                  <div className="col grow" style={{ gap: 4 }}>
                    <div className="spread"><b>{b.name}</b>{on && <Check size={16} color="var(--accent)" />}</div>
                    <span className="muted small">{b.desc}</span>
                    {st && <span className={`tiny ${st.ok ? "" : "faint"}`} style={{ color: st.ok ? "var(--ok)" : undefined }}>{st.message}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label className="field">
              Anthropic API key {s.anthropic_key_set && <span className="pill ok" style={{ height: 20, alignSelf: "flex-start" }}>Saved</span>}
              <div className="row">
                <input className="input" type="password" placeholder={s.anthropic_key_set ? "Paste a new key to replace it" : "sk-ant-..."}
                  value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} autoComplete="off" />
                <button className="btn" disabled={!anthropicKey || saving} onClick={() => { save({ anthropic_key: anthropicKey }, "Key saved on this computer"); setAnthropicKey(""); }}>Save</button>
                {s.anthropic_key_set && <button className="btn ghost icon" title="Remove key" onClick={async () => setS(await api.clearSecret("anthropic_key"))}><X size={16} /></button>}
              </div>
            </label>
            <label className="field">
              Groq API key {s.groq_key_set && <span className="pill ok" style={{ height: 20, alignSelf: "flex-start" }}>Saved</span>}
              <div className="row">
                <input className="input" type="password" placeholder={s.groq_key_set ? "Paste a new key to replace it" : "gsk_..."}
                  value={groqKey} onChange={(e) => setGroqKey(e.target.value)} autoComplete="off" />
                <button className="btn" disabled={!groqKey || saving} onClick={() => { save({ groq_key: groqKey }, "Key saved on this computer"); setGroqKey(""); }}>Save</button>
                {s.groq_key_set && <button className="btn ghost icon" title="Remove key" onClick={async () => setS(await api.clearSecret("groq_key"))}><X size={16} /></button>}
              </div>
            </label>
            <label className="field">
              Claude model (API key)
              <input className="input" defaultValue={s.anthropic_model} onBlur={(e) => e.target.value !== s.anthropic_model && save({ anthropic_model: e.target.value })} />
            </label>
            <label className="field">
              Claude Code location (leave empty to find it)
              <input className="input mono" style={{ fontSize: 12.5 }} defaultValue={s.claude_path} placeholder="Found automatically"
                onBlur={(e) => e.target.value !== s.claude_path && save({ claude_path: e.target.value })} />
            </label>
          </div>
          <p className="faint tiny row" style={{ gap: 6 }}><Lock size={12} /> Keys stay on this computer, in your app data folder. They are never shown again after saving.</p>
        </section>

        {/* Transcription */}
        <section className="card pad col" style={{ gap: 14, marginBottom: 18 }}>
          <h2>Listening</h2>
          <div className="row wrap" style={{ gap: 18 }}>
            <label className="field" style={{ width: 280 }}>
              Transcription accuracy
              <div className="seg">
                {[["base", "Fast"], ["small", "Balanced"], ["medium", "Most accurate"]].map(([v, l]) => (
                  <button key={v} className={s.whisper_model === v ? "on" : ""} onClick={() => save({ whisper_model: v })}>{l}</button>
                ))}
              </div>
            </label>
            <label className="field" style={{ width: 160 }}>
              Language
              <select className="select" value={s.language} onChange={(e) => save({ language: e.target.value })}>
                {[["en", "English"], ["fr", "French"], ["es", "Spanish"], ["pt", "Portuguese"], ["de", "German"], ["", "Detect"]].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="faint tiny">Balanced runs at roughly a third of real time on a 4-core laptop. Most accurate is slower but better with accents and names.</p>
        </section>

        {/* Privacy words */}
        <section className="card pad col" style={{ gap: 14, marginBottom: 18 }}>
          <div className="row"><Lock size={18} color="var(--privacy)" /><h2>Private words</h2></div>
          <p className="muted small">
            Emails, phone numbers, API keys, passwords, IDs in links, file pickers and desktop icons are always blurred.
            Add anything else that must never be readable: client names, private project folders, your street.
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            {s.private_words.map((w) => (
              <span key={w} className="pill privacy" style={{ height: 30, paddingRight: 4 }}>
                {w}
                <button className="btn ghost sm icon" style={{ width: 22, height: 22, color: "inherit" }}
                  onClick={() => save({ private_words: s.private_words.filter((x) => x !== w) })} aria-label={`Remove ${w}`}>
                  <X size={13} />
                </button>
              </span>
            ))}
            {s.private_words.length === 0 && <span className="faint small">No private words yet.</span>}
          </div>
          <form className="row" style={{ maxWidth: 440 }} onSubmit={(e) => { e.preventDefault(); addWord(); }}>
            <input className="input" placeholder="Add a word or name" value={word} onChange={(e) => setWord(e.target.value)} />
            <button className="btn" type="submit" disabled={!word.trim()}><Plus size={16} /> Add</button>
          </form>
        </section>

        {/* Brand */}
        <section className="card pad col" style={{ gap: 16 }}>
          <div className="row"><Palette size={18} color="var(--accent)" /><h2>Your look</h2></div>
          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 22, alignItems: "start" }}>
            <div className="col" style={{ gap: 12 }}>
              {([["accent", "Accent"], ["background", "Cards and title background"], ["text", "Text"]] as const).map(([k, l]) => (
                <label key={k} className="field">
                  {l}
                  <div className="row">
                    <input type="color" value={s.brand[k]} onChange={(e) => setS({ ...s, brand: { ...s.brand, [k]: e.target.value } })}
                      onBlur={() => save({ brand: s.brand }, "Look updated")} style={{ width: 44, height: 38, border: 0, background: "none", padding: 0, cursor: "pointer" }} />
                    <input className="input mono" value={s.brand[k]} onChange={(e) => setS({ ...s, brand: { ...s.brand, [k]: e.target.value } })}
                      onBlur={() => save({ brand: s.brand }, "Look updated")} />
                  </div>
                </label>
              ))}
            </div>
            <div className="col" style={{ gap: 8 }}>
              <span className="faint tiny">Preview: a chapter label as it appears in your video</span>
              <div style={{ position: "relative", aspectRatio: "16/9", borderRadius: 12, overflow: "hidden", border: "1px solid var(--line)",
                background: "linear-gradient(135deg, #1f2937, #0f172a)" }}>
                <img alt="" key={JSON.stringify(s.brand)} src={media.overlay("preview", { kind: "label", text: "Make the game installable", tag: "STEP 01" }) + `&v=${encodeURIComponent(JSON.stringify(s.brand))}`}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
