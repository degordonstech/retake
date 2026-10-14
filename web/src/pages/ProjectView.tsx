import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { api } from "../api";
import type { Job, Project } from "../types";
import { useJob, useToast } from "../ui";
import Footage from "../steps/Footage";
import Editor from "../editor/Editor";
import Privacy from "../steps/Privacy";
import Export from "../steps/Export";

export type Step = "footage" | "edit" | "privacy" | "export";
const STEPS: { id: Step; label: string }[] = [
  { id: "footage", label: "Footage" },
  { id: "edit", label: "Edit" },
  { id: "privacy", label: "Privacy" },
  { id: "export", label: "Export" },
];

export default function ProjectView({ id, onGone }: { id: string; onGone: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<Project | null>(null);
  const [step, setStep] = useState<Step>(() => (localStorage.getItem(`retake.step.${id}`) as Step) || "footage");
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await api.project(id);
      setP(next);
      setName(next.name);
      return next;
    } catch (e) {
      toast((e as Error).message, "bad");
      onGone();
      return null;
    }
  }, [id, onGone, toast]);

  const onFinish = useCallback(
    async (j: Job) => {
      const next = await reload();
      if (j.status === "error") toast(j.error || "Something went wrong", "bad");
      else if (j.kind === "prepare" || j.kind === "autoedit") {
        toast("Your first cut is ready", "ok");
        if (next?.edit.clips.length) setStep("edit");
      } else if (j.kind === "scan") toast("Privacy scan finished", "ok");
      else if (j.kind === "render") toast("Your video is ready", "ok");
    },
    [reload, toast],
  );
  const { job, start, active } = useJob(id, onFinish);

  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    try { localStorage.setItem(`retake.step.${id}`, step); } catch { /* ignore */ }
  }, [id, step]);

  if (!p) return <div className="page"><div className="page-inner muted row"><Loader2 size={16} className="spin" /> Opening project</div></div>;

  const prepared = p.takes.length > 0 && p.takes.every((t) => t.ready);
  const hasCut = p.edit.clips.length > 0;
  const enabled: Record<Step, boolean> = { footage: true, edit: prepared || hasCut, privacy: hasCut, export: hasCut };
  const done: Record<Step, boolean> = {
    footage: prepared,
    edit: hasCut,
    privacy: !!p.privacy.scanned,
    export: p.renders.length > 0,
  };
  const current = enabled[step] ? step : "footage";

  return (
    <>
      <header className="topbar">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name"
          onBlur={async () => { if (name.trim() && name !== p.name) setP(await api.rename(id, name)); }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          style={{ width: 260, background: "transparent", borderColor: "transparent", fontWeight: 650, fontSize: 15, fontFamily: "var(--display)" }} />
        <nav className="steps">
          {STEPS.map((s, i) => (
            <button key={s.id} className={`step ${current === s.id ? "on" : ""} ${done[s.id] && current !== s.id ? "done" : ""}`}
              disabled={!enabled[s.id]} onClick={() => setStep(s.id)}>
              <span className="num">{done[s.id] && current !== s.id ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div style={{ width: 260, display: "flex", justifyContent: "flex-end" }}>
          {active && (
            <div className="pill accent" title={job.message} style={{ maxWidth: 260 }}>
              <Loader2 size={13} className="spin" />
              <span className="ellipsis">{job.message}</span>
              <span className="mono">{Math.round((job.progress ?? 0) * 100)}%</span>
            </div>
          )}
        </div>
      </header>
      <div className="page" style={current === "edit" ? { overflow: "hidden" } : undefined}>
        {current === "footage" && <Footage p={p} setP={setP} job={job} active={active} start={start} goEdit={() => setStep("edit")} />}
        {current === "edit" && <Editor p={p} setP={setP} job={job} active={active} start={start} />}
        {current === "privacy" && <Privacy p={p} job={job} active={active} start={start} reload={reload} goExport={() => setStep("export")} />}
        {current === "export" && <Export p={p} setP={setP} job={job} active={active} start={start} reload={reload} />}
      </div>
    </>
  );
}
