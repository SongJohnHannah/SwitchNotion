export const formulaId = n => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
export const formulaIds = { space: formulaId(1), collection: formulaId(2) };
export function formulaInput() {
  const { space, collection } = formulaIds;
  return { spaceId: space, traceId: formulaId(3), generateTitle: false, transcript: [
    { id: formulaId(4), type: 'config', value: { type: 'formulas', collectionId: collection,
      existingFormula: 'prop("单价") * prop("数量")', formulaErrors: [],
      valueTypes: [{ kind: 'ThisRow', type: { type: 'block', collection: { table: 'collection', id: collection, spaceId: space } } }],
      sourceProperty: { collectionId: collection, propertyId: 'sum' }, returnType: { type: 'number' } } },
    { id: formulaId(5), type: 'agent-record-map', threadRecordMap: { recordMap: {
      collection: { [collection]: { role: 'reader', value: { id: collection, space_id: space, name: [['合成账单']],
        schema: { cost: { name: '单价', type: 'number' }, qty: { name: '数量', type: 'number' }, sum: { name: '合计', type: 'formula' } },
        permissions: [{ user_id: 'must-not-forward' }] } } },
      block: { [formulaId(6)]: { role: 'reader', value: { id: formulaId(6), properties: { title: [['must-not-forward-private-row']] } } } },
      notion_user: { [formulaId(7)]: { value: { email: 'must-not-forward@example.test' } } }
    } } },
    { id: formulaId(8), type: 'user', value: [['将合计增加 927。']], userId: formulaId(9) }
  ] };
}
