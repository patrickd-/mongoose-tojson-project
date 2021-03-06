'use strict';

//const mpath = require('mpath');
const utils = module.parent.require('mongoose/lib/utils');
const NUMBER_REGEX = new RegExp('^\\d+$');

function minimize(obj) {
  var k = Object.keys(obj),
    i = k.length,
    h,
    v;

  while (i--) {
    v = obj[k[i]];
    if (undefined === (utils.isObject(v) ? minimize(v) : v)) {
      delete obj[k[i]];
    } else {
      h = true;
    }
  }

  return h ? obj : undefined;
}

function compileProjectionStringToArray(str, schema) {
  let out = str.split(' ').reduce((projection, path) => {
    if (path[0] === '-') {
      projection.exclude.push(path.substr(1));
    } else if (path.length) {
      projection.include.push(path);
    }
    return projection;
  }, {
    include: [],
    exclude: []
  });

  // Filter child paths
  Object.keys(out).forEach(key => {
    let fields = out[key].sort();
    out[key] = fields.filter(v => !fields.some(field => v !== field && v.startsWith(field + '.')));
  });

  if (schema) {
    // Find exclusions that are parent of one or more inclusions and convert parent exclusion to child exclusion
    let newExclusions = Array.from(new Set(out.exclude.slice().map((exclusion, index) => {
      let exclusionDot = exclusion + '.';
      let includes = out.include.filter(v => v.startsWith(exclusionDot)); //.map(v => v.substr(exclusion.length));

      // check if any children are included
      if (!includes.length) {
        return [];
      }

      let exclusionDotLength = exclusionDot.length;

      // calculate new
      let exclusions = Array.from(new Set(Object.keys(schema.paths)
        .filter(v => v.startsWith(exclusionDot) && !includes.some(iv => v.startsWith(iv)))
        .map(v => {
          let firstDot = v.substr(exclusionDotLength).indexOf('.');
          return firstDot > -1 ? v.substr(0, exclusionDotLength + firstDot) : v;
        })));

      if (exclusions.length) {
        out.exclude.splice(index, 1);
      }

      return exclusions;
    })));

    out.exclude = Array.prototype.concat.apply(out.exclude, newExclusions);
  }

  return out;
}

function findAndDelete(target, parts) {
  var type;
  var i = parts.length;
  while (i-- > 1) {
    target = target[parts.shift()];

    if (Array.isArray(target)) {
      return target.forEach((v) => findAndDelete(v, parts.slice()));
    } else if (!utils.isObject(target)) {
      return;
    }
  }

  delete target[parts.shift()];
}

function transfer(source, target, parts) {
  var part;
  var i = parts.length;
  while (i-- > 1) {
    part = parts.shift();
    source = source[part];

    if (Array.isArray(source)) {
      if (!target[part]) {
        target = target[part] = new Array(source.length);
      } else {
        target = target[part];
      }

      return source.forEach((v, i) => {
        // nested arrays in form of [[Type]] is not supported in mongoose, untill it is supported this will remain untested
        var c = target[i] || (target[i] = Array.isArray(v) ? new Array(v.length) : utils.isObject(v) ? {} : undefined);
        return c && transfer(v, c, parts.slice());
      });
    }

    if (utils.isObject(source)) {
      target = target[part] = target[part] || {};
    } else {
      return;
    }
  }

  part = parts.shift();
  if (target && source.hasOwnProperty(part)) {
    target[part] = source[part];
  }
}

function levelProject(obj, out, level, projection, minimizeOutput) {
  projection = compileProjectionStringToArray(projection || '');

  if (!level) {
    throw new Error('unable to determine level');
  }

  // merge user and preset levels projection
  projection.include = projection.include.concat(level.include);
  projection.exclude = projection.exclude.concat(level.exclude);

  // inclusion
  if (projection.include.length) {
    //out = projection.include.reduce((p, path) => mpath.set(path, mpath.get(path, obj), p) || p, {});
    out = {};
    projection.include.forEach(path => transfer(obj, out, path.split('.')));

  }

  // exclusion
  if (projection.exclude.length) {
    out = out || obj;
    projection.exclude.forEach((path) => findAndDelete(out, path.split('.')));
  }

  return minimizeOutput ? minimize(out) : out;
}

/*
 * Mongoose ToJSON level projection plugin
 */
