//
// Copyright 2021 Vulcanize, Inc.
//

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import yaml from 'js-yaml';
import Handlebars from 'handlebars';
import { Writable } from 'stream';

import { VariableDeclaration } from '@solidity-parser/parser/dist/src/ast-types';

import { getPgForTs, getTsForGql, getGqlForSol } from './utils/type-mappings';
import { Param } from './utils/types';
import { getFieldType } from './utils/subgraph';
import { getBaseType, isArrayType } from './utils/helpers';

const TEMPLATE_FILE = './templates/entity-template.handlebars';
const TABLES_DIR = './data/entities';

export class Entity {
  _entities: Array<any>;
  _templateString: string;

  constructor () {
    this._entities = [];
    this._templateString = fs.readFileSync(path.resolve(__dirname, TEMPLATE_FILE)).toString();
  }

  /**
   * Creates an entity object from the query and stores to be passed to the template.
   * @param name Name of the query.
   * @param params Parameters to the query.
   * @param returnType Return type for the query.
   */
  addQuery (name: string, params: Array<Param>, returnParameters: VariableDeclaration[]): void {
    // Check if the query is already added.
    if (this._entities.some(entity => entity.className.toLowerCase() === name.toLowerCase())) {
      return;
    }

    const entityObject: any = {
      className: '',
      indexOn: [],
      columns: [],
      imports: []
    };

    // eth_call mode: Capitalize first letter of entity name (balanceOf -> BalanceOf).
    // storage mode: Capiltalize second letter of entity name (_balances -> _Balances).
    entityObject.className = (name.charAt(0) === '_')
      ? `_${name.charAt(1).toUpperCase()}${name.slice(2)}`
      : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

    entityObject.imports.push(
      {
        toImport: new Set(['Entity', 'PrimaryGeneratedColumn', 'Column', 'Index']),
        from: 'typeorm'
      }
    );

    const indexObject = {
      columns: ['blockHash', 'contractAddress'],
      unique: true
    };
    indexObject.columns = indexObject.columns.concat(
      params.map((param) => {
        return param.name;
      })
    );
    entityObject.indexOn.push(indexObject);

    entityObject.columns.push({
      name: 'id',
      tsType: 'number',
      columnType: 'PrimaryGeneratedColumn',
      columnOptions: []
    });
    entityObject.columns.push({
      name: 'blockHash',
      pgType: 'varchar',
      tsType: 'string',
      columnType: 'Column',
      columnOptions: [
        {
          option: 'length',
          value: 66
        }
      ]
    });
    entityObject.columns.push({
      name: 'blockNumber',
      pgType: 'integer',
      tsType: 'number',
      columnType: 'Column'
    });
    entityObject.columns.push({
      name: 'contractAddress',
      pgType: 'varchar',
      tsType: 'string',
      columnType: 'Column',
      columnOptions: [
        {
          option: 'length',
          value: 42
        }
      ]
    });

    entityObject.columns = entityObject.columns.concat(
      params.map((param) => {
        const name = param.name;

        const gqlType = getGqlForSol(param.type);
        assert(gqlType);
        const tsType = getTsForGql(gqlType);
        assert(tsType);
        const pgType = getPgForTs(tsType);
        assert(pgType);

        const columnOptions = [];

        if (param.type === 'address') {
          columnOptions.push(
            {
              option: 'length',
              value: 42
            }
          );
        }

        return {
          name,
          pgType,
          tsType,
          columnType: 'Column',
          columnOptions
        };
      })
    );

    entityObject.columns = entityObject.columns.concat(
      returnParameters.map((returnParameter, index) => {
        let typeName = returnParameter.typeName;
        assert(typeName);

        // Handle Mapping type for state variable queries
        while (typeName.type === 'Mapping') {
          typeName = typeName.valueType;
        }

        const baseType = getBaseType(typeName);
        assert(baseType);
        const gqlReturnType = getGqlForSol(baseType);
        assert(gqlReturnType);
        let tsReturnType = getTsForGql(gqlReturnType);
        assert(tsReturnType);
        const pgReturnType = getPgForTs(tsReturnType);
        assert(pgReturnType);

        const columnOptions = [];
        const isArray = isArrayType(typeName);

        if (isArray) {
          tsReturnType = tsReturnType.concat('[]');

          columnOptions.push({
            option: 'array',
            value: true
          });
        }

        return {
          name: returnParameters.length > 1 ? `value${index}` : 'value',
          pgType: pgReturnType,
          tsType: tsReturnType,
          columnType: 'Column',
          columnOptions
        };
      })
    );

    entityObject.columns.push({
      name: 'proof',
      pgType: 'text',
      tsType: 'string',
      columnType: 'Column',
      columnOptions: [
        {
          option: 'nullable',
          value: true
        }
      ]
    });

    // Add bigintTransformer column option if required.
    this._addBigIntTransformerOption(entityObject);

    this._entities.push(entityObject);
  }

