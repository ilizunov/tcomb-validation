'use strict';

var t = require('tcomb');
var stringify = t.stringify;

var noobj = {};

var ValidationError = t.struct({
  message: t.Any,
  actual: t.Any,
  expected: t.Any,
  path: t.list(t.union([t.String, t.Number]))
}, 'ValidationError');

function getDefaultValidationErrorMessage(actual, expected, path) {
  var expectedName = t.getTypeName(expected);
  var to = path.length ? '/' + path.join('/') + ': ' + expectedName : expectedName;
  return 'Invalid value ' + stringify(actual) + ' supplied to ' + to;
}

function getValidationErrorMessage(actual, expected, path, context) {
  if (t.Function.is(expected.getValidationErrorMessage)) {
    return expected.getValidationErrorMessage(actual, path, context);
  }
  else {
    return getDefaultValidationErrorMessage(actual, expected, path);
  }
}

ValidationError.of = async function (actual, expected, path, context) {
  return new ValidationError({
    message: await getValidationErrorMessage(actual, expected, path, context),
    actual: actual,
    expected: expected,
    path: path
  });
};

var ValidationResult = t.struct({
  errors: t.list(ValidationError),
  value: t.Any
}, 'ValidationResult');

ValidationResult.prototype.isValid = function () {
  return !(this.errors.length);
};

ValidationResult.prototype.firstError = function () {
  return this.isValid() ? null : this.errors[0];
};

ValidationResult.prototype.toString = function () {
  if (this.isValid()) {
    return '[ValidationResult, true, ' + stringify(this.value) + ']';
  }
  else {
    return '[ValidationResult, false, (' + this.errors.map(function (err) {
      return stringify(err.message);
    }).join(', ') + ')]';
  }
};

async function validate(x, type, options) {
  options = options || {};
  var path = t.Array.is(options) ? options : options.path || [];
  return new ValidationResult(await recurse(x, type, path, options));
}

async function recurse(x, type, path, options) {
  if (t.isType(type)) {
    return await validators[type.meta.kind](x, type, path, options);
  }
  else {
    return await validators.es6classes(x, type, path, options);
  }
}

var validators = validate.validators = {};

validators.es6classes = async function validateES6Classes(x, type, path, options) {
  return {
    value: x,
    errors: x instanceof type ? [] : [await ValidationError.of(x, type, path, options.context)]
  };
};

// irreducibles and enums
validators.irreducible =
validators.enums = async function validateIrreducible(x, type, path, options) {
  return {
    value: x,
    errors: type.is(x) ? [] : [await ValidationError.of(x, type, path, options.context)]
  };
};

validators.list = async function validateList(x, type, path, options) {

  // x should be an array
  if (!t.Array.is(x)) {
    return {value: x, errors: [await ValidationError.of(x, type, path, options.context)]};
  }

  var ret = {value: [], errors: []};
  // every item should be of type `type.meta.type`
  for (var i = 0, len = x.length; i < len; i++ ) {
    var item = await recurse(x[i], type.meta.type, path.concat(i), options);
    ret.value[i] = item.value;
    ret.errors = ret.errors.concat(item.errors);
  }
  return ret;
};

validators.subtype = async function validateSubtype(x, type, path, options) {

  // x should be a valid inner type
  var ret = await recurse(x, type.meta.type, path, options);
  if (ret.errors.length) {
    return ret;
  }

  // x should satisfy the predicate
  if (!await type.meta.predicate(ret.value, options.context)) {
    ret.errors = [await ValidationError.of(x, type, path, options.context)];
  }

  return ret;

};

validators.maybe = async function validateMaybe(x, type, path, options) {
  return t.Nil.is(x) ?
    {value: x, errors: []} :
    await recurse(x, type.meta.type, path, options);
};

