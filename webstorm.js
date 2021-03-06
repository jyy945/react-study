/**
 * @Desc webstorm.js
 * @Auther: jyy
 * @Date: 2020/12/11 13:43
 * @Version: 1.0
 * @Last Modified by: jyy
 * @Last Modified time: 2020/12/11 13:43
 */
"use strict";
const path = require("path");

module.exports = {
  context: path.resolve(__dirname, "./"),
  resolve: {
    extensions: [".js", ".vue", ".json"],
    alias: {
      "react-reconciler": path.resolve(__dirname, "packages/react-reconciler"),
      "react-dom":  path.resolve(__dirname, "packages/react-dom"),
      "shared": path.resolve(__dirname, "packages/shared"),
      "scheduler": path.resolve(__dirname, "packages/scheduler"),
      "events": path.resolve(__dirname, "packages/events")
    }
  }
};
