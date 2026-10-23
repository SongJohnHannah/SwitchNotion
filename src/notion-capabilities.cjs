// Page-content capabilities only; workspace/account administration is excluded.
const suites = [require('./notion-pages.cjs'), require('./notion-databases.cjs'), require('./notion-blocks.cjs'), require('./notion-collaboration.cjs')];
const definitions = suites.flatMap(suite => suite.definitions);
if (new Set(definitions.map(d => d.function.name)).size !== definitions.length) throw Error('Duplicate Notion capability name');
const writeTools = new Set(['append_page', 'replace_page_text', ...suites.flatMap(suite => [...suite.writeTools])]);
function createSession(context) {
  const sessions = suites.map(suite => ({ names: new Set(suite.definitions.map(d => d.function.name)), session: suite.createSession(context) }));
  return { execute: (name, args) => {
    const handler = sessions.find(item => item.names.has(name));
    if (!handler) throw Error('Notion 未启用此内容操作工具。');
    return handler.session.execute(name, args);
  } };
}
module.exports = { definitions, writeTools, createSession };
