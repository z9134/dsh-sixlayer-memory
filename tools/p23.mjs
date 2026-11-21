/** p23：静态加密（key 生成、加解密往返、透明读、坏密钥失败） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MemoryStore from '../lib/memory/store.js'
import { isEncrypted } from '../lib/memory/crypto.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-p23-'))
const store = new MemoryStore({ dataDir: dir }).open()

ok('默认未启用', store.cryptoStatus().enabled === false)
const enabled = store.enableCrypto()
ok('启用并生成密钥', enabled.enabled === true && enabled.created === true, JSON.stringify(enabled))
ok('密钥文件存在', fs.existsSync(enabled.keyPath))

const rec = store.write({ content: '机密内容：测试口令 123456', layer: 'L3', sourceChannel: 'user', trustLevel: 'trusted', tags: ['crypto'] })
const enc = store.encryptRecord(rec.record_id)
ok('加密成功', enc.encrypted === true)
const raw = store.db.prepare('SELECT content FROM records WHERE record_id = ?').get(rec.record_id).content
ok('库内是密文', isEncrypted(raw), String(raw).slice(0, 12))

const read = store.read(rec.record_id, { includeSensitive: true })
ok('读出来是明文', read && read.content === '机密内容：测试口令 123456', read && read.content)

const dec = store.decryptRecord(rec.record_id)
ok('解密恢复明文', dec.encrypted === false)
const raw2 = store.db.prepare('SELECT content FROM records WHERE record_id = ?').get(rec.record_id).content
ok('库内恢复明文', raw2 === '机密内容：测试口令 123456')

// 坏密钥：先用正确密钥加密，再把密钥换掉，读取应明确失败而不是崩
store.encryptRecord(rec.record_id)
fs.writeFileSync(enabled.keyPath, 'ff'.repeat(32) + '\n', 'utf8')
const bad = store.read(rec.record_id, { includeSensitive: true })
ok('坏密钥读取被拒', bad && bad.denied === true, JSON.stringify(bad && bad.reason))

store.close()
console.log(`\nP23 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)