'use strict';

/**
 * fnpack 等价的 .fpk 打包器。
 *
 * 结构：内层把 package/app 打成 app.tgz；外层 fpk = tar.gz(manifest, cmd/, config/,
 * wizard/, i18n/, ICON*, app.tgz)。Windows 下保留 Unix 可执行权限位。
 *
 * 用法: node pack.js [packageDir] [output.fpk]
 *
 * 与原实现的区别（原实现会把两个约 110MB 的 Node 二进制 + node_modules 全部读进内存
 * 再 Buffer.concat + gzipSync(level:9)，峰值常驻 250MB 以上且完全同步）：
 *   - 全程流式：文件按块写入 gzip 流，内存占用与包体积无关
 *   - 打包前预检必需文件，缺 Node 运行时/入口时立刻失败，而不是装到 NAS 上才报错
 *   - mtime 默认取 manifest 的修改时间，可用 SOURCE_DATE_EPOCH 覆盖 → 产物可复现
 *   - 输出 sha256，便于发布校验
 *   - 排除 node_modules/.bin（Windows 侧安装残留的 .cmd/.ps1 垫片）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');

const pkgDir = path.resolve(process.argv[2] || path.join(__dirname, 'package'));
const outFile = path.resolve(process.argv[3] || path.join(__dirname, 'mediaiptv.fpk'));

const EXEC_DIRS = ['cmd', 'app/ui', 'ui']; // 外层 cmd/、内层 ui/
const EXEC_FILES = new Set([
  'app/server/node_x86_64', 'app/server/node_aarch64', // 外层视角
  'server/node_x86_64', 'server/node_aarch64',          // 内层 app.tgz 视角
]);

function isExec(rel, isDir) {
  if (isDir) return true;
  const norm = rel.replace(/\\/g, '/');
  if (EXEC_FILES.has(norm)) return true;
  if (EXEC_DIRS.some((d) => norm === d || norm.startsWith(d + '/'))) return true;
  if (norm.endsWith('.cgi')) return true;
  return false;
}

/** 排除 Windows 侧 npm install 留下的 .bin 垫片（含 .bin 目录本身），它们对 Linux 运行时毫无用处 */
function isExcluded(rel) {
  const norm = rel.replace(/\\/g, '/');
  return /(^|\/)node_modules\/\.bin(\/|$)/.test(norm);
}

// mtime 默认取 manifest 的修改时间：确定性来自源码树本身，同样的输入产出同样的字节
const manifestPath = path.join(pkgDir, 'manifest');
const MTIME = process.env.SOURCE_DATE_EPOCH
  ? parseInt(process.env.SOURCE_DATE_EPOCH, 10)
  : (fs.existsSync(manifestPath) ? Math.floor(fs.statSync(manifestPath).mtimeMs / 1000) : 1700000000);

function octalField(value, length) {
  const s = value.toString(8);
  if (s.length + 1 > length) throw new Error('field overflow: ' + value);
  return Buffer.from('0'.repeat(length - 1 - s.length) + s + '\0', 'ascii');
}

function makeHeader(name, mode, size, typeflag) {
  const buf = Buffer.alloc(512, 0);
  let shortName = name;
  if (Buffer.byteLength(shortName) > 100) shortName = shortName.slice(0, 99);
  buf.write(shortName, 0, 'ascii');
  octalField(mode, 8).copy(buf, 100);
  octalField(0, 8).copy(buf, 108);
  octalField(0, 8).copy(buf, 116);
  octalField(size, 12).copy(buf, 124);
  octalField(MTIME, 12).copy(buf, 136);
  buf.fill(0x20, 148, 156);
  buf.write(typeflag, 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  buf.write('root', 265, 'ascii');
  buf.write('root', 297, 'ascii');
  octalField(0, 8).copy(buf, 329);
  octalField(0, 8).copy(buf, 337);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}

const pad512 = (n) => (512 - (n % 512)) % 512;

/** 递归收集目录内容（只收集元信息，不读文件内容） */
function collect(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      out.push({ rel, full, isDir: true });
      collect(full, rel, out);
    } else if (entry.isFile()) {
      out.push({ rel, full, isDir: false });
    }
  }
  return out;
}

/**
 * 把条目流式写成一个 tar.gz 文件。
 * 大文件（Node 运行时）按块读取后直接写入 gzip 流，不在内存里留整份副本。
 */