validators.struct = async function validateStruct(x, type, path, options) {

  // x should be an object
  if (!t.Object.is(x)) {
    return {value: x, errors: [await ValidationError.of(x, type, path, options.context)]};
  }

  // [optimization]
  if (type.is(x)) {
    return {value: x, errors: []};
  }

  var ret = {value: {}, errors: []};
  var props = type.meta.props;
  var defaultProps = type.meta.defaultProps || noobj;
  // every item should be of type `props[name]`
  for (var name in props) {
    if (props.hasOwnProperty(name)) {
      var actual = x[name];
      // apply defaults
      if (actual === undefined) {
        actual = defaultProps[name];
      }
      var prop = await recurse(actual, props[name], path.concat(name), options);
      ret.value[name] = prop.value;
      ret.errors = ret.errors.concat(prop.errors);
    }
  }
  var strict = options.hasOwnProperty('strict') ? options.strict : type.meta.strict;
  if (strict) {
    for (var field in x) {
      if (x.hasOwnProperty(field) && !props.hasOwnProperty(field)) {
        ret.errors.push(await ValidationError.of(x[field], t.Nil, path.concat(field), options.context));
      }
    }
  }
  if (!ret.errors.length) {
    ret.value = new type(ret.value);
  }
  return ret;
};

validators.tuple = async function validateTuple(x, type, path, options) {

  var types = type.meta.types;
  var len = types.length;

  // x should be an array of at most `len` items
  if (!t.Array.is(x) || x.length > len) {
    return {value: x, errors: [await ValidationError.of(x, type, path, options.context)]};
  }

  var ret = {value: [], errors: []};
  // every item should be of type `types[i]`
  for (var i = 0; i < len; i++) {
    var item = await recurse(x[i], types[i], path.concat(i), options);
    ret.value[i] = item.value;
    ret.errors = ret.errors.concat(item.errors);
  }
  return ret;
};

validators.dict = async function validateDict(x, type, path, options) {

  // x should be an object
  if (!t.Object.is(x)) {
    return {value: x, errors: [await ValidationError.of(x, type, path, options.context)]};
  }

  var ret = {value: {}, errors: []};
  // every key should be of type `domain`
  // every value should be of type `codomain`
  for (var k in x) {
    if (x.hasOwnProperty(k)) {
      var subpath = path.concat(k);
      var key = await recurse(k, type.meta.domain, subpath, options);
      var item = await recurse(x[k], type.meta.codomain, subpath, options);
      ret.value[k] = item.value;
      ret.errors = ret.errors.concat(key.errors, item.errors);
    }
  }
  return ret;
};

validators.union = async function validateUnion(x, type, path, options) {
  var ctor = type.dispatch(x);
  return t.Function.is(ctor) ?
    await recurse(x, ctor, path.concat(type.meta.types.indexOf(ctor)), options) :
    {value: x, errors: [await ValidationError.of(x, type, path, options.context)]};
};

validators.intersection = async function validateIntersection(x, type, path, options) {

  var types = type.meta.types;
  var len = types.length;

  var ret = {value: x, errors: []};
  var nrOfStructs = 0;
  // x should be of type `types[i]` for all i
  for (var i = 0; i < len; i++) {
    if (types[i].meta.kind === 'struct') {
      nrOfStructs++;
    }
    var item = await recurse(x, types[i], path, options);
    ret.errors = ret.errors.concat(item.errors);
  }
  if (nrOfStructs > 1) {
    ret.errors.push(await ValidationError.of(x, type, path, options.context));
  }
  return ret;
};

validators['interface'] = async function validateInterface(x, type, path, options) { // eslint-disable-line dot-notation

  // x should be an object
  if (!t.Object.is(x)) {
    return {value: x, errors: [await ValidationError.of(x, type, path, options.context)]};
  }

  var ret = {value: {}, errors: []};
  var props = type.meta.props;
  // every item should be of type `props[name]`
  for (var name in props) {
    var prop = await recurse(x[name], props[name], path.concat(name), options);
    ret.value[name] = prop.value;
    ret.errors = ret.errors.concat(prop.errors);
  }
  var strict = options.hasOwnProperty('strict') ? options.strict : type.meta.strict;
  if (strict) {
    for (var field in x) {
      if (!props.hasOwnProperty(field) && !t.Nil.is(x[field])) {
        ret.errors.push(await ValidationError.of(x[field], t.Nil, path.concat(field), options.context));
      }
    }
  }
  return ret;
};

t.mixin(t, {
  ValidationError: ValidationError,
  ValidationResult: ValidationResult,
  validate: validate
});

module.exports = t;
