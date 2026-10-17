// In-memory stand-in for @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb, used only by the
// local Lyrsoft dev API (scripts/lyrsoft-dev-api.mjs). It understands exactly the key conditions,
// update and condition expressions that api/work/ and api/mail/ use, and throws on anything else.
// Queries return items sorted by sort key and page with Limit/LastEvaluatedKey like DynamoDB.
const tables = new Map();
const table = (name) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
};
const keyOf = (item) => `${item.PK ?? item.userId}\u0000${item.SK ?? ''}`;
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

class Command {
  constructor(input) {
    this.input = input;
  }
}
export class GetCommand extends Command {}
export class PutCommand extends Command {}
export class DeleteCommand extends Command {}
export class QueryCommand extends Command {}
export class UpdateCommand extends Command {}
export class BatchWriteCommand extends Command {}
export class ScanCommand extends Command {}
export class DynamoDBClient {}

function conditionalCheckFailed() {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

function query({ TableName, IndexName, KeyConditionExpression, ExpressionAttributeValues: v, ScanIndexForward = true, Limit, ExclusiveStartKey, Select }) {
  const [hashKey, sortKey] = IndexName === 'GSI1' ? ['GSI1PK', 'GSI1SK'] : ['PK', 'SK'];
  let match;
  let items;
  if ((match = KeyConditionExpression.match(/^(\w+) = (:\w+)$/))) {
    items = [...table(TableName).values()].filter((item) => item[hashKey] === v[match[2]]);
  } else if ((match = KeyConditionExpression.match(/^(\w+) = (:\w+) AND begins_with\((\w+), (:\w+)\)$/))) {
    items = [...table(TableName).values()].filter(
      (item) => item[hashKey] === v[match[2]] && typeof item[sortKey] === 'string' && item[sortKey].startsWith(v[match[4]]),
    );
  } else {
    throw new Error(`fake-dynamodb: unsupported KeyConditionExpression ${KeyConditionExpression}`);
  }
  items.sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])));
  if (!ScanIndexForward) items.reverse();
  if (Select === 'COUNT') return { Count: items.length };
  const start = ExclusiveStartKey?.offset || 0;
  const end = Limit ? start + Limit : items.length;
  return { Items: items.slice(start, end).map(clone), LastEvaluatedKey: end < items.length ? { offset: end } : undefined };
}

function update({ TableName, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames: n = {}, ExpressionAttributeValues: v = {} }) {
  const store = table(TableName);
  const existing = store.get(keyOf(Key));
  if (ConditionExpression && !/^attribute_exists\(\w+\)$/.test(ConditionExpression)) {
    throw new Error(`fake-dynamodb: unsupported ConditionExpression ${ConditionExpression}`);
  }
  if (ConditionExpression && !existing) throw conditionalCheckFailed();
  const item = existing || { ...Key };
  const sections = [...UpdateExpression.matchAll(/(SET|ADD) (.+?)(?= (?:SET|ADD) |$)/g)];
  if (!sections.length || sections.map((m) => m[0]).join(' ') !== UpdateExpression) {
    throw new Error(`fake-dynamodb: unsupported UpdateExpression ${UpdateExpression}`);
  }
  for (const [, action, clauses] of sections) {
    for (const clause of clauses.split(/,\s*/)) {
      const [name, value] = action === 'SET' ? clause.split(/\s*=\s*/) : clause.split(/\s+/);
      const attribute = n[name] || name;
      item[attribute] = action === 'SET' ? clone(v[value]) : (item[attribute] || 0) + v[value];
    }
  }
  store.set(keyOf(Key), item);
  return { Attributes: clone(item) };
}

const handlers = {
  GetCommand: ({ TableName, Key }) => ({ Item: clone(table(TableName).get(keyOf(Key))) }),
  PutCommand: ({ TableName, Item, ConditionExpression }) => {
    if (ConditionExpression && ConditionExpression !== 'attribute_not_exists(PK)') {
      throw new Error(`fake-dynamodb: unsupported ConditionExpression ${ConditionExpression}`);
    }
    if (ConditionExpression && table(TableName).has(keyOf(Item))) throw conditionalCheckFailed();
    table(TableName).set(keyOf(Item), clone(Item));
    return {};
  },
  DeleteCommand: ({ TableName, Key }) => {
    table(TableName).delete(keyOf(Key));
    return {};
  },
  QueryCommand: query,
  ScanCommand: ({ TableName }) => ({ Items: [...table(TableName).values()].map(clone) }),
  UpdateCommand: update,
  BatchWriteCommand: ({ RequestItems }) => {
    for (const [name, requests] of Object.entries(RequestItems)) {
      for (const request of requests) {
        if (request.DeleteRequest) table(name).delete(keyOf(request.DeleteRequest.Key));
        if (request.PutRequest) table(name).set(keyOf(request.PutRequest.Item), clone(request.PutRequest.Item));
      }
    }
    return { UnprocessedItems: {} };
  },
};

export const DynamoDBDocumentClient = {
  from: () => ({
    send: async (command) => handlers[command.constructor.name](command.input),
  }),
};

export const fakeTables = tables;