async function writeTarGz(entries, outPath) {
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(outPath);
  gz.pipe(out);
  const finished = once(out, 'close');

  const write = async (buf) => {
    if (!gz.write(buf)) await once(gz, 'drain');
  };

  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/');
    if (e.isDir) {
      await write(makeHeader(name + '/', e.mode, 0, '5'));
      continue;
    }
    const size = e.data !== undefined ? e.data.length : fs.statSync(e.file).size;
    if (Buffer.byteLength(name) > 100) {
      const nameBuf = Buffer.from(name + '\0', 'utf8');
      await write(makeHeader('./@LongLink', 0o644, nameBuf.length, 'L'));
      await write(nameBuf);
      await write(Buffer.alloc(pad512(nameBuf.length)));
    }
    await write(makeHeader(name, e.mode, size, '0'));
    if (e.data !== undefined) {
      await write(e.data);
    } else {
      const rs = fs.createReadStream(e.file, { highWaterMark: 1 << 20 });
      for await (const chunk of rs) await write(chunk);
    }
    const pad = pad512(size);
    if (pad) await write(Buffer.alloc(pad));
  }

  await write(Buffer.alloc(1024)); // 两个 512 字节的结束块
  gz.end();
  await finished;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

(async () => {
  // ---- 预检：缺关键文件就不要产出一个装不上的包 ----
  const required = [
    path.join(pkgDir, 'app', 'server', 'app', 'src', 'index.js'),
    path.join(pkgDir, 'manifest'),
    path.join(pkgDir, 'cmd', 'main'),
  ];
  const missing = required.filter((f) => !fs.existsSync(f));
  const hasNode = ['node_x86_64', 'node_aarch64'].some((n) =>
    fs.existsSync(path.join(pkgDir, 'app', 'server', n)));
  if (!hasNode) missing.push(path.join(pkgDir, 'app', 'server', 'node_{x86_64,aarch64}'));
  if (missing.length) {
    console.error('打包中止，缺少必需文件：');
    for (const m of missing) console.error('  - ' + m);
    console.error('\n请先运行 build.sh / build.ps1 准备 package/app/server 目录。');
    process.exit(1);
  }

  const appDir = path.join(pkgDir, 'app');
  const appEntries = collect(appDir, '', []).map((e) => ({
    name: e.rel.replace(/\\/g, '/'),
    mode: isExec('app/' + e.rel.replace(/\\/g, '/'), e.isDir) || isExec(e.rel.replace(/\\/g, '/'), e.isDir) ? 0o755 : 0o644,
    isDir: e.isDir,
    file: e.isDir ? undefined : e.full,
  }));

  // ---- 内层：package/app/** -> app.tgz ----
  const appTgz = path.join(pkgDir, '.app.tgz.tmp');
  await writeTarGz(appEntries, appTgz);
  const appTgzSize = fs.statSync(appTgz).size;
  console.log(`app.tgz: ${(appTgzSize / 1024 / 1024).toFixed(1)} MB (${appEntries.length} entries)`);

  // ---- 外层：package 下除 app/ 以外的内容 + app.tgz ----
  const outerItems = [];
  for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (entry.name === 'app') continue;
    if (entry.name === '.app.tgz.tmp') continue;
    const full = path.join(pkgDir, entry.name);
    if (entry.isDirectory()) {
      for (const e of collect(full, entry.name, [])) {
        outerItems.push({
          name: e.rel.replace(/\\/g, '/'),
          mode: isExec(e.rel.replace(/\\/g, '/'), e.isDir) ? 0o755 : 0o644,
          isDir: e.isDir,
          file: e.isDir ? undefined : e.full,
        });
      }
    } else if (entry.isFile()) {
      outerItems.push({
        name: entry.name,
        mode: isExec(entry.name, false) ? 0o755 : 0o644,
        isDir: false,
        file: full,
      });
    }
  }
  // app.tgz 以文件形式流式嵌入，不再整份读进内存
  outerItems.push({ name: 'app.tgz', mode: 0o644, isDir: false, file: appTgz });

  await writeTarGz(outerItems, outFile);
  fs.unlinkSync(appTgz);

  const size = fs.statSync(outFile).size;
  const hash = await sha256File(outFile);
  console.log(`OK: ${outFile}`);
  console.log(`    ${(size / 1024 / 1024).toFixed(1)} MB, ${outerItems.length} outer entries`);
  console.log(`    sha256: ${hash}`);
  console.log(`    mtime : ${MTIME}${process.env.SOURCE_DATE_EPOCH ? ' (SOURCE_DATE_EPOCH)' : ' (取自 manifest 修改时间，可用 SOURCE_DATE_EPOCH 覆盖)'}`);
})().catch((e) => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
