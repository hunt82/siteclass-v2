import { categoryGroupLabel, exportFolderPath, formatCategoryCode, getCategoriesForType, getCategoryById } from "./categories";
import { getBlob } from "./db";
import { ensureJpegBlob } from "./imageProcessor";
import { PhotoRecord, ProjectRecord } from "./types";
import { createStreamingZipBlob, ZipStreamInput } from "./zipStream";

const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);
const sanitizeToken = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);

function compactTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function buildArchiveBaseName(project: ProjectRecord): string {
  const siteSlug = slugify(project.name) || "site";
  const scope = project.type === "DUAL" ? "ESA-PCA" : project.type;
  const projNo = sanitizeToken(project.projectNo);
  return projNo ? `${projNo}_${siteSlug}_${scope}` : `${siteSlug}_${scope}`;
}

export function combinedPhotoNote(photo: PhotoRecord): string {
  return [...(photo.tags ?? []), photo.note.trim()].filter(Boolean).join("; ");
}

export function buildExportFileName(photo: PhotoRecord, seqIndex: number): string {
  const defPrefix = photo.deficient === true ? "Y_" : photo.deficient === false ? "N_" : "";
  const catShort = slugify(getCategoryById(photo.categoryId).short);
  const tagSlug = slugify((photo.tags ?? []).join(" ")) || catShort;
  return `${defPrefix}${String(seqIndex).padStart(2, "0")}_${compactTimestamp(photo.createdAt)}_${tagSlug}.jpg`;
}

export interface PlannedPhotoExport { photo: PhotoRecord; folder: string; file: string; }

export function planPhotoExports(project: ProjectRecord, onlyCategoryId?: string): PlannedPhotoExport[] {
  const byFolder = new Map<string, PhotoRecord[]>();
  const filtered = [...project.photos].filter((p) => !onlyCategoryId || p.categoryId === onlyCategoryId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const photo of filtered) {
    const folder = exportFolderPath(project.type, photo.categoryId);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), photo]);
  }
  const planned: PlannedPhotoExport[] = [];
  for (const [folder, photos] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    photos.forEach((photo, idx) => planned.push({ photo, folder, file: buildExportFileName(photo, idx + 1) }));
  }
  return planned;
}

