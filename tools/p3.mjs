// P3 回归：通知兜底 / 季度优化单 / 月报发送链路。
import fs from 'node:fs'
import { sendReport, sendMail, sendFeishu } from '../lib/memory/notify.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}

// 1. 配置为空时：SMTP 失败 → 飞书失败 → 本地 outbox 兜底
const r = await sendReport({ subject: 'P3 自测', text: '这是一条兜底测试。' }, {})
check('兜底到 outbox', r.ok === true && r.channel === 'outbox', JSON.stringify(r))
check('三级都尝试过', r.attempts.length === 3, String(r.attempts.length))
check('outbox 文件真实存在', r.path && fs.existsSync(r.path), String(r.path))

// 2. 配置不全时给出明确错误
let mailErr = ''
try {
  sendMail({ subject: 'x', text: 'y' }, {})
} catch (e) {
  mailErr = e.message
}
check('SMTP 配置不全时报错', mailErr.includes('配置不完整'), mailErr)

let feishuErr = ''
try {
  await sendFeishu({ subject: 'x', text: 'y' }, {})
} catch (e) {
  feishuErr = e.message
}
check('飞书无 webhook 时报错', feishuErr.includes('webhook'), feishuErr)

// 3. 季度优化单
const qmd = 'D:/001/CH002/dsh-memory-data/reports/quarterly/2026-Q4.md'
check('季度优化单已生成', fs.existsSync(qmd))
if (fs.existsSync(qmd)) {
  const text = fs.readFileSync(qmd, 'utf8')
  check('季度单写明不自动改参数', text.includes('不自动修改'))
  check('季度单含趋势表', text.includes('## 一、趋势'))
}

// 4. 月报文件
check('月报 md 存在', fs.existsSync('D:/001/CH002/dsh-memory-data/reports/monthly/2026-10.md'))
check('月报 json 存在', fs.existsSync('D:/001/CH002/dsh-memory-data/reports/monthly/2026-10.json'))

console.log(`\nP3 ${fail === 0 ? 'OK' : 'FAILED'}  pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
