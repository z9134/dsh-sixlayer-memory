/** p27：把记忆翻译成「人话」（展示层） */
import {
  cleanText,
  decorateRows,
  detectKind,
  explainRecord,
  relativeWhen,
} from '../lib/memory/explain.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok  ' + name) } else { fail += 1; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')) }
}

const NOW = Date.parse('2026-11-20T11:00:00+08:00')

// ---------- 1. 去术语 ----------
ok('去术语：代码块被删', !cleanText('```bash\nls -la /opt/x\n```\n结论是能跑').includes('ls -la'))
ok('去术语：长内联代码被删', !cleanText('卡在 `wchan=pipe_read_blocked_for_ever` 这里').includes('wchan'))
ok('去术语：短内联代码保留', cleanText('用 `ps` 看一下').includes('ps'))
ok('去术语：绝对路径被删', !cleanText('日志在 /var/log/dsh/memory-core.log 里').includes('/var/log'))
ok('去术语：Windows 路径被删', !cleanText('放在 D:\\001\\CH002\\dsh-memory-core 下').includes('D:\\'))
ok('去术语：文件名被删', !cleanText('改 wifi_push.py 就行').includes('wifi_push'))
ok('去术语：长哈希被删', !cleanText('记录 8SHNP56M10R7R700S3F5A2W164 已写入').includes('8SHNP'))
ok('去术语：普通中文不动', cleanText('以后数据库一律用 SQLite') === '以后数据库一律用 SQLite')

// ---------- 2. 相对时间 ----------
ok('时间：今天', relativeWhen('2026-11-20T09:00:00+08:00', NOW) === '今天')
ok('时间：昨天', relativeWhen('2026-11-19T23:00:00+08:00', NOW) === '昨天')
ok('时间：几天前', relativeWhen('2026-11-17T10:00:00+08:00', NOW) === '3 天前')
ok('时间：几周前', relativeWhen('2026-11-05T10:00:00+08:00', NOW).includes('周前'), relativeWhen('2026-11-05T10:00:00+08:00', NOW))
ok('时间：跨年给日期', relativeWhen('2025-03-02T10:00:00+08:00', NOW) === '2025年3月2日', relativeWhen('2025-03-02T10:00:00+08:00', NOW))
ok('时间：坏输入返回空', relativeWhen('not-a-date', NOW) === '')

// ---------- 3. 分类 ----------
ok('分类：修过的坑', detectKind('USB 摄像头卡死的软件复位：症状是 CPU 烧满').id === 'fix')
ok('分类：定下的规则', detectKind('以后数据库一律用 SQLite').id === 'rule')
ok('分类：怎么做', detectKind('启动只需跑一条脚本，配置好端口').id === 'howto')
ok('分类：聊过的话', detectKind('用户：在吗 角色：在的').id === 'chat')
ok('分类：默认记下的事实', detectKind('昇腾开发板官方资料下载地址汇总').id === 'fact')

// ---------- 4. 人话：截图里那条 ----------
const usb = explainRecord({
  summary: '★ USB 摄像头卡死的软件复位（2026-10-26 实测有效，免拔插）：症状是 ffmpeg 烧 97.8% CPU 但 /proc/<pid>/io 的 wchar=0（写出 0 字节），Python 卡在 wchan=pipe_read',
  created_at: '2026-10-30T14:06:33+08:00',
  layer: 'L2',
}, { now: NOW })
ok('人话：分类正确', usb.kind === '修过的坑', usb.kind)
ok('人话：标题是人话不是原文', usb.title.includes('USB 摄像头卡死') && !usb.title.includes('8SHNP'), usb.title)
ok('人话：把验证信息提出来', usb.plain.includes('10月26日') && usb.plain.includes('免拔插'), usb.plain)
ok('人话：技术细节不进展示', !/proc|<pid>|wchar|ffmpeg/.test(usb.title + usb.plain), usb.title + ' | ' + usb.plain)
ok('人话：原文仍然保留（详情用）', usb.technical.includes('/proc/<pid>/io'))
ok('人话：带相对时间', usb.when === '3 周前', usb.when)

// ---------- 5. 人话：规则 / 对话 / 空 ----------
const rule = explainRecord({ summary: '以后数据库一律用 SQLite，不要再用 MySQL。', created_at: '2026-11-19T20:00:00+08:00' }, { now: NOW })
ok('规则：标题直接可读', rule.title.includes('SQLite'), rule.title)
ok('规则：分类=定下的规则', rule.kind === '定下的规则')

const chat = explainRecord({ summary: '用户：能和你视频通话吗 角色：不行啦，只有声音没有画面。' }, { now: NOW })
ok('对话：标题是"你说过"', chat.title.startsWith('你说过：'), chat.title)
ok('对话：人话带上回复', chat.plain.includes('它回你'), chat.plain)
ok('对话：分类=聊过的话', chat.kind === '聊过的话')

const short = explainRecord({ summary: '用户：对 角色：行，说吧。' }, { now: NOW })
ok('对话：太短的搭话降级', short.title === '随口聊了一句', short.title)

const empty = explainRecord({ summary: '' }, { now: NOW })
ok('空记录：不抛错且有占位', empty.title === '（没有摘要）')

// ---------- 5b. 纯日期括号不能当人话 ----------
const blender = explainRecord({
  summary: 'Blender 能力扩展（2026-10-26）：dshbb 命令 24→39 条全解锁；官方扩展 8 个（looptools / measureit / extra_mesh_objects …',
  created_at: '2026-10-30T14:06:33+08:00',
}, { now: NOW })
ok('纯日期括号：人话不能只剩一个日期', blender.plain === '' || !/^\d+月\d+日。$/.test(blender.plain), JSON.stringify(blender.plain))
ok('纯日期括号：标题仍然是人话', blender.title.includes('Blender'), blender.title)
ok('纯日期括号：时间靠 when 字段给', blender.when === '3 周前', blender.when)

// ---------- 6. 批量装饰 ----------
const rows = [{ record_id: 'r1', summary: '以后一律用 SQLite', created_at: '2026-11-19T20:00:00+08:00' }]
const wrapped = decorateRows(rows, { now: NOW })
ok('装饰：挂上 display', wrapped[0].display && wrapped[0].display.title.includes('SQLite'))
ok('装饰：不改原对象', rows[0].display === undefined)
ok('装饰：非数组原样返回', decorateRows(null) === null)

console.log(`\nP27 ${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
