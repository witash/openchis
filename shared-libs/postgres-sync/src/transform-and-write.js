const { transform } = require('./transform');
const { write } = require('./write');

const SELECT_CONTACTS_BY_IDS = 'SELECT id, lineage FROM contacts WHERE id = ANY($1)';

// Look up parents in a single query and stamp `lineage` onto each contact
// record. Lineage for a contact is `[parentId, ...parentLineage]`. When a
// parent is not (yet) in the contacts table, fall back to `[parentId]`; a
// later parent write/cascade will repair it. Contacts with no parent get [].
const stampLineages = async (records, pgClient) => {
  const contactRecords = records.filter(r => r.contact);
  if (!contactRecords.length) {
    return;
  }
  const parentIds = [...new Set(
    contactRecords.map(r => r.contact.parent).filter(Boolean)
  )];
  const parentLineages = {};
  if (parentIds.length) {
    const result = await pgClient.query(SELECT_CONTACTS_BY_IDS, [parentIds]);
    const rows = (result && result.rows) || [];
    for (const row of rows) {
      parentLineages[row.id] = row.lineage || [];
    }
  }
  for (const r of contactRecords) {
    const parent = r.contact.parent;
    if (!parent) {
      r.contact.lineage = [];
    } else if (Object.prototype.hasOwnProperty.call(parentLineages, parent)) {
      r.contact.lineage = [parent, ...parentLineages[parent]];
    } else {
      r.contact.lineage = [parent];
    }
  }
};

// Bulk transform a batch of docs and write them to Postgres.
// One bulk INSERT per table per call (medic_documents, then contacts).
// Empty input is a no-op. A failing pg call propagates.
const transformAndWrite = async (docs, pgClient) => {
  if (!docs || !docs.length) {
    return;
  }
  const records = [];
  for (const doc of docs) {
    const record = transform(doc);
    if (record) {
      records.push(record);
    }
  }
  if (!records.length) {
    return;
  }
  await stampLineages(records, pgClient);
  await write(records, pgClient);
};

module.exports = {
  transformAndWrite,
  _stampLineages: stampLineages,
  _sql: {
    SELECT_CONTACTS_BY_IDS,
  },
};
