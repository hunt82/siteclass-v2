import { AspectChoice, GpsFix } from "./types";

const MAX_CAPTURE_DIM = 2048;
const MAX_CAPTURE_PIXELS = 4_200_000;
const THUMB_MAX_DIM = 480;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (val) => { window.clearTimeout(timer); resolve(val); },
      (err) => { window.clearTimeout(timer); reject(err); }
    );
  });
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  let completed = 0;
  async function next(): Promise<void> {
    while (nextIdx < items.length) {
      const current = nextIdx++;
      results[current] = await worker(items[current], current);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

export function aspectRatioValue(aspect: string): number {
  if (aspect === "3:4") return 3 / 4;
  if (aspect === "4:3") return 4 / 3;
  return 16 / 9;
}

export function computeCropRect(srcW: number, srcH: number, targetRatio: number, zoom = 1) {
  if (Math.abs(srcW / srcH - targetRatio) / targetRatio < 0.01 && zoom <= 1) {
    return { x: 0, y: 0, w: srcW, h: srcH };
  }
  let w = srcW;
  let h = srcW / targetRatio;
  if (h > srcH) { h = srcH; w = srcH * targetRatio; }
  const z = Math.max(1, zoom);
  w /= z; h /= z;
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h };
}

function releaseCanvas(canvas: HTMLCanvasElement): void { canvas.width = 0; canvas.height = 0; }

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number, timeoutMs: number): Promise<Blob | null> {
  return withTimeout(
    new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality)),
    timeoutMs,
    "JPEG encoding"
  ).catch(() => null);
}

export async function captureFrameToJpeg(
  video: HTMLVideoElement,
  track: MediaStreamTrack | null,
  zoom: number,
  hardwareZoom: boolean,
  aspect: AspectChoice
): Promise<{ blob: Blob; thumb: Blob | null; width: number; height: number }> {
  const rawW = video.videoWidth;
  const rawH = video.videoHeight;
  if (!rawW || !rawH) throw new Error("Camera frame not ready");

  let bitmap: ImageBitmap | null = null;
  const ImageCaptureCtor = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } }).ImageCapture;
  if (typeof ImageCaptureCtor === "function" && track) {
    try {
      const ic = new ImageCaptureCtor(track);
      const photoBlob = await withTimeout(ic.takePhoto(), 2500, "takePhoto");
      bitmap = await withTimeout(createImageBitmap(photoBlob), 4000, "bitmap decode");
    } catch { bitmap = null; }
  }

  const source: CanvasImageSource = bitmap ?? video;
  const srcW = bitmap ? bitmap.width : rawW;
  const srcH = bitmap ? bitmap.height : rawH;
  const crop = computeCropRect(srcW, srcH, aspectRatioValue(aspect), hardwareZoom ? 1 : zoom);
  const scale = Math.min(1, MAX_CAPTURE_DIM / Math.max(crop.w, crop.h), Math.sqrt(MAX_CAPTURE_PIXELS / Math.max(1, crop.w * crop.h)));
  const outW = Math.max(1, Math.round(crop.w * scale));
  const outH = Math.max(1, Math.round(crop.h * scale));

  const mainCanvas = document.createElement("canvas");
  mainCanvas.width = outW;
  mainCanvas.height = outH;
  const ctx = mainCanvas.getContext("2d", { alpha: false });
  if (!ctx) { bitmap?.close(); throw new Error("Canvas context unavailable"); }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
  bitmap?.close();

  const blob = await canvasToJpegBlob(mainCanvas, 0.9, 10000);
  if (!blob) { releaseCanvas(mainCanvas); throw new Error("Failed to encode JPEG"); }

  const thumbScale = Math.min(1, THUMB_MAX_DIM / Math.max(outW, outH));
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = Math.max(1, Math.round(outW * thumbScale));
  thumbCanvas.height = Math.max(1, Math.round(outH * thumbScale));
  const tCtx = thumbCanvas.getContext("2d", { alpha: false });
  let thumb: Blob | null = null;
  if (tCtx) {
    tCtx.drawImage(mainCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    thumb = await canvasToJpegBlob(thumbCanvas, 0.78, 4000);
    releaseCanvas(thumbCanvas);
  }
  releaseCanvas(mainCanvas);
  return { blob, thumb, width: outW, height: outH };
}

export async function generateThumbnailFromBlob(blob: Blob, maxDim = THUMB_MAX_DIM) {
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) { bitmap.close(); return { thumb: null, width, height }; }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumb = await canvasToJpegBlob(canvas, 0.78, 4000);
    releaseCanvas(canvas);
    return { thumb, width, height };
  } catch { return { thumb: null, width: 0, height: 0 }; }
}

export async function ensureJpegBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/jpeg") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_CAPTURE_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) { bitmap.close(); return blob; }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const out = await canvasToJpegBlob(canvas, 0.92, 8000);
    releaseCanvas(canvas);
    return out ?? blob;
  } catch { return blob; }
}

export async function injectJpegExif(jpegBlob: Blob, _meta: { date: Date; width: number; height: number; lat?: number; lng?: number; accuracy?: number; model?: string }): Promise<Blob> {
  return jpegBlob;
}

export async function detectDeviceModel(): Promise<string> { return ""; }

export function formatGpsFix(fix: GpsFix | null): string {
  return fix ? `${fix.lat.toFixed(6)}, ${fix.lng.toFixed(6)}` : "";
}
