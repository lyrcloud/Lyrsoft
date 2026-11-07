// In-memory stand-in for @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb, used only by the
// local Lyrsoft dev API (scripts/lyrsoft-dev-api.mjs). It understands exactly the key conditions,
// update, condition and filter expressions that api/work/ and api/mail/ use, and throws on anything else.
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

// Condition and filter expressions: comparisons (= <> < <= > >=), IN (…), attribute_exists /
// attribute_not_exists, AND, OR, NOT and parentheses.
function evaluate(expression, item, n = {}, v = {}) {
  const tokens = expression.match(/\(|\)|,|<>|<=|>=|[=<>]|[#:]?[\w.]+/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (expected) => {
    const token = tokens[i++];
    if (expected && token !== expected) throw new Error(`fake-dynamodb: expected ${expected} in ${expression}`);
    return token;
  };
  const operand = (token) => (token.startsWith(':') ? v[token] : item?.[n[token] || token]);
  function primary() {
    if (peek() === 'NOT') return take(), !primary();
    if (peek() === '(') {
      take('(');
      const value = or();
      take(')');
      return value;
    }
    const token = take();
    if (token === 'attribute_exists' || token === 'attribute_not_exists') {
      take('(');
      const name = take();
      take(')');
      const present = item?.[n[name] || name] !== undefined;
      return token === 'attribute_exists' ? present : !present;
    }
    const left = operand(token);
    const op = take();
    if (op === 'IN') {
      take('(');
      const values = [];
      while (peek() !== ')') {
        values.push(operand(take()));
        if (peek() === ',') take(',');
      }
      take(')');
      return values.includes(left);
    }
    const right = operand(take());
    if (op === '=') return left === right;
    if (op === '<>') return left !== right;
    if (left === undefined || right === undefined) return false;
    return { '<': left < right, '<=': left <= right, '>': left > right, '>=': left >= right }[op];
  }
  function and() {
    let value = primary();
    while (peek() === 'AND') take(), (value = primary() && value);
    return value;
  }
  function or() {
    let value = and();
    while (peek() === 'OR') take(), (value = and() || value);
    return value;
  }
  const result = or();
  if (i !== tokens.length) throw new Error(`fake-dynamodb: unsupported expression ${expression}`);
  return result;
}

// Splits "a = :x, b = if_not_exists(b, :y)" on the commas between clauses only.
function clausesOf(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function query({ TableName, IndexName, KeyConditionExpression, FilterExpression, ExpressionAttributeNames, ExpressionAttributeValues: v, ScanIndexForward = true, Limit, ExclusiveStartKey, Select }) {
  const [hashKey, sortKey] = IndexName === 'GSI1' ? ['GSI1PK', 'GSI1SK'] : ['PK', 'SK'];
  let match;
  let items;
  if ((match = KeyConditionExpression.match(/^(\w+) = (:\w+)$/))) {
    items = [...table(TableName).values()].filter((item) => item[hashKey] === v[match[2]]);
  } else if ((match = KeyConditionExpression.match(/^(\w+) = (:\w+) AND begins_with\((\w+), (:\w+)\)$/))) {
    items = [...table(TableName).values()].filter(
      (item) => item[hashKey] === v[match[2]] && typeof item[sortKey] === 'string' && item[sortKey].startsWith(v[match[4]]),
    );
  } else if ((match = KeyConditionExpression.match(/^(\w+) = (:\w+) AND (\w+) (<=|>=|<|>) (:\w+)$/))) {
    const [, , pk, , op, value] = match;
    const cmp = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b }[op];
    items = [...table(TableName).values()].filter((item) => item[hashKey] === v[pk] && typeof item[sortKey] === 'string' && cmp(item[sortKey], v[value]));
  } else {
    throw new Error(`fake-dynamodb: unsupported KeyConditionExpression ${KeyConditionExpression}`);
  }
  if (FilterExpression) items = items.filter((item) => evaluate(FilterExpression, item, ExpressionAttributeNames, v));
  items.sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])));
  if (!ScanIndexForward) items.reverse();
  if (Select === 'COUNT') return { Count: items.length };
  const start = ExclusiveStartKey?.offset || 0;
  const end = Limit ? start + Limit : items.length;
  return { Items: items.slice(start, end).map(clone), LastEvaluatedKey: end < items.length ? { offset: end } : undefined };
}

function update({ TableName, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames: n = {}, ExpressionAttributeValues: v = {}, ReturnValues }) {
  const store = table(TableName);
  const existing = store.get(keyOf(Key));
  if (ConditionExpression && !evaluate(ConditionExpression, existing, n, v)) throw conditionalCheckFailed();
  const before = clone(existing);
  const item = existing ? clone(existing) : { ...Key };
  const sections = [...UpdateExpression.matchAll(/(SET|ADD|REMOVE) (.+?)(?= (?:SET|ADD|REMOVE) |$)/g)];
  if (!sections.length || sections.map((m) => m[0]).join(' ') !== UpdateExpression) {
    throw new Error(`fake-dynamodb: unsupported UpdateExpression ${UpdateExpression}`);
  }
  for (const [, action, clauses] of sections) {
    for (const clause of clausesOf(clauses)) {
      if (action === 'REMOVE') {
        delete item[n[clause] || clause];
        continue;
      }
      const [name, value] = action === 'SET' ? clause.split(/\s*=\s*(?=.)/) : clause.split(/\s+/);
      const attribute = n[name] || name;
      if (action === 'ADD') {
        item[attribute] = (item[attribute] || 0) + v[value];
        continue;
      }
      const ifNotExists = value.match(/^if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)$/);
      if (ifNotExists) item[attribute] = item[n[ifNotExists[1]] || ifNotExists[1]] ?? clone(v[ifNotExists[2]]);
      else if (/^:\w+$/.test(value)) item[attribute] = clone(v[value]);
      else throw new Error(`fake-dynamodb: unsupported SET ${clause}`);
    }
  }
  store.set(keyOf(Key), item);
  return { Attributes: ReturnValues === 'UPDATED_OLD' || ReturnValues === 'ALL_OLD' ? before : clone(item) };
}

const handlers = {
  GetCommand: ({ TableName, Key }) => ({ Item: clone(table(TableName).get(keyOf(Key))) }),
  PutCommand: ({ TableName, Item, ConditionExpression }) => {
    if (ConditionExpression && !evaluate(ConditionExpression, table(TableName).get(keyOf(Item)))) throw conditionalCheckFailed();
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
