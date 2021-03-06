/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactNodeList} from 'shared/ReactTypes';
// TODO: This type is shared between the reconciler and ReactDOM, but will
// eventually be lifted out to the renderer.
import type {
  FiberRoot,
  Batch as FiberRootBatch,
} from 'react-reconciler/src/ReactFiberRoot';
import type {Container} from './ReactDOMHostConfig';

import '../shared/checkReact';
import './ReactDOMClientInjection';

import * as DOMRenderer from 'react-reconciler/inline.dom';
import * as ReactPortal from 'shared/ReactPortal';
import {canUseDOM} from 'shared/ExecutionEnvironment';
import * as ReactGenericBatching from 'events/ReactGenericBatching';
import * as ReactControlledComponent from 'events/ReactControlledComponent';
import * as EventPluginHub from 'events/EventPluginHub';
import * as EventPluginRegistry from 'events/EventPluginRegistry';
import * as EventPropagators from 'events/EventPropagators';
import * as ReactInstanceMap from 'shared/ReactInstanceMap';
import ReactVersion from 'shared/ReactVersion';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import lowPriorityWarning from 'shared/lowPriorityWarning';
import warningWithoutStack from 'shared/warningWithoutStack';
import {enableStableConcurrentModeAPIs} from 'shared/ReactFeatureFlags';

import * as ReactDOMComponentTree from './ReactDOMComponentTree';
import {restoreControlledState} from './ReactDOMComponent';
import * as ReactDOMEventListener from '../events/ReactDOMEventListener';
import {
  ELEMENT_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
} from '../shared/HTMLNodeType';
import {ROOT_ATTRIBUTE_NAME} from '../shared/DOMProperty';

const ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;

let topLevelUpdateWarnings;
let warnOnInvalidCallback;
let didWarnAboutUnstableCreatePortal = false;

if (__DEV__) {
  if (
    typeof Map !== 'function' ||
    // $FlowIssue Flow incorrectly thinks Map has no prototype
    Map.prototype == null ||
    typeof Map.prototype.forEach !== 'function' ||
    typeof Set !== 'function' ||
    // $FlowIssue Flow incorrectly thinks Set has no prototype
    Set.prototype == null ||
    typeof Set.prototype.clear !== 'function' ||
    typeof Set.prototype.forEach !== 'function'
  ) {
    warningWithoutStack(
      false,
      'React depends on Map and Set built-in types. Make sure that you load a ' +
        'polyfill in older browsers. https://fb.me/react-polyfills',
    );
  }

  topLevelUpdateWarnings = (container: DOMContainer) => {
    if (container._reactRootContainer && container.nodeType !== COMMENT_NODE) {
      const hostInstance = DOMRenderer.findHostInstanceWithNoPortals(
        container._reactRootContainer._internalRoot.current,
      );
      if (hostInstance) {
        warningWithoutStack(
          hostInstance.parentNode === container,
          'render(...): It looks like the React-rendered content of this ' +
            'container was removed without using React. This is not ' +
            'supported and will cause errors. Instead, call ' +
            'ReactDOM.unmountComponentAtNode to empty a container.',
        );
      }
    }

    const isRootRenderedBySomeReact = !!container._reactRootContainer;
    const rootEl = getReactRootElementInContainer(container);
    const hasNonRootReactChild = !!(
      rootEl && ReactDOMComponentTree.getInstanceFromNode(rootEl)
    );

    warningWithoutStack(
      !hasNonRootReactChild || isRootRenderedBySomeReact,
      'render(...): Replacing React-rendered children with a new root ' +
        'component. If you intended to update the children of this node, ' +
        'you should instead have the existing children update their state ' +
        'and render the new components instead of calling ReactDOM.render.',
    );

    warningWithoutStack(
      container.nodeType !== ELEMENT_NODE ||
        !((container: any): Element).tagName ||
        ((container: any): Element).tagName.toUpperCase() !== 'BODY',
      'render(): Rendering components directly into document.body is ' +
        'discouraged, since its children are often manipulated by third-party ' +
        'scripts and browser extensions. This may lead to subtle ' +
        'reconciliation issues. Try rendering into a container element created ' +
        'for your app.',
    );
  };

  warnOnInvalidCallback = function(callback: mixed, callerName: string) {
    warningWithoutStack(
      callback === null || typeof callback === 'function',
      '%s(...): Expected the last optional `callback` argument to be a ' +
        'function. Instead received: %s.',
      callerName,
      callback,
    );
  };
}

