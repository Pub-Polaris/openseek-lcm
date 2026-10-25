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
        title: 'openseek-lcm branches',
        hint: 'Which checkout this plugin runs from.',
        current: 'Current',
        restart: 'Applied. Restart DSH for it to take effect.',
        loading: 'Reading the checkout…',
        unavailable: 'Not running from a checkout, so there is nothing to switch.',
        failed: 'Could not apply.',
        uncommitted: 'uncommitted',
        source: 'Source',
        localMode: 'Local checkout',
        githubMode: 'GitHub branch',
        localOnly: 'No local checkout here, so only the GitHub branch can be used.',
        applying: 'Applying…',
        installs: 'installs from',
      },
      zh: {
        title: 'openseek-lcm版本分支',
        hint: '这个插件当前从哪份代码运行。',
        current: '当前',
        restart: '已应用。重启 DSH 后生效。',
        loading: '正在读取检出…',
        unavailable: '不是在源码检出上运行，没有可切换的东西。',
        failed: '应用失败。',
        uncommitted: '项未提交',
        source: '安装来源',
        localMode: '本地仓库',
        githubMode: 'GitHub 分支',
        localOnly: '本机没有这个仓库的检出，只能用 GitHub 分支。',
        applying: '正在应用…',
        installs: '来源',
      },
    };

    const STYLE = {
      page: { display: 'grid', gap: 10, maxWidth: 560, paddingTop: 4 },
      hint: { margin: 0, opacity: 0.65, fontSize: 13 },
      now: { font: '13px ui-monospace, SFMono-Regular, Menlo, monospace' },
      modes: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      mode: {
        padding: '5px 10px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      modeActive: { borderColor: 'currentColor', fontWeight: 600 },
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

    // Locale lookup can miss (an active locale whose fallback chain never reaches
    // our registered tags); then the registry hands back the raw key. Fall back to
    // the Chinese dictionary so the UI never shows `title` / `unavailable`.
    const FALLBACK_DICT = DICT.zh;
    function safeTranslate(key) {
      const text = translate(key);
      if (text !== key) return text;
      return FALLBACK_DICT[key] || key;
    }

    function SourcePage() {
      const t = safeTranslate;
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

      async function apply(mode, branch) {
        setState(function (previous) {
          return Object.assign({}, previous, { busy: branch, failure: null });
        });
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: mode, branch: branch }),
          });
          const result = await response.json();
          if (!result || result.ok !== true) {
            setState(function (previous) {
              return Object.assign({}, previous, {
                busy: null,
                failure:
                  (result && result.reason) ||
                  (result && result.change && result.change.error && result.change.error.code) ||
                  t('failed'),
              });
            });
            return;
          }
          // The route reads the checkout live, so a reload already reflects it; a
          // GitHub install reports `restart-required` and the note covers that.
          const source = await reload();
          setState({ phase: 'ready', source: source, busy: null, failure: null, applied: true, mode: mode });
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
      const modes = Array.isArray(source.modes) ? source.modes : [];
      const dirty = Array.isArray(source.dirty) ? source.dirty.length : 0;
      const checkout = source.checkout === true;
      const mode = state.mode || (source.mode === 'github' ? 'github' : 'local');
      const where = checkout
        ? `${source.branch} @ ${source.sha}${dirty > 0 ? ` · ${dirty} ${t('uncommitted')}` : ''}`
        : String(source.spec || source.reason || '');

      return h(
        'div',
        { style: STYLE.page },
        h('h2', { style: { margin: 0, fontSize: 15 } }, t('title')),
        h('p', { style: STYLE.hint }, t('hint')),
        h('div', { style: STYLE.now }, `${t('current')}: ${where}`),
        source.spec ? h('p', { style: STYLE.hint }, `${t('installs')}: ${source.spec}`) : null,
        h(
          'div',
          { style: STYLE.modes },
          modes.map(function (entry) {
            const selected = entry.id === mode;
            const disabled = entry.id === 'local' && !checkout;
            return h(
              'button',
              {
                key: entry.id,
                type: 'button',
                disabled: disabled,
                title: entry.summary,
                style: Object.assign(
                  {},
                  STYLE.mode,
                  selected ? STYLE.modeActive : null,
                  disabled ? STYLE.rowBusy : null,
                ),
                onClick: function () {
                  setState(function (previous) {
                    return Object.assign({}, previous, { mode: entry.id, failure: null });
                  });
                },
              },
              entry.id === 'local' ? t('localMode') : t('githubMode'),
            );
          }),
        ),
        !checkout ? h('p', { style: STYLE.hint }, t('localOnly')) : null,
        h(
          'div',
          { style: STYLE.list },
          branches.map(function (entry) {
            const active = checkout && entry.name === source.branch;
            const busy = state.busy === entry.name;
            return h(
              'button',
              {
                key: entry.name,
                type: 'button',
                disabled: busy,
                style: Object.assign({}, STYLE.row, active ? STYLE.rowActive : null, busy ? STYLE.rowBusy : null),
                onClick: function () {
                  apply(mode, entry.name);
                },
              },
              h('span', { style: STYLE.name }, active ? `${entry.name}  ✓` : entry.name),
              h('span', { style: STYLE.summary }, entry.summary),
            );
          }),
        ),
        state.busy ? h('p', { style: STYLE.note }, t('applying')) : null,
        state.applied ? h('p', { style: STYLE.note }, t('restart')) : null,
        state.failure ? h('p', { style: STYLE.failure }, state.failure) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          // The shell's active locale is a BCP-47 tag (`zh-CN`, `en-US`, …);
          // registering only the bare `zh`/`en` left `bind` with no match and the
          // nav rendered the raw keys ("title"). Register the aliases too.
          [
            ['en', DICT.en],
            ['en-US', DICT.en],
            ['zh', DICT.zh],
            ['zh-CN', DICT.zh],
            ['zh-Hans', DICT.zh],
            ['zh-Hans-CN', DICT.zh],
          ].forEach(function (entry) {
            ctx.locale.register(NS, entry[0], entry[1]);
          });
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
                  return safeTranslate('title');
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
