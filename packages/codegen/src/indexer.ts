//
// Copyright 2021 Vulcanize, Inc.
//

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import Handlebars from 'handlebars';
import { Writable } from 'stream';
import _ from 'lodash';

import { VariableDeclaration } from '@solidity-parser/parser/dist/src/ast-types';

import { getGqlForSol, getTsForGql } from './utils/type-mappings';
import { Param } from './utils/types';
import { MODE_ETH_CALL, MODE_STORAGE } from './utils/constants';
import { getFieldType } from './utils/subgraph';
import { getBaseType, isArrayType } from './utils/helpers';

const TEMPLATE_FILE = './templates/indexer-template.handlebars';

export class Indexer {
  _queries: Array<any>;
  _events: Array<any>;
  _subgraphEntities: Array<any>;
  _templateString: string;
  _hasStateVariableElementaryType: boolean;
  _hasStateVariableMappingType: boolean;

  constructor () {
    this._queries = [];
    this._events = [];
    this._subgraphEntities = [];
    this._hasStateVariableElementaryType = false;
    this._hasStateVariableMappingType = false;
    this._templateString = fs.readFileSync(path.resolve(__dirname, TEMPLATE_FILE)).toString();
  }

  /**
   * Stores the query to be passed to the template.
   * @param mode Code generation mode.
   * @param name Name of the query.
   * @param params Parameters to the query.
   * @param returnType Return type for the query.
   * @param stateVariableType Type of the state variable in case of state variable query.
   */
  addQuery (
    contract: string,
    mode: string,
    name: string,
    params: Array<Param>,
    returnParameters: VariableDeclaration[],
    stateVariableType?: string
  ): void {
    // Check if the query is already added.
    if (this._queries.some(query => query.name === name)) {
      return;
    }

    const returnTypes = returnParameters.map(returnParameter => {
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

      const isArray = isArrayType(typeName);
      if (isArray) {
        tsReturnType = tsReturnType.concat('[]');
      }

      return tsReturnType;
    });

    const queryObject = {
      name,
      entityName: '',
      getQueryName: '',
      saveQueryName: '',
      params: _.cloneDeep(params),
      returnTypes,
      mode,
      stateVariableType,
      contract
    };

    if (name.charAt(0) === '_') {
      const capitalizedName = `${name.charAt(1).toUpperCase()}${name.slice(2)}`;
      queryObject.entityName = `_${capitalizedName}`;
      queryObject.getQueryName = `_get${capitalizedName}`;
      queryObject.saveQueryName = `_save${capitalizedName}`;
    } else {
      const capitalizedName = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      queryObject.entityName = capitalizedName;
      queryObject.getQueryName = `get${capitalizedName}`;
      queryObject.saveQueryName = `save${capitalizedName}`;
    }

    queryObject.params = queryObject.params.map((param) => {
      const gqlParamType = getGqlForSol(param.type);
      assert(gqlParamType);
      const tsParamType = getTsForGql(gqlParamType);
      assert(tsParamType);
      param.type = tsParamType;
      return param;
    });

    if (stateVariableType) {
      queryObject.stateVariableType = stateVariableType;

      switch (stateVariableType) {
        case 'ElementaryTypeName':
          this._hasStateVariableElementaryType = true;
          break;
        case 'Mapping':
          this._hasStateVariableMappingType = true;
          break;
      }
    }

    this._queries.push(queryObject);
  }

  addSubgraphEntities (subgraphSchemaDocument: any): void {
    // Add subgraph entities for creating the relations and entity types maps in the indexer.
    const subgraphTypeDefs = subgraphSchemaDocument.definitions;

    subgraphTypeDefs.forEach((def: any) => {
      if (def.kind !== 'ObjectTypeDefinition') {
        return;
      }

      let entityObject: any = {
        className: def.name.value,
        columns: [],
        relations: []
      };

      entityObject = this._addSubgraphColumns(subgraphTypeDefs, entityObject, def);

      this._subgraphEntities.push(entityObject);
    });
  }

  _addSubgraphColumns (subgraphTypeDefs: any, entityObject: any, def: any): any {
    // Process each field of the entity type def.
    def.fields.forEach((field: any) => {
      const columnObject: any = {
        name: field.name.value,
        type: '',
        isRelation: false,
        isArray: false
      };

      // Process field properties.
      const { typeName, array } = getFieldType(field.type);

      columnObject.type = typeName;
      columnObject.isArray = array;

      // Add a relation if the type is a object type available in subgraph type defs.
      const columnType = subgraphTypeDefs.find((def: any) => {
        return def.name.value === typeName && def.kind === 'ObjectTypeDefinition';
      });

      if (columnType) {
        columnObject.isRelation = true;

        // Process the derivedFrom directive for the relation field.
        const { isDerived, derivedFromField } = this._getDerivedFrom(field.directives);

        if (isDerived) {
          columnObject.isDerived = true;
          columnObject.derivedFromField = derivedFromField;
        } else {
          columnObject.isDerived = false;
        }

        entityObject.relations.push(columnObject);
      }

      entityObject.columns.push(columnObject);
    });

    return entityObject;
  }

  /**
   * Writes the indexer file generated from a template to a stream.
   * @param outStream A writable output stream to write the indexer file to.
   * @param contracts Input contracts to be passed to the template.
   */
  exportIndexer (outStream: Writable, contracts: any[]): void {
    const template = Handlebars.compile(this._templateString);

    const obj = {
      contracts,
      queries: this._queries,
      subgraphEntities: this._subgraphEntities,
      hasStateVariableElementaryType: this._hasStateVariableElementaryType,
      hasStateVariableMappingType: this._hasStateVariableMappingType,
      constants: {
        MODE_ETH_CALL,
        MODE_STORAGE
      }
    };

    const indexer = template(obj);
    outStream.write(indexer);
  }

  _getDerivedFrom (directives: any): { isDerived: boolean, derivedFromField: string } {
    const derivedFromDirective = directives.find((directive: any) => {
      return directive.name.value === 'derivedFrom';
    });

    let isDerived = false;
    let derivedFromField = '';

    // Get the derivedFrom field name if derivedFrom directive is present.
    if (derivedFromDirective) {
      isDerived = true;
      derivedFromField = derivedFromDirective.arguments[0].value.value;
    }

    return { isDerived, derivedFromField };
  }
}
