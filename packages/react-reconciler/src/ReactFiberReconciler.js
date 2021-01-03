/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {FiberRoot} from './ReactFiberRoot';
import type {
  Instance,
  TextInstance,
  Container,
  PublicInstance,
} from './ReactFiberHostConfig';
import type {ReactNodeList} from 'shared/ReactTypes';
import type {ExpirationTime} from './ReactFiberExpirationTime';

import {
  findCurrentHostFiber,
  findCurrentHostFiberWithNoPortals,
} from 'react-reconciler/reflection';
import * as ReactInstanceMap from 'shared/ReactInstanceMap';
import {HostComponent, ClassComponent} from 'shared/ReactWorkTags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

import {getPublicInstance} from './ReactFiberHostConfig';
import {
  findCurrentUnmaskedContext,
  processChildContext,
  emptyContextObject,
  isContextProvider as isLegacyContextProvider,
} from './ReactFiberContext';
import {createFiberRoot} from './ReactFiberRoot';
import * as ReactFiberDevToolsHook from './ReactFiberDevToolsHook';
import {
  computeUniqueAsyncExpiration,
  requestCurrentTime,
  computeExpirationForFiber,
  scheduleWork,
  requestWork,
  flushRoot,
  batchedUpdates,
  unbatchedUpdates,
  flushSync,
  flushControlled,
  deferredUpdates,
  syncUpdates,
  interactiveUpdates,
  flushInteractiveUpdates,
} from './ReactFiberScheduler';
import {createUpdate, enqueueUpdate} from './ReactUpdateQueue';
import ReactFiberInstrumentation from './ReactFiberInstrumentation';
import * as ReactCurrentFiber from './ReactCurrentFiber';
import {getStackByFiberInDevAndProd} from './ReactCurrentFiber';
import {StrictMode} from './ReactTypeOfMode';

type OpaqueRoot = FiberRoot;

// 0 is PROD, 1 is DEV.
// Might add PROFILE later.
type BundleType = 0 | 1;

type DevToolsConfig = {|
  bundleType: BundleType,
  version: string,
  rendererPackageName: string,
  // Note: this actually *does* depend on Fiber internal fields.
  // Used by "inspect clicked DOM element" in React DevTools.
  findFiberByHostInstance?: (instance: Instance | TextInstance) => Fiber,
  // Used by RN in-app inspector.
  // This API is unfortunately RN-specific.
  // TODO: Change it to accept Fiber instead and type it properly.
  getInspectorDataForViewTag?: (tag: number) => Object,
|};

let didWarnAboutNestedUpdates;
let didWarnAboutFindNodeInStrictMode;

if (__DEV__) {
  didWarnAboutNestedUpdates = false;
  didWarnAboutFindNodeInStrictMode = {};
}

function getContextForSubtree(
  parentComponent: ?React$Component<any, any>,
): Object {
  if (!parentComponent) {
    return emptyContextObject;
  }

  const fiber = ReactInstanceMap.get(parentComponent);
  const parentContext = findCurrentUnmaskedContext(fiber);

  if (fiber.tag === ClassComponent) {
    const Component = fiber.type;
    if (isLegacyContextProvider(Component)) {
      return processChildContext(fiber, Component, parentContext);
    }
  }

  return parentContext;
}

// 对fiberRoot的更新进行调度
// 创建一个update，然后将update放入update queue中
function scheduleRootUpdate(
  current: Fiber, // rootFiber
  element: ReactNodeList,
  expirationTime: ExpirationTime,
  callback: ?Function,
) {
  if (__DEV__) {
    if (
      ReactCurrentFiber.phase === 'render' &&
      ReactCurrentFiber.current !== null &&
      !didWarnAboutNestedUpdates
    ) {
      didWarnAboutNestedUpdates = true;
      warningWithoutStack(
        false,
        'Render methods should be a pure function of props and state; ' +
          'triggering nested component updates from render is not allowed. ' +
          'If necessary, trigger nested updates in componentDidUpdate.\n\n' +
          'Check the render method of %s.',
        getComponentName(ReactCurrentFiber.current.type) || 'Unknown',
      );
    }
  }

  const update = createUpdate(expirationTime); // 创建update
  // Caution: React DevTools currently depends on this property
  // being called "element".
  update.payload = {element};

  // 若存在callback则赋值为update.callback
  // 此时callback为ReactDOM.render(App, "dom", callback)中callback被legacyRenderSubtreeIntoContainer方法中重新封装的回调
  callback = callback === undefined ? null : callback;
  if (callback !== null) {
    warningWithoutStack(
      typeof callback === 'function',
      'render(...): Expected the last optional `callback` argument to be a ' +
        'function. Instead received: %s.',
      callback,
    );
    update.callback = callback;
  }
  // // 将更新放入更新队列
  enqueueUpdate(current, update);

  // 开始对任务进行调度
  scheduleWork(current, expirationTime);
  return expirationTime;
}

// 使用expirationTime更新fiber树
export function updateContainerAtExpirationTime(
  element: ReactNodeList, // 第一个子节点App
  container: OpaqueRoot, // fiberRoot
  parentComponent: ?React$Component<any, any>,
  expirationTime: ExpirationTime,
  callback: ?Function,
) {
  const current = container.current; // fiber

  if (__DEV__) {
    if (ReactFiberInstrumentation.debugTool) {
      if (current.alternate === null) {
        ReactFiberInstrumentation.debugTool.onMountContainer(container);
      } else if (element === null) {
        ReactFiberInstrumentation.debugTool.onUnmountContainer(container);
      } else {
        ReactFiberInstrumentation.debugTool.onUpdateContainer(container);
      }
    }
  }

  const context = getContextForSubtree(parentComponent);
  if (container.context === null) {
    container.context = context;
  } else {
    container.pendingContext = context;
  }
  // 开始对rootFiber 的update进行调度
  return scheduleRootUpdate(current, element, expirationTime, callback);
}

