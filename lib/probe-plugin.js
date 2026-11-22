/**
 * probe-plugin.js — 临时诊断插件（问题定位后可删）。
 *
 * 它只做一件事：证明"这个宿主能不能加载 file:// 插件"以及
 * "index.js 到底能不能被 import、apply 会不会抛错"，全部写进诊断日志。
 */
import fs from 'node:fs'

const LOG = process.env.DSH_HOME ? process.env.DSH_HOME + '/memory-core/diag.log' : 'D:/001/CH002/dsh-memory-core/diag.log'
function log(message) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

log('probe: module loaded')

export const name = 'memory-core-probe'

export function apply(ctx, config = {}) {
  log('probe: apply called')
  const dataDir = String(config?.dataDir ?? 'D:\\001\\CH002\\dsh-memory-data')
  import('./index.js')
    .then((mod) => {
      log('probe: index.js import OK')
      try {
        mod.apply(ctx, { dataDir })
        log('probe: index.apply OK')
      } catch (error) {
        log('probe: index.apply THREW: ' + (error && error.message ? error.message : String(error)))
      }
    })
    .catch((error) => {
      log('probe: index.js import FAILED: ' + (error && error.message ? error.message : String(error)))
    })
}
