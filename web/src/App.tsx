import { useEffect, useState } from "react";
import { Clapperboard, FolderOpen, Settings as Cog } from "lucide-react";
import { api } from "./api";
import { Logo } from "./ui";
import Home from "./pages/Home";
import SettingsPage from "./pages/Settings";
import ProjectView from "./pages/ProjectView";

type Route = { view: "home" } | { view: "settings" } | { view: "project"; id: string };

function initialRoute(): Route {
  try {
    const r = JSON.parse(localStorage.getItem("retake.route") || "null");
    if (r && (r.view === "home" || r.view === "settings" || (r.view === "project" && r.id))) return r;
  } catch {
    /* ignore */
  }
  return { view: "home" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [lastProject, setLastProject] = useState<string | null>(route.view === "project" ? route.id : null);
  const [ffmpeg, setFfmpeg] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem("retake.route", JSON.stringify(route));
    } catch {
      /* ignore */
    }
    if (route.view === "project") setLastProject(route.id);
  }, [route]);

  useEffect(() => {
    api.health().then((h) => setFfmpeg(h.ffmpeg)).catch(() => {});
  }, []);

  return (
    <div className="app">
      <nav className="rail">
        <button className="rail-btn" style={{ width: "auto", height: "auto", background: "none" }} onClick={() => setRoute({ view: "home" })} aria-label="Retake home">
          <Logo />
        </button>
        <button className={`rail-btn ${route.view === "home" ? "on" : ""}`} data-tip="Projects" onClick={() => setRoute({ view: "home" })}>
          <FolderOpen size={20} />
        </button>
        {lastProject && (
          <button className={`rail-btn ${route.view === "project" ? "on" : ""}`} data-tip="Current project"
            onClick={() => setRoute({ view: "project", id: lastProject })}>
            <Clapperboard size={20} />
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className={`rail-btn ${route.view === "settings" ? "on" : ""}`} data-tip="Settings" onClick={() => setRoute({ view: "settings" })}>
          <Cog size={20} />
        </button>
      </nav>
      <main className="main">
        {!ffmpeg && (
          <div className="pill bad" style={{ borderRadius: 0, height: 34, justifyContent: "center" }}>
            Retake needs ffmpeg to read and write video. Install it (winget install ffmpeg) and restart Retake.
          </div>
        )}
        {route.view === "home" && <Home onOpen={(id, step) => {
          if (step) { try { localStorage.setItem(`retake.step.${id}`, step); } catch { /* ignore */ } }
          setRoute({ view: "project", id });
        }} />}
        {route.view === "settings" && <SettingsPage />}
        {route.view === "project" && (
          <ProjectView key={route.id} id={route.id} onGone={() => { setLastProject(null); setRoute({ view: "home" }); }} />
        )}
      </main>
    </div>
  );
}
