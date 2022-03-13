import { noop } from 'lodash';
import type { ParcelConfigObject } from 'single-spa';
import { mountRootParcel, registerApplication, start as startSingleSpa } from 'single-spa';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  LoadableApp,
  MicroApp,
  ObjectType,
  RegistrableApp,
} from './interfaces';
import type { ParcelConfigObjectGetter } from './loader';
import { loadApp } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainerXPath, toArray } from './utils';

let microApps: Array<RegistrableApp<Record<string, unknown>>> = [];

export let frameworkConfiguration: FrameworkConfiguration = {};

let started = false;
const defaultUrlRerouteOnly = true;

const frameworkStartedDefer = new Deferred<void>();

const autoDowngradeForLowVersionBrowser = (configuration: FrameworkConfiguration): FrameworkConfiguration => {
  const { sandbox, singular } = configuration;
  if (sandbox) {
    if (!window.Proxy) {
      console.warn('[qiankun] Miss window.Proxy, proxySandbox will degenerate into snapshotSandbox');

      if (singular === false) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        );
      }

      return { ...configuration, sandbox: typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true } };
    }
  }

  return configuration;
};

// 注册微应用api
/**
 *
 * @param apps 微应用数组
 * @param lifeCycles 用户自定义的生命周期
 */
export function registerMicroApps<T extends ObjectType>(
  apps: Array<RegistrableApp<T>>,
  lifeCycles?: FrameworkLifeCycles<T>,
) {
  // Each app only needs to be registered once
  // 过滤出未注册的微应用
  // Array.prototype.some()，方法测试数组中是不是至少有1个元素通过了被提供的函数测试，返回一个布尔值
  const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));

  microApps = [...microApps, ...unregisteredApps];

  unregisteredApps.forEach((app) => {
    const { name, activeRule, loader = noop, props, ...appConfig } = app;

    // single-sap 应用注册
    registerApplication({
      name,
      app: async () => {
        loader(true);
        await frameworkStartedDefer.promise; // ???

        // !!! 重要，组装加载微应用配置项
        const { mount, ...otherMicroAppConfigs } = (
          await loadApp({ name, props, ...appConfig }, frameworkConfiguration, lifeCycles)
        )();

        return {
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        };
      },
      /**
       * 可以是一个路径前缀，它将匹配每个以该路径开头的URL，也可以是激活函数(如简单参数中所述)或一个数组两者都包含在内。
       * 如果任何条件为真，则保留应用活动。路径前缀也接受动态值(以':'开头)，因为有些路径会接收url参数，但仍然应该激活您的应用。
       */
      activeWhen: activeRule,
      /**
       * 在生命周期钩子函数执行时会被作为参数传入
       */
      customProps: props,
    });
  });
}

const appConfigPromiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>();
const containerMicroAppsMap = new Map<string, MicroApp[]>();

/**
 * 手动加载应用
 * @param app
 * @param configuration
 * @param lifeCycles
 * @returns
 */
