import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, ChevronLeft, ChevronRight, Download, FileText, ImagePlus, Images, LayoutGrid, MapPin, Mic, Plus, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import { categoryGroupLabel, exportFolderPath, formatCategoryCode, getCategoriesForType, getCategoryById } from "./categories";
import { getBlob, getOrCreateThumbUrl } from "./db";
import { exportProjectCsv, exportProjectZip } from "./exportBundle";
import { captureFrameToJpeg, formatGpsFix, runWithConcurrency, withTimeout } from "./imageProcessor";
import { projectStore, summarizeCoverage, useProject, useProjects } from "./store";
import { AspectChoice, AssessmentType, GpsFix, PhotoRecord, PhotoSource, ProjectRecord } from "./types";

type ToastItem = { id: number; text: string; tone: "info" | "error" };
let toastSeq = 1;
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toastState: ToastItem[] = [];

function showToast(text: string, tone: "info" | "error" = "info") {
  const id = toastSeq++;
  toastState = [...toastState.slice(-2), { id, text, tone }];
  toastListeners.forEach((fn) => fn(toastState));
  window.setTimeout(() => {
    toastState = toastState.filter((t) => t.id !== id);
    toastListeners.forEach((fn) => fn(toastState));
  }, tone === "error" ? 4500 : 2600);
}

function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>(toastState);
  useEffect(() => { toastListeners.add(setItems); return () => { toastListeners.delete(setItems); }; }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-4 pt-[max(12px,env(safe-area-inset-top))]" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast-in max-w-[440px] rounded-md px-4 py-3 text-[15px] font-semibold shadow-lg ${item.tone === "error" ? "bg-def text-white" : "bg-ink text-white"}`}>{item.text}</div>
      ))}
    </div>
  );
}

let latestFix: GpsFix | null = null;
const gpsListeners = new Set<(fix: GpsFix | null) => void>();
let watchId: number | null = null;
function startGps() {
  if (watchId !== null || typeof navigator === "undefined" || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => { latestFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() }; gpsListeners.forEach((fn) => fn(latestFix)); },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
  );
}
const recentFix = () => (latestFix && Date.now() - (latestFix.at ?? 0) < 120000 ? latestFix : null);
function useGpsFix() {
  const [fix, setFix] = useState<GpsFix | null>(latestFix);
  useEffect(() => { startGps(); if (latestFix) setFix(latestFix); gpsListeners.add(setFix); return () => { gpsListeners.delete(setFix); }; }, []);
  return fix;
}

type Route =
  | { name: "home" } | { name: "new" } | { name: "capture"; id: string } | { name: "groups"; id: string }
  | { name: "photos"; id: string } | { name: "defects"; id: string }
  | { name: "photo"; id: string; photoId: string; from: "capture" | "photos" | "defects" };

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "new") return { name: "new" };
  if (parts[0] === "p" && parts[1]) {
    const id = parts[1];
    if (parts[2] === "groups" || parts[2] === "photos" || parts[2] === "defects") return { name: parts[2], id };
    if (parts[2] === "photo" && parts[3]) return { name: "photo", id, photoId: parts[3], from: parts[4] === "defects" || parts[4] === "capture" ? parts[4] : "photos" };
    return { name: "capture", id };
  }
  return { name: "home" };
}

const routeHref = (r: Route) => (r.name === "home" ? "#/" : r.name === "new" ? "#/new" : r.name === "capture" ? `#/p/${r.id}` : r.name === "photo" ? `#/p/${r.id}/photo/${r.photoId}/${r.from}` : `#/p/${r.id}/${r.name}`);
const navigate = (r: Route, replace = false) => { const h = routeHref(r); if (replace) window.location.replace(h); else window.location.hash = h; };