ReactControlledComponent.setRestoreImplementation(restoreControlledState);

export type DOMContainer =
  | (Element & {
      _reactRootContainer: ?Root,
    })
  | (Document & {
      _reactRootContainer: ?Root,
    });

type Batch = FiberRootBatch & {
  render(children: ReactNodeList): Work,
  then(onComplete: () => mixed): void,
  commit(): void,

  // The ReactRoot constructor is hoisted but the prototype methods are not. If
  // we move ReactRoot to be above ReactBatch, the inverse error occurs.
  // $FlowFixMe Hoisting issue.
  _root: Root,
  _hasChildren: boolean,
  _children: ReactNodeList,

  _callbacks: Array<() => mixed> | null,
  _didComplete: boolean,
};

type Root = {
  render(children: ReactNodeList, callback: ?() => mixed): Work,
  unmount(callback: ?() => mixed): Work,
  legacy_renderSubtreeIntoContainer(
    parentComponent: ?React$Component<any, any>,
    children: ReactNodeList,
    callback: ?() => mixed,
  ): Work,
  createBatch(): Batch,

  _internalRoot: FiberRoot,
};

function ReactBatch(root: ReactRoot) {
  const expirationTime = DOMRenderer.computeUniqueAsyncExpiration();
  this._expirationTime = expirationTime;
  this._root = root;
  this._next = null;
  this._callbacks = null;
  this._didComplete = false;
  this._hasChildren = false;
  this._children = null;
  this._defer = true;
}
ReactBatch.prototype.render = function(children: ReactNodeList) {
  invariant(
    this._defer,
    'batch.render: Cannot render a batch that already committed.',
  );
  this._hasChildren = true;
  this._children = children;
  const internalRoot = this._root._internalRoot;
  const expirationTime = this._expirationTime;
  const work = new ReactWork();
  DOMRenderer.updateContainerAtExpirationTime(
    children,
    internalRoot,
    null,
    expirationTime,
    work._onCommit,
  );
  return work;
};
ReactBatch.prototype.then = function(onComplete: () => mixed) {
  if (this._didComplete) {
    onComplete();
    return;
  }
  let callbacks = this._callbacks;
  if (callbacks === null) {
    callbacks = this._callbacks = [];
  }
  callbacks.push(onComplete);
};
ReactBatch.prototype.commit = function() {
  const internalRoot = this._root._internalRoot;
  let firstBatch = internalRoot.firstBatch;
  invariant(
    this._defer && firstBatch !== null,
    'batch.commit: Cannot commit a batch multiple times.',
  );

  if (!this._hasChildren) {
    // This batch is empty. Return.
    this._next = null;
    this._defer = false;
    return;
  }

  let expirationTime = this._expirationTime;

  // Ensure this is the first batch in the list.
  if (firstBatch !== this) {
    // This batch is not the earliest batch. We need to move it to the front.
    // Update its expiration time to be the expiration time of the earliest
    // batch, so that we can flush it without flushing the other batches.
    if (this._hasChildren) {
      expirationTime = this._expirationTime = firstBatch._expirationTime;
      // Rendering this batch again ensures its children will be the final state
      // when we flush (updates are processed in insertion order: last
      // update wins).
      // TODO: This forces a restart. Should we print a warning?
      this.render(this._children);
    }

    // Remove the batch from the list.
    let previous = null;
    let batch = firstBatch;
    while (batch !== this) {
      previous = batch;
      batch = batch._next;
    }
    invariant(
      previous !== null,
      'batch.commit: Cannot commit a batch multiple times.',
    );
    previous._next = batch._next;

    // Add it to the front.
    this._next = firstBatch;
    firstBatch = internalRoot.firstBatch = this;
  }

  // Synchronously flush all the work up to this batch's expiration time.
  this._defer = false;
  DOMRenderer.flushRoot(internalRoot, expirationTime);

  // Pop the batch from the list.
  const next = this._next;
  this._next = null;
  firstBatch = internalRoot.firstBatch = next;

  // Append the next earliest batch's children to the update queue.
  if (firstBatch !== null && firstBatch._hasChildren) {
    firstBatch.render(firstBatch._children);
  }
};
ReactBatch.prototype._onComplete = function() {
  if (this._didComplete) {
    return;
  }
  this._didComplete = true;
  const callbacks = this._callbacks;
  if (callbacks === null) {
    return;
  }
  // TODO: Error handling.
  for (let i = 0; i < callbacks.length; i++) {
    const callback = callbacks[i];
    callback();
  }
};

