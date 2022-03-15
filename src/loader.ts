/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import type { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  HTMLContentRender,
  LifeCycleFn,
  LoadableApp,
  ObjectType,
} from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import {
  Deferred,
  genAppInstanceIdByName,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceGetEntriesByName,
  performanceMark,
  performanceMeasure,
  toArray,
  validateExportLifecycle,
} from './utils';

function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new QiankunError(msg);
    }

    throw new QiankunError('element not existed!');
  }
}

function execHooksChain<T extends ObjectType>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

async function validateSingularMode<T extends ObjectType>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

// @ts-ignore
const supportShadowDOM = document.head.attachShadow || document.head.createShadowRoot;

function createElement(
  appContent: string,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  appInstanceId: string,
): HTMLElement {
  // 创建一个 div 节点，将 appContent 插入到这个节点中
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  // appContent always wrapped with a singular div
  // so we can get the first child as the app element
  const appElement = containerElement.firstChild as HTMLElement;

  // 如果强制样式隔离，则将 appElement 插入到一个 shadow dom 中
  // 相关参考资料: https://developer.mozilla.org/zh-CN/docs/Web/API/Element/shadowRoot
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      if (appElement.attachShadow) {
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // createShadowRoot was proposed in initial spec, which has then been deprecated
        shadow = (appElement as any).createShadowRoot();
      }
      shadow.innerHTML = innerHTML;
    }
  }

  // 如果样式隔离
  if (scopedCSS) {
    // 获取 data-qiankun 属性的节点
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) { // 如果没有则设置
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appInstanceId);
    }

    // 过去该节点下所有 css style
    const styleNodes = appElement.querySelectorAll('style') || [];

    // 循环遍历添加前缀
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appInstanceId);
    });
  }

  return appElement;
}

/** generate app wrapper dom getter */
function getAppWrapperGetter(
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');

      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(appWrapper, `Wrapper element for ${appInstanceId} is not existed!`);
      return appWrapper!;
    }

    const element = elementGetter();
    assertElementExist(element, `Wrapper element for ${appInstanceId} is not existed!`);

    if (strictStyleIsolation && supportShadowDOM) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

/**
 * Get the render function
 * If the legacy render function is provide, used as it, otherwise we will insert the app element to target container by qiankun
 * @param appInstanceId
 * @param appContent
 * @param legacyRender
 */
