/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import dangerousStyleValue from './dangerousStyleValue';
import hyphenateStyleName from './hyphenateStyleName';
import warnValidStyle from './warnValidStyle';

/**
 * Operations for dealing with CSS properties.
 */

/**
 * This creates a string that is expected to be equivalent to the style
 * attribute generated by server-side rendering. It by-passes warnings and
 * security checks so it's not safe to use this value for anything other than
 * comparison. It is only used in DEV for SSR validation.
 */
export function createDangerousStringForStyles(styles) {
  if (__DEV__) {
    let serialized = '';
    let delimiter = '';
    for (const styleName in styles) {
      if (!styles.hasOwnProperty(styleName)) {
        continue;
      }
      const styleValue = styles[styleName];
      if (styleValue != null) {
        const isCustomProperty = styleName.indexOf('--') === 0;
        serialized += delimiter + hyphenateStyleName(styleName) + ':';
        serialized += dangerousStyleValue(
          styleName,
          styleValue,
          isCustomProperty,
        );

        delimiter = ';';
      }
    }
    return serialized || null;
  }
}

// 设置style的原生属性和自定义属性，并将特殊样式的数字添加px单位
export function setValueForStyles(node, styles) {
  const style = node.style;
  for (let styleName in styles) {
    if (!styles.hasOwnProperty(styleName)) {
      continue;
    }
    // 若以”--“开头则表示为自定义的css属性，需要使用setProperty才能设置
    const isCustomProperty = styleName.indexOf('--') === 0;
    if (__DEV__) {
      if (!isCustomProperty) {
        warnValidStyle(styleName, styles[styleName]);
      }
    }
    // 处理style中为数字的值，将会将特定的值转为px单位
    const styleValue = dangerousStyleValue(
      styleName,
      styles[styleName],
      isCustomProperty,
    );
    if (styleName === 'float') {
      styleName = 'cssFloat';
    }
    if (isCustomProperty) {
      style.setProperty(styleName, styleValue);
    } else {
      style[styleName] = styleValue;
    }
  }
}
