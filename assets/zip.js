// zip.js — minimal self-contained ZIP writer (STORE, no compression, no deps).
// Enough to bundle a handful of small HTML files for the multi-page Download.
// Produces a valid .zip (local headers + central directory + EOCD).

// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

// files: [{ name, data(string) }] -> Blob
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime();

  const push = (arr) => { parts.push(arr); offset += arr.length; };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.data);
    const crc = crc32(dataBytes);
    const sz = dataBytes.length;

    // local file header
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);           // version needed
    lh.setUint16(6, 0, true);            // flags
    lh.setUint16(8, 0, true);            // method 0 = store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, sz, true);          // compressed size
    lh.setUint32(22, sz, true);          // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);           // extra len
    const localOffset = offset;
    push(new Uint8Array(lh.buffer));
    push(nameBytes);
    push(dataBytes);

    // central directory record
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);           // version made by
    cd.setUint16(6, 20, true);           // version needed
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);           // method
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, sz, true);
    cd.setUint32(24, sz, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);           // extra
    cd.setUint16(32, 0, true);           // comment
    cd.setUint16(34, 0, true);           // disk
    cd.setUint16(36, 0, true);           // internal attrs
    cd.setUint32(38, 0, true);           // external attrs
    cd.setUint32(42, localOffset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { push(c); cdSize += c.length; }

  // end of central directory
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  push(new Uint8Array(eocd.buffer));

  return new Blob(parts, { type: "application/zip" });
}
