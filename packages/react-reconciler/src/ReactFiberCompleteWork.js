/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {FiberRoot} from './ReactFiberRoot';
import type {
  Instance,
  Type,
  Props,
  Container,
  ChildSet,
} from './ReactFiberHostConfig';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import {
  IndeterminateComponent,
  FunctionComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostText,
  HostPortal,
  ContextProvider,
  ContextConsumer,
  ForwardRef,
  Fragment,
  Mode,
  Profiler,
  SuspenseComponent,
  MemoComponent,
  SimpleMemoComponent,
  LazyComponent,
  IncompleteClassComponent,
} from 'shared/ReactWorkTags';
import {Placement, Ref, Update} from 'shared/ReactSideEffectTags';
import invariant from 'shared/invariant';

import {
  createInstance,
  createTextInstance,
  createHiddenTextInstance,
  appendInitialChild,
  finalizeInitialChildren,
  prepareUpdate,
  supportsMutation,
  supportsPersistence,
  cloneInstance,
  cloneHiddenInstance,
  cloneUnhiddenInstance,
  createContainerChildSet,
  appendChildToContainerChildSet,
  finalizeContainerChildren,
} from 'react-dom/src/client/ReactDOMHostConfig';
import {
  getRootHostContainer,
  popHostContext,
  getHostContext,
  popHostContainer,
} from './ReactFiberHostContext';
import {
  isContextProvider as isLegacyContextProvider,
  popContext as popLegacyContext,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
} from './ReactFiberContext';
import {popProvider} from './ReactFiberNewContext';
import {
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  popHydrationState,
} from './ReactFiberHydrationContext';

function markUpdate(workInProgress: Fiber) {
  // Tag the fiber with an update effect. This turns a Placement into
  // a PlacementAndUpdate.
  workInProgress.effectTag |= Update;
}

function markRef(workInProgress: Fiber) {
  workInProgress.effectTag |= Ref;
}
  // 通过子节点fiber为节点创建其所有的子节点dom，并将其放在该节点的dom元素下
  // 对wip的fiber子树中的所有节点进行遍历，直到找到HostComponent或HostText类型节点，将其对应的dom添加到wip对应的dom下
  // 因为只有HostComponent和HostText节点是可以创建对应的dom节点的，为了构成最终的dom树，只需要找到这些节点然后构建就可以
  let appendAllChildren = function(
    parent: Instance,
    workInProgress: Fiber,
    needsVisibilityToggle: boolean,
    isHidden: boolean,
  ) {
    // 对wip的子fiber树中的所有fiber进行遍历，找到所有的HostComponent和HostText节点，然后将对应的dom添加到wip对应的dom下
    // 因为非HostComponent和HostText类型节点是没有真实的dom元素的，只是抽象的fiber对象，需要继续下找到HostComponent和HostText类型节点，
    // 然后将这些dom挂在到祖先fiber树中的第一个HostComponent和HostText类型节点
    let node = workInProgress.child;
    while (node !== null) {
      // wip为html原生标签，则将其子dom元素添加到其子节点
      if (node.tag === HostComponent || node.tag === HostText) {
        appendInitialChild(parent, node.stateNode);
      }
      else if (node.tag === HostPortal) {
      }
      // 若子节点的child不为空，则设置子节点和父节点的联系
      else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }

      // 当前节点为wip，表示其所有子节点的dom已经完成更新和挂在
      if (node === workInProgress) {
        return;
      }
      // 不断向上查找父节点，直到这个父节点为wip则退出。
      // 若期间的节点有兄弟节点，则对这个节点进行处理
      while (node.sibling === null) {
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      // 设置node的其他兄弟节点的reture的值为node的父节点
      node.sibling.return = node.return;
      node = node.sibling;
    }
  };

  let updateHostContainer = function(workInProgress: Fiber) {
    // Noop
  };

  // 更新HostComponent节点
  let updateHostComponent = function(
    current: Fiber,
    workInProgress: Fiber,
    type: Type,
    newProps: Props,
    rootContainerInstance: Container,
  ) {
    // If we have an alternate, that means this is an update and we need to
    // schedule a side-effect to do the updates.
    const oldProps = current.memoizedProps;
    // 前后两次的props一致，不需要更新
    if (oldProps === newProps) {
      return;
    }

    // If we get updated because one of our children updated, we don't
    // have newProps so we'll have to reuse them.
    // TODO: Split the update API as separate for the props vs. children.
    // Even better would be if children weren't special cased at all tho.
    const instance: Instance = workInProgress.stateNode;
    const currentHostContext = getHostContext();
    // TODO: Experiencing an error where oldProps is null. Suggests a host
    // component is hitting the resume path. Figure out why. Possibly
    // related to `hidden`.
    const updatePayload = prepareUpdate(
      instance,
      type,
      oldProps,
      newProps,
      rootContainerInstance,
      currentHostContext,
    );
    // TODO: Type this specific to this type of component.
    workInProgress.updateQueue = (updatePayload: any);
    // If the update payload indicates that there is a change or if there
    // is a new ref we mark this as an update. All the work is done in commitWork.
    if (updatePayload) {
      markUpdate(workInProgress);
    }
  };
  let updateHostText = function(
    current: Fiber,
    workInProgress: Fiber,
    oldText: string,
    newText: string,
  ) {
    // If the text differs, mark it as an update. All the work in done in commitWork.
    if (oldText !== newText) {
      markUpdate(workInProgress);
    }
  };