function PhotoThumb({ id, alt = "", className = "", full = false }: { id: string; alt?: string; className?: string; full?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true, url: string | null = null;
    if (full) getBlob(id).then((b) => { if (b && active) { url = URL.createObjectURL(b); setSrc(url); } });
    else getOrCreateThumbUrl(id).then((u) => { if (active) setSrc(u); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [id, full]);
  return src ? <img src={src} alt={alt} className={`block object-cover ${className}`} draggable={false} /> : <div className={`bg-line ${className}`} aria-hidden="true" />;
}

function BottomSheet({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: React.ReactNode; label: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="sheet-in safe-bottom relative flex max-h-[92dvh] w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-t-[14px] bg-paper px-5 pt-2.5 text-ink">
        <span className="block h-[5px] w-10 shrink-0 self-center rounded-full bg-line2" />
        {children}
      </div>
    </div>
  );
}

function useDictation(onResultText: (spoken: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => recRef.current?.stop(), []);
  const toggle = () => {
    const win = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
    const SR = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SR) { showToast("Use your phone keyboard mic key to dictate."); return; }
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = "en-US"; rec.interimResults = false; rec.continuous = false;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0]?.transcript ?? "").join(" ").trim();
      if (t) onResultText(t.charAt(0).toUpperCase() + t.slice(1));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); showToast("Dictation unavailable.", "error"); };
    recRef.current = rec; setListening(true); rec.start();
  };
  return { listening, toggle };
}

function PhotoEditor({ project, photo }: { project: ProjectRecord; photo: PhotoRecord }) {
  const cat = getCategoryById(photo.categoryId);
  const [refileOpen, setRefileOpen] = useState(false);
  const [note, setNote] = useState(photo.note);
  useEffect(() => setNote(photo.note), [photo.id, photo.note]);
  const { listening, toggle } = useDictation((spoken) => {
    setNote((prev) => { const next = prev.trim() ? `${prev.trim()} ${spoken}` : spoken; projectStore.updatePhotoFields(project.id, photo.id, { note: next }); return next; });
  });
  const tags = photo.tags ?? [];
  const allCats = getCategoriesForType(project.type);
  const groups = Array.from(new Set(allCats.map((c) => categoryGroupLabel(c, project.type))));

  return (
    <>
      <button type="button" onClick={() => setRefileOpen(true)} className="flex h-11 items-center justify-center gap-2 rounded-md border-[1.5px] border-line2 text-[15px] font-semibold">
        <Undo2 className="size-[18px]" /> Wrong group? Refile
      </button>
      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" onClick={() => projectStore.updatePhotoFields(project.id, photo.id, { deficient: photo.deficient === true ? undefined : true })} className={`flex h-[64px] items-center justify-center gap-2 rounded-md border-2 font-display text-[21px] font-bold uppercase ${photo.deficient === true ? "border-def bg-def text-white" : "border-def bg-white text-def"}`}>
          <TriangleAlert className="size-[22px]" /> Deficient
        </button>
        <button type="button" onClick={() => projectStore.updatePhotoFields(project.id, photo.id, { deficient: photo.deficient === false ? undefined : false })} className={`flex h-[64px] items-center justify-center gap-2 rounded-md border-2 font-display text-[21px] font-bold uppercase ${photo.deficient === false ? "border-ok bg-ok text-white" : "border-ok bg-white text-ok"}`}>
          <Check className="size-[22px]" /> Good / fair
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {cat.tags.map((tag) => (
          <button key={tag} type="button" onClick={() => projectStore.toggleTag(project.id, photo.id, tag)} className={`h-11 rounded-full border-[1.5px] px-3.5 text-[15px] font-medium ${tags.includes(tag) ? "border-ink bg-ink text-white" : "border-line2 bg-white"}`}>{tag}</button>
        ))}
        <button type="button" onClick={toggle} className={`flex h-11 items-center gap-1.5 rounded-full border-[1.5px] px-3.5 text-[15px] font-semibold ${listening ? "border-def bg-def text-white" : "border-ink bg-white"}`}>
          <Mic className="size-[18px]" /> {listening ? "Listening…" : "Dictate"}
        </button>
      </div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={(e) => e.target.value !== photo.note && projectStore.updatePhotoFields(project.id, photo.id, { note: e.target.value })} rows={2} placeholder="Field note (optional)" className="w-full resize-none rounded-md border-[1.5px] border-line2 bg-white px-3.5 py-3 text-[16px]" />
      <BottomSheet open={refileOpen} onClose={() => setRefileOpen(false)} label="Refile to">
        <div className="font-display text-[26px] font-bold uppercase">Refile to</div>
        {groups.map((grp) => (
          <div key={grp} className="flex flex-col gap-2">
            <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-ink2">{grp}</div>
            <div className="grid grid-cols-2 gap-2">
              {allCats.filter((c) => categoryGroupLabel(c, project.type) === grp).map((c) => (
                <button key={c.id} type="button" onClick={() => { projectStore.updatePhotoFields(project.id, photo.id, { categoryId: c.id, tags: [] }); projectStore.setArmed(project.id, c.id); setRefileOpen(false); showToast(`Refiled to ${c.short}`); }} className={`flex min-h-12 items-center gap-2 rounded-md border-[1.5px] px-3 py-2 text-left text-[15px] font-semibold ${c.id === photo.categoryId ? "border-ink bg-ink text-white" : "border-line2 bg-white"}`}>
                  <span className="font-mono text-[12px] opacity-75">{formatCategoryCode(c, project.type)}</span> {c.short}
                </button>
              ))}
            </div>
          </div>
        ))}
      </BottomSheet>
    </>
  );
}