export function loadMicroApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration & { autoStart?: boolean },
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const { props, name } = app;

  const container = 'container' in app ? app.container : undefined;
  // Must compute the container xpath at beginning to keep it consist around app running
  // If we compute it every time, the container dom structure most probably been changed and result in a different xpath value
  const containerXPath = getContainerXPath(container);
  const appContainerXPathKey = `${name}-${containerXPath}`;

  let microApp: MicroApp;
  const wrapParcelConfigForRemount = (config: ParcelConfigObject): ParcelConfigObject => {
    let microAppConfig = config;
    if (container) {
      if (containerXPath) {
        const containerMicroApps = containerMicroAppsMap.get(appContainerXPathKey);
        if (containerMicroApps?.length) {
          const mount = [
            async () => {
              // While there are multiple micro apps mounted on the same container, we must wait until the prev instances all had unmounted
              // Otherwise it will lead some concurrent issues
              const prevLoadMicroApps = containerMicroApps.slice(0, containerMicroApps.indexOf(microApp));
              const prevLoadMicroAppsWhichNotBroken = prevLoadMicroApps.filter(
                (v) => v.getStatus() !== 'LOAD_ERROR' && v.getStatus() !== 'SKIP_BECAUSE_BROKEN',
              );
              await Promise.all(prevLoadMicroAppsWhichNotBroken.map((v) => v.unmountPromise));
            },
            ...toArray(microAppConfig.mount),
          ];

          microAppConfig = {
            ...config,
            mount,
          };
        }
      }
    }

    return {
      ...microAppConfig,
      // empty bootstrap hook which should not run twice while it calling from cached micro app
      bootstrap: () => Promise.resolve(),
    };
  };

  /**
   * using name + container xpath as the micro app instance id,
   * it means if you rendering a micro app to a dom which have been rendered before,
   * the micro app would not load and evaluate its lifecycles again
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const userConfiguration = autoDowngradeForLowVersionBrowser(
      configuration ?? { ...frameworkConfiguration, singular: false },
    );
    const { $$cacheLifecycleByAppName } = userConfiguration;

    if (container) {
      // using appName as cache for internal experimental scenario
      if ($$cacheLifecycleByAppName) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }

      if (containerXPath) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(appContainerXPathKey);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }
    }

    const parcelConfigObjectGetterPromise = loadApp(app, userConfiguration, lifeCycles);

    if (container) {
      if ($$cacheLifecycleByAppName) {
        appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);
      } else if (containerXPath) appConfigPromiseGetterMap.set(appContainerXPathKey, parcelConfigObjectGetterPromise);
    }

    return (await parcelConfigObjectGetterPromise)(container);
  };

  if (!started && configuration?.autoStart !== false) {
    // We need to invoke start method of single-spa as the popstate event should be dispatched while the main app calling pushState/replaceState automatically,
    // but in single-spa it will check the start status before it dispatch popstate
    // see https://github.com/single-spa/single-spa/blob/f28b5963be1484583a072c8145ac0b5a28d91235/src/navigation/navigation-events.js#L101
    // ref https://github.com/umijs/qiankun/pull/1071
    startSingleSpa({ urlRerouteOnly: frameworkConfiguration.urlRerouteOnly ?? defaultUrlRerouteOnly });
  }

  microApp = mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });

  if (container) {
    if (containerXPath) {
      // Store the microApps which they mounted on the same container
      const microAppsRef = containerMicroAppsMap.get(appContainerXPathKey) || [];
      microAppsRef.push(microApp);
      containerMicroAppsMap.set(appContainerXPathKey, microAppsRef);

      const cleanup = () => {
        const index = microAppsRef.indexOf(microApp);
        microAppsRef.splice(index, 1);
        // @ts-ignore
        microApp = null;
      };

      // gc after unmount
      microApp.unmountPromise.then(cleanup).catch(cleanup);
    }
  }

  return microApp;
}

export function start(opts: FrameworkConfiguration = {}) {
  frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts };
  const {
    prefetch,
    sandbox,
    singular,
    urlRerouteOnly = defaultUrlRerouteOnly,
    ...importEntryOpts
  } = frameworkConfiguration;

  if (prefetch) { // 是否预加载资源
    doPrefetchStrategy(microApps, prefetch, importEntryOpts);
  }

  frameworkConfiguration = autoDowngradeForLowVersionBrowser(frameworkConfiguration);

  // 启动应用
  // https://zh-hans.single-spa.js.org/docs/api#start
  /**
   * urlRerouteOnly: 默认为 false 的布尔值。
   * 如果设置为 true，除非客户端路由已更改，否则调用history.pushState()并history.replaceState()不会触发单个 spa 重新路由。
   * 在某些情况下，将此设置为 true 可能会更好地提高性能。有关更多信息，请阅读文档
   */
  startSingleSpa({ urlRerouteOnly });
  started = true;

  frameworkStartedDefer.resolve();
}
