'use strict';

/**
 * 从 APK 里读出包名与版本号。
 *
 * 为什么要自己解析：后台「上传更新包」时如果还要人工填 versionCode/versionName，
 * 迟早会填错（版本号填错会导致客户端永远认为有新版本，或者永远不提示）。而 APK 的
 * AndroidManifest.xml 是**二进制**格式，不能当文本读；解析它需要先按 ZIP 取出条目，
 * 再解 AXML。这里用 Node 自带的 zlib 手写，**不引第三方依赖** —— fpk 是离线打包的，
 * 多一个依赖就多一份体积和失效风险。
 *
 * 只需要 manifest 里的 package / versionCode / versionName 三个值，所以解析器只做
 * 这一件事，不追求通用。
 */

const fs = require('fs');
const zlib = require('zlib');

// ---------------------------------------------------------------- 最小 ZIP 读取
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 从 zip Buffer 里取出一个条目的原始（可能已压缩的）数据 */
function readZipEntry(buf, wantedName) {
    // EOCD 在文件末尾，注释最长 65535，所以最多往回找 65557 字节
    let eocd = -1;
    const from = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= from; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/APK（找不到 EOCD）');

    const entryCount = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16); // 中央目录偏移

    for (let n = 0; n < entryCount; n++) {
        if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('中央目录损坏');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

        if (name === wantedName) {
            if (buf.readUInt32LE(localOffset) !== LFH_SIG) throw new Error('本地文件头损坏');
            const lNameLen = buf.readUInt16LE(localOffset + 26);
            const lExtraLen = buf.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + lNameLen + lExtraLen;
            const raw = buf.subarray(dataStart, dataStart + compSize);
            if (method === 0) return Buffer.from(raw);          // stored
            if (method === 8) return zlib.inflateRawSync(raw);  // deflate
            throw new Error(`不支持的压缩方式 ${method}`);
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(`APK 里没有 ${wantedName}`);
}

// ---------------------------------------------------------------- 最小 AXML 解析
const RES_STRING_POOL = 0x0001;
const RES_XML_START_ELEMENT = 0x0102;

/** 解析字符串池，返回 (index) => string */
function parseStringPool(buf, offset) {
    const chunkSize = buf.readUInt32LE(offset + 4);
    const stringCount = buf.readUInt32LE(offset + 8);
    const flags = buf.readUInt32LE(offset + 16);
    const stringsStart = buf.readUInt32LE(offset + 20);
    const isUtf8 = (flags & 0x00000100) !== 0;
    const base = offset + stringsStart;
    const offsets = [];
    for (let i = 0; i < stringCount; i++) offsets.push(buf.readUInt32LE(offset + 28 + i * 4));

    const cache = new Array(stringCount);
    const get = (i) => {
        if (i < 0 || i >= stringCount) return null;
        if (cache[i] !== undefined) return cache[i];
        let q = base + offsets[i];
        let s;
        if (isUtf8) {
            // UTF-8：字符数(u8 或 u16) + 字节数(u8 或 u16) + 字节 + 0
            let len = buf[q++];
            if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[q++]; }
            let blen = buf[q++];
            if (blen & 0x80) { blen = ((blen & 0x7f) << 8) | buf[q++]; }
            s = buf.toString('utf8', q, q + blen);
        } else {
            let len = buf.readUInt16LE(q); q += 2;
            if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q); q += 2; }
            s = buf.toString('utf16le', q, q + len * 2);
        }
        cache[i] = s;
        return s;
    };
    return { get, chunkSize };
}

/**
 * 从二进制 AndroidManifest.xml 里取 manifest 元素的属性。
 * @returns {{packageName:string, versionCode:number|null, versionName:string|null, attrs:Object}}
 */
function parseBinaryManifest(buf) {
    if (buf.readUInt16LE(0) !== 0x0003) throw new Error('不是二进制 AndroidManifest.xml');
    const total = buf.readUInt32LE(4);

    // 第一个 chunk 必须是字符串池
    let off = 8;
    if (buf.readUInt16LE(off) !== RES_STRING_POOL) throw new Error('AXML 头部不是字符串池');
    const pool = parseStringPool(buf, off);
    off += pool.chunkSize;

    const out = { packageName: null, versionCode: null, versionName: null, attrs: {} };
    const attrNames = ['versionCode', 'versionName', 'compileSdkVersion', 'platformBuildVersionCode'];

    while (off + 8 <= Math.min(total, buf.length)) {
        const type = buf.readUInt16LE(off);
        const chunkSize = buf.readUInt32LE(off + 4);
        if (chunkSize <= 0) break;

        if (type === RES_XML_START_ELEMENT) {
            const name = pool.get(buf.readUInt32LE(off + 20));
            const attrStart = buf.readUInt16LE(off + 24);
            const attrSize = buf.readUInt16LE(off + 26);
            const attrCount = buf.readUInt16LE(off + 28);
            const aBase = off + 16 + attrStart;

            // 只关心 <manifest> 上的属性
            if (name === 'manifest') {
                for (let i = 0; i < attrCount; i++) {
                    const a = aBase + i * attrSize;
                    const aName = pool.get(buf.readUInt32LE(a + 4));
                    const dataType = buf.readUInt8(a + 15);
                    const data = buf.readUInt32LE(a + 16);
                    if (!aName) continue;
                    if (aName === 'package') out.packageName = pool.get(buf.readUInt32LE(a + 8));
                    else if (aName === 'versionCode' && dataType === 0x10) out.versionCode = data;
                    else if (aName === 'versionName') {
                        // 0x03 = 字符串（指向字符串池），0x10 = 十进制整数
                        out.versionName = dataType === 0x03 ? pool.get(data) : String(data);
                    }
                    if (attrNames.includes(aName) && dataType === 0x10) out.attrs[aName] = data;
                }
                break;
            }
        }
        off += chunkSize;
    }
    return out;
}

/**
 * 读取一个 APK 文件的包名与版本号。
 * @param {string} filePath
 * @returns {{packageName:string|null, versionCode:number|null, versionName:string|null, size:number}}
 */
function readApkInfo(filePath) {
    const buf = fs.readFileSync(filePath);
    const manifest = readZipEntry(buf, 'AndroidManifest.xml');
    const info = parseBinaryManifest(manifest);
    return { ...info, size: buf.length };
}

/** 列出 ZIP 中央目录里的所有条目名（只读名字，不读内容） */
function listZipEntryNames(buf) {
    let eocd = -1;
    const from = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= from; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const entryCount = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let n = 0; n < entryCount; n++) {
        if (buf.readUInt32LE(p) !== CD_SIG) break;
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

/**
 * 判断 APK 是否已签名。
 *
 * 为什么需要这个检查：**未签名的 APK 在 Android 上根本装不上**，
 * 把它收进 dist/ 或当成更新包发出去都是纯粹的误导（这个坑已经踩过一次：
 * 1.3.0 的三个 release 包是未签名的，却在发布目录里躺着）。
 *
 * v2/v3 签名：文件里带 "APK Sig Block 42" 签名块魔数
 * v1 签名（jar signing）：中央目录里有 META-INF/*.RSA|.DSA|.EC
 */
function isApkSigned(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.includes('APK Sig Block 42')) return true;
    const names = listZipEntryNames(buf);
    return names.some((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
}

module.exports = { readApkInfo, readZipEntry, parseBinaryManifest, listZipEntryNames, isApkSigned };