function findHostInstance(component: Object): PublicInstance | null {
  const fiber = ReactInstanceMap.get(component);
  if (fiber === undefined) {
    if (typeof component.render === 'function') {
      invariant(false, 'Unable to find node on an unmounted component.');
    } else {
      invariant(
        false,
        'Argument appears to not be a ReactComponent. Keys: %s',
        Object.keys(component),
      );
    }
  }
  const hostFiber = findCurrentHostFiber(fiber);
  if (hostFiber === null) {
    return null;
  }
  return hostFiber.stateNode;
}

function findHostInstanceWithWarning(
  component: Object,
  methodName: string,
): PublicInstance | null {
  if (__DEV__) {
    const fiber = ReactInstanceMap.get(component);
    if (fiber === undefined) {
      if (typeof component.render === 'function') {
        invariant(false, 'Unable to find node on an unmounted component.');
      } else {
        invariant(
          false,
          'Argument appears to not be a ReactComponent. Keys: %s',
          Object.keys(component),
        );
      }
    }
    const hostFiber = findCurrentHostFiber(fiber);
    if (hostFiber === null) {
      return null;
    }
    if (hostFiber.mode & StrictMode) {
      const componentName = getComponentName(fiber.type) || 'Component';
      if (!didWarnAboutFindNodeInStrictMode[componentName]) {
        didWarnAboutFindNodeInStrictMode[componentName] = true;
        if (fiber.mode & StrictMode) {
          warningWithoutStack(
            false,
            '%s is deprecated in StrictMode. ' +
              '%s was passed an instance of %s which is inside StrictMode. ' +
              'Instead, add a ref directly to the element you want to reference.' +
              '\n%s' +
              '\n\nLearn more about using refs safely here:' +
              '\nhttps://fb.me/react-strict-mode-find-node',
            methodName,
            methodName,
            componentName,
            getStackByFiberInDevAndProd(hostFiber),
          );
        } else {
          warningWithoutStack(
            false,
            '%s is deprecated in StrictMode. ' +
              '%s was passed an instance of %s which renders StrictMode children. ' +
              'Instead, add a ref directly to the element you want to reference.' +
              '\n%s' +
              '\n\nLearn more about using refs safely here:' +
              '\nhttps://fb.me/react-strict-mode-find-node',
            methodName,
            methodName,
            componentName,
            getStackByFiberInDevAndProd(hostFiber),
          );
        }
      }
    }
    return hostFiber.stateNode;
  }
  return findHostInstance(component);
}

// 创建fiberRoot对象
// 内部将创建一个rootFiber对象
// fiberRoot.current = rootFiber;
// rootFiber.stateNode = filberRoot;
export function createContainer(
  containerInfo: Container,
  isConcurrent: boolean,
  hydrate: boolean,
): OpaqueRoot {
  return createFiberRoot(containerInfo, isConcurrent, hydrate);
}

// 更新fiber树
// 计算expiration time，根据expiration time更新fiber树
export function updateContainer(
  element: ReactNodeList, // 第一个子节点App
  container: OpaqueRoot,  // fiberRoot
  parentComponent: ?React$Component<any, any>,
  callback: ?Function,
): ExpirationTime {
  const current = container.current; // 获取fiber对象
  const currentTime = requestCurrentTime();
  // 为fiber计算expiration time
  const expirationTime = computeExpirationForFiber(currentTime, current);
  return updateContainerAtExpirationTime(
    element,
    container,
    parentComponent,
    expirationTime,
    callback,
  );
}

export {
  flushRoot,
  requestWork,
  computeUniqueAsyncExpiration,
  batchedUpdates,
  unbatchedUpdates,
  deferredUpdates,
  syncUpdates,
  interactiveUpdates,
  flushInteractiveUpdates,
  flushControlled,
  flushSync,
};

// 获取rootFiber的第一个子节点的stateNode
export function getPublicRootInstance(
  container: OpaqueRoot,
): React$Component<any, any> | PublicInstance | null {
  const containerFiber = container.current; // rootFiber
  if (!containerFiber.child) {
    return null;
  }
  switch (containerFiber.child.tag) {
    case HostComponent:
      return getPublicInstance(containerFiber.child.stateNode);
    default:
      return containerFiber.child.stateNode;
  }
}

export {findHostInstance};

export {findHostInstanceWithWarning};

export function findHostInstanceWithNoPortals(
  fiber: Fiber,
): PublicInstance | null {
  const hostFiber = findCurrentHostFiberWithNoPortals(fiber);
  if (hostFiber === null) {
    return null;
  }
  return hostFiber.stateNode;
}

export function injectIntoDevTools(devToolsConfig: DevToolsConfig): boolean {
  const {findFiberByHostInstance} = devToolsConfig;
  return ReactFiberDevToolsHook.injectInternals({
    ...devToolsConfig,
    findHostInstanceByFiber(fiber: Fiber): Instance | TextInstance | null {
      const hostFiber = findCurrentHostFiber(fiber);
      if (hostFiber === null) {
        return null;
      }
      return hostFiber.stateNode;
    },
    findFiberByHostInstance(instance: Instance | TextInstance): Fiber | null {
      if (!findFiberByHostInstance) {
        // Might not be implemented by the renderer.
        return null;
      }
      return findFiberByHostInstance(instance);
    },
  });
}
