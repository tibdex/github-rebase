/* eslint-env node */
/* eslint-disable security/detect-non-literal-regexp */

"use strict";

const path = require("path");

const pkgDir = require("pkg-dir");
const webpack = require("webpack");

const { dependencies } = require("./package");

const pkgRoot = pkgDir.sync(__dirname);

module.exports = {
  entry: require.resolve("./src"),
  externals: new RegExp(
    `^(${Object.keys(dependencies).join("|")})(/.*)?$`,
    "u"
  ),
  mode: "production",
  module: {
    rules: [
      {
        include: [
          path.dirname(
            require.resolve("@tibdex/shared-github-internals/src/git")
          ),
          path.join(pkgRoot, "src")
        ],
        test: /\.js$/u,
        use: {
          loader: require.resolve("babel-loader")
        }
      }
    ]
  },
  optimization: {
    // Keep the lib code readable.
    minimize: false
  },
  output: {
    filename: "index.js",
    libraryTarget: "commonjs2",
    path: path.join(pkgRoot, "lib")
  },
  plugins: [new webpack.IgnorePlugin(/^encoding$/u, /node-fetch/u)],
  target: "node"
};
