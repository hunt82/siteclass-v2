import { useCallback, useSyncExternalStore } from "react";
import { defaultCategoryId, getCategoriesForType } from "./categories";
import { deleteBlobs, putBlob, thumbKey } from "./db";
import { generateThumbnailFromBlob } from "./imageProcessor";
import { AssessmentType, GpsFix, PhotoRecord, PhotoSource, ProjectRecord } from "./types";

const STORAGE_KEY = "siteclass.projects.v2";
const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);

function readProjects(): ProjectRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map((p) => ({ ...p, siteNotes: typeof p.siteNotes === "string" ? p.siteNotes : "", photos: Array.isArray(p.photos) ? p.photos : [] })) : [];
  } catch { return []; }
}

class ProjectStore {
  private state = { projects: readProjects() };
  private listeners = new Set<() => void>();
  private saveTimer: number | undefined;
  private pendingProjects: ProjectRecord[] | null = null;

  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };

  flushNow = () => {
    if (this.saveTimer !== undefined) { window.clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.pendingProjects) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pendingProjects)); } catch {}
      this.pendingProjects = null;
    }
  };

  private setProjects(next: ProjectRecord[]) {
    this.state = { projects: next };
    this.pendingProjects = next;
    if (this.saveTimer === undefined) this.saveTimer = window.setTimeout(this.flushNow, 300);
    this.listeners.forEach((fn) => fn());
  }

  private updateProject(projectId: string, updater: (p: ProjectRecord) => ProjectRecord) {
    const now = new Date().toISOString();
    this.setProjects(this.state.projects.map((p) => (p.id === projectId ? { ...updater(p), updatedAt: now } : p)));
  }

  private updatePhoto(projectId: string, photoId: string, updater: (photo: PhotoRecord) => PhotoRecord) {
    this.updateProject(projectId, (p) => ({ ...p, photos: p.photos.map((ph) => (ph.id === photoId ? updater(ph) : ph)) }));
  }

  createProject = (input: { name: string; address: string; inspector: string; projectNo: string; type: AssessmentType }): string => {
    const now = new Date().toISOString();
    const id = uid();
    this.setProjects([{ id, name: input.name.trim(), address: input.address.trim(), inspector: input.inspector.trim(), projectNo: input.projectNo.trim(), type: input.type, siteNotes: "", createdAt: now, updatedAt: now, armedCategoryId: defaultCategoryId(input.type), photos: [] }, ...this.state.projects]);
    return id;
  };

  updateSiteNotes = (projectId: string, siteNotes: string) => this.updateProject(projectId, (p) => ({ ...p, siteNotes }));

  deleteProject = async (projectId: string) => {
    const target = this.state.projects.find((p) => p.id === projectId);
    if (target) await deleteBlobs(target.photos.flatMap((ph) => [ph.id, thumbKey(ph.id)]));
    this.setProjects(this.state.projects.filter((p) => p.id !== projectId));
  };

  setArmed = (projectId: string, categoryId: string) => this.setProjects(this.state.projects.map((p) => (p.id === projectId ? { ...p, armedCategoryId: categoryId } : p)));

  addPhoto = async (projectId: string, blob: Blob, categoryId: string, meta: { name: string; aspect: string; source: PhotoSource; fix?: GpsFix | null; thumb?: Blob | null; width?: number; height?: number }): Promise<PhotoRecord> => {
    const id = uid();
    await putBlob(id, blob);
    const derived = meta.thumb !== undefined ? { thumb: meta.thumb, width: meta.width ?? 0, height: meta.height ?? 0 } : await generateThumbnailFromBlob(blob);
    if (derived.thumb) await putBlob(thumbKey(id), derived.thumb);
    const record: PhotoRecord = {
      id, categoryId, createdAt: new Date().toISOString(), note: "", tags: [], name: meta.name, aspect: meta.aspect, source: meta.source, bytes: blob.size,
      ...(derived.width ? { width: derived.width, height: derived.height } : {}),
      ...(meta.fix ? { lat: meta.fix.lat, lng: meta.fix.lng, accuracy: meta.fix.accuracy } : {}),
    };
    this.updateProject(projectId, (p) => ({ ...p, armedCategoryId: categoryId, photos: [record, ...p.photos] }));
    return record;
  };

  updatePhotoFields = (projectId: string, photoId: string, patch: Partial<Pick<PhotoRecord, "note" | "deficient" | "categoryId" | "tags">>) => this.updatePhoto(projectId, photoId, (ph) => ({ ...ph, ...patch }));

  toggleTag = (projectId: string, photoId: string, tag: string) => this.updatePhoto(projectId, photoId, (ph) => {
    const current = ph.tags ?? [];
    return { ...ph, tags: current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag] };
  });

  deletePhoto = async (projectId: string, photoId: string) => {
    await deleteBlobs([photoId, thumbKey(photoId)]);
    this.updateProject(projectId, (p) => ({ ...p, photos: p.photos.filter((ph) => ph.id !== photoId) }));
  };
}

export const projectStore = new ProjectStore();
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", projectStore.flushNow);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") projectStore.flushNow(); });
}

export const useProjects = () => useSyncExternalStore(projectStore.subscribe, useCallback(() => projectStore.getState().projects, []));
export const useProject = (id: string | undefined) => useSyncExternalStore(projectStore.subscribe, useCallback(() => (id ? projectStore.getState().projects.find((p) => p.id === id) : undefined), [id]));

export function summarizeCoverage(project: ProjectRecord) {
  const cats = getCategoriesForType(project.type);
  const counts = new Map<string, number>();
  for (const ph of project.photos) counts.set(ph.categoryId, (counts.get(ph.categoryId) ?? 0) + 1);
  const missing = cats.filter((c) => !counts.get(c.id)).map((c) => c.short);
  return { total: cats.length, covered: cats.length - missing.length, missing, deficient: project.photos.filter((ph) => ph.deficient === true).length, counts };
}
