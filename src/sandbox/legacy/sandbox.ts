/**
 * @author Kuitos
 * @since 2019-04-11
 */
import type { SandBox } from '../../interfaces';
import { SandBoxType } from '../../interfaces';
import { getTargetValue } from '../common';

function isPropConfigurable(target: WindowProxy, prop: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);
  return descriptor ? descriptor.configurable : true;
}

/**
 * 基于 Proxy 实现的沙箱
 * TODO: 为了兼容性 singular 模式下依旧使用该沙箱，等新沙箱稳定之后再切换
 */
export default class LegacySandbox implements SandBox {
  /** 沙箱期间新增的全局变量 */
  private addedPropsMapInSandbox = new Map<PropertyKey, any>();

  /** 沙箱期间更新的全局变量 */
  private modifiedPropsOriginalValueMapInSandbox = new Map<PropertyKey, any>();

  /** 持续记录更新的(新增和修改的)全局变量的 map，用于在任意时刻做 snapshot */
  private currentUpdatedPropsValueMap = new Map<PropertyKey, any>();

  name: string;

  proxy: WindowProxy;

  globalContext: typeof window;

  type: SandBoxType;

  sandboxRunning = true;

  latestSetProp: PropertyKey | null = null;

  private setWindowProp(prop: PropertyKey, value: any, toDelete?: boolean) {
    if (value === undefined && toDelete) {
      // eslint-disable-next-line no-param-reassign
      delete (this.globalContext as any)[prop];
      // 检查对象属性是否可配置，并且不是 symbol 属性
    } else if (isPropConfigurable(this.globalContext, prop) && typeof prop !== 'symbol') {
      Object.defineProperty(this.globalContext, prop, { writable: true, configurable: true }); // 设置全局上下文
      // eslint-disable-next-line no-param-reassign
      (this.globalContext as any)[prop] = value;
    }
  }

  // 激活沙箱
  active() {
    // 如果沙箱不在运行中，为什么？激活的时候，沙箱应该是未启动的，这里应该永远是 true
    if (!this.sandboxRunning) {
      // 将保存在沙箱中的全局变量map恢复到初始状态
      this.currentUpdatedPropsValueMap.forEach((v, p) => this.setWindowProp(p, v));
    }

    // 否则就启动沙箱
    this.sandboxRunning = true;
  }

  // 关闭沙箱
  inactive() {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
        ...this.addedPropsMapInSandbox.keys(),
        ...this.modifiedPropsOriginalValueMapInSandbox.keys(),
      ]);
    }

    // renderSandboxSnapshot = snapshot(currentUpdatedPropsValueMapForSnapshot);
    // restore global props to initial snapshot
    this.modifiedPropsOriginalValueMapInSandbox.forEach((v, p) => this.setWindowProp(p, v)); // 更新的就恢复
    this.addedPropsMapInSandbox.forEach((_, p) => this.setWindowProp(p, undefined, true)); // 新增的就移除

    this.sandboxRunning = false;
  }

  constructor(name: string, globalContext = window) {
    this.name = name;
    this.globalContext = globalContext;
    this.type = SandBoxType.LegacyProxy;
    const { addedPropsMapInSandbox, modifiedPropsOriginalValueMapInSandbox, currentUpdatedPropsValueMap } = this;

    const rawWindow = globalContext;
    const fakeWindow = Object.create(null) as Window;

    const setTrap = (p: PropertyKey, value: any, originalValue: any, sync2Window = true) => {
      // 如果子应用沙箱启动
      if (this.sandboxRunning) {
        // 全局上下文如果没有该属性
        if (!rawWindow.hasOwnProperty(p)) {
          addedPropsMapInSandbox.set(p, value);
        } else if (!modifiedPropsOriginalValueMapInSandbox.has(p)) {
          // 如果当前 window 对象存在该属性，且 record map 中未记录过，则记录该属性初始值
          modifiedPropsOriginalValueMapInSandbox.set(p, originalValue);
        }

        // 记录每个绑定在全局上下文的值，用于在任意时刻做 snapshot
        currentUpdatedPropsValueMap.set(p, value);

        // 如果开启更新到全局上下文
        if (sync2Window) {
          // 必须重新设置 window 对象保证下次 get 时能拿到已更新的数据
          (rawWindow as any)[p] = value; // 设置值
        }

        // 最近一次设置的属性，有什么用？
        this.latestSetProp = p;

        return true;
      }

      if (process.env.NODE_ENV === 'development') {
        console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
      }

      // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
      return true;
    };

    // ES6 Proxy 代理 window 对象
    const proxy = new Proxy(fakeWindow, {
      set: (_: Window, p: PropertyKey, value: any): boolean => {
        const originalValue = (rawWindow as any)[p];
        return setTrap(p, value, originalValue, true); // 设置虚拟windows 属性时，触发代理的 set 方法，并且记录设置的属性值，将值设置到 window 对象上
      },

      get(_: Window, p: PropertyKey): any {
        // 避免使用window.window 或window.self 逃离沙盒环境去触碰真正的窗口
        // avoid who using window.window or window.self to escape the sandbox environment to touch the really window
        // or use window.top to check if an iframe context
        // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
        if (p === 'top' || p === 'parent' || p === 'window' || p === 'self') {
          return proxy;
        }

        const value = (rawWindow as any)[p];
        return getTargetValue(rawWindow, value); // ？？？
      },

      // trap in operator
      // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
      has(_: Window, p: string | number | symbol): boolean {
        return p in rawWindow;
      },

      getOwnPropertyDescriptor(_: Window, p: PropertyKey): PropertyDescriptor | undefined {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
        // A property cannot be reported as non-configurable, if it does not exists as an own property of the target object
        if (descriptor && !descriptor.configurable) {
          descriptor.configurable = true;
        }
        return descriptor;
      },

      defineProperty(_: Window, p: string | symbol, attributes: PropertyDescriptor): boolean {
        const originalValue = (rawWindow as any)[p];
        const done = Reflect.defineProperty(rawWindow, p, attributes);
        const value = (rawWindow as any)[p];
        setTrap(p, value, originalValue, false);

        return done;
      },
    });

    this.proxy = proxy;
  }
}
