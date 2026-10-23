const { pageId } = require('./notion-tools.cjs');
function uuid(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)) return null;
  return pageId(value);
}
function nativeContext(input = {}, fallbackSpaceId) {
  const context = input.threadContext;
  return {
    workspace_id: uuid(input.spaceId || fallbackSpaceId),
    page_id: uuid(context?.currentBlockId),
    source: 'native-request',
    // Never reuse a previous turn's page when the latest native request omits it.
    page_context_present: !!uuid(context?.currentBlockId)
  };
}
const needsCurrentPage = prompt => /(?:当前|这个|此|本)页(?:面)?|\b(?:this|current) page\b/i.test(prompt);
module.exports = { nativeContext, needsCurrentPage, uuid };