// // ReactWork对象定义
type Work = {
  then(onCommit: () => mixed): void,
  _onCommit: () => void,
  _callbacks: Array<() => mixed> | null,
  _didCommit: boolean,
};
// 发布订阅模式
function ReactWork() {
  this._callbacks = null;
  this._didCommit = false;
  this._onCommit = this._onCommit.bind(this);
}
// 订阅
ReactWork.prototype.then = function(onCommit: () => mixed): void {
  if (this._didCommit) {
    onCommit();
    return;
  }
  let callbacks = this._callbacks;
  if (callbacks === null) {
    callbacks = this._callbacks = [];
  }
  callbacks.push(onCommit);
};

// 发布
ReactWork.prototype._onCommit = function(): void {
  if (this._didCommit) {
    return;
  }
  this._didCommit = true;
  const callbacks = this._callbacks;
  if (callbacks === null) {
    return;
  }
  // TODO: Error handling.
  for (let i = 0; i < callbacks.length; i++) {
    const callback = callbacks[i];
    invariant(
      typeof callback === 'function',
      'Invalid argument passed as callback. Expected a function. Instead ' +
        'received: %s',
      callback,
    );
    callback();
  }
};

// reactRoot对象定义
// 创建fiberRoot赋值给内部属性_internalRoot
function ReactRoot(
  container: Container,
  isConcurrent: boolean,
  hydrate: boolean,
) {
    const root = DOMRenderer.createContainer(container, isConcurrent, hydrate); // 创建fiberRoot
    this._internalRoot = root;  // 将fiberRoot赋值给_internalRoot
  }
  // 渲染整个fiber树
  // 此时的children为第一个reactElement，例如：React.render(App, document.getElementById("div"))
  // children就是react为App生成的对应的reactElement对象，这个对象对应的fiber将会是rootFiber的第一个子节点
  ReactRoot.prototype.render = function(
    children: ReactNodeList,
    callback: ?() => mixed,
  ): Work {
    const root = this._internalRoot;  // 获取fiberRoot
    const work = new ReactWork();
    callback = callback === undefined ? null : callback;
    if (__DEV__) {
      warnOnInvalidCallback(callback, 'render');
    }
    if (callback !== null) {
      work.then(callback);
    }
    // 开始更新
    DOMRenderer.updateContainer(children, root, null, work._onCommit);
    return work;
  };
  ReactRoot.prototype.unmount = function(callback: ?() => mixed): Work {
    const root = this._internalRoot;
    const work = new ReactWork();
    callback = callback === undefined ? null : callback;
    if (__DEV__) {
      warnOnInvalidCallback(callback, 'render');
    }
    if (callback !== null) {
      work.then(callback);
    }
    DOMRenderer.updateContainer(null, root, null, work._onCommit);
    return work;
  };
  ReactRoot.prototype.legacy_renderSubtreeIntoContainer = function(
    parentComponent: ?React$Component<any, any>,
    children: ReactNodeList,
    callback: ?() => mixed,
  ): Work {
  const root = this._internalRoot;  // 获取fiberRoot
  const work = new ReactWork();
  callback = callback === undefined ? null : callback;
  if (__DEV__) {
    warnOnInvalidCallback(callback, 'render');
  }
  if (callback !== null) {
    work.then(callback);
  }
  DOMRenderer.updateContainer(children, root, parentComponent, work._onCommit);
  return work;
};
ReactRoot.prototype.createBatch = function(): Batch {
  const batch = new ReactBatch(this);
  const expirationTime = batch._expirationTime;

  const internalRoot = this._internalRoot;
  const firstBatch = internalRoot.firstBatch;
  if (firstBatch === null) {
    internalRoot.firstBatch = batch;
    batch._next = null;
  } else {
    // Insert sorted by expiration time then insertion order
    let insertAfter = null;
    let insertBefore = firstBatch;
    while (
      insertBefore !== null &&
      insertBefore._expirationTime <= expirationTime
    ) {
      insertAfter = insertBefore;
      insertBefore = insertBefore._next;
    }
    batch._next = insertBefore;
    if (insertAfter !== null) {
      insertAfter._next = batch;
    }
  }

  return batch;
};

