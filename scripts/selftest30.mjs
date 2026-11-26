/**
 * selftest30：client 组件能不能「渲染」——用假 React 跑一遍 apply + 组件函数。
 *
 * 2026-11-24 主人撞到：右上角「记忆」按钮点了没反应。原因是组件里提前引用了还没定义的
 * useCallback 变量（TDZ），渲染时抛 ReferenceError，整块面板消失。node --check 查不出这种。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

// ---- 假宿主：window.__ModuleLoader__.load 拿包，require('react') 给最小实现 ----
let loaded = null;
const fakeElement = (type, props, children) => ({ type, props: props ?? {}, children });
const fakeReact = {
  createElement: (type, props, ...children) => fakeElement(type, props, children),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
};
globalThis.window = {
  __ModuleLoader__: {
    load: (mod) => {
      loaded = mod;
    },
  },
};
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require: ${name}`);
};

// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, fakeRequire);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

await check('bundle 能加载出 factory', () => {
  assert.ok(loaded, '没有调用 window.__ModuleLoader__.load');
  assert.equal(typeof loaded.factory, 'function');
});

const registrations = [];
const ctx = {
  // 可选依赖：apply 里用 ctx.inject([...], cb) 挂 webServer / betterSidebar
  inject: (deps, fn) => fn(ctx),
  get: (name) =>
    ({
      betterSidebar: { registerTab: () => () => {} },
    })[name],
  effect: (fn) => {
    const cleanup = fn();
    return typeof cleanup === 'function' ? cleanup : () => {};
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (spec, component) => {
      registrations.push({ spec, component });
      return () => {};
    },
  },
};

await check('apply 能跑通并注册 main / sidebar.panellist / shell.overlay', () => {
  const mod = loaded.factory(fakeRequire);
  assert.equal(typeof mod.apply, 'function');
  mod.apply(ctx);
  const names = registrations.map((item) => item.spec.name);
  assert.ok(names.includes('main'), `缺 main：${names.join(',')}`);
  assert.ok(names.includes('sidebar.panellist'), `缺 sidebar.panellist：${names.join(',')}`);
  assert.ok(names.includes('shell.overlay'), `缺 shell.overlay：${names.join(',')}`);
});

await check('记忆面板组件渲染不抛错', () => {
  const panel = registrations.find((item) => item.spec.id === 'memory-yuan-panel');
  assert.ok(panel, '没注册 memory-yuan-panel');
  assert.equal(typeof panel.component, 'function');
  const tree = panel.component({});
  assert.ok(tree === null || typeof tree === 'object', '组件返回了奇怪的东西');
});

await check('星图组件渲染不抛错', () => {
  const graph = registrations.find((item) => item.component && item.component.name === 'GraphTab');
  assert.ok(graph, '没注册 GraphTab');
  const tree = graph.component({});
  assert.ok(tree === null || typeof tree === 'object');
});

await check('左栏图标渲染不抛错', () => {
  const icon = registrations.find(
    (item) => item.spec.name === 'sidebar.panellist' && typeof item.component === 'function',
  );
  assert.ok(icon);
  const tree = icon.component({ size: 18 });
  assert.ok(tree && typeof tree === 'object');
});

console.log(`\nselftest30：${passed} 通过，${failures.length} 失败`);
if (failures.length) process.exitCode = 1;
