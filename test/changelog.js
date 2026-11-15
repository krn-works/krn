var assert = require('assert')
var fs = require('fs')
var path = require('path')

var pkg = require('../package.json')
var text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
assert.ok(text.indexOf(pkg.version) !== -1, 'CHANGELOG.md names ' + pkg.version)
