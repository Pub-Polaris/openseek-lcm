/**
 * The settings page: which checkout this plugin is running from.
 *
 * The desktop profile links this repository, so the branch in the working tree *is*
 * the installed code. The page cannot read git itself, so it asks the Host's
 * package-private route (`GET` reports, `POST` moves) -- the same split the other
 * hand-written settings pages in this deployment use.
 *
 * Switching never takes effect in place: the Cordis loader keeps the module
 * generation it first imported, so the page says so instead of pretending.
 */
window.__ModuleLoader__.load({
  id: 'openseek-lcm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ROUTE = '/openseek-lcm/source';
    const NS = 'openseek-lcm-source';

    const DICT = {
      en: {
        title: 'Source',
        hint: 'Which checkout this plugin runs from.',
        current: 'Current',
        restart: 'Switched. Restart DSH for it to take effect.',
        loading: 'Reading the checkout…',
        unavailable: 'Not running from a checkout, so there is nothing to switch.',
        failed: 'Could not switch.',
        uncommitted: 'uncommitted',
      },
      zh: {
        title: '版本来源',
        hint: '这个插件当前从哪份代码运行。',
        current: '当前',
        restart: '已切换。重启 DSH 后生效。',
        loading: '正在读取检出…',
        unavailable: '不是在源码检出上运行，没有可切换的东西。',
        failed: '切换失败。',
        uncommitted: '项未提交',
      },
    };

    const STYLE = {
      page: { display: 'grid', gap: 10, maxWidth: 560, paddingTop: 4 },
      hint: { margin: 0, opacity: 0.65, fontSize: 13 },
      now: { font: '13px ui-monospace, SFMono-Regular, Menlo, monospace' },
      list: { display: 'grid', gap: 6 },
      row: {
        display: 'grid',
        gap: 2,
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      rowActive: { borderColor: 'currentColor', cursor: 'default' },
      rowBusy: { opacity: 0.55, cursor: 'progress' },
      name: { font: '600 13px ui-monospace, SFMono-Regular, Menlo, monospace' },
      summary: { opacity: 0.7, fontSize: 12 },
      note: { margin: 0, fontSize: 12 },
      failure: { margin: 0, fontSize: 12, color: '#c0392b' },
    };

    let translate = function (key) {
      return key;
    };

    function SourcePage() {
      const t = translate;
      const [state, setState] = React.useState({ phase: 'loading' });

      async function reload() {
        const response = await fetch(ROUTE, { headers: { accept: 'application/json' } });
        return response.json();
      }

      React.useEffect(function () {
        let alive = true;
        reload()
          .then(function (source) {
            if (!alive) return;
            setState(source && source.ok
              ? { phase: 'ready', source: source, busy: null, failure: null, switched: false }
              : { phase: 'unavailable' });
          })
          .catch(function () {
            if (alive) setState({ phase: 'unavailable' });
          });
        return function () {
          alive = false;
        };
      }, []);

      async function pick(branch) {
        setState(function (previous) {
          return Object.assign({}, previous, { busy: branch, failure: null });
        });
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ branch: branch }),
          });
          const result = await response.json();
          if (!result || result.ok !== true) {
            setState(function (previous) {
              return Object.assign({}, previous, {
                busy: null,
                failure: (result && result.reason) || t('failed'),
              });
            });
            return;
          }
          // The route reads the working tree live, so a reload already shows the
          // branch the files were moved to.
          const source = await reload();
          setState({ phase: 'ready', source: source, busy: null, failure: null, switched: true });
        } catch (error) {
          setState(function (previous) {
            return Object.assign({}, previous, {
              busy: null,
              failure: String((error && error.message) || error),
            });
          });
        }
      }

      if (state.phase === 'loading') {
        return h('p', { style: STYLE.hint }, t('loading'));
      }
      if (state.phase !== 'ready') {
        return h('p', { style: STYLE.hint }, t('unavailable'));
      }

      const source = state.source;
      const branches = Array.isArray(source.branches) ? source.branches : [];
      const dirty = Array.isArray(source.dirty) ? source.dirty.length : 0;
      const status = `${t('current')}: ${source.branch} @ ${source.sha}${dirty > 0 ? ` · ${dirty} ${t('uncommitted')}` : ''}`;

      return h(
        'div',
        { style: STYLE.page },
        h('h2', { style: { margin: 0, fontSize: 15 } }, t('title')),
        h('p', { style: STYLE.hint }, t('hint')),
        h('div', { style: STYLE.now }, status),
        h(
          'div',
          { style: STYLE.list },
          branches.map(function (entry) {
            const active = entry.name === source.branch;
            const busy = state.busy === entry.name;
            return h(
              'button',
              {
                key: entry.name,
                type: 'button',
                disabled: active || busy,
                style: Object.assign({}, STYLE.row, active ? STYLE.rowActive : null, busy ? STYLE.rowBusy : null),
                onClick: function () {
                  pick(entry.name);
                },
              },
              h('span', { style: STYLE.name }, active ? `${entry.name}  ✓` : entry.name),
              h('span', { style: STYLE.summary }, entry.summary),
            );
          }),
        ),
        state.switched ? h('p', { style: STYLE.note }, t('restart')) : null,
        state.failure ? h('p', { style: STYLE.failure }, state.failure) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register(NS, 'en', DICT.en);
          ctx.locale.register(NS, 'zh', DICT.zh);
          translate = ctx.locale.bind(NS);
        } catch {
          // The page still works with key-shaped text rather than failing to mount.
        }

        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'openseek-lcm-source',
                order: 70,
                label: function () {
                  return translate('title');
                },
              },
              SourcePage,
            );
          });
        }, 'openseek-lcm: source settings page');
      },
    };
  },
});
