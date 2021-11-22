/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const babylon = require('babylon');
const fs = require('fs');
const path = require('path');
const traverse = require('babel-traverse').default;
const evalToString = require('../shared/evalToString');
const invertObject = require('./invertObject');

const babylonOptions = {
  sourceType: 'module',
  // As a parser, babylon has its own options and we can't directly
  // import/require a babel preset. It should be kept **the same** as
  // the `babel-plugin-syntax-*` ones specified in
  // https://github.com/facebook/fbjs/blob/master/packages/babel-preset-fbjs/configure.js
  plugins: [
    'classProperties',
    'flow',
    'jsx',
    'trailingFunctionCommas',
    'objectRestSpread',
  ],
}; 

// 导出错误代码映射
module.exports = function(opts) {
  if (!opts || !('errorMapFilePath' in opts)) {
    throw new Error(
      'Missing options. Ensure you pass an object with `errorMapFilePath`.'
    );
  }

  // 错误代码映射所在的文件路径
  const errorMapFilePath = opts.errorMapFilePath;
  let existingErrorMap;
  try {
    // Using `fs.readFileSync` instead of `require` here, because `require()`
    // calls are cached, and the cache map is not properly invalidated after
    // file changes.
    // 使用fs.readFileSync，而不是require，是因为require调用会存在cached。被缓存的映射在文件被修改后是无效的
    existingErrorMap = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, path.basename(errorMapFilePath)),
        'utf8'
      )
    );
  } catch (e) {
    existingErrorMap = {};
  }

  // 获取全部的错误代码key
  const allErrorIDs = Object.keys(existingErrorMap);
  let currentID;

  if (allErrorIDs.length === 0) {
    // Map is empty
    currentID = 0;
  } else {
    currentID = Math.max.apply(null, allErrorIDs) + 1;
  }

  // 调转键与值
  existingErrorMap = invertObject(existingErrorMap);

  function transform(source) {
    const ast = babylon.parse(source, babylonOptions);

    traverse(ast, {
      CallExpression: {
        exit(astPath) {
          if (astPath.get('callee').isIdentifier({name: 'invariant'})) {
            const node = astPath.node;

            // error messages can be concatenated (`+`) at runtime, so here's a
            // trivial partial evaluator that interprets the literal value
            const errorMsgLiteral = evalToString(node.arguments[1]);
            if (existingErrorMap.hasOwnProperty(errorMsgLiteral)) {
              return;
            }

            existingErrorMap[errorMsgLiteral] = '' + currentID++;
          }
        },
      },
    });
  }

  function flush(cb) {
    fs.writeFileSync(
      errorMapFilePath,
      JSON.stringify(invertObject(existingErrorMap), null, 2) + '\n',
      'utf-8'
    );
  }

  return function extractErrors(source) {
    transform(source);
    flush();
  };
};
