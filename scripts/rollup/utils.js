'use strict';

const ncp = require('ncp').ncp;
const path = require('path');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const exec = require('child_process').exec;
const targz = require('targz');

/**
 * 递归复制文件和文件夹
 * 首先使用mkdirp递归创建目标文件夹
 * 然后将源文件夹复制到目标文件夹
 */
function asyncCopyTo(from, to) {
  return asyncMkDirP(path.dirname(to)).then(
    () =>
      new Promise((resolve, reject) => {
        // 递归复制文件和文件夹
        ncp(from, to, error => {
          if (error) {
            // Wrap to have a useful stack trace.
            reject(new Error(error));
            return;
          }
          resolve();
        });
      })
  );
}

// 异步化执行脚本
function asyncExecuteCommand(command) {
  return new Promise((resolve, reject) =>
    exec(command, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    })
  );
}

// 异步化解压缩
function asyncExtractTar(options) {
  return new Promise((resolve, reject) =>
    targz.decompress(options, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    })
  );
}

// 递归创建文件夹和文件
function asyncMkDirP(filepath) {
  return new Promise((resolve, reject) =>
    mkdirp(filepath, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    })
  );
}

/**
 * 移除文件路径下所有的文件和文件夹
 */
function asyncRimRaf(filepath) {
  return new Promise((resolve, reject) =>
    rimraf(filepath, error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    })
  );
}

function resolvePath(filepath) {
  if (filepath[0] === '~') {
    return path.join(process.env.HOME, filepath.slice(1));
  } else {
    return path.resolve(filepath);
  }
}

module.exports = {
  asyncCopyTo,
  resolvePath,
  asyncExecuteCommand,
  asyncExtractTar,
  asyncMkDirP,
  asyncRimRaf,
};
