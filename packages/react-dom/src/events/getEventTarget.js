/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {TEXT_NODE} from '../shared/HTMLNodeType';

// 获取事件触发的目标dom
function getEventTarget(nativeEvent) {
  let target = nativeEvent.target || nativeEvent.srcElement || window;
  if (target.correspondingUseElement) {
    target = target.correspondingUseElement;
  }
  return target.nodeType === TEXT_NODE ? target.parentNode : target;
}

export default getEventTarget;
