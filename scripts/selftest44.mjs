/**
 * selftest44：星图交互（第 4 项）——拖拽平移 / 双击复位 / 右键菜单的结构检查。
 *
 * client.js 是在浏览器里跑的 JSX 手写版，node --check 只能查语法；
 * 这里用假 React 把 GraphTab 渲染一遍，确认：
 *  ① 能渲染不抛错（TDZ 这类错误会在这里炸）
 *  ② canvas 上挂了 onMouseDown / onDoubleClick / onContextMenu
 *  ③ 三个处理器被调到时不会抛异常（canvasRef 为空时 pick 返回 null 是正常路径）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

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
  innerWidth: 1200,
  innerHeight: 800,
};
// 浏览器全局：拖动/双击后要重绘，测试里同步执行一次（canvasRef 为空时 draw 会早退）
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};
globalThis.cancelAnimationFrame = () => {};
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require: ${name}`);
};

// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, fakeRequire);

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

const registrations = [];
const ctx = {
  inject: (deps, fn) => fn(ctx),
  get: () => undefined,
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
const mod = loaded.factory(fakeRequire);
mod.apply(ctx);

const tree = () => {
  const main = registrations.find((item) => item.spec.name === 'main');
  assert.ok(main, '没注册 sidebar.panellist 的 main');
  return main.component({});
};

// 在假元素树里找 canvas
function findCanvas(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'canvas') return node;
  for (const child of node.children ?? []) {
    const hit = findCanvas(child);
    if (hit) return hit;
  }
  return null;
}

await check('GraphTab 能渲染（假 React，无 TDZ）', () => {
  const element = tree();
  assert.equal(element.type, 'div');
  const canvas = findCanvas(element);
  assert.ok(canvas, '没渲染出 canvas');
});

await check('canvas 挂了拖拽 / 双击 / 右键处理器', () => {
  const canvas = findCanvas(tree());
  assert.equal(typeof canvas.props.onMouseDown, 'function');
  assert.equal(typeof canvas.props.onDoubleClick, 'function');
  assert.equal(typeof canvas.props.onContextMenu, 'function');
  assert.equal(typeof canvas.props.onMouseMove, 'function');
  assert.equal(typeof canvas.props.onClick, 'function');
});

await check('右键处理器被调时不抛（canvas 为空 → 菜单不弹）', () => {
  const canvas = findCanvas(tree());
  let prevented = false;
  canvas.props.onContextMenu({ clientX: 10, clientY: 10, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
});

await check('按下 / 双击 / 移动处理器被调时不抛', () => {
  const canvas = findCanvas(tree());
  canvas.props.onMouseDown({ button: 0, clientX: 5, clientY: 5 });
  canvas.props.onMouseMove({ clientX: 8, clientY: 9 });
  canvas.props.onDoubleClick({});
  canvas.props.onClick({ clientX: 5, clientY: 5 });
});

await check('光标：空画布上是 grab（拖得动）', () => {
  const canvas = findCanvas(tree());
  assert.equal(canvas.props.style.cursor, 'grab');
});

await check('图例提示写了拖拽 / 双击 / 右键', () => {
  const text = JSON.stringify(tree());
  assert.match(text, /拖拽平移/);
  assert.match(text, /双击复位/);
  assert.match(text, /右键菜单/);
});

console.log(`\n${pass} 通过，${failures.length} 失败`);
if (failures.length) process.exit(1);
