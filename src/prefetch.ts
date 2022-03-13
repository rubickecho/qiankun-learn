/**
 * @author Kuitos
 * @since 2019-02-26
 */

import type { Entry, ImportEntryOpts } from 'import-html-entry';
import { importEntry } from 'import-html-entry';
import { isFunction } from 'lodash';
import { getAppStatus, getMountedApps, NOT_LOADED } from 'single-spa';
import type { AppMetadata, PrefetchStrategy } from './interfaces';

declare global {
  interface NetworkInformation {
    saveData: boolean;
    effectiveType: string;
  }
}

// RIC and shim for browsers setTimeout() without it
const requestIdleCallback =
  window.requestIdleCallback ||
  function requestIdleCallback(cb: CallableFunction) {
    const start = Date.now();
    return setTimeout(() => {
      cb({
        didTimeout: false,
        timeRemaining() {
          return Math.max(0, 50 - (Date.now() - start));
        },
      });
    }, 1);
  };

const isSlowNetwork = navigator.connection
  ? navigator.connection.saveData ||
    (navigator.connection.type !== 'wifi' &&
      navigator.connection.type !== 'ethernet' &&
      /([23])g/.test(navigator.connection.effectiveType))
  : false;

/**
 * prefetch assets, do nothing while in mobile network
  * 预加载资源，不在移动端执行
 * @param entry
 * @param opts
 */
function prefetch(entry: Entry, opts?: ImportEntryOpts): void {
  if (!navigator.onLine || isSlowNetwork) {
    // Don't prefetch if in a slow network or offline
    return;
  }

  requestIdleCallback(async () => {
    // 将获取到的 js脚本和 css脚本预加载
    /**
     * return getEmbedHTML(template, styles, { fetch }).then(embedHTML => ({
				template: embedHTML,
				assetPublicPath,
				getExternalScripts: () => getExternalScripts(scripts, fetch),
				getExternalStyleSheets: () => getExternalStyleSheets(styles, fetch),
				execScripts: (proxy, strictGlobal, execScriptsHooks = {}) => {
					if (!scripts.length) {
						return Promise.resolve();
					}
					return execScripts(entry, scripts, proxy, {
						fetch,
						strictGlobal,
						beforeExec: execScriptsHooks.beforeExec,
						afterExec: execScriptsHooks.afterExec,
					});
				},
			}));
     */
    const { getExternalScripts, getExternalStyleSheets } = await importEntry(entry, opts);
    requestIdleCallback(getExternalStyleSheets); // 异步加载脚本
    requestIdleCallback(getExternalScripts); // 异步加载资源
  });
}

function prefetchAfterFirstMounted(apps: AppMetadata[], opts?: ImportEntryOpts): void {
  // 监听 single-spa:first-mount 钩子，首次加载时
  window.addEventListener('single-spa:first-mount', function listener() {
    const notLoadedApps = apps.filter((app) => getAppStatus(app.name) === NOT_LOADED); // 获取还没有加载过的 apps

    if (process.env.NODE_ENV === 'development') {
      const mountedApps = getMountedApps();
      console.log(`[qiankun] prefetch starting after ${mountedApps} mounted...`, notLoadedApps);
    }

    // 核心方法，prefetch 预加载
    notLoadedApps.forEach(({ entry }) => prefetch(entry, opts)); // 预先加载资源

    window.removeEventListener('single-spa:first-mount', listener); // 移除监听
  });
}

export function prefetchImmediately(apps: AppMetadata[], opts?: ImportEntryOpts): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('[qiankun] prefetch starting for apps...', apps);
  }

  apps.forEach(({ entry }) => prefetch(entry, opts));
}

export function doPrefetchStrategy(
  apps: AppMetadata[],
  prefetchStrategy: PrefetchStrategy,
  importEntryOpts?: ImportEntryOpts, // 参数
) {
  const appsName2Apps = (names: string[]): AppMetadata[] => apps.filter((app) => names.includes(app.name));

  // 如果是数组
  // example: ['app-1', 'app-2']
  if (Array.isArray(prefetchStrategy)) {
    prefetchAfterFirstMounted(appsName2Apps(prefetchStrategy as string[]), importEntryOpts);
  } else if (isFunction(prefetchStrategy)) { // 如果上方法，则执行，获取返回参数，并处理
    (async () => {
      // critical rendering apps would be prefetch as earlier as possible
      const { criticalAppNames = [], minorAppsName = [] } = await prefetchStrategy(apps);
      prefetchImmediately(appsName2Apps(criticalAppNames), importEntryOpts);
      prefetchAfterFirstMounted(appsName2Apps(minorAppsName), importEntryOpts);
    })();
  } else {
    switch (prefetchStrategy) {
      case true: // 如果是布尔值 ture
        prefetchAfterFirstMounted(apps, importEntryOpts);
        break;

      case 'all': // 如果是全部应用预先加载
        prefetchImmediately(apps, importEntryOpts);
        break;

      default:
        break;
    }
  }
}
