const get = require('lodash.get');
const merge = require('lodash.merge');
const Util = require('@coderich/util');
const Pipeline = require('../data/Pipeline');
const { isPlainObject, isGlob, globToRegex, mergeDeep } = require('../service/AppService');

module.exports = class Query {
  #config;
  #resolver;
  #context;
  #schema;
  #model;
  #query;

  constructor(config) {
    const { schema, context, resolver, query } = config;
    this.#config = config;
    this.#resolver = resolver;
    this.#context = context;
    this.#schema = schema;
    this.#model = schema.models[query.model];
    this.#query = Object.defineProperties(query, {
      $clone: { value: (...args) => this.clone(...args).#query },
      $toDriver: { value: q => this.toDriver(q) },
    });
  }

  get(...args) {
    return get(this.#query, ...args);
  }

  clone(query) {
    query = merge({}, this.#config.query, query);
    // query = { ...this.#config.query, ...query };
    return new Query({ ...this.#config, query });
  }

  async toObject() {
    const query = this.#query;
    const clone = this.clone().#query;
    const { crud, input, where, select = Object.values(this.#model.fields).map(field => field.name) } = query;
    const crudMap = { create: ['$construct'], update: ['$restruct'], delete: ['$destruct'] };
    const crudLines = crudMap[crud] || [];

    [clone.input, clone.where] = await Promise.all([
      // Promise.resolve(input),
      this.transform(query, 'input', this.#model, Util.unflatten(input), ['defaultValue', 'castValue', 'ensureArrayValue', '$normalize', '$instruct', ...crudLines, '$serialize', '$transform', '$validate'].map(el => Pipeline[el])),
      this.transform(query, 'where', this.#model, Util.unflatten(where), ['castValue', '$instruct', '$serialize'].map(el => Pipeline[el])),
    ]);

    return clone;
  }

  toDriver(query) {
    const clone = query.$clone();

    return this.prepare(Object.defineProperties(clone, {
      input: {
        value: this.renameModelFields(this.#model, query.input),
      },
      where: {
        value: this.renameModelFields(this.#model, query.where),
      },
      before: {
        get: () => {
          if (!query.isCursorPaging || !query.before) return undefined;
          return JSON.parse(Buffer.from(query.before, 'base64').toString('ascii'));
        },
      },
      after: {
        get: () => {
          if (!query.isCursorPaging || !query.after) return undefined;
          return JSON.parse(Buffer.from(query.after, 'base64').toString('ascii'));
        },
      },
      $schema: {
        value: this.#schema.resolvePath,
      },
    }));
  }

  async transform(query, target, model, data, transformers = [], paths = []) {
    const allFields = Object.values(model.fields).reduce((prev, field) => Object.assign(prev, { [field.name]: undefined }), {});
    const instructFields = Object.values(model.fields).filter(field => field.pipelines?.instruct).reduce((prev, field) => Object.assign(prev, { [field.name]: undefined }), {});

    // Next we transform the $data
    return Util.mapPromise(data, (doc, index) => {
      if (Array.isArray(data)) paths = paths.concat(index);
      if (target === 'input') doc = mergeDeep(allFields, doc);
      else if (target === 'where') doc = mergeDeep(instructFields, doc);

      return Util.pipeline(Object.entries(doc).map(([keyPath, startValue]) => async (prev) => {
        const path = paths.concat(keyPath);
        const [name] = target === 'input' ? [keyPath] : keyPath.split('.'); // Input is the only thing that can have key.path.keys
        const field = model.fields[name];

        if (!field) return Object.assign(prev, { [keyPath]: startValue }); // "keyPath" is correct here to preserve namespace

        // Transform value
        let $value = await Util.pipeline(transformers.map(t => async (value) => {
          const v = await t({ query, path, model, field, value, startValue, resolver: this.#resolver, context: this.#context });
          return v === undefined ? value : v;
        }), startValue);

        // If it's embedded - delegate
        if (field.model && !field.isFKReference && !field.isPrimaryKey) {
          $value = await this.transform(query, target, field.model, $value, transformers, paths.concat(keyPath));
        }

        // Assign it back
        if (target === 'input' && $value === undefined) return prev;
        return Object.assign(prev, { [field.name]: $value });
      }), {});
    });
  }

  renameModelFields(model, fields = {}) {
    return Object.entries(fields).reduce((prev, [name, value]) => {
      const field = model.fields[name];
      if (!field) {
        console.log('cannot find field', model.name, name);
        return prev;
      }

      return Object.assign(prev, {
        [field.key]: Util.map(value, (val) => {
          return field.model && !field.isFKReference && !field.isPrimaryKey ? this.renameModelFields(field.model, val) : val;
        }),
      });
    }, {});
  }

  prepare(query) {
    const self = this;
    const { model, where = {} } = query;

    [query.joins, query.where] = (function traverse($model, target, joins, clause) {
      Object.entries(target).forEach(([key, value]) => {
        const $field = $model.fields[key];
        // const isSelfReference = $field?.model?.name === model && $model.name !== model;
        // const from = isSelfReference ? $model.fields[$model.idField].key : $field?.join?.from;
        const join = { ...$field?.join, where: {} };

        if ($field?.join && isPlainObject(value)) {
          joins.push(join);
          traverse($field.model, value, joins, join.where);
        } else {
          value = Util.map(value, el => (isGlob(el) ? globToRegex(el) : el));
          clause[key] = value;
        }
      });

      return [joins, self.#globToRegex(query, clause)];
    }(self.#schema.models[model], where, [], {}));

    return query;
  }

  #globToRegex(query, obj, arrayOp = '$in') {
    return Object.entries(Util.flatten(obj, false)).reduce((prev, [key, value]) => {
      // const field = this.#schema.resolvePath(`${query.model}.${key}`);
      const isArray = Array.isArray(value);
      // value = isArray ? Util.ensureArray(value) : value;
      // if (query.flags?.debug) console.log(query.model, key, value);
      // value = Util.map(value, el => (isGlob(el) ? globToRegex(el) : el));
      if (isArray) return Object.assign(prev, { [key]: { [arrayOp]: value } });
      return Object.assign(prev, { [key]: value });
    }, {});
  }
};
