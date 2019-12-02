#!/usr/local/bin/node

require("@babel/register")({
  presets: ["babel-preset-meteor"]
});

module.exports = require('./bootstrap')