module.exports = exports = (schema, pluginOptions) => {
  schema.static('toJSONOptionsExtend', options => Object.setPrototypeOf(options, schema.options.toJSON));

  if (!pluginOptions.levels) {
    pluginOptions.levels = {};
  }

  let predefinedLevels = Object.keys(pluginOptions.levels);

  // Compile levels to arrays
  predefinedLevels.forEach(key => pluginOptions.levels[key] = compileProjectionStringToArray(pluginOptions.levels[key], schema));

  // Support schemaType level option
  schema.eachPath((pathName, schemaType) => {
    if (pluginOptions.defaultFieldLevel && !schemaType.options.level) {
      schemaType.options.level = pluginOptions.defaultFieldLevel;
    }
    if (schemaType.options.level) {
      var levels = compileProjectionStringToArray(schemaType.options.level);

      if (levels.include.length > 0 && levels.exclude.length > 0) {
        throw new Error(`"${pathName}" contains inclusions and exclusions, only one type can be used`);
      }

      levels.include.forEach(level => {
        if (!pluginOptions.levels.hasOwnProperty(level)) {
          throw new Error(`"${pathName}" contains undefined level "${level}". Level inclusions must be predefined in plugin options.`);
        }

        predefinedLevels.filter(v => v !== level).forEach(excludeLevel => {
          pluginOptions.levels[excludeLevel].exclude.push(pathName);
        });
      });

      levels.exclude.forEach((level) => {
        if (pluginOptions.levels.hasOwnProperty(level)) {
          pluginOptions.levels[level].exclude.push(pathName);
        } else {
          pluginOptions.levels[level] = {
            include: [],
            exclude: [pathName]
          };
        }
      });
    }
  });

  schema.options.toJSON = Object.assign(schema.options.toJSON || {}, {
    levels: pluginOptions.levels
  });

  function resolveLevel(level, doc, ret, options) {
    level = options && options.level || pluginOptions.level;

    if (level instanceof Function) {
      level = level(doc, ret, options);
    }

    if (typeof level === 'string') {
      if (doc &&
        doc.constructor &&
        doc.constructor.schema) {
        if (doc.constructor.schema.options.toJSON &&
          doc.constructor.schema.options.toJSON.levels) {
          level = doc.constructor.schema.options.toJSON.levels[level];
        } else {
          return {
            include: [],
            exclude: []
          };
        }
      } else {
        level = pluginOptions.levels[level];
      }
    }

    return level;
  }

  function transform(doc, ret, options) {
    return levelProject(ret,
      ret,
      resolveLevel(options && options.level, doc, ret, options),
      options && options.projection,
      options && options.minimize);
  }

  // Set schema toJSON options
  schema.options.toJSON = schema.options.toJSON || {};

  var preTransform = schema.options.toJSON.transform;

  schema.options.toJSON.transform = preTransform ? (doc, ret, options) => transform(doc, preTransform(doc, ret, options) || ret, options) : transform;
  schema.options.toJSON.level = pluginOptions.level; // set default level

  /*
   * Returns simple schema object
   */
  schema.static('getLevelSchemaTree', level => transform(undefined, utils.clone(schema.tree), {
    minimize: true,
    level: level
  }));

  let set = module.parent.require('mongoose').Document.prototype.set;

  function buildObjectTreeAndSetValue(dotNotationPath, val) {
    var parts = dotNotationPath.split('.');
    var path = {};
    var target = path;
    var treePath;
    var treeHistory = '';
    var part;
    var i = parts.length;
    var len = parts.length;

    while (i-- > 1) {
      part = parts.shift();
      treeHistory += (treeHistory.length ? '.' : '') + part;

      if (schema.pathType(treeHistory) === 'nested') {
        target = target[part] = {};
        continue;
      }

      treePath = schema.path(treeHistory);

      if (treePath && treePath.instance === 'Array') {
        target = target[part] = [];

        if (NUMBER_REGEX.test(parts[0])) {
          parts[0] = parseInt(parts[0]);
          if (parts.length > 1) {
            i--;
            target = target[parts.shift()] = {};
          }
        }
      } else {
        break;
      }
    }

    if (treePath || len === 1) {
      target[parts.shift()] = val;
    }

    return path;
  }

  schema.method('set', function(path, val, type, options) {
    if (type && type.constructor && type.constructor.name === 'Object') {
      options = type;
      type = undefined;
    }

    if (options && options.constructor && options.constructor.name === 'Object') {
      if (typeof path === 'string') {
        // Build object tree from string
        path = buildObjectTreeAndSetValue(path, val);
        val = undefined;
      }

      path = this.constructor.levelProjectObject(path, options);
    }

    return set.call(this, path, val, type, options);
  });

  schema.static('levelProjectObject', (obj, options) => levelProject(
    obj,
    undefined,
    resolveLevel(options && options.level, undefined, obj, options),
    options && options.projection,
    options && options.minimize)
  );

  schema.static('getPathAsLevel', (level, path) => {
    level = pluginOptions.levels[level];

    if (!level) {
      return;
    }

    if (level.exclude.length) {
      if (level.exclude.some(v => path === v || (path + '.').startsWith(v))) {
        return;
      }
    }

    if (level.include.length) {
      if (!level.include.some(v => path === v || (path + '.').startsWith(v))) {
        return;
      }
    }
    return schema.path(path);
  });
};