/**
 * True if the supplied DOM node is a valid node element.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @return {boolean} True if the DOM is a valid DOM node.
 * @internal
 */
function isValidContainer(node) {
  return !!(
    node &&
    (node.nodeType === ELEMENT_NODE ||
      node.nodeType === DOCUMENT_NODE ||
      node.nodeType === DOCUMENT_FRAGMENT_NODE ||
      (node.nodeType === COMMENT_NODE &&
        node.nodeValue === ' react-mount-point-unstable '))
  );
}

// 根据dom节点获取react的根节点元素
// 若container的为document类型，则返回该节点，否则返回其第一个子元素
function getReactRootElementInContainer(container: any) {
  if (!container) {
    return null;
  }

  if (container.nodeType === DOCUMENT_NODE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

// 是否需要调和container内的元素，浏览器端渲染为false
function shouldHydrateDueToLegacyHeuristic(container) {
  const rootElement = getReactRootElementInContainer(container);
  return !!(
    rootElement &&
    rootElement.nodeType === ELEMENT_NODE &&
    rootElement.hasAttribute(ROOT_ATTRIBUTE_NAME)
  );
}

ReactGenericBatching.setBatchingImplementation(
  DOMRenderer.batchedUpdates,
  DOMRenderer.interactiveUpdates,
  DOMRenderer.flushInteractiveUpdates,
);

let warnedAboutHydrateAPI = false;

// 通过dom节点创建reactRoot对象
// 删除container元素中的所有子元素
// 返回创建的reactRoot对象
function legacyCreateRootFromDOMContainer(
  container: DOMContainer,
  forceHydrate: boolean,
): Root {
  // 是否需要调和container内的元素，浏览器端渲染为false
  const shouldHydrate =
    forceHydrate || shouldHydrateDueToLegacyHeuristic(container);
  // 浏览器端渲染执行
  if (!shouldHydrate) {
    let warned = false;
    let rootSibling;
    // 清空container中的所有dom节点
    while ((rootSibling = container.lastChild)) {
      if (__DEV__) {
        if (
          !warned &&
          rootSibling.nodeType === ELEMENT_NODE &&
          (rootSibling: any).hasAttribute(ROOT_ATTRIBUTE_NAME)
        ) {
          warned = true;
          warningWithoutStack(
            false,
            'render(): Target node has markup rendered by React, but there ' +
              'are unrelated nodes as well. This is most commonly caused by ' +
              'white-space inserted around server-rendered markup.',
          );
        }
      }
      container.removeChild(rootSibling);
    }
  }
  if (__DEV__) {
    if (shouldHydrate && !forceHydrate && !warnedAboutHydrateAPI) {
      warnedAboutHydrateAPI = true;
      lowPriorityWarning(
        false,
        'render(): Calling ReactDOM.render() to hydrate server-rendered markup ' +
          'will stop working in React v17. Replace the ReactDOM.render() call ' +
          'with ReactDOM.hydrate() if you want React to attach to the server HTML.',
      );
    }
  }
  // 默认不是异步的
  const isConcurrent = false;
  return new ReactRoot(container, isConcurrent, shouldHydrate); // 为react创建reactRoot
}

// 向container中创建添加渲染子树, 并返回这个fiberRoot的第一个子节点的stateNode
// 创建一个reactRoot赋值给container._reactRootContainer
// 也就是container._reactRootContainer = ReactRoot
// ReactRoot._internalRoot = fiberRoot
// fiberRoot.current = rootFiber
// rootFiber.stateNode = fiberRoot
// 若为首次渲染，则执行reactRoot.render，否则执行fiberRoot._reactRootContainer
function legacyRenderSubtreeIntoContainer(
  parentComponent: ?React$Component<any, any>,
  children: ReactNodeList,
  container: DOMContainer,
  forceHydrate: boolean,
  callback: ?Function,
) {
  // TODO: Ensure all entry points contain this check
  invariant(
    isValidContainer(container),
    'Target container is not a DOM element.',
  );

  if (__DEV__) {
    topLevelUpdateWarnings(container);
  }

  let root: Root = (container._reactRootContainer: any);
  if (!root) {
    // 为container创建ReactRoot对象并返回
    // 会创建fiberRoot对象赋值给reactRoot对象的_internalRoot
    root = container._reactRootContainer = legacyCreateRootFromDOMContainer(
      container,
      forceHydrate,
    );
    // 若包括回调函数，则构建回调函数，将作用域设置为rootFiber的子节点也就是App对应的fiber的stateNode，一般为App的对象实例
    // 之所以这样做是为了将第一个fiber子节点的stateNode作用域作用于该回调函数，只有在渲染之后构建完毕fiber树，这个回调才会执行
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        // 获取rootFiber的子节点的stateNode
        const instance = DOMRenderer.getPublicRootInstance(root._internalRoot);
        originalCallback.call(instance);
      };
    }
    // 首次渲染不使用批量更新
    DOMRenderer.unbatchedUpdates(() => {
      if (parentComponent != null) {
        root.legacy_renderSubtreeIntoContainer(
          parentComponent,
          children,
          callback,
        );
      } else {
        root.render(children, callback);
      }
    });
  } else {
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = DOMRenderer.getPublicRootInstance(root._internalRoot);
        originalCallback.call(instance);
      };
    }
    // Update
    if (parentComponent != null) {
      root.legacy_renderSubtreeIntoContainer(
        parentComponent,
        children,
        callback,
      );
    } else {
      root.render(children, callback);
    }
  }
  return DOMRenderer.getPublicRootInstance(root._internalRoot);
}

