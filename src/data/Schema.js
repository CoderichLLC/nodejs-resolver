const Util = require('@coderich/util');
const { Kind, parse, print, visit } = require('graphql');
const { mergeGraphQLTypes } = require('@graphql-tools/merge');

const operations = ['Query', 'Mutation', 'Subscription'];
const modelKinds = [Kind.OBJECT_TYPE_DEFINITION, Kind.OBJECT_TYPE_EXTENSION, Kind.INTERFACE_TYPE_DEFINITION, Kind.INTERFACE_TYPE_EXTENSION];
const allowedKinds = modelKinds.concat(Kind.DOCUMENT, Kind.FIELD_DEFINITION, Kind.NON_NULL_TYPE, Kind.NAMED_TYPE, Kind.LIST_TYPE, Kind.DIRECTIVE);

module.exports = class Schema {
  #config;

  constructor(config) {
    this.#config = config;
  }

  decorate() {
    this.#config.typeDefs = print(visit(parse(this.#config.typeDefs), {
      enter: (node) => {
        if (modelKinds.includes(node.kind) && !operations.includes(node.name.value)) {
          const directive = node.directives.find(({ name }) => name.value === 'model');

          if (directive) {
            const arg = directive.arguments.find(({ name }) => name.value === 'decorate');
            const value = arg?.value.value || 'default';
            const decorator = this.#config.decorators?.[value];

            if (decorator) {
              const name = node.name.value;
              const [merged] = mergeGraphQLTypes([`type ${name} { ${decorator} }`, print(node)], { noLocation: true });
              node.fields = merged.fields;
              return node;
            }
          }

          return false;
        }

        return undefined;
      },
    }));

    return this;
  }

  parse() {
    let model, field, isField, isList;
    const thunks = [];
    const schema = { models: {}, indexes: [] };

    // Parse AST
    visit(parse(this.#config.typeDefs), {
      enter: (node) => {
        const name = node.name?.value;
        if (!allowedKinds.includes(node.kind)) return false;

        if (modelKinds.includes(node.kind) && !operations.includes(name)) {
          model = schema.models[name] = {
            name,
            key: name,
            fields: {},
            idField: 'id',
            dalScope: 'crud',
            gqlScope: 'cruds',
            isPersistable: true,
            source: this.#config.dataSources?.default,
            toString: () => name,
          };
        } else if (node.kind === Kind.FIELD_DEFINITION) {
          isField = true;
          field = model.fields[name] = {
            name,
            key: name,
            dalScope: 'crud',
            gqlScope: 'cruds',
            pipelines: { validate: [], serialize: [], construct: [] },
          };
        } else if (node.kind === Kind.NON_NULL_TYPE) {
          field[isList ? 'isArrayRequired' : 'isRequired'] = true;
        } else if (node.kind === Kind.NAMED_TYPE) {
          field.type = node.name.value;
        } else if (node.kind === Kind.LIST_TYPE) {
          field.isArray = true;
          isList = true;
        } else if (node.kind === Kind.DIRECTIVE) {
          const target = isField ? field : model;

          if (name === 'model') model.isMarkedModel = true;
          else if (name === 'index') schema.indexes.push({ model });

          node.arguments.forEach((arg) => {
            const key = arg.name.value;
            const { value: val, values } = arg.value;
            const value = values ? values.map(n => n.value) : val;

            if (name === 'index') schema.indexes[schema.indexes.length - 1][key] = value;

            switch (`${name}-${key}`) {
              case 'model-id': {
                model.idField = value;
                break;
              }
              case 'model-key': {
                model.key = value;
                break;
              }
              case 'model-source': {
                model.source = this.#config.dataSources?.[value];
                break;
              }
              case 'model-embed': {
                model.isEmbedded = value;
                break;
              }
              case 'model-persist': {
                model.isPersistable = value;
                break;
              }
              case 'model-gqlScope': case 'model-dalScope': {
                model[key] = Util.nvl(value, '');
                break;
              }
              case 'field-key': {
                field.key = value;
                break;
              }
              case 'field-default': {
                field.defaultValue = value;
                break;
              }
              case 'field-persist': {
                field.isPersistable = value;
                break;
              }
              case 'field-onDelete': {
                field.onDelete = value;
                break;
              }
              case 'link-by': {
                field.fkField = value;
                field.isVirtual = true;
                break;
              }
              default: {
                if (['validate', 'construct', 'restruct', 'destruct', 'instruct', 'normalize', 'transform', 'serialize', 'deserialize'].includes(key)) {
                  target.pipelines[key] = target.pipelines[key] || [];
                  target.pipelines[key] = target.pipelines[key].concat(value).filter(Boolean);
                }
                break;
              }
            }
          });
        }

        return undefined; // Continue
      },
      leave: (node) => {
        if (modelKinds.includes(node.kind) && !operations.includes(node.name.value)) {
          const $model = model;
          // const idField = $model.fields[$model.idField];
          // $model.primaryKey = Util.nvl(idField?.key, idField?.name, 'id');

          // Model resolution after field resolution (push)
          thunks.push(($schema) => {
            $model.gqlScope = $model.isMarkedModel ? $model.gqlScope : '';
            $model.dalScope = $model.isMarkedModel ? $model.dalScope : '';
            $model.isEntity = Boolean($model.dalScope !== '' && !$model.isEmbedded);
          });
        } else if (node.kind === Kind.FIELD_DEFINITION) {
          const $field = field;
          const $model = model;

          $field.isPrimaryKey = Boolean($field.name === model.idField);
          $field.isPersistable = Util.uvl($field.isPersistable, model.isPersistable, true);

          // Field resolution comes first (unshift)
          thunks.unshift(($schema) => {
            $field.model = $schema.models[$field.type];
            $field.isFKReference = !$field.isPrimaryKey && $field.model?.isMarkedModel && !$field.model?.isEmbedded;
            if ($field.isPrimaryKey || $field.isFKReference) $field.pipelines.serialize.unshift('$id');
            if ($field.isRequired && $field.isPersistable && !$field.isVirtual) $field.pipelines.validate.push('required');
            if ($field.isFKReference) {
              const fkModel = $field.model;
              const to = fkModel.key;
              const on = fkModel.fields[$field.fkField || fkModel.idField].key;
              const from = $field.isVirtual ? $model.fields[$model.idField].key : $field.key;
              $field.join = { to, on, from };
              $field.pipelines.validate.push('ensureId'); // Absolute Last
            }
          });

          isField = false;
        } else if (node.kind === Kind.LIST_TYPE) {
          isList = false;
        }
      },
    });

    // Resolve data thunks
    thunks.forEach(thunk => thunk(schema));

    // Resolve indexes
    schema.indexes = schema.indexes.map((index) => {
      const { key } = index.model;
      const { name, type } = index;
      const on = index.on.map(f => index.model.fields[f].key);
      return { key, name, type, on };
    });

    // Resolve referential integrity
    Object.values(schema.models).forEach(($model) => {
      $model.referentialIntegrity = Schema.identifyOnDeletes(Object.values(schema.models), $model.name);
    });

    // Helper methods
    schema.resolvePath = (path, prop = 'key') => {
      const [modelKey, ...fieldKeys] = path.split('.');
      const $model = Object.values(schema.models).find(el => el[prop] === modelKey);
      if (!$model || !fieldKeys.length) return $model;
      return fieldKeys.reduce((parent, key) => Object.values(parent.fields || parent.model.fields).find(el => el[prop] === key) || parent, $model);
    };

    // Return schema
    return schema;
  }

  static identifyOnDeletes(models, parentName) {
    return models.reduce((prev, model) => {
      Object.values(model.fields).filter(f => f.onDelete).forEach((field) => {
        if (`${field.model.name}` === `${parentName}`) {
          if (model.isEntity) {
            prev.push({ model, field, isArray: field.isArray, op: field.onDelete });
          } else {
            prev.push(...Schema.identifyOnDeletes(models, model.name).map(od => Object.assign(od, { fieldRef: field.name, isArray: field.isArray, op: field.onDelete })));
          }
        }
      });

      // Assign model referential integrity
      return Util.filterBy(prev, (a, b) => `${a.model.name}:${a.field.name}:${a.fieldRef}:${a.op}` === `${b.model.name}:${b.field.name}:${b.fieldRef}:${b.op}`);
    }, []);
  }
};
