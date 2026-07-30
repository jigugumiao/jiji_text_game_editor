// js/zip.js — 极简 ZIP 写入器（STORE 法，无压缩，零依赖）
// 用于「标准结构 HTML 压缩包」导出，保证离线可用、不引入第三方库。

const ZIP_CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// files: [{ name: 'assets/bg/x.png', data: Uint8Array }]
// 返回 Blob（application/zip）
function buildZipBlob(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  function strToBytes(s) { return enc.encode(s); }

  for (const f of files) {
    const nameBytes = strToBytes(f.name);
    const data = f.data; // Uint8Array
    const crc = zipCrc32(data);
    const size = data.length;

    // local file header
    const local = new Uint8Array(30 + nameBytes.length + size);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);     // local file sig
    dv.setUint16(4, 20, true);             // version needed
    dv.setUint16(6, 0, true);              // flags
    dv.setUint16(8, 0, true);              // method = store
    dv.setUint16(10, 0, true);             // mod time
    dv.setUint16(12, 0, true);             // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);          // compressed size
    dv.setUint32(22, size, true);          // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);             // extra len
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    // central directory record
    const cen = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cen.buffer);
    cdv.setUint32(0, 0x02014b50, true);    // central sig
    cdv.setUint16(4, 20, true);            // version made by
    cdv.setUint16(6, 20, true);            // version needed
    cdv.setUint16(8, 0, true);             // flags
    cdv.setUint16(10, 0, true);            // method
    cdv.setUint16(12, 0, true);            // mod time
    cdv.setUint16(14, 0, true);            // mod date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);            // extra
    cdv.setUint16(32, 0, true);            // comment
    cdv.setUint16(34, 0, true);            // disk #
    cdv.setUint16(36, 0, true);            // internal attr
    cdv.setUint32(38, 0, true);            // external attr
    cdv.setUint32(42, offset, true);       // local header offset
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  // end of central directory
  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

// 解析 ZIP（支持 STORE 与 DEFLATE）为 { name: Uint8Array }
async function parseZipBlob(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const files = {};
  let off = 0;
  while (off + 4 <= buf.length) {
    const sig = dv.getUint32(off, true);
    if (sig !== 0x04034b50) break; // 进入 central directory，停止遍历
    const method = dv.getUint16(off + 8, true);
    const compressedSize = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const nameStart = off + 30;
    const name = new TextDecoder().decode(buf.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      files[name] = data.slice();
    } else if (method === 8) {
      const out = await new Response(
        new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      ).arrayBuffer();
      files[name] = new Uint8Array(out);
    } else {
      throw new Error('不支持的 ZIP 压缩方式: ' + method);
    }
    off = dataStart + compressedSize;
  }
  return files;
}

if (typeof window !== 'undefined') {
  window.buildZipBlob = buildZipBlob;
  window.zipCrc32 = zipCrc32;
  window.parseZipBlob = parseZipBlob;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildZipBlob, zipCrc32, parseZipBlob };
}
