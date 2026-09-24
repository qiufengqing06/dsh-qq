/**
 * ResourceScope —— dsh-qq 的生命周期基座（执行文档 §5.7）。
 *
 * dsh-qq 是常驻 Gateway 插件，最大的长期风险不是消息协议，而是 listener 泄漏、
 * 重复心跳、重复重连、token 定时器叠加。所有运行时资源（定时器、事件订阅、WS、
 * pending 任务）统一挂到同一个 AbortController 树，插件 disable / 卸载时一次性释放。
 *
 * 用法：
 *   const scope = createResourceScope({ name: 'dsh-qq', onError })
 *   scope.timer(fn, 30_000, { repeat: true })       // 定时器，dispose 时自动清
 *   scope.add(() => ws.close())                     // 清理函数（可返回 Promise）
 *   scope.run(signal => loop(signal))               // 长期任务，dispose 时等待收敛
 *   scope.listen(() => ctx.on(...), h => h.dispose())
 *   await scope.dispose()                           // LIFO 清理 + abort + 等待任务
 */

/**
 * 创建一个资源作用域。
 * @param {object} [options]
 * @param {string} [options.name] - 诊断用的作用域名。
 * @param {(error: unknown, label: string) => void} [options.onError] - 资源失败上报（默认静默）。
 * @returns {object} scope
 */
export function createResourceScope({ name = 'dsh-qq', onError = null } = {}) {
  const controller = new AbortController()
  const cleanups = []
  const timers = new Set()
  const tasks = new Set()
  let disposed = false
  let disposePromise = null

  const report = (error, label) => {
    if (typeof onError !== 'function') return
    try {
      onError(error, label)
    } catch {
      /* 上报失败不得影响其他清理 */
    }
  }

  const add = (fn, label = 'resource') => {
    if (typeof fn !== 'function') throw new TypeError(`${name}: scope.add requires a function`)
    if (disposed) {
      // 已释放：立即执行，避免把资源登记成永久泄漏
      Promise.resolve()
        .then(fn)
        .catch(error => report(error, label))
      return fn
    }
    cleanups.push({ fn, label })
    return fn
  }

  const listen = (subscribe, unsubscribe, label = 'listener') => {
    const handle = subscribe()
    add(() => unsubscribe(handle), label)
    return handle
  }

  const timer = (fn, ms, { repeat = false, label = 'timer' } = {}) => {
    if (disposed) return null
    const run = () => {
      try {
        fn()
      } catch (error) {
        report(error, label)
      }
    }
    const handle = repeat
      ? setInterval(run, ms)
      : setTimeout(() => {
          timers.delete(handle)
          run()
        }, ms)
    if (typeof handle.unref === 'function') handle.unref()
    timers.add(handle)
    return handle
  }

  const clearTimer = handle => {
    if (handle === null || handle === undefined) return
    clearTimeout(handle)
    clearInterval(handle)
    timers.delete(handle)
  }

  const run = (fn, label = 'task') => {
    if (disposed) return Promise.resolve(undefined)
    const settled = (async () => fn(controller.signal))().catch(error => {
      if (controller.signal.aborted) return undefined
      report(error, label)
      return undefined
    })
    tasks.add(settled)
    settled.finally(() => tasks.delete(settled))
    return settled
  }

  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    disposePromise = (async () => {
      controller.abort()
      for (const handle of [...timers]) {
        clearTimeout(handle)
        clearInterval(handle)
      }
      timers.clear()
      // LIFO：后登记的先释放（依赖方先于被依赖方收尾）
      while (cleanups.length > 0) {
        const { fn, label } = cleanups.pop()
        try {
          await fn()
        } catch (error) {
          report(error, label)
        }
      }
      await Promise.allSettled([...tasks])
    })()
    return disposePromise
  }

  return {
    name,
    get signal() {
      return controller.signal
    },
    get disposed() {
      return disposed
    },
    /** 已登记的资源数量（测试用：确认 enable/disable 循环不增长）。 */
    get size() {
      return cleanups.length + timers.size + tasks.size
    },
    get stats() {
      return { cleanups: cleanups.length, timers: timers.size, tasks: tasks.size }
    },
    add,
    listen,
    timer,
    clearTimer,
    run,
    dispose,
  }
}

export default createResourceScope
