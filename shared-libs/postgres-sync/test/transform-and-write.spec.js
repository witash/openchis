const chai = require('chai').use(require('chai-as-promised'));
const { expect } = chai;
const sinon = require('sinon');

const { transformAndWrite } = require('../src');

const makeClient = () => {
  const query = sinon.stub().resolves({ rows: [] });
  return { query };
};

const matchContains = (substr) => sinon.match(
  (value) => typeof value === 'string' && value.includes(substr),
  `query containing "${substr}"`,
);
const matchInsertDoc = () => matchContains('INSERT INTO medic_documents');
const matchInsertContacts = () => matchContains('INSERT INTO contacts');
const matchSelectParents = () => matchContains('SELECT id, lineage FROM contacts');

describe('postgres-sync transformAndWrite', () => {
  afterEach(() => sinon.restore());

  it('is a no-op for empty/falsy input', async () => {
    const client = makeClient();
    await transformAndWrite([], client);
    await transformAndWrite(null, client);
    await transformAndWrite(undefined, client);
    expect(client.query.callCount).to.equal(0);
  });

  it('writes all non-contact docs in a single medic_documents INSERT', async () => {
    const client = makeClient();
    const docs = [
      { _id: 'r1', _rev: '1-a', type: 'data_record', form: 'p', fields: { patient_id: 'pa' } },
      { _id: 'r2', _rev: '1-b', type: 'data_record', form: 'p', fields: { patient_id: 'pb' } },
    ];
    await transformAndWrite(docs, client);

    const docInserts = client.query.withArgs(matchInsertDoc()).getCalls();
    expect(docInserts).to.have.length(1);
    expect(docInserts[0].args[1]).to.have.length(14); // 2 rows × 7 columns
    expect(docInserts[0].args[1][0]).to.equal('r1');
    expect(docInserts[0].args[1][7]).to.equal('r2');

    // No contact records means no parents lookup and no contacts insert.
    expect(client.query.withArgs(matchSelectParents()).callCount).to.equal(0);
    expect(client.query.withArgs(matchInsertContacts()).callCount).to.equal(0);
  });

  it('looks up parents in one round trip and stamps lineage on contact records', async () => {
    const client = makeClient();
    client.query.withArgs(matchSelectParents()).resolves({
      rows: [
        { id: 'd1', lineage: [] },
        { id: 'h1', lineage: ['d1'] },
      ],
    });
    const docs = [
      { _id: 'c1', _rev: '1', type: 'clinic', name: 'A', parent: { _id: 'h1' } },
      { _id: 'c2', _rev: '1', type: 'clinic', name: 'B', parent: 'h1' },
      { _id: 'r1', _rev: '1', type: 'district_hospital', name: 'C' }, // no parent
    ];
    await transformAndWrite(docs, client);

    const selectCalls = client.query.withArgs(matchSelectParents()).getCalls();
    expect(selectCalls).to.have.length(1);
    // Parents are deduped and only `h1` is referenced.
    expect(selectCalls[0].args[1]).to.deep.equal([['h1']]);

    const contactInserts = client.query.withArgs(matchInsertContacts()).getCalls();
    expect(contactInserts).to.have.length(1);
    // 3 contacts × 9 cols = 27 params. Column 5 (index 4) per row is lineage.
    const params = contactInserts[0].args[1];
    expect(params).to.have.length(27);
    expect(params[4]).to.deep.equal(['h1', 'd1']);   // c1: [parent, ...parentLineage]
    expect(params[13]).to.deep.equal(['h1', 'd1']);  // c2: same parent → same lineage
    expect(params[22]).to.deep.equal([]);            // r1: no parent → []
  });

  it('falls back to [parentId] when the parent is not in contacts yet', async () => {
    const client = makeClient();
    client.query.withArgs(matchSelectParents()).resolves({ rows: [] });
    await transformAndWrite([
      { _id: 'orphan', _rev: '1', type: 'person', parent: { _id: 'future' } },
    ], client);

    const insert = client.query.withArgs(matchInsertContacts()).firstCall;
    expect(insert.args[1][4]).to.deep.equal(['future']);
  });

  it('threads in-batch ancestors into descendants\' lineage in one pass', async () => {
    const client = makeClient();
    // None of the parents exist in pg yet — they are all part of this batch.
    client.query.withArgs(matchSelectParents()).resolves({ rows: [] });
    const docs = [
      { _id: 'd1', _rev: '1', type: 'district_hospital' },
      { _id: 'h1', _rev: '1', type: 'health_center', parent: { _id: 'd1' } },
      { _id: 'c1', _rev: '1', type: 'clinic', parent: { _id: 'h1' } },
      { _id: 'p1', _rev: '1', type: 'person', parent: { _id: 'c1' } },
    ];
    await transformAndWrite(docs, client);

    // The SELECT is skipped entirely when every parent is in the batch.
    expect(client.query.withArgs(matchSelectParents()).callCount).to.equal(0);

    // 4 contacts × 9 cols = 36 params. lineage at column index 4 of each row.
    const params = client.query.withArgs(matchInsertContacts()).firstCall.args[1];
    expect(params[4]).to.deep.equal([]);                       // d1
    expect(params[13]).to.deep.equal(['d1']);                  // h1
    expect(params[22]).to.deep.equal(['h1', 'd1']);            // c1
    expect(params[31]).to.deep.equal(['c1', 'h1', 'd1']);      // p1
  });

  it('issues exactly one INSERT per table for a mixed batch', async () => {
    const client = makeClient();
    client.query.withArgs(matchSelectParents()).resolves({
      rows: [{ id: 'h1', lineage: [] }],
    });
    const docs = [
      { _id: 'c1', _rev: '1', type: 'clinic', parent: { _id: 'h1' } },
      { _id: 'r1', _rev: '1', type: 'data_record', form: 'p', fields: { patient_id: 'p1' } },
      { _id: 'c2', _rev: '1', type: 'clinic', parent: { _id: 'h1' } },
    ];
    await transformAndWrite(docs, client);

    expect(client.query.withArgs(matchInsertDoc()).callCount).to.equal(1);
    expect(client.query.withArgs(matchInsertContacts()).callCount).to.equal(1);
  });

  it('skips docs that transform cannot interpret (missing _id/_rev)', async () => {
    const client = makeClient();
    const docs = [
      { _id: 'good', _rev: '1', type: 'data_record', form: 'p' },
      { _id: 'no-rev' },
      null,
      { _rev: '1' },
    ];
    await transformAndWrite(docs, client);

    const insert = client.query.withArgs(matchInsertDoc()).firstCall;
    expect(insert.args[1]).to.have.length(7);
    expect(insert.args[1][0]).to.equal('good');
  });

  it('writes tombstones (docs with _deleted: true) to medic_documents only', async () => {
    const client = makeClient();
    await transformAndWrite([
      { _id: 't1', _rev: '3-tomb', _deleted: true },
    ], client);

    const insert = client.query.withArgs(matchInsertDoc()).firstCall;
    expect(insert.args[1][6]).to.equal(true);
    expect(insert.args[1][4]).to.equal(null); // subject
    expect(client.query.withArgs(matchInsertContacts()).callCount).to.equal(0);
  });

  it('propagates a failing pg call', async () => {
    const client = makeClient();
    client.query.withArgs(matchInsertDoc()).rejects(new Error('disk full'));
    await expect(transformAndWrite(
      [{ _id: 'r1', _rev: '1', type: 'data_record', form: 'p' }],
      client,
    )).to.eventually.be.rejectedWith('disk full');
  });
});
