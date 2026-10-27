/**
 * 鱼书 浏览器半（客户端插件）。
 *
 * 在 DSH 的「设置」里增加一个「鱼书」分区，内嵌插件自带的控制台页面
 * （同源 /dsh-qq，登录/凭据/配置/人设/表情/诊断都在里面）。
 *
 * 为什么是手写的：鱼书的立场是零依赖、零构建——这个文件就是浏览器直接执行的
 * 动态插件包（window.__ModuleLoader__.load 格式，由 DSH 的 clientModules 服务按
 * package.json 的 dsh.client 声明发现并下发），不需要 tsdown/React 构建链。
 * 组件用 require('react') 的 createElement，渲染进 settings.section 插槽，
 * 不再占用左侧栏底部的动作位。
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
    const TITLE = '鱼书'

    /** 设置页里的「鱼书」分区：标题 + 新标签入口 + 内嵌控制台。 */
    function FishbookSection() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            minHeight: 0,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            },
          },
          h(
            'div',
            null,
            h('div', { style: { fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, TITLE),
            h('div', { style: { marginTop: '2px', fontSize: '12px', opacity: 0.65 } }, 'QQ 通道控制台 · 登录、配置、人设、表情与诊断'),
          ),
          h(
            'a',
            {
              href: CONSOLE_PATH,
              target: '_blank',
              rel: 'noreferrer',
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '12px',
                textDecoration: 'underline',
                whiteSpace: 'nowrap',
              },
            },
            '在新标签打开',
          ),
        ),
        h('iframe', {
          src: CONSOLE_PATH,
          title: '鱼书控制台',
          style: {
            display: 'block',
            width: '100%',
            height: 'min(760px, calc(100vh - 220px))',
            minHeight: '520px',
            border: '0',
            borderRadius: '12px',
            background: '#fff',
          },
        }),
      )
    }

    /**
     * 注册到设置分区。id 保持 dsh-qq，避免热重载/书签键位迁移。
     * @param {object} ctx - 客户端 Cordis 上下文
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'dsh-qq-console', order: 60, label: () => TITLE },
          FishbookSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
