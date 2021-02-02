/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {DispatchConfig} from './ReactSyntheticEventType';
import type {
  AnyNativeEvent,
  PluginName,
  PluginModule,
} from './PluginModuleType';

import invariant from 'shared/invariant';
import {TOP_BLUR} from "react-dom/src/events/DOMTopLevelEventTypes";

type NamesToPlugins = {[key: PluginName]: PluginModule<AnyNativeEvent>};
type EventPluginOrder = null | Array<PluginName>;

// 事件插件的注入顺序，保存着插件名。在injectEventPluginOrder中赋值
let eventPluginOrder: EventPluginOrder = null;

/**
 * Injectable mapping from names to event plugin modules.
 */
// 插件名称和事件插件的映射
const namesToPlugins: NamesToPlugins = {};

// 使用注入的插件和插件排序重新计算插件列表。
// 首先将事件插件按照顺序放入plugins数组中，其中0索引中为undefined。
function recomputePluginOrdering(): void {
  if (!eventPluginOrder) {
    // Wait until an `eventPluginOrder` is injected.
    return;
  }
  for (const pluginName in namesToPlugins) {
    const pluginModule = namesToPlugins[pluginName];
    const pluginIndex = eventPluginOrder.indexOf(pluginName);
    invariant(
      pluginIndex > -1,
      'EventPluginRegistry: Cannot inject event plugins that do not exist in ' +
        'the plugin ordering, `%s`.',
      pluginName,
    );
    if (plugins[pluginIndex]) {
      continue;
    }
    invariant(
      pluginModule.extractEvents,
      'EventPluginRegistry: Event plugins must implement an `extractEvents` ' +
        'method, but `%s` does not.',
      pluginName,
    );
    plugins[pluginIndex] = pluginModule;
    //{
    //   change: {
    //     phasedRegistrationNames: {
    //       bubbled: 'onChange',
    //       captured: 'onChangeCapture',
    //     },
    //     dependencies: [ ... ],
    //  }
    //}
    const publishedEvents = pluginModule.eventTypes;
    // 对eventTypes中的事件类型进行遍历
    for (const eventName in publishedEvents) {
      invariant(
        publishEventForPlugin(
          publishedEvents[eventName],
          pluginModule,
          eventName,
        ),
        'EventPluginRegistry: Failed to publish event `%s` for plugin `%s`.',
        eventName,
        pluginName,
      );
    }
  }
}



// dispatchConfig：
//    {
//       change: {
//         phasedRegistrationNames: {
//           bubbled: 'onChange',
//           captured: 'onChangeCapture',
//         },
//         dependencies: [ ... ],
//      }
//    }
// pluginModule：
// {
//   eventTypes: eventTypes,
//   _isInputEventSupported: isInputEventSupported,
//   extractEvents：...
// }
// eventName: change
// 对事件插件中的事件类型进行发布
function publishEventForPlugin(
  dispatchConfig: DispatchConfig, // 事件插件eventTypes中的事件对象
  pluginModule: PluginModule<AnyNativeEvent>, // 事件插件
  eventName: string,  // 事件名称
): boolean {
  invariant(
    !eventNameDispatchConfigs.hasOwnProperty(eventName),
    'EventPluginHub: More than one plugin attempted to publish the same ' +
      'event name, `%s`.',
    eventName,
  );
  eventNameDispatchConfigs[eventName] = dispatchConfig;
  //{
  //  bubbled: 'onChange',
  //  captured: 'onChangeCapture',
  //}
  const phasedRegistrationNames = dispatchConfig.phasedRegistrationNames; // 事件的触发阶段及其需要注册的事件名称
  if (phasedRegistrationNames) {
    // 遍历事件的触发阶段，对触发阶段的事件名称进行注册，
    // 向registrationNameModules和registrationNameDependencies中添加信息
    for (const phaseName in phasedRegistrationNames) {
      if (phasedRegistrationNames.hasOwnProperty(phaseName)) {
        const phasedRegistrationName = phasedRegistrationNames[phaseName];
        // 向registrationNameModules和registrationNameDependencies中
        // 添加注册的事件名和其所对应的事件插件和依赖
        publishRegistrationName(
          phasedRegistrationName,
          pluginModule,
          eventName,
        );
      }
    }
    return true;
  } else if (dispatchConfig.registrationName) {
    publishRegistrationName(
      dispatchConfig.registrationName,
      pluginModule,
      eventName,
    );
    return true;
  }
  return false;
}

