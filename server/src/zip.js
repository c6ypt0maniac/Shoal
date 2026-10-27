// Minimal .zip writer (deflate, no zip64), so downloads don't depend on which
// `tar` happens to be on the PATH. Fine for repo-sized archives.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// files: [{ path, data: Buffer | string }] -> Buffer of the whole archive.
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path.replace(/\\/g, "/"));
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// Minimal .zip reader for uploaded agent bundles (stored or deflate, no zip64).
// Refuses what could escape the folder it's unpacked into (absolute paths,
// "..", links) and anything over the limits, before inflating a byte more.
// -> [{ path, data: Buffer }] (folders left out).
export function unzip(buf, { maxFiles = 2000, maxBytes = 20 * 1024 * 1024 } = {}) {
  const bad = (why) => Object.assign(new Error(`That zip ${why}`), { status: 400 });
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw bad("isn't a valid zip file");
  const count = buf.readUInt16LE(end + 10);
  if (count > maxFiles) throw bad(`has more than ${maxFiles} files`);
  let at = buf.readUInt32LE(end + 16), total = 0;
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw bad("is damaged");
    const method = buf.readUInt16LE(at + 10), packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const unixMode = buf.readUInt32LE(at + 38) >>> 16, local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) throw bad(`has a file outside its folder (${name})`);
    if ((unixMode & 0o170000) === 0o120000) throw bad(`has a link (${name}); include the file itself`);
    total += size;
    if (total > maxBytes) throw bad(`unpacks to more than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + packed);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : null;
    if (!data) throw bad(`uses a compression Shoal can't read (${name})`);
    out.push({ path: name, data });
  }
  return out;
}