  /**
   * Writes the generated entity files in the given directory.
   * @param entityDir Directory to write the entities to.
   */
  exportEntities (entityDir: string, subgraphPath: string): void {
    this._addEventEntity();
    this._addSyncStatusEntity();
    this._addContractEntity();
    this._addBlockProgressEntity();
    this._addStateEntity();
    this._addStateSyncStatusEntity();

    // Add FrothyEntity table only for subgraph watchers
    if (subgraphPath) {
      this._addFrothyEntity();
    }

    const template = Handlebars.compile(this._templateString);
    this._entities.forEach(entityObj => {
      const entity = template(entityObj);
      const outStream: Writable = entityDir
        ? fs.createWriteStream(path.join(entityDir, `${entityObj.className}.ts`))
        : process.stdout;
      outStream.write(entity);
    });
  }

  addSubgraphEntities (subgraphSchemaDocument: any): void {
    const subgraphTypeDefs = subgraphSchemaDocument.definitions;

    subgraphTypeDefs.forEach((def: any) => {
      // TODO Handle enum types.
      if (def.kind !== 'ObjectTypeDefinition') {
        return;
      }

      let entityObject: any = {
        className: def.name.value,
        indexOn: [],
        columns: [],
        imports: []
      };

      entityObject.imports.push(
        {
          toImport: new Set(['Entity', 'PrimaryColumn', 'Column', 'Index']),
          from: 'typeorm'
        }
      );

      entityObject.indexOn.push({
        columns: ['blockNumber']
      });

      // Add common columns.
      entityObject.columns.push({
        name: 'id',
        pgType: 'varchar',
        tsType: 'string',
        columnType: 'PrimaryColumn',
        columnOptions: []
      });
      entityObject.columns.push({
        name: 'blockHash',
        pgType: 'varchar',
        tsType: 'string',
        columnType: 'PrimaryColumn',
        columnOptions: [
          {
            option: 'length',
            value: 66
          }
        ]
      });
      entityObject.columns.push({
        name: 'blockNumber',
        pgType: 'integer',
        tsType: 'number',
        columnType: 'Column'
      });

      // Add subgraph entity specific columns.
      entityObject = this._addSubgraphColumns(subgraphTypeDefs, entityObject, def);

      // Add is_pruned column.
      entityObject.columns.push({
        name: 'isPruned',
        pgType: 'boolean',
        tsType: 'boolean',
        columnType: 'Column',
        columnOptions: [
          {
            option: 'default',
            value: false
          }
        ]
      });

      // Add decimalTransformer column option if required.
      this._addDecimalTransformerOption(entityObject);

      // Add bigintTransformer column option if required.
      this._addBigIntTransformerOption(entityObject);

      this._entities.push(entityObject);
    });
  }

  _addEventEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'Event.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addSyncStatusEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'SyncStatus.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addContractEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'Contract.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addBlockProgressEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'BlockProgress.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addStateEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'State.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addStateSyncStatusEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'StateSyncStatus.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addFrothyEntity (): void {
    const entity = yaml.load(fs.readFileSync(path.resolve(__dirname, TABLES_DIR, 'FrothyEntity.yaml'), 'utf8'));
    this._entities.push(entity);
  }