function createPortal(
  children: ReactNodeList,
  container: DOMContainer,
  key: ?string = null,
) {
  invariant(
    isValidContainer(container),
    'Target container is not a DOM element.',
  );
  // TODO: pass ReactDOM portal implementation as third argument
  return ReactPortal.createPortal(children, container, null, key);
}

// reactDom对象定义
const ReactDOM: Object = {
  createPortal,

  findDOMNode(
    componentOrElement: Element | ?React$Component<any, any>,
  ): null | Element | Text {
    if (__DEV__) {
      let owner = (ReactCurrentOwner.current: any);
      if (owner !== null && owner.stateNode !== null) {
        const warnedAboutRefsInRender =
          owner.stateNode._warnedAboutRefsInRender;
        warningWithoutStack(
          warnedAboutRefsInRender,
          '%s is accessing findDOMNode inside its render(). ' +
            'render() should be a pure function of props and state. It should ' +
            'never access something that requires stale data from the previous ' +
            'render, such as refs. Move this logic to componentDidMount and ' +
            'componentDidUpdate instead.',
          getComponentName(owner.type) || 'A component',
        );
        owner.stateNode._warnedAboutRefsInRender = true;
      }
    }
    if (componentOrElement == null) {
      return null;
    }
    if ((componentOrElement: any).nodeType === ELEMENT_NODE) {
      return (componentOrElement: any);
    }
    if (__DEV__) {
      return DOMRenderer.findHostInstanceWithWarning(
        componentOrElement,
        'findDOMNode',
      );
    }
    return DOMRenderer.findHostInstance(componentOrElement);
  },

  hydrate(element: React$Node, container: DOMContainer, callback: ?Function) {
    // TODO: throw or warn if we couldn't hydrate?
    return legacyRenderSubtreeIntoContainer(
      null,
      element,
      container,
      true,
      callback,
    );
  },

  // 返回这个fiberRoot的第一个子节点的stateNode，
  // 例如ReactDOM.render(App, document.getElementById("div")
  // 返回的就是App节点对应的fiber的stateNode，需要根据当前当前节点的类型决定
  // ClassComponent类型的stateNode为组件对象的实例
  render(
    // element为ReactElement,包含如下属性: $$typeof，type，key，ref，props，_owner，props中包含children子节点
    // 就是ReactDOM.render(App, document.getElementById("div")中，对App对应的ReactElement对象
    element: React$Element<any>,
    container: DOMContainer,
    callback: ?Function,
  ) {
    // 将render子树添加到container中
    // 将为container创建其对应的fiberRoot和footFiber，为整个fiber树的根节点
    // 而element的fiber则为rootFiber的子节点
    return legacyRenderSubtreeIntoContainer(
      null,
      element,
      container,
      false,
      callback,
    );
  },

  unstable_renderSubtreeIntoContainer(
    parentComponent: React$Component<any, any>,
    element: React$Element<any>,
    containerNode: DOMContainer,
    callback: ?Function,
  ) {
    invariant(
      parentComponent != null && ReactInstanceMap.has(parentComponent),
      'parentComponent must be a valid React Component',
    );
    return legacyRenderSubtreeIntoContainer(
      parentComponent,
      element,
      containerNode,
      false,
      callback,
    );
  },

  unmountComponentAtNode(container: DOMContainer) {
    invariant(
      isValidContainer(container),
      'unmountComponentAtNode(...): Target container is not a DOM element.',
    );

    if (container._reactRootContainer) {
      if (__DEV__) {
        const rootEl = getReactRootElementInContainer(container);
        const renderedByDifferentReact =
          rootEl && !ReactDOMComponentTree.getInstanceFromNode(rootEl);
        warningWithoutStack(
          !renderedByDifferentReact,
          "unmountComponentAtNode(): The node you're attempting to unmount " +
            'was rendered by another copy of React.',
        );
      }

      // Unmount should not be batched.
      DOMRenderer.unbatchedUpdates(() => {
        legacyRenderSubtreeIntoContainer(null, null, container, false, () => {
          container._reactRootContainer = null;
        });
      });
      // If you call unmountComponentAtNode twice in quick succession, you'll
      // get `true` twice. That's probably fine?
      return true;
    } else {
      if (__DEV__) {
        const rootEl = getReactRootElementInContainer(container);
        const hasNonRootReactChild = !!(
          rootEl && ReactDOMComponentTree.getInstanceFromNode(rootEl)
        );

        // Check if the container itself is a React root node.
        const isContainerReactRoot =
          container.nodeType === ELEMENT_NODE &&
          isValidContainer(container.parentNode) &&
          !!container.parentNode._reactRootContainer;

        warningWithoutStack(
          !hasNonRootReactChild,
          "unmountComponentAtNode(): The node you're attempting to unmount " +
            'was rendered by React and is not a top-level container. %s',
          isContainerReactRoot
            ? 'You may have accidentally passed in a React root node instead ' +
              'of its container.'
            : 'Instead, have the parent component update its state and ' +
              'rerender in order to remove this component.',
        );
      }

      return false;
    }
  },

  // Temporary alias since we already shipped React 16 RC with it.
  // TODO: remove in React 17.
  unstable_createPortal(...args) {
    if (!didWarnAboutUnstableCreatePortal) {
      didWarnAboutUnstableCreatePortal = true;
      lowPriorityWarning(
        false,
        'The ReactDOM.unstable_createPortal() alias has been deprecated, ' +
          'and will be removed in React 17+. Update your code to use ' +
          'ReactDOM.createPortal() instead. It has the exact same API, ' +
          'but without the "unstable_" prefix.',
      );
    }
    return createPortal(...args);
  },

  unstable_batchedUpdates: DOMRenderer.batchedUpdates,

  unstable_interactiveUpdates: DOMRenderer.interactiveUpdates,

  flushSync: DOMRenderer.flushSync,

  unstable_flushControlled: DOMRenderer.flushControlled,

  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    // Keep in sync with ReactDOMUnstableNativeDependencies.js
    // and ReactTestUtils.js. This is an array for better minification.
    Events: [
      ReactDOMComponentTree.getInstanceFromNode,
      ReactDOMComponentTree.getNodeFromInstance,
      ReactDOMComponentTree.getFiberCurrentPropsFromNode,
      EventPluginHub.injection.injectEventPluginsByName,
      EventPluginRegistry.eventNameDispatchConfigs,
      EventPropagators.accumulateTwoPhaseDispatches,
      EventPropagators.accumulateDirectDispatches,
      ReactControlledComponent.enqueueStateRestore,
      ReactControlledComponent.restoreStateIfNeeded,
      ReactDOMEventListener.dispatchEvent,
      EventPluginHub.runEventsInBatch,
    ],
  },
};