const escapeCsvCell = (val: string) => (/[",\n]/.test(val) ? `"${val.replaceAll('"', '""')}"` : val);

export function buildPhotoCsv(project: ProjectRecord, items: PlannedPhotoExport[]): string {
  const header = "project_no,site,system,classification,folder,file,deficient,latitude,longitude,gps_accuracy_m,note,taken,width_px,height_px,source,original_file";
  const rows = items.map(({ photo, folder, file }) => {
    const cat = getCategoryById(photo.categoryId);
    return [
      project.projectNo, project.name, cat.system, cat.label, folder, file,
      photo.deficient === true ? "Y" : photo.deficient === false ? "N" : "",
      photo.lat != null ? photo.lat.toFixed(6) : "", photo.lng != null ? photo.lng.toFixed(6) : "",
      photo.accuracy != null ? String(Math.round(photo.accuracy)) : "", combinedPhotoNote(photo),
      new Date(photo.createdAt).toLocaleString(), photo.width ? String(photo.width) : "", photo.height ? String(photo.height) : "",
      photo.source, photo.source !== "app" ? photo.name : "",
    ].map(escapeCsvCell).join(",");
  });
  return `${[header, ...rows].join("\n")}\n`;
}

export function buildFieldNotesMarkdown(project: ProjectRecord, items: PlannedPhotoExport[]): string {
  const categories = getCategoriesForType(project.type);
  const lines: string[] = [
    `# Field Notes — ${project.name}`, "",
    `- **Project No.:** ${project.projectNo || "N/A"}`,
    `- **Protocol:** ${project.type}`,
    `- **Address:** ${project.address || "N/A"}`,
    `- **Field Inspector:** ${project.inspector || "N/A"}`,
    `- **Exported:** ${new Date().toLocaleString()}`,
    `- **Total Photos:** ${items.length}`, "",
    "## General Site Walk Notes", "",
    project.siteNotes.trim() || "_No general site walk notes recorded._", "",
  ];
  for (const cat of categories) {
    const matching = items.filter((item) => item.photo.categoryId === cat.id);
    lines.push(`## ${formatCategoryCode(cat, project.type)} · ${cat.label} (${categoryGroupLabel(cat, project.type)})`, "");
    if (matching.length === 0) { lines.push("_No photos filed in this group._", ""); continue; }
    for (const { photo, folder, file } of matching) {
      const cond = photo.deficient === true ? "**DEFICIENT**" : photo.deficient === false ? "Good / Fair" : "Unmarked";
      const gps = photo.lat != null && photo.lng != null ? `${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}` : "No GPS";
      lines.push(`- **${folder}/${file}** — ${cond} | GPS: ${gps} | Notes: ${combinedPhotoNote(photo) || "_No note_"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildPhotoManifestJson(project: ProjectRecord, items: PlannedPhotoExport[]): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    project: { id: project.id, projectNo: project.projectNo, name: project.name, address: project.address, inspector: project.inspector, type: project.type, siteNotes: project.siteNotes },
    photos: items.map(({ photo, folder, file }) => ({
      id: photo.id, relativePath: `${folder}/${file}`, folder, file, categoryId: photo.categoryId,
      deficient: photo.deficient ?? null, tags: photo.tags ?? [], note: photo.note, combinedNote: combinedPhotoNote(photo),
      takenAt: photo.createdAt, gps: photo.lat != null && photo.lng != null ? { lat: photo.lat, lng: photo.lng, accuracyM: photo.accuracy ?? null } : null,
    })),
  }, null, 2);
}

export async function exportProjectZip(project: ProjectRecord, onlyCategoryId?: string, onProgress?: (cur: number, tot: number) => void): Promise<number> {
  const items = planPhotoExports(project, onlyCategoryId);
  if (items.length === 0) throw new Error("No photos to export yet");
  const baseName = buildArchiveBaseName(project);
  async function* entryGenerator(): AsyncGenerator<ZipStreamInput> {
    let processed = 0;
    for (const { photo, folder, file } of items) {
      const rawBlob = await getBlob(photo.id);
      if (rawBlob) yield { name: `${baseName}/${folder}/${file}`, input: await ensureJpegBlob(rawBlob), lastModified: new Date(photo.createdAt) };
      processed += 1; onProgress?.(processed, items.length);
    }
    if (!onlyCategoryId) {
      yield { name: `${baseName}/field_notes.md`, input: buildFieldNotesMarkdown(project, items) };
      yield { name: `${baseName}/photo_manifest.json`, input: buildPhotoManifestJson(project, items) };
      yield { name: `${baseName}/photo-log.csv`, input: buildPhotoCsv(project, items) };
      const def = items.filter((i) => i.photo.deficient === true);
      if (def.length > 0) yield { name: `${baseName}/deficiencies.csv`, input: buildPhotoCsv(project, def) };
    }
  }
  const zipBlob = await createStreamingZipBlob(entryGenerator());
  const suffix = onlyCategoryId ? `_${getCategoryById(onlyCategoryId).folder}` : "";
  triggerDownload(zipBlob, `${baseName}${suffix}.zip`);
  return items.length;
}

export function exportProjectCsv(project: ProjectRecord, onlyDeficient: boolean): void {
  const items = planPhotoExports(project).filter((item) => (onlyDeficient ? item.photo.deficient === true : true));
  if (items.length === 0) throw new Error(onlyDeficient ? "No deficiencies marked yet" : "No photos yet");
  triggerDownload(new Blob([buildPhotoCsv(project, items)], { type: "text/csv" }), `${buildArchiveBaseName(project)}_${onlyDeficient ? "deficiencies" : "photo-log"}.csv`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.rel = "noopener";
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
