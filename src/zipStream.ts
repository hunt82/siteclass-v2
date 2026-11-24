export interface ZipStreamInput {
  name: string;
  input: string | Uint8Array | Blob | ReadableStream<Uint8Array>;
  lastModified?: Date;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function crc32Chunk(bytes: Uint8Array, seed = 0): number {
  let c = seed ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date: Date) {
  const time = (Math.floor(date.getSeconds() / 2) & 0x1f) | ((date.getMinutes() & 0x3f) << 5) | ((date.getHours() & 0x1f) << 11);
  const dosDate = (date.getDate() & 0x1f) | (((date.getMonth() + 1) & 0x0f) << 5) | (((date.getFullYear() - 1980) & 0x7f) << 9);
  return { time, dosDate };
}

async function* readChunks(input: ZipStreamInput["input"]): AsyncGenerator<Uint8Array> {
  if (typeof input === "string") { yield new TextEncoder().encode(input); return; }
  if (input instanceof Uint8Array) { yield input; return; }
  const stream = input instanceof Blob ? input.stream() : input;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) yield value;
    }
  } finally { reader.releaseLock(); }
}

export function createStreamingZipBlob(entries: AsyncIterable<ZipStreamInput>): Promise<Blob> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const centralRecords: Uint8Array[] = [];
        let localOffset = 0;
        let entryCount = 0;
        for await (const entry of entries) {
          const nameBytes = encoder.encode(entry.name.replace(/^\/+/, ""));
          const { time, dosDate } = dosTimeDate(entry.lastModified ?? new Date());
          let crc = 0, fileSize = 0;
          const bufferedChunks: Uint8Array[] = [];
          for await (const chunk of readChunks(entry.input)) {
            crc = crc32Chunk(chunk, crc);
            fileSize += chunk.byteLength;
            bufferedChunks.push(chunk);
          }
          const lfh = new Uint8Array(30);
          const lv = new DataView(lfh.buffer);
          lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
          lv.setUint16(10, time, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true);
          lv.setUint32(18, fileSize, true); lv.setUint32(22, fileSize, true); lv.setUint16(26, nameBytes.length, true);
          controller.enqueue(lfh); controller.enqueue(nameBytes);
          for (const chunk of bufferedChunks) controller.enqueue(chunk);

          const cdfh = new Uint8Array(46 + nameBytes.length);
          const cv = new DataView(cdfh.buffer);
          cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
          cv.setUint16(12, time, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
          cv.setUint32(20, fileSize, true); cv.setUint32(24, fileSize, true); cv.setUint16(28, nameBytes.length, true);
          cv.setUint32(42, localOffset, true); cdfh.set(nameBytes, 46);
          centralRecords.push(cdfh);
          localOffset += 30 + nameBytes.length + fileSize;
          entryCount += 1;
        }
        let centralSize = 0;
        for (const rec of centralRecords) { controller.enqueue(rec); centralSize += rec.byteLength; }
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entryCount, true); ev.setUint16(10, entryCount, true);
        ev.setUint32(12, centralSize, true); ev.setUint32(16, localOffset, true);
        controller.enqueue(eocd); controller.close();
      } catch (err) { controller.error(err); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/zip" } }).blob();
}