function getRender(appInstanceId: string, appContent: string, legacyRender?: HTMLContentRender) {
  const render: ElementRender = ({ element, loading, container }, phase) => {
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.error(
          '[qiankun] Custom rendering function is deprecated and will be removed in 3.0, you can use the container element setting instead!',
        );
      }

      return legacyRender({ loading, appContent: element ? appContent : '' });
    }

    const containerElement = getContainer(container!);

    // The container might have be removed after micro app unmounted.
    // Such as the micro app unmount lifecycle called by a react componentWillUnmount lifecycle, after micro app unmounted, the react component might also be removed
    if (phase !== 'unmounted') { // 应用加载状态
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `Target container with ${container} not existed while ${appInstanceId} ${phase}!`;

          case 'mounted':
            return `Target container with ${container} not existed after ${appInstanceId} ${phase}!`;

          default:
            return `Target container with ${container} not existed while ${appInstanceId} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }

    if (containerElement && !containerElement.contains(element)) {
      // clear the container
      while (containerElement!.firstChild) { // 从容器中移除
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // append the element to container if it exist
      // 将 element 插入到 containerElement 中，即创建好的 element 到 通过 container 找到的容器中

      // 例如 <div id="subapp-viewport"><div id="__qiankun_microapp_wrapper_for_vue__" data-name="vue" data-version="2.6.3" data-qiankun="vue">......</div>
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

function getLifecyclesFromExports(
  scriptExports: LifeCycles<any>,
  appName: string,
  global: WindowProxy,
  globalLatestSetProp?: PropertyKey | null,
) {
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // fallback to sandbox latest set property if it had
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // fallback to global variable who named with ${appName} while module exports not found
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

/**
 *
 * @param app 加载的 APP 对象
 * @param configuration 加载的 APP 配置
 * @param lifeCycles 加载的 APP 生命周期，用户自定义的生命周期
 * @returns
 */
export async function loadApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  //  entry: '//localhost:7101' 微应用的入口
  const { entry, name: appName } = app;
  const appInstanceId = genAppInstanceIdByName(appName); // 获取微应用实例

  const markName = `[qiankun] App ${appInstanceId} Loading`;
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  const {
    singular = false, // 是否单实例场景
    sandbox = true, // 是否沙箱隔离
    excludeAssetFilter, // 可选，指定部分特殊的动态加载的微应用资源（css/js) 不被 qiankun 劫持处理。
    globalContext = window,
    ...importEntryOpts // ??? 走哪里来？
  } = configuration; // 基本配置参数

  // get the entry html content and script executor
  // html entry，需要再研究 import-html-entry 包
  // 返回模板，立即执行脚本，和资源路径
  const { template, execScripts, assetPublicPath } = await importEntry(entry, importEntryOpts);

  // as single-spa load and bootstrap new app parallel with other apps unmounting
  // (see https://github.com/CanopyTax/single-spa/blob/master/src/navigation/reroute.js#L74)
  // we need wait to load the app until all apps are finishing unmount in singular mode
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }

  // 获取应用容器，例如: <div id="__qiankun_microapp_wrapper_for_vue__" data-name="vue" data-version="2.6.3">
  const appContent = getDefaultTplWrapper(appInstanceId)(template);

  // 当配置为 { strictStyleIsolation: true } 时表示开启严格的样式隔离模式。
  // 这种模式下 qiankun 会为每个微应用的容器包裹上一个 shadow dom 节点，从而确保微应用的样式不会对全局造成影响
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;

  if (process.env.NODE_ENV === 'development' && strictStyleIsolation) {
    console.warn(
      "[qiankun] strictStyleIsolation configuration will be removed in 3.0, pls don't depend on it or use experimentalStyleIsolation instead!",
    );
  }

  // 是否启用隔离 CSS
  const scopedCSS = isEnableScopedCSS(sandbox);

  // 创建应用容器节点
  let initialAppWrapperElement: HTMLElement | null = createElement(
    appContent,
    strictStyleIsolation, // 是否强制隔离
    scopedCSS, // 是否隔离样式
    appInstanceId, // 应用实例ID
  );

  // container - string | HTMLElement - 必选，微应用的容器节点的选择器或者 Element 实例。
  // 如container: '#root' 或 container: document.querySelector('#root')。
  const initialContainer = 'container' in app ? app.container : undefined;
  const legacyRender = 'render' in app ? app.render : undefined;

  const render = getRender(appInstanceId, appContent, legacyRender);

  // 第一次加载设置应用可见区域 dom 结构
  // 确保每次应用加载前容器 dom 结构已经设置完毕，首次为加载状态
  render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');

  // 获取 app 包装器
  const initialAppWrapperGetter = getAppWrapperGetter(
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    scopedCSS,
    () => initialAppWrapperElement,
  );

  // windows 全局对象
  let global = globalContext;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  let sandboxContainer; //  沙盒容器
  if (sandbox) { // 如果有沙盒对象

    // 创建沙盒容器
    sandboxContainer = createSandboxContainer(
      appInstanceId, // 应用实例ID
      // FIXME should use a strict sandbox logic while remount, see https://github.com/umijs/qiankun/issues/518
      initialAppWrapperGetter,
      scopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
      global, // 全局对象
    );
    // !!!重要，用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window; // 代理时，有这句：this.proxy = proxy，所以在 instance 上可以获取到 proxy 对象
    mountSandbox = sandboxContainer.mount; // 启动沙箱方法
    unmountSandbox = sandboxContainer.unmount; // 关闭沙箱方法
  }

  // 合并用户 registerMicroApp 时自定义的生命周期勾子 和 内部默认定义的勾子
  // 定义全局上下文绑定值 __INJECTED_PUBLIC_PATH_BY_QIANKUN__ 即运行时的 assets public path
  // https://webpack.docschina.org/guides/public-path/#on-the-fly
  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = [],
  } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

  // 执行 beforeLoad 勾子，并返回 app, global 数据
  await execHooksChain(toArray(beforeLoad), app, global);

  // get the lifecycle hooks from module exports
  // 从加载的脚本中获取生命周期钩子
  // 用新的沙箱上下文执行脚本，并返回脚本的返回值
  const scriptExports: any = await execScripts(global, sandbox && !useLooseSandbox);
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    sandboxContainer?.instance?.latestSetProp,
  );


  // 初始化qiankun 全局数据通信对象
  const { onGlobalStateChange, setGlobalState, offGlobalStateChange }: Record<string, CallableFunction> =
    getMicroAppStateActions(appInstanceId);

  // FIXME temporary way
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null;
    let appWrapperGetter: ReturnType<typeof getAppWrapperGetter>;

    // 包装应用挂载参数，用于 single-spa 挂载应用
    // single-spa docs: https://zh-hans.single-spa.js.org/docs/parcels-api/#mountparcel
    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performanceGetEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (marks && !marks.length) {
              performanceMark(markName);
            }
          }
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) { // 验证是否时单应用实例模式
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // initial wrapper element before app mount/remount
        async () => {
          appWrapperElement = initialAppWrapperElement;
          appWrapperGetter = getAppWrapperGetter(
            appInstanceId,
            !!legacyRender,
            strictStyleIsolation,
            scopedCSS,
            () => appWrapperElement,
          );
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // element will be destroyed after unmounted, we need to recreate it if it not exist
            // or we try to remount into a new container
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }

          render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
        },
        mountSandbox, // 启动沙箱
        // exec the chain after rendering to keep the behavior with beforeLoad
        async () => execHooksChain(toArray(beforeMount), app, global), // 准备开始加载 执行 beforeMount 勾子
        // 应用加载成功，返回应用实例，包含 GlobalState，子应用可以在 mount 生命周期中获取到，并执行相应的处理逻辑
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),
        // finish loading after app mounted
        async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
        async () => execHooksChain(toArray(afterMount), app, global), // 已经加载完，触发 afterMount 勾子
        // initialize the unmount defer after app mounted and resolve the defer after it unmounted
        async () => {
          if (await validateSingularMode(singular, app)) { // 验证是否时单应用实例模式
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        async () => execHooksChain(toArray(beforeUnmount), app, global), // 准备开始卸载 执行 beforeUnmount 勾子
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        unmountSandbox, // 关闭沙箱
        async () => execHooksChain(toArray(afterUnmount), app, global), // 关闭后触发 afterUnmount 勾子
        async () => {
          render({ element: null, loading: false, container: remountContainer }, 'unmounted'); // 渲染卸载完成  将节点从 dom 中移除
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) { // 验证是否时单实例应用
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}
