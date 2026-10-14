import { useEffect, useState } from "react";
import { ArrowRight, AudioLines, Clock, Film, FolderPlus, Loader2, ScanEye, Sparkles, Trash2, Wand2 } from "lucide-react";
import { api } from "../api";
import type { ProjectSummary } from "../types";
import { ago, fmtDuration } from "../util";
import { useToast } from "../ui";

const STAGE: Record<string, { label: string; tone: string }> = {
  sources: { label: "New", tone: "" },
  edit: { label: "Editing", tone: "accent" },
  privacy: { label: "Privacy checked", tone: "privacy" },
  done: { label: "Exported", tone: "ok" },
};

export default function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [canPick, setCanPick] = useState(false);

  const load = () => api.projects().then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    load();
    api.health().then((h) => setCanPick(h.window)).catch(() => {});
  }, []);

  const create = async (folder: string) => {
    if (!folder.trim()) return;
    setBusy(true);
    try {
      const p = await api.create(folder.trim());
      onOpen(p.id);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    try {
      const r = await api.pickFolder();
      if (r.folder) await create(r.folder);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1060 }}>
        <div className="col rise" style={{ gap: 8, marginBottom: 26 }}>
          <span className="eyebrow">Retake</span>
          <h1>Record it once. Retake does the rest.</h1>
          <p className="muted" style={{ maxWidth: 620, fontSize: 15 }}>
            Point it at a folder of recordings. It lines up your voice with your screen, cuts the retakes and pauses,
            blurs anything private, and hands you a timeline to finish like any editor.
          </p>
        </div>

        <div className="dropzone rise" style={{ animationDelay: "60ms" }}>
          <div className="col" style={{ alignItems: "center", gap: 16 }}>
            <div style={{ width: 62, height: 62, borderRadius: 18, display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent)" }}>
              <FolderPlus size={28} />
            </div>
            <div className="col" style={{ gap: 4, alignItems: "center" }}>
              <h2>Start from a folder</h2>
              <p className="muted small">Screen recordings, a separate voice track, camera footage: put them in one folder.</p>
            </div>
            {canPick && (
              <button className="btn primary lg" onClick={pick} disabled={busy}>
                {busy ? <Loader2 size={18} className="spin" /> : <FolderPlus size={18} />} Choose a folder
              </button>
            )}
            <form className="row" style={{ width: "min(560px, 100%)" }} onSubmit={(e) => { e.preventDefault(); create(path); }}>
              <input className="input" placeholder={canPick ? "or paste a folder path, like C:\\Users\\you\\Desktop\\My video" : "Paste a folder path, like C:\\Users\\you\\Desktop\\My video"}
                value={path} onChange={(e) => setPath(e.target.value)} />
              <button className="btn" type="submit" disabled={!path.trim() || busy}>Open <ArrowRight size={16} /></button>
            </form>
          </div>
        </div>

        <div className="row wrap rise" style={{ gap: 10, margin: "18px 0 40px", animationDelay: "120ms" }}>
          {[
            [AudioLines, "Syncs your voice to the screen"],
            [Wand2, "AI cuts retakes and dead air"],
            [ScanEye, "Blurs emails, keys and passwords"],
            [Film, "Timeline you can edit like CapCut"],
          ].map(([Icon, text], i) => {
            const I = Icon as typeof AudioLines;
            return (
              <div key={i} className="pill" style={{ height: 32, padding: "0 12px", gap: 8 }}>
                <I size={15} color="var(--accent-2)" /> {text as string}
              </div>
            );
          })}
        </div>

        <div className="spread" style={{ marginBottom: 14 }}>
          <h2>Projects</h2>
          {projects && projects.length > 0 && <span className="faint small">{projects.length} project{projects.length === 1 ? "" : "s"}</span>}
        </div>
        {projects === null ? (
          <div className="muted row"><Loader2 size={16} className="spin" /> Loading</div>
        ) : projects.length === 0 ? (
          <div className="card pad row muted" style={{ gap: 12 }}>
            <Sparkles size={18} color="var(--accent)" /> Your projects will show up here.
          </div>
        ) : (
          <div className="proj-grid">
            {projects.map((p) => {
              const st = STAGE[p.stage] ?? STAGE.sources;
              return (
                <div key={p.id} className="proj" role="button" tabIndex={0} onClick={() => !p.missing && onOpen(p.id)}
                  onKeyDown={(e) => e.key === "Enter" && !p.missing && onOpen(p.id)} style={p.missing ? { opacity: 0.55, cursor: "default" } : undefined}>
                  <div className="spread">
                    <span className={`pill ${p.missing ? "bad" : st.tone}`}>{p.missing ? "Folder missing" : st.label}</span>
                    <button className="btn ghost sm icon" aria-label="Remove from list" title="Remove from this list (keeps your files)"
                      onClick={async (e) => { e.stopPropagation(); await api.forget(p.id); load(); }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="col" style={{ gap: 4 }}>
                    <h3 className="ellipsis" style={{ fontSize: 16 }}>{p.name}</h3>
                    <span className="faint tiny ellipsis mono" title={p.folder}>{p.folder}</span>
                  </div>
                  <div className="row faint small" style={{ gap: 14 }}>
                    <span className="row" style={{ gap: 5 }}><Film size={13} /> {p.sources} files</span>
                    {p.duration > 0 && <span className="row" style={{ gap: 5 }}><Clock size={13} /> {fmtDuration(p.duration)} cut</span>}
                    <span style={{ marginLeft: "auto" }}>{ago(p.updated)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
