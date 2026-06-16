/**
 * 流式打包文件夹为 zip —— 边读边 deflate 边写, 内存可控(不把整包攒内存), 不依赖系统 zip。
 * 保留 Unix 可执行位(Mac .command / node 二进制解压后可直接跑)。
 */
import { createReadStream, createWriteStream, statSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createDeflateRaw } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crcUpdate(crc, chunk) { for (let i = 0; i < chunk.length; i++) crc = CRC[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8); return crc >>> 0; }

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push({ abs, rel: relative(base, abs).split(sep).join("/"), size: st.size, mode: st.mode });
  }
  return out;
}

export async function zipFolder(srcDir, outZipPath) {
  const files = walk(srcDir);
  const out = createWriteStream(outZipPath);
  const writeBuf = (b) => new Promise((res, rej) => { out.write(b, (e) => (e ? rej(e) : res())); });
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.rel, "utf8");
    // 流式: 读文件 → 累计 crc32 + deflate; deflate 输出按文件收集(单文件级内存, node.exe ~30MB 可接受)
    let crc = 0xffffffff;
    const chunks = [];
    await new Promise((resolve, reject) => {
      const rs = createReadStream(f.abs);
      const dz = createDeflateRaw();
      rs.on("data", (c) => { crc = crcUpdate(crc, c); dz.write(c); });
      rs.on("end", () => dz.end());
      rs.on("error", reject);
      dz.on("data", (d) => chunks.push(d));
      dz.on("end", resolve);
      dz.on("error", reject);
    });
    crc = (crc ^ 0xffffffff) >>> 0;
    const deflated = Buffer.concat(chunks);
    const useStore = deflated.length >= f.size;
    const method = useStore ? 0 : 8;
    const compLen = useStore ? f.size : deflated.length;
    const mode = (f.mode & 0o777) | 0o100000;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8); lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(compLen, 18); lfh.writeUInt32LE(f.size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
    await writeBuf(lfh); await writeBuf(nameBuf);
    if (useStore) {
      // store: 流式拷原文件, 不进内存
      await new Promise((res, rej) => {
        const rs = createReadStream(f.abs);
        rs.on("data", (c) => { if (!out.write(c)) { rs.pause(); out.once("drain", () => rs.resume()); } });
        rs.on("end", res); rs.on("error", rej);
      });
    } else {
      await writeBuf(deflated);
    }

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE((3 << 8) | 20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8); cdh.writeUInt16LE(method, 10); cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(compLen, 20); cdh.writeUInt32LE(f.size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36); cdh.writeUInt32LE((mode >>> 0) * 0x10000, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + compLen;
  }
  const centralBuf = Buffer.concat(central);
  await writeBuf(centralBuf);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  await writeBuf(eocd);
  await new Promise((res) => out.end(res));
  return { files: files.length };
}
