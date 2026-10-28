const { uuid } = require('./native-context.cjs');

// An omitted scope is reserved for trusted in-process inspection. HTTP routes
// always supply a scope, including a null user when the account header is absent.
function mayUseRecord(record, scope) {
  if (!record) return false;
  if (scope === undefined) return true;
  const owner = uuid(record.created_by_id), user = uuid(scope?.userId), space = uuid(record.space_id);
  return !!owner && owner === user && !!space && (scope.spaceId === undefined || uuid(scope.spaceId) === space);
}
const requestScope = (input, meta) => meta === undefined ? undefined : {
  userId: meta?.userId, spaceId: input?.spaceId !== undefined ? input.spaceId : meta?.spaceId
};
module.exports = { mayUseRecord, requestScope };