  _addBigIntTransformerOption (entityObject: any): void {
    let importObject = entityObject.imports.find((element: any) => {
      return element.from === '@cerc-io/util';
    });

    entityObject.columns.forEach((column: any) => {
      // Implement bigintTransformer for bigint type.
      if (column.tsType === 'bigint') {
        column.columnOptions.push(
          {
            option: 'transformer',
            value: 'bigintTransformer'
          }
        );

        if (importObject) {
          importObject.toImport.add('bigintTransformer');
        } else {
          importObject = {
            toImport: new Set(['bigintTransformer']),
            from: '@cerc-io/util'
          };

          entityObject.imports.push(importObject);
        }
      }

      // Implement bigintArrayTransformer for array of bigint type.
      if (column.tsType === 'bigint[]') {
        column.columnOptions.push(
          {
            option: 'transformer',
            value: 'bigintArrayTransformer'
          }
        );

        if (importObject) {
          importObject.toImport.add('bigintArrayTransformer');
        } else {
          importObject = {
            toImport: new Set(['bigintArrayTransformer']),
            from: '@cerc-io/util'
          };

          entityObject.imports.push(importObject);
        }
      }
    });
  }

  _addDecimalTransformerOption (entityObject: any): void {
    let importObject = entityObject.imports.find((element: any) => {
      return element.from === '@cerc-io/util';
    });

    let isDecimalRequired = false;

    entityObject.columns.forEach((column: any) => {
      // Implement decimalTransformer for Decimal type.
      if (column.tsType === 'Decimal') {
        isDecimalRequired = true;

        column.columnOptions.push(
          {
            option: 'transformer',
            value: 'decimalTransformer'
          }
        );

        if (importObject) {
          importObject.toImport.add('decimalTransformer');
        } else {
          importObject = {
            toImport: new Set(['decimalTransformer']),
            from: '@cerc-io/util'
          };

          entityObject.imports.push(importObject);
        }
      }

      // Implement decimalArrayTransformer for array of Decimal type.
      if (column.tsType === 'Decimal[]') {
        isDecimalRequired = true;

        column.columnOptions.push(
          {
            option: 'transformer',
            value: 'decimalArrayTransformer'
          }
        );

        if (importObject) {
          importObject.toImport.add('decimalArrayTransformer');
        } else {
          importObject = {
            toImport: new Set(['decimalArrayTransformer']),
            from: '@cerc-io/util'
          };

          entityObject.imports.push(importObject);
        }
      }
    });

    if (isDecimalRequired) {
      entityObject.imports.push(
        {
          toImport: new Set(['Decimal']),
          from: 'decimal.js'
        }
      );
    }
  }

  _addSubgraphColumns (subgraphTypeDefs: any, entityObject: any, def: any): any {
    def.fields.forEach((field: any) => {
      if (field.directives.some((directive: any) => directive.name.value === 'derivedFrom')) {
        // Do not add column if it is a derived field.
        return;
      }

      let name = field.name.value;

      // Column id is already added.
      if (name === 'id') {
        return;
      }

      // Handle column with existing name.
      if (['blockHash', 'blockNumber'].includes(name)) {
        name = `_${name}`;
      }

      const columnObject: any = {
        name,
        columnOptions: [],
        columnType: 'Column'
      };

      const { typeName, array, nullable } = getFieldType(field.type);
      let tsType = getTsForGql(typeName);

      if (subgraphTypeDefs.some((typeDef: any) => typeDef.kind === 'EnumTypeDefinition' && typeDef.name.value === typeName)) {
        // Create enum type column.

        const entityImport = entityObject.imports.find(({ from }: any) => from === '../types');

        if (!entityImport) {
          entityObject.imports.push(
            {
              toImport: new Set([typeName]),
              from: '../types'
            }
          );
        } else {
          entityImport.toImport.add(typeName);
        }

        columnObject.columnOptions.push(
          {
            option: 'type',
            value: "'enum'"
          },
          {
            option: 'enum',
            value: typeName
          }
        );

        columnObject.tsType = typeName;
      } else {
        if (!tsType) {
          tsType = 'string';
        }

        columnObject.tsType = tsType;

        // Enum type does not require pgType.
        columnObject.pgType = getPgForTs(tsType);
      }

      // Handle basic array types.
      if (array) {
        columnObject.columnOptions.push({
          option: 'array',
          value: 'true'
        });

        columnObject.tsType = `${tsType}[]`;
      }

      if (nullable) {
        columnObject.columnOptions.push({
          option: 'nullable',
          value: 'true'
        });
      }

      entityObject.columns.push(columnObject);
    });

    return entityObject;
  }
}
