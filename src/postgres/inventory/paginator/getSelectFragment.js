import { sql } from '../../utils'

export function getFieldsFromResolveInfo(resolveInfo, aliasIdentifier, collectionGqlType = null) {
  const {parentType, variableValues, fragments} = resolveInfo
  const fieldNodes = resolveInfo.fieldNodes || resolveInfo.fieldASTs
  const fields = {}
  fieldNodes.forEach(
    queryAST => {
      const fieldName = queryAST.name.value
      const field = parentType._fields[fieldName]
      if (!field) throw new Error("Couldn't fetch field!")
      let nodeGqlType = stripNonNullType(field.type)
      let nodeQueryAST = queryAST
      if (nodeGqlType._fields.edges) {
        // It's Relay-like; lets dig in
        ({nodeGqlType, nodeQueryAST} = getNodeTypeFromRelayType(nodeGqlType, queryAST))
      }
      if (collectionGqlType) {
        // It's the Node type, resolve the fragment
        nodeGqlType = stripNonNullType(collectionGqlType) // So we can pluck the REQUIRED fields, also so the correct fragments are resolved
        addSelectionsToFields(fields, aliasIdentifier, nodeQueryAST, nodeGqlType, fragments, variableValues)
      } else {
        // Get REQUESTED expressions (from the GQL query)
        addSelectionsToFields(fields, aliasIdentifier, nodeQueryAST, nodeGqlType, fragments, variableValues)
      }
      // XXX: Get REQUIRED expressions (e.g. for __id / pagination / etc)
      if (true /* THIS IS A HACK, DO NOT USE THIS */) {
        Object.keys(nodeGqlType._fields).forEach(
          attrName =>  {
            const fld = nodeGqlType._fields[attrName]
            if ((attrName === "id" || attrName.endsWith("Id")) && fld.sqlExpression) {
              fields[fld.sqlName(aliasIdentifier)] = fld.sqlExpression(aliasIdentifier);
            }
          }
        )
      }

    }
  );
  return fields;
}

export function getSelectFragmentFromFields(fields) {
  const buildArgs = [];
  for (var k in fields) {
    buildArgs.push(sql.query`${sql.value(k)}::text`, fields[k]);
  }
  return sql.query`json_build_object(${sql.join(buildArgs, ', ')})`
}

export default function getSelectFragment(resolveInfo, aliasIdentifier, collectionGqlType = null) {
  if (!resolveInfo) {
    if (!process.env.WHATEVER) console.error("This won't work much longer! Just a hack to keep the tests working")
    return sql.query`to_json(${sql.identifier(aliasIdentifier)})`
  }
  return getSelectFragmentFromFields(getFieldsFromResolveInfo(resolveInfo, aliasIdentifier, collectionGqlType))
}

function addSelectionsToFields(fields, aliasIdentifier, selectionsQueryAST, gqlType, fragments, variableValues) {
  if (!selectionsQueryAST.selectionSet) {
    return;
  }
  selectionsQueryAST.selectionSet.selections.forEach(
    selectionQueryAST => {
      const fieldName = selectionQueryAST.name.value
      if (fieldName.startsWith("__")) {
        return
      }
      if (selectionQueryAST.kind === 'Field') {
        const field = gqlType._fields[fieldName]
        if (!field) {
          throw new Error(`Cannot find field named '${fieldName}'`)
        }
        const fieldGqlType = stripNonNullType(field.type)
        const args = {}
        if (selectionQueryAST.arguments.length) {
          for (let arg of selectionQueryAST.arguments) {
            args[arg.name.value] = parseArgValue(arg.value, variableValues)
          }
        }
        if (field.sqlExpression) {
          const sqlName = field.sqlName(aliasIdentifier, args)
          if (fields[sqlName]) {
            if (!process.env.WHATEVER) console.error(`🔥 We need to alias multiple calls to the same field if it's a procedure (${field.name})`)
            //throw new Error("Field name already specified!!")
          }
          fields[sqlName] = field.sqlExpression(aliasIdentifier, args);
        }
      } else if (selectionQueryAST.kind === 'InlineFragment') {
        const selectionNameOfType = selectionQueryAST.typeCondition.name.value
        const sameType = selectionNameOfType === gqlType.name
        const interfaceType = gqlType._interfaces.map(iface => iface.name).indexOf(selectionNameOfType) >= 0
        if (sameType || interfaceType) {
          addSelectionsToFields(fields, aliasIdentifier, selectionQueryAST.selectionSet.selections, gqlType, fragments, variableValues)
        }
      } else if (selectionQueryAST.kind === 'FragmentSpread') {
        const fragmentName = fieldName;
        const fragment = fragments[fragmentName]
        const fragmentNameOfType = fragment.typeCondition.name.value
        const sameType = fragmentNameOfType === gqlType.name
        const interfaceType = gqlType._interfaces && gqlType._interfaces.map(iface => iface.name).indexOf(fragmentNameOfType) >= 0
        if (sameType || interfaceType) {
          addSelectionsToFields(fields, aliasIdentifier, fragment, gqlType, fragments, variableValues)
        }
      } else {
        throw new Error(`${selectionQueryAST.kind} not supported`);
      }
    }
  );
}

function getNodeTypeFromRelayType(type, queryASTNode) {
  const nodeGqlType = stripNonNullType(type._fields.edges.type.ofType._fields.node.type)
  const edges = queryASTNode.selectionSet.selections.find(selection => selection.name.value === 'edges')
  const nodeQueryAST =
    edges
    ? edges.selectionSet.selections.find(selection => selection.name.value === 'node') || {}
    : {}
  return { nodeGqlType, nodeQueryAST }
}

function stripNonNullType(type) {
  return type.constructor.name === 'GraphQLNonNull' ? type.ofType : type
}

function parseArgValue(value, variableValues) {
  if (value.kind === 'Variable') {
    const variableName = value.name.value
    return variableValues[variableName]
  }

  let primitive = value.value
  // TODO parse other kinds of variables
  if (value.kind === 'IntValue') {
    primitive = parseInt(primitive)
  }
  return primitive
}
