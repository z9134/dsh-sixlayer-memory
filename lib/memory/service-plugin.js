/**
 * service-plugin.js — 服务化独立插件行（P6）。
 *
 * 为什么单独一行：
 *  主插件（index.js）里调用 ctx.provide 一旦抛错，会把整个插件带崩，
 *  连工具都不注册（2026-10-31 实测过一次）。拆成独立的插件行后：
 *    - 主插件只负责工具/注入/RPC，永远能加载；
 *    - 这一行只负责把记忆暴露成 Cordis 服务，挂了只少一个服务。
 *
 * 配置（cordis.patch.yml）：
 *   - insert:
 *       - id: memory-core-service
 *         name: file:///D:/001/CH002/dsh-memory-core/lib/service-plugin.js
 *         config:
 *           dataDir: 'D:\001\CH002\dsh-memory-data'
 *           serviceName: memory
 */
import MemoryStore from './store.js'
import { buildService } from './service.js'

export const name = 'workbench-service'

export function apply(ctx, config = {}) {
  const dataDir = String(config?.dataDir ?? 'D:\\001\\CH002\\dsh-memory-data')
  const serviceName = String(config?.serviceName ?? 'workbench')
  const logger = ctx.logger

  let store = null
  try {
    store = new MemoryStore({ dataDir, authority: config?.authority ?? 'shadow' }).open()
  } catch (error) {
    logger?.warn?.(`workbench-service: 记忆库打不开，服务进入降级：${error?.message ?? error}`)
  }

  const service = buildService({ store })
  // 一个大服务，两个命名空间：workbench.memory / workbench.parts
  const workbench = {
    ...service,
    memory: service,
    parts: {
      list: () => service.parts(),
      compose: (options) => service.compose(options ?? {}),
    },
  }

  try {
    ctx.provide(serviceName, workbench)
    logger?.info?.(`workbench-service: 已提供服务 ${serviceName}（apiVersion 1）`)
  } catch (error) {
    logger?.warn?.(`workbench-service: 服务 ${serviceName} 注册失败：${error?.message ?? error}`)
  }

  // 兼容旧消费者：memory 别名指向同一个对象
  if (serviceName !== 'memory') {
    try {
      ctx.provide('memory', workbench)
    } catch (error) {
      logger?.warn?.(`workbench-service: memory 别名注册失败：${error?.message ?? error}`)
    }
  }

  ctx.effect(() => () => {
    try {
      store?.close()
    } catch {
      /* 忽略 */
    }
  })
}
