/**
 * 极简零依赖 ZIP 打包器 — 用于客户端启动包一键下载。
 * deflate 压缩 + CRC32 + 支持 Unix 可执行位 (Mac 下 .command 解压后可直接双击)。
 * 文件名按 UTF-8 (flag bit 11)。小文件 (agent dist 几十 KB) 场景足够。
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** zip 内路径, 用 / 分隔, 如 "dist/cli.js" */
  name: string;
  data: Buffer;
  /** Unix mode (含文件类型位), 默认 0o100644; 可执行脚本传 0o100755 */
  mode?: number;
}

/** 把多个文件打成一个 zip Buffer (deflate, 零依赖)。 */
export function createZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const compressed = deflateRawSync(e.data);
    const useDeflate = compressed.length < e.data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? compressed : e.data;
    const mode = e.mode ?? 0o100644;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);        // version needed
    lfh.writeUInt16LE(0x0800, 6);    // flags: bit11 UTF-8 名
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);        // mod time
    lfh.writeUInt16LE(0x21, 12);     // mod date (1980-01-01 占位)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // version made by: 高字节3=Unix(让外部属性的mode生效)
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE((mode >>> 0) * 0x10000, 38); // 外部属性高16位 = Unix mode
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuf, eocd]);
}