// 发布用于标识已调度事件的注册名称
// 将注册的事件名称和事件插件和所需依赖的事件数组hash表，
// 也就是向registrationNameModules和registrationNameDependencies添加注册的事件名和其所对应的事件插件和依赖
function publishRegistrationName(
  registrationName: string,   // 'onChange'
  pluginModule: PluginModule<AnyNativeEvent>,
  eventName: string,  // change
): void {
  invariant(
    !registrationNameModules[registrationName],
    'EventPluginHub: More than one plugin attempted to publish the same ' +
      'registration name, `%s`.',
    registrationName,
  );
  // onChange: ChangeEventPlugin
  // 注册的事件名和事件插件的key，value
  registrationNameModules[registrationName] = pluginModule;
  // onChange: [TOP_BLUR...]
  // 注册的事件名和事件依赖的key，value
  registrationNameDependencies[registrationName] =
    pluginModule.eventTypes[eventName].dependencies;

  if (__DEV__) {
    const lowerCasedName = registrationName.toLowerCase();
    possibleRegistrationNames[lowerCasedName] = registrationName;

    if (registrationName === 'onDoubleClick') {
      possibleRegistrationNames.ondblclick = registrationName;
    }
  }
}

/**
 * Registers plugins so that they can extract and dispatch events.
 *
 * @see {EventPluginHub}
 */

/**
 * Ordered list of injected plugins.
 */
// 注入的事件数组
export const plugins = [];

// 事件名称到触发阶段和对应的所需注册的事件名称的映射
export const eventNameDispatchConfigs = {};

/**
 * Mapping from registration name to plugin module
 */
// 发布的事件名称和事件插件的映射
export const registrationNameModules = {};

/**
 * Mapping from registration name to event name
 */
// 发布的事件名称和所依赖的事件数组的映射
export const registrationNameDependencies = {};

/**
 * Mapping from lowercase registration names to the properly cased version,
 * used to warn in the case of missing event handlers. Available
 * only in __DEV__.
 * @type {Object}
 */
export const possibleRegistrationNames = __DEV__ ? {} : (null: any);
// Trust the developer to only use possibleRegistrationNames in __DEV__

// 注入插件的顺序（按插件名称）。
// 这使得排序与实际插件的注入分离，
// 因此排序总是确定的，而不考虑包装、动态注入等。
// 作用其拷贝一份injectedEventPluginOrder给eventPluginOrder
export function injectEventPluginOrder(
  injectedEventPluginOrder: EventPluginOrder,
): void {
  invariant(
    !eventPluginOrder,
    'EventPluginRegistry: Cannot inject event plugin ordering more than ' +
      'once. You are likely trying to load more than one copy of React.',
  );
  // 将事件插件的注入顺序数组克隆到eventPluginOrder，防止动态修改造成原数据被污染
  eventPluginOrder = Array.prototype.slice.call(injectedEventPluginOrder);
  recomputePluginOrdering();
}


// 将事件放入namesToPlugins map中，以pluginName：plugin保存
// 然后执行recomputePluginOrdering，从新计算插件的顺序
export function injectEventPluginsByName(
  injectedNamesToPlugins: NamesToPlugins,
): void {
  let isOrderingDirty = false;
  for (const pluginName in injectedNamesToPlugins) {
    if (!injectedNamesToPlugins.hasOwnProperty(pluginName)) {
      continue;
    }
    const pluginModule = injectedNamesToPlugins[pluginName];
    if (
      !namesToPlugins.hasOwnProperty(pluginName) ||
      namesToPlugins[pluginName] !== pluginModule
    ) {
      invariant(
        !namesToPlugins[pluginName],
        'EventPluginRegistry: Cannot inject two different event plugins ' +
          'using the same name, `%s`.',
        pluginName,
      );
      namesToPlugins[pluginName] = pluginModule;
      isOrderingDirty = true;
    }
  }
  if (isOrderingDirty) {
    recomputePluginOrdering();
  }
}