function CaptureView({ project }: { project: ProjectRecord }) {
  const categories = getCategoriesForType(project.type);
  const armed = categories.find((c) => c.id === project.armedCategoryId) ?? categories[0];
  const armedIndex = categories.indexOf(armed);
  const coverage = summarizeCoverage(project);
  const fix = useGpsFix();
  const [aspect, setAspect] = useState<AspectChoice>("4:3");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const hqInputRef = useRef<HTMLInputElement | null>(null);
  const libInputRef = useRef<HTMLInputElement | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [restartTick, setRestartTick] = useState(0);
  const [busyText, setBusyText] = useState<string | null>(null);
  const [filedPhotoId, setFiledPhotoId] = useState<string | null>(null);
  const [siteNotesOpen, setSiteNotesOpen] = useState(false);
  const [siteNotesDraft, setSiteNotesDraft] = useState(project.siteNotes);

  useEffect(() => setSiteNotesDraft(project.siteNotes), [project.id, project.siteNotes]);
  const { listening: dictatingSite, toggle: toggleSiteDictation } = useDictation((spoken) => {
    setSiteNotesDraft((prev) => { const next = prev.trim() ? `${prev.trim()}\n- ${spoken}` : `- ${spoken}`; projectStore.updateSiteNotes(project.id, next); return next; });
  });

  useEffect(() => {
    let cancelled = false, stream: MediaStream | null = null;
    navigator.mediaDevices?.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } } })
      .then(async (s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s; trackRef.current = s.getVideoTracks()[0] ?? null;
        if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => {}); }
        setCameraReady(true);
      }).catch(() => setCameraReady(false));
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [restartTick]);

  const savePhotoBlob = useCallback(async (blob: Blob, name: string, openSheet: boolean, source: PhotoSource, asp?: string, extra?: { thumb?: Blob | null; width?: number; height?: number }) => {
    const record = await projectStore.addPhoto(project.id, blob, armed.id, { name, fix: source === "library" ? null : recentFix(), aspect: asp ?? "original", source, ...extra });
    if (openSheet) setFiledPhotoId(record.id);
  }, [project.id, armed.id]);

  const handleShutter = async () => {
    if (busyText) return;
    const vid = videoRef.current;
    if (!cameraReady || !vid || vid.videoWidth === 0) { hqInputRef.current?.click(); return; }
    setBusyText("Saving…");
    try {
      const cap = await withTimeout(captureFrameToJpeg(vid, trackRef.current, 1, false, aspect), 15000, "Capture");
      await savePhotoBlob(cap.blob, `capture-${Date.now()}.jpg`, true, "app", aspect, { thumb: cap.thumb, width: cap.width, height: cap.height });
      navigator.vibrate?.(30);
    } catch { showToast("Camera restarted — tap again.", "error"); setRestartTick((n) => n + 1); }
    finally { setBusyText(null); }
  };

  const handleFileImport = async (files: FileList | null, source: PhotoSource) => {
    const imgs = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setBusyText(`Importing 0 / ${imgs.length}`);
    try {
      await runWithConcurrency(imgs, 3, async (f) => { await savePhotoBlob(f, f.name, imgs.length === 1, source); }, (d, t) => setBusyText(`Importing ${d} / ${t}`));
      if (imgs.length > 1) showToast(`${imgs.length} photos filed to ${armed.short}`);
    } finally { setBusyText(null); }
  };

  const filedPhoto = project.photos.find((p) => p.id === filedPhotoId) ?? null;
  const lastPhoto = project.photos[0];
  const prevCat = categories[(armedIndex - 1 + categories.length) % categories.length];
  const nextCat = categories[(armedIndex + 1) % categories.length];

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-cam text-white select-none">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 size-full object-contain" />
        <div className="absolute inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-10 flex items-center gap-2">
          <a href={routeHref({ name: "home" })} className="flex size-11 items-center justify-center rounded-full bg-cam/75 text-white"><ChevronLeft className="size-[22px]" /></a>
          <div className="flex h-11 min-w-0 items-center gap-2 rounded-full bg-cam/75 px-3.5">
            <span className="font-mono text-[12px] text-hivis">{project.type}</span>
            <span className="truncate text-[16px] font-semibold">{project.name}</span>
          </div>
          <div className="flex h-11 items-center gap-1 rounded-full bg-cam/75 px-3 font-mono text-[12px]">
            <MapPin className="size-4 text-hivis" /> {fix ? `±${Math.round(fix.accuracy ?? 0)}m` : "GPS"}
          </div>
          <span className="flex-1" />
          <button type="button" onClick={() => setSiteNotesOpen(true)} className={`flex h-11 items-center gap-1.5 rounded-full bg-cam/75 px-3 font-mono text-[12px] ${project.siteNotes.trim() ? "text-hivis" : "text-white"}`}>
            <FileText className="size-4" /> NOTES
          </button>
          <button type="button" onClick={() => hqInputRef.current?.click()} className="flex h-11 items-center gap-1.5 rounded-full bg-cam/75 px-3 font-mono text-[12px] text-hivis">
            <Camera className="size-4" /> HQ
          </button>
          <button type="button" onClick={() => libInputRef.current?.click()} className="flex size-11 items-center justify-center rounded-full bg-cam/75">
            <ImagePlus className="size-5" />
          </button>
        </div>
        <div className="absolute inset-x-4 bottom-3 z-10 flex justify-end">
          <div className="flex gap-1 rounded-full bg-cam/75 p-1">
            {(["3:4", "4:3", "16:9"] as AspectChoice[]).map((opt) => (
              <button key={opt} type="button" onClick={() => setAspect(opt)} className={`h-10 rounded-full px-2.5 font-mono text-[12px] ${aspect === opt ? "bg-hivis font-bold text-ink" : ""}`}>{opt}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex h-[72px] shrink-0 items-center gap-2 bg-hivis px-3 text-ink">
        <button type="button" onClick={() => projectStore.setArmed(project.id, prevCat.id)} className="flex size-11 items-center justify-center rounded-md border-[1.5px] border-ink"><ChevronLeft className="size-5" /></button>
        <span className="rounded-[3px] border-[1.5px] border-ink px-1.5 py-1 font-mono text-[12px] font-medium">ARMED {formatCategoryCode(armed, project.type)}</span>
        <span className="min-w-0 flex-1 truncate font-display text-[22px] font-bold uppercase">{armed.label}</span>
        <span className="font-display text-[32px] font-bold">{coverage.counts.get(armed.id) ?? 0}</span>
        <button type="button" onClick={() => projectStore.setArmed(project.id, nextCat.id)} className="flex size-11 items-center justify-center rounded-md border-[1.5px] border-ink"><ChevronRight className="size-5" /></button>
      </div>

      <div className="safe-bottom flex shrink-0 flex-col gap-4 pt-3.5">
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-3">
          {categories.map((cat) => {
            const count = coverage.counts.get(cat.id) ?? 0;
            const isArmed = cat.id === armed.id;
            return (
              <button key={cat.id} type="button" onClick={() => projectStore.setArmed(project.id, cat.id)} className={`flex h-[52px] shrink-0 items-center gap-2 rounded-md border-[1.5px] px-3.5 ${isArmed ? "border-hivis bg-hivis text-ink" : count ? "border-camline bg-cam2" : "border-dashed border-hivis"}`}>
                <span className="font-mono text-[12px]">{formatCategoryCode(cat, project.type)}</span>
                <span className="text-[16px] font-semibold whitespace-nowrap">{cat.short}</span>
                <span className="font-mono text-[12px]">{count || "NEED"}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-6">
          {lastPhoto ? (
            <a href={routeHref({ name: "photo", id: project.id, photoId: lastPhoto.id, from: "capture" })} className="block size-[60px] overflow-hidden rounded-md border-2 border-white"><PhotoThumb id={lastPhoto.id} className="size-full" /></a>
          ) : (
            <a href={routeHref({ name: "photos", id: project.id })} className="block size-[60px] rounded-md border-[1.5px] border-camline bg-cam2" />
          )}
          <button type="button" onClick={handleShutter} disabled={!!busyText} className="flex size-[92px] items-center justify-center rounded-full border-[5px] border-white">
            <span className="block size-[72px] rounded-full bg-white" />
          </button>
          <a href={routeHref({ name: "groups", id: project.id })} className="flex size-[60px] flex-col items-center justify-center rounded-md border-[1.5px] border-camline bg-cam2 text-white no-underline">
            <LayoutGrid className="size-5" />
            <span className="font-mono text-[11px]">{coverage.covered}/{coverage.total}</span>
          </a>
        </div>
        {busyText && <div className="text-center font-mono text-[12px] text-hivis">{busyText}</div>}
      </div>

      <input ref={hqInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { handleFileImport(e.target.files, "camera-app"); e.target.value = ""; }} />
      <input ref={libInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFileImport(e.target.files, "library"); e.target.value = ""; }} />

      <BottomSheet open={siteNotesOpen} onClose={() => { projectStore.updateSiteNotes(project.id, siteNotesDraft); setSiteNotesOpen(false); }} label="Site Walk Notes">
        <div className="flex items-center justify-between">
          <div className="font-display text-[26px] font-bold uppercase">Site Walk Notes</div>
          <button type="button" onClick={toggleSiteDictation} className={`flex h-11 items-center gap-1.5 rounded-full border-[1.5px] px-3.5 text-[15px] font-semibold ${dictatingSite ? "border-def bg-def text-white" : "border-ink bg-white"}`}>
            <Mic className="size-[18px]" /> {dictatingSite ? "Listening…" : "Dictate"}
          </button>
        </div>
        <textarea value={siteNotesDraft} onChange={(e) => setSiteNotesDraft(e.target.value)} rows={6} placeholder="Site contact, weather, adjoining properties, tenant operations..." className="w-full rounded-md border-[1.5px] border-line2 bg-white p-3.5 text-[16px]" />
        <button type="button" onClick={() => { projectStore.updateSiteNotes(project.id, siteNotesDraft); setSiteNotesOpen(false); showToast("Site notes saved"); }} className="flex h-14 items-center justify-center rounded-md bg-ink font-display text-[20px] font-semibold text-white uppercase">Done</button>
      </BottomSheet>

      <BottomSheet open={!!filedPhoto} onClose={() => setFiledPhotoId(null)} label="Photo filed">
        {filedPhoto && (
          <>
            <div className="flex items-center gap-3.5">
              <PhotoThumb id={filedPhoto.id} className="size-[84px] shrink-0 rounded-md border-2 border-ink" />
              <div className="flex-1">
                <div className="font-mono text-[12px] text-ink2">FILED</div>
                <div className="font-display text-[24px] font-bold uppercase">{getCategoryById(filedPhoto.categoryId).short}</div>
              </div>
              <button type="button" onClick={async () => { await projectStore.deletePhoto(project.id, filedPhoto.id); setFiledPhotoId(null); }} className="flex size-11 items-center justify-center text-def"><Trash2 className="size-5" /></button>
            </div>
            <PhotoEditor project={project} photo={filedPhoto} />
            <button type="button" onClick={() => setFiledPhotoId(null)} className="flex h-14 items-center justify-center rounded-md bg-ink font-display text-[20px] font-semibold text-white uppercase">Next shot</button>
          </>
        )}
      </BottomSheet>
    </div>
  );
}

function GroupsView({ project }: { project: ProjectRecord }) {
  const categories = getCategoriesForType(project.type);
  const coverage = summarizeCoverage(project);
  return (
    <div className="mx-auto flex min-h-dvh max-w-[560px] flex-col">
      <header className="safe-top sticky top-0 z-20 flex flex-col gap-2 border-b-2 border-ink bg-paper px-5 pb-4">
        <a href={routeHref({ name: "capture", id: project.id })} className="flex h-11 items-center gap-1.5 font-medium"><ChevronLeft className="size-5" /> Camera</a>
        <div className="flex items-end justify-between"><h1 className="font-display text-[40px] leading-none font-bold uppercase">Coverage</h1><span className="font-display text-[32px] font-bold">{coverage.covered}/{coverage.total}</span></div>
      </header>
      <main className="flex-1 pb-4">
        {categories.map((cat) => {
          const count = coverage.counts.get(cat.id) ?? 0;
          const isArmed = cat.id === project.armedCategoryId;
          return (
            <button key={cat.id} type="button" onClick={() => { projectStore.setArmed(project.id, cat.id); navigate({ name: "capture", id: project.id }); }} className={`flex min-h-[58px] w-full items-center gap-3 border-t border-line px-5 py-2 text-left ${isArmed ? "bg-ink text-white" : "bg-white"}`}>
              <span className="w-8 font-mono text-[13px]">{formatCategoryCode(cat, project.type)}</span>
              <span className="flex-1 text-[17px] font-semibold">{cat.label}</span>
              <span className="font-mono text-[14px] font-bold">{count || "NEEDED"}</span>
            </button>
          );
        })}
      </main>
    </div>
  );
}

function PhotosView({ project }: { project: ProjectRecord }) {
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const categories = getCategoriesForType(project.type);
  const runExport = async () => {
    setExportProgress("Preparing…");
    try {
      const n = await exportProjectZip(project, undefined, (c, t) => setExportProgress(`${c}/${t}`));
      showToast(`Exported ${n} photos + field_notes.md`);
    } catch (e) { showToast(e instanceof Error ? e.message : "Export failed", "error"); }
    finally { setExportProgress(null); }
  };
  return (
    <div className="mx-auto flex min-h-dvh max-w-[560px] flex-col">
      <header className="safe-top sticky top-0 z-20 flex flex-col gap-2 border-b-2 border-ink bg-paper px-5 pb-4">
        <a href={routeHref({ name: "capture", id: project.id })} className="flex h-11 items-center gap-1.5 font-medium"><ChevronLeft className="size-5" /> Camera</a>
        <h1 className="font-display text-[40px] leading-none font-bold uppercase">Photos ({project.photos.length})</h1>
      </header>
      <main className="flex flex-1 flex-col gap-5 p-5">
        {categories.map((cat) => {
          const list = project.photos.filter((p) => p.categoryId === cat.id);
          if (!list.length) return null;
          return (
            <section key={cat.id} className="flex flex-col gap-2">
              <h2 className="font-display text-[22px] font-bold uppercase">{formatCategoryCode(cat, project.type)} · {cat.short} ({list.length})</h2>
              <div className="grid grid-cols-3 gap-1.5">
                {list.map((ph) => (
                  <a key={ph.id} href={routeHref({ name: "photo", id: project.id, photoId: ph.id, from: "photos" })} className="relative block aspect-square">
                    <PhotoThumb id={ph.id} className="size-full rounded" />
                    {ph.deficient !== undefined && <span className={`absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] text-white ${ph.deficient ? "bg-def" : "bg-ok"}`}>{ph.deficient ? "DEF" : "OK"}</span>}
                  </a>
                ))}
              </div>
              <div className="font-mono text-[12px] text-ink2">→ {exportFolderPath(project.type, cat.id)}/</div>
            </section>
          );
        })}
      </main>
      <div className="safe-bottom sticky bottom-0 flex gap-2.5 border-t-2 border-ink bg-white px-5 pt-3.5">
        <button type="button" onClick={runExport} disabled={!!exportProgress || !project.photos.length} className="flex h-14 flex-1 items-center justify-center gap-2 rounded-md bg-ink font-display text-[20px] font-semibold text-white uppercase">
          <Download className="size-5" /> {exportProgress ? `Zipping ${exportProgress}` : "Export ZIP"}
        </button>
        <button type="button" onClick={() => exportProjectCsv(project, false)} disabled={!project.photos.length} className="flex h-14 w-[104px] items-center justify-center rounded-md border-2 border-ink bg-white font-display text-[20px] font-semibold uppercase">CSV</button>
      </div>
    </div>
  );
}

function PhotoDetailView({ project, photoId, from }: { project: ProjectRecord; photoId: string; from: "capture" | "photos" | "defects" }) {
  const idx = project.photos.findIndex((p) => p.id === photoId);
  const photo = project.photos[idx];
  const backRoute: Route = from === "capture" ? { name: "capture", id: project.id } : { name: from, id: project.id };
  useEffect(() => { if (!photo) navigate(backRoute, true); });
  if (!photo) return null;
  const cat = getCategoryById(photo.categoryId);
  return (
    <div className="mx-auto flex min-h-dvh max-w-[720px] flex-col bg-paper">
      <header className="safe-top sticky top-0 z-20 flex items-center justify-between bg-cam px-3 pb-2 text-white">
        <a href={routeHref(backRoute)} className="flex size-11 items-center justify-center"><X className="size-6" /></a>
        <span className="font-display text-[19px] font-bold uppercase">{formatCategoryCode(cat, project.type)} · {cat.short}</span>
        <button type="button" onClick={async () => { await projectStore.deletePhoto(project.id, photo.id); navigate(backRoute, true); }} className="flex size-11 items-center justify-center text-[#FF8A6B]"><Trash2 className="size-5" /></button>
      </header>
      <div className="flex items-center justify-center bg-cam"><PhotoThumb full id={photo.id} className="max-h-[56dvh] w-full object-contain" /></div>
      <div className="safe-bottom flex flex-col gap-4 px-5 pt-4">
        <div className="flex justify-between font-mono text-[12px] text-ink2">
          <span>{photo.lat != null && photo.lng != null ? formatGpsFix({ lat: photo.lat, lng: photo.lng }) : "No GPS"}</span>
          <span>{new Date(photo.createdAt).toLocaleString()}</span>
        </div>
        <PhotoEditor project={project} photo={photo} />
      </div>
    </div>
  );
}

function NewAssessmentView() {
  const [type, setType] = useState<AssessmentType>("PCA");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [projectNo, setProjectNo] = useState("");
  const [inspector, setInspector] = useState("");
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = projectStore.createProject({ name, address, inspector, projectNo, type });
    navigate({ name: "capture", id }, true);
  };
  return (
    <div className="mx-auto flex min-h-dvh max-w-[560px] flex-col">
      <header className="safe-top border-b-2 border-ink bg-paper px-5 pb-4">
        <a href={routeHref({ name: "home" })} className="flex h-11 items-center gap-1.5 font-medium"><ChevronLeft className="size-5" /> Assessments</a>
        <h1 className="font-display text-[40px] leading-none font-bold uppercase">New assessment</h1>
      </header>
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-4 p-5">
        <div className="grid grid-cols-3 gap-2">
          {(["ESA", "PCA", "DUAL"] as AssessmentType[]).map((t) => (
            <button key={t} type="button" onClick={() => setType(t)} className={`h-20 rounded-md border-2 font-display text-[24px] font-bold ${type === t ? "border-ink bg-ink text-white" : "border-line2 bg-white"}`}>{t}</button>
          ))}
        </div>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Site name *" className="h-[52px] rounded-md border-2 border-ink bg-white px-3.5 text-[17px]" />
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address" className="h-[52px] rounded-md border-[1.5px] border-line2 bg-white px-3.5 text-[17px]" />
        <div className="grid grid-cols-2 gap-2.5">
          <input value={projectNo} onChange={(e) => setProjectNo(e.target.value)} placeholder="Project no." className="h-[52px] rounded-md border-[1.5px] border-line2 bg-white px-3.5 font-mono text-[15px]" />
          <input value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="Inspector" className="h-[52px] rounded-md border-[1.5px] border-line2 bg-white px-3.5 text-[17px]" />
        </div>
        <button type="submit" disabled={!name.trim()} className="mt-auto flex h-[60px] items-center justify-center gap-2 rounded-md bg-ink font-display text-[20px] font-semibold text-white uppercase">
          <Camera className="size-5" /> Open camera
        </button>
      </form>
    </div>
  );
}

function HomeView() {
  const projects = [...useProjects()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="mx-auto flex min-h-dvh max-w-[560px] flex-col">
      <header className="safe-top border-b-2 border-ink px-5 pb-5">
        <div className="mt-6 font-mono text-[12px] tracking-[0.18em] uppercase text-ink2">SiteClass v2</div>
        <h1 className="font-display text-[40px] leading-none font-bold uppercase">Assessments</h1>
      </header>
      <main className="flex flex-1 flex-col gap-4 p-5">
        {projects.map((p) => {
          const cov = summarizeCoverage(p);
          return (
            <article key={p.id} className="flex flex-col overflow-hidden rounded-md border-2 border-ink bg-white">
              <div className="p-4">
                <div className="flex justify-between font-mono text-[12px] text-ink2">
                  <span className="rounded bg-ink px-2 py-0.5 text-white">{p.type}</span>
                  <span>{p.projectNo ? `${p.projectNo} · ` : ""}{p.photos.length} photos</span>
                </div>
                <h2 className="mt-2 font-display text-[28px] leading-tight font-bold">{p.name}</h2>
                <p className="mt-1 text-[14px] text-ink2">Coverage {cov.covered}/{cov.total} groups</p>
              </div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] border-t border-line">
                <a href={routeHref({ name: "capture", id: p.id })} className="flex h-14 items-center justify-center gap-2 bg-ink font-display text-[20px] font-semibold text-white uppercase no-underline"><Camera className="size-5" /> {p.photos.length ? "Resume" : "Start"}</a>
                <a href={routeHref({ name: "photos", id: p.id })} className="flex size-14 items-center justify-center border-l border-line"><Images className="size-5" /></a>
                <button type="button" onClick={() => exportProjectZip(p).then((n) => showToast(`Exported ${n} photos`))} disabled={!p.photos.length} className="flex size-14 items-center justify-center border-l border-line"><Download className="size-5" /></button>
                <button type="button" onClick={() => window.confirm(`Delete ${p.name}?`) && projectStore.deleteProject(p.id)} className="flex size-14 items-center justify-center border-l border-line text-def"><Trash2 className="size-5" /></button>
              </div>
            </article>
          );
        })}
      </main>
      <div className="safe-bottom sticky bottom-0 border-t border-line bg-paper px-5 pt-4">
        <a href={routeHref({ name: "new" })} className="flex h-[60px] items-center justify-center gap-2 rounded-md border-2 border-ink bg-white font-display text-[20px] font-semibold uppercase no-underline"><Plus className="size-5" /> New assessment</a>
      </div>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => { const h = () => setRoute(parseHash(window.location.hash)); window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h); }, []);
  const project = useProject("id" in route ? route.id : undefined);
  useEffect(() => { if ("id" in route && !project) navigate({ name: "home" }, true); }, [route, project]);

  return (
    <>
      {route.name === "home" && <HomeView />}
      {route.name === "new" && <NewAssessmentView />}
      {project && route.name === "capture" && <CaptureView project={project} />}
      {project && route.name === "groups" && <GroupsView project={project} />}
      {project && (route.name === "photos" || route.name === "defects") && <PhotosView project={project} />}
      {project && route.name === "photo" && <PhotoDetailView project={project} photoId={route.photoId} from={route.from} />}
      <ToastContainer />
    </>
  );
}