// 若当前节点为HostComponent，则创建或更新这个节点对应的dom
// 若为创建则将其子树中的dom节点添加到当前的dom中，从而构成dom树
function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
): Fiber | null {
  const newProps = workInProgress.pendingProps;

  switch (workInProgress.tag) {
    case IndeterminateComponent:
      break;
    case LazyComponent:
      break;
    case SimpleMemoComponent:
    case FunctionComponent:
      break;
    case ClassComponent: {
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      break;
    }
    case HostRoot: { // fiber树的最高层fiber
      popHostContainer(workInProgress);
      popTopLevelLegacyContextObject(workInProgress);
      const fiberRoot = (workInProgress.stateNode: FiberRoot);
      if (fiberRoot.pendingContext) {
        fiberRoot.context = fiberRoot.pendingContext;
        fiberRoot.pendingContext = null;
      }
      if (current === null || current.child === null) {
        // If we hydrated, pop so that we can delete any remaining children
        // that weren't hydrated.
        popHydrationState(workInProgress);
        // This resets the hacky state to fix isMounted before committing.
        // TODO: Delete this when we delete isMounted and findDOMNode.
        workInProgress.effectTag &= ~Placement;
      }
      updateHostContainer(workInProgress);
      break;
    }
    // html原生标签
    case HostComponent: {
      popHostContext(workInProgress);
      const rootContainerInstance = getRootHostContainer();
      const type = workInProgress.type;
      // 该节点不是第一次渲染
      if (current !== null && workInProgress.stateNode != null) {
        updateHostComponent(
          current,
          workInProgress,
          type,
          newProps,
          rootContainerInstance,
        );

        if (current.ref !== workInProgress.ref) {
          markRef(workInProgress);
        }
      }
      // 节点是第一次渲染
      else {
        if (!newProps) {
          invariant(
            workInProgress.stateNode !== null,
            'We must have new props for new mounts. This error is likely ' +
              'caused by a bug in React. Please file an issue.',
          );
          // This can happen when we abort work.
          break;
        }

        const currentHostContext = getHostContext();
        // TODO: Move createInstance to beginWork and keep it on a context
        // "stack" as the parent. Then append children as we go in beginWork
        // or completeWork depending on we want to add then top->down or
        // bottom->up. Top->down is faster in IE11.
        let wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          // TODO: Move this and createInstance step into the beginPhase
          // to consolidate.
          if (
            prepareToHydrateHostInstance(
              workInProgress,
              rootContainerInstance,
              currentHostContext,
            )
          ) {
            // If changes to the hydrated node needs to be applied at the
            // commit-phase we mark this as such.
            markUpdate(workInProgress);
          }
        } else {
          // 通过wip创建dom元素
          let instance = createInstance(
            type,
            newProps,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );

          // 通过wip的children，创建对应的dom，并添加到当前节点的dom下
          appendAllChildren(instance, workInProgress, false, false);

          // 为当前的html dom节点设置属性，并为叶子节点设置文本，返回是否需要聚焦
          if (
            finalizeInitialChildren(
              instance,
              type,
              newProps,
              rootContainerInstance,
              currentHostContext,
            )
          ) {
            markUpdate(workInProgress);
          }
          // 设置html原生节点的wip的stateNode的值为dom对象
          workInProgress.stateNode = instance;
        }

        if (workInProgress.ref !== null) {
          // If there is a ref on a host node we need to schedule a callback
          markRef(workInProgress);
        }
      }
      break;
    }
    case HostText: {
      let newText = newProps;
      if (current && workInProgress.stateNode != null) {
        const oldText = current.memoizedProps;
        // If we have an alternate, that means this is an update and we need
        // to schedule a side-effect to do the updates.
        updateHostText(current, workInProgress, oldText, newText);
      } else {
        if (typeof newText !== 'string') {
          invariant(
            workInProgress.stateNode !== null,
            'We must have new props for new mounts. This error is likely ' +
              'caused by a bug in React. Please file an issue.',
          );
          // This can happen when we abort work.
        }
        const rootContainerInstance = getRootHostContainer();
        const currentHostContext = getHostContext();
        let wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          if (prepareToHydrateHostTextInstance(workInProgress)) {
            markUpdate(workInProgress);
          }
        } else {
          workInProgress.stateNode = createTextInstance(
            newText,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );
        }
      }
      break;
    }
    case ForwardRef:
      break;
    case SuspenseComponent: {
      const nextState = workInProgress.memoizedState;
      const prevState = current !== null ? current.memoizedState : null;
      const nextDidTimeout = nextState !== null && nextState.didTimeout;
      const prevDidTimeout = prevState !== null && prevState.didTimeout;
      if (nextDidTimeout !== prevDidTimeout) {
        // If this render commits, and it switches between the normal state
        // and the timed-out state, schedule an effect.
        workInProgress.effectTag |= Update;
      }
      break;
    }
    case Fragment:
      break;
    case Mode:
      break;
    case Profiler:
      break;
    case HostPortal:
      popHostContainer(workInProgress);
      updateHostContainer(workInProgress);
      break;
    case ContextProvider:
      // Pop provider fiber
      popProvider(workInProgress);
      break;
    case ContextConsumer:
      break;
    case MemoComponent:
      break;
    case IncompleteClassComponent: {
      // Same as class component case. I put it down here so that the tags are
      // sequential to ensure this switch is compiled to a jump table.
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      break;
    }
    default:
      invariant(
        false,
        'Unknown unit of work tag. This error is likely caused by a bug in ' +
          'React. Please file an issue.',
      );
  }

  return null;
}

export {completeWork};