type RootOptions = {
  hydrate?: boolean,
};

function createRoot(container: DOMContainer, options?: RootOptions): ReactRoot {
  invariant(
    isValidContainer(container),
    'unstable_createRoot(...): Target container is not a DOM element.',
  );
  const hydrate = options != null && options.hydrate === true;
  return new ReactRoot(container, true, hydrate);
}

if (enableStableConcurrentModeAPIs) {
  ReactDOM.createRoot = createRoot;
} else {
  ReactDOM.unstable_createRoot = createRoot;
}

const foundDevTools = DOMRenderer.injectIntoDevTools({
  findFiberByHostInstance: ReactDOMComponentTree.getClosestInstanceFromNode,
  bundleType: __DEV__ ? 1 : 0,
  version: ReactVersion,
  rendererPackageName: 'react-dom',
});

if (__DEV__) {
  if (!foundDevTools && canUseDOM && window.top === window.self) {
    // If we're in Chrome or Firefox, provide a download link if not installed.
    if (
      (navigator.userAgent.indexOf('Chrome') > -1 &&
        navigator.userAgent.indexOf('Edge') === -1) ||
      navigator.userAgent.indexOf('Firefox') > -1
    ) {
      const protocol = window.location.protocol;
      // Don't warn in exotic cases like chrome-extension://.
      if (/^(https?|file):$/.test(protocol)) {
        console.info(
          '%cDownload the React DevTools ' +
            'for a better development experience: ' +
            'https://fb.me/react-devtools' +
            (protocol === 'file:'
              ? '\nYou might need to use a local HTTP server (instead of file://): ' +
                'https://fb.me/react-devtools-faq'
              : ''),
          'font-weight:bold',
        );
      }
    }
  }
}

export default ReactDOM;
