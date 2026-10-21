/** Minimal image headers for tests. The server never decodes a picture, so a valid header (plus padding) is all it ever looks at. */
const pad = (b: Buffer, to = 64): Buffer => (b.length >= to ? b : Buffer.concat([b, Buffer.alloc(to - b.length, 7)]));

export function fakePng(w: number, h: number, opts: { animated?: boolean } = {}): Buffer {
  const ihdr = Buffer.alloc(8 + 4 + 4 + 8);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
  ihdr.writeUInt32BE(13, 8);
  ihdr.write("IHDR", 12, "latin1");
  ihdr.writeUInt32BE(w, 16);
  ihdr.writeUInt32BE(h, 20);
  return pad(Buffer.concat([ihdr, opts.animated ? Buffer.from("acTL") : Buffer.alloc(0)]));
}

export function fakeJpeg(w: number, h: number, salt = 0): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  return pad(Buffer.concat([head, sof, Buffer.from([salt & 255, (salt >> 8) & 255])]));
}

export function fakeWebp(w: number, h: number, kind: "VP8X" | "VP8 " | "VP8L" = "VP8X", animated = false): Buffer {
  const b = Buffer.alloc(40, 3);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write(kind, 12, "latin1");
  if (kind === "VP8X") {
    b[20] = animated ? 0x02 : 0;
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  } else if (kind === "VP8 ") {
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  } else {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  }
  return b;
}
