/**
 * dsh-qq 浏览器半（客户端插件）。
 *
 * 作用只有一个：在 DSH Web 的左侧栏底部加一个「QQ 控制台」按钮，点开弹出面板，
 * 内嵌 iframe 加载插件自带的控制台页面（同源 `/dsh-qq`，登录/凭据/配置/告警都在里面）。
 *
 * 为什么是手写的：dsh-qq 的立场是零依赖、零构建——这个文件就是浏览器直接执行的
 * 动态插件包（`window.__ModuleLoader__.load` 格式，由 DSH 的 clientModules 服务按
 * package.json 的 `dsh.client` 声明发现并下发），不需要 tsdown/React 构建链。
 * 组件用 `require('react')` 的 createElement，渲染进 `sidebar.footer.action` 插槽。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    /** 控制台在本机 DSH Web 上的同源地址（插件注册的 prefix 路由）。 */
    const CONSOLE_PATH = '/dsh-qq'

    /** 侧栏按钮：图标 + 文字（展开时显示文字，收起成图标栏时只有图标）。 */
    function ConsoleTrigger(props) {
      const wide = props !== null && props !== undefined && props.wide === true
      const [hover, setHover] = react.useState(false)
      const [open, setOpen] = react.useState(false)

      react.useEffect(() => {
        if (!open) return undefined
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const trigger = h(
        'button',
        {
          type: 'button',
          title: 'QQ 控制台（在弹窗里打开 dsh-qq 配置页）',
          'aria-label': '打开 QQ 控制台',
          'aria-expanded': open,
          onClick: () => setOpen(true),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: '8px',
            width: wide ? '100%' : '36px',
            height: '32px',
            margin: '2px 0 0',
            padding: wide ? '0 10px' : '0',
            border: '1px solid transparent',
            borderRadius: '8px',
            background: hover ? 'rgba(127,127,127,.14)' : 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: '13px',
            lineHeight: '1',
            transition: 'background .15s ease',
            opacity: 0.9,
          },
        },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
          h('path', { d: 'M7 9h10M7 13h6' }),
          h('circle', { cx: 17, cy: 16, r: 2 }),
        ),
        wide ? h('span', null, 'QQ 控制台') : null,
      )

      if (!open) return trigger

      const overlay = h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': 'dsh-qq 控制台',
          onClick: () => setOpen(false),
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '18px',
            background: 'rgba(10, 12, 16, .42)',
          },
        },
        h(
          'div',
          {
            onClick: event => event.stopPropagation(),
            style: {
              position: 'relative',
              width: 'min(1320px, 95vw)',
              height: 'min(920px, 92vh)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRadius: '16px',
              background: '#fff',
              boxShadow: '0 24px 80px -16px rgba(0,0,0,.45)',
            },
          },
          h('iframe', {
            src: CONSOLE_PATH,
            title: 'dsh-qq 控制台',
            style: { flex: '1 1 auto', width: '100%', border: '0', display: 'block', background: '#fff' },
          }),
          h(
            'button',
            {
              type: 'button',
              title: '关闭（Esc）',
              'aria-label': '关闭控制台',
              onClick: () => setOpen(false),
              style: {
                position: 'absolute',
                top: '10px',
                right: '12px',
                width: '30px',
                height: '30px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(0,0,0,.12)',
                borderRadius: '9px',
                background: 'rgba(255,255,255,.92)',
                color: '#333',
                fontSize: '17px',
                lineHeight: '1',
                cursor: 'pointer',
              },
            },
            '×',
          ),
        ),
      )

      // 弹窗用 portal 挂到 body，避免被侧栏的 overflow 裁掉
      const createPortal = typeof react.createPortal === 'function' ? react.createPortal : null
      return h(react.Fragment, null, trigger, createPortal !== null ? createPortal(overlay, document.body) : overlay)
    }

    /**
     * 插件体：往侧栏底部的动作插槽注册按钮。
     * @param {object} ctx - 客户端 Cordis 上下文
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-qq-console', order: 60 },
          ConsoleTrigger,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
