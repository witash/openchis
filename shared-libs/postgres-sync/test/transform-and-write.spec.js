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
const matchInsertDoc = () => matchContains('INSERT INTO documents');
const matchInsertContacts = () => matchContains('INSERT INTO contacts');
const matchInsertReports = () => matchContains('INSERT INTO reports');
const matchInsertTasks = () => matchContains('INSERT INTO tasks');
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

  it('writes data_record docs to documents and reports', async () => {
    const client = makeClient();
    const docs = [
      { _id: 'r1', _rev: '1-a', type: 'data_record', form: 'p', fields: { patient_id: 'pa' } },
      { _id: 'r2', _rev: '1-b', type: 'data_record', form: 'p', fields: { patient_id: 'pb' } },
    ];
    await transformAndWrite(docs, client);

    const docInserts = client.query.withArgs(matchInsertDoc()).getCalls();
    expect(docInserts).to.have.length(1);
    expect(docInserts[0].args[1]).to.have.length(12); // 2 rows × 6 columns

    const reportInserts = client.query.withArgs(matchInsertReports()).getCalls();
    expect(reportInserts).to.have.length(1);
    expect(reportInserts[0].args[1]).to.have.length(10); // 2 rows × 5 columns

    expect(client.query.withArgs(matchSelectParents()).callCount).to.equal(0);
    expect(client.query.withArgs(matchInsertContacts()).callCount).to.equal(0);
  });

  it('writes task docs to documents and tasks', async () => {
    const client = makeClient();
    await transformAndWrite([
      { _id: 't1', _rev: '1', type: 'task', owner: 'p1', requester: 'c1', state: 'Ready' },
    ], client);

    expect(client.query.withArgs(matchInsertDoc()).callCount).to.equal(1);
    const taskInsert = client.query.withArgs(matchInsertTasks()).firstCall;
    expect(taskInsert.args[1]).to.deep.equal(['t1', 'p1', 'c1', 'Ready']);
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
      { _id: 'r1', _rev: '1', type: 'district_hospital', name: 'C' },
    ];
    await transformAndWrite(docs, client);

    const selectCalls = client.query.withArgs(matchSelectParents()).getCalls();
    expect(selectCalls).to.have.length(1);
    expect(selectCalls[0].args[1]).to.deep.equal([['h1']]);

    const contactInserts = client.query.withArgs(matchInsertContacts()).getCalls();
    expect(contactInserts).to.have.length(1);
    const params = contactInserts[0].args[1];
    expect(params).to.have.length(27);
    expect(params[4]).to.deep.equal(['h1', 'd1']);
    expect(params[13]).to.deep.equal(['h1', 'd1']);
    expect(params[22]).to.deep.equal([]);
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
    client.query.withArgs(matchSelectParents()).resolves({ rows: [] });
    const docs = [
      { _id: 'd1', _rev: '1', type: 'district_hospital' },
      { _id: 'h1', _rev: '1', type: 'health_center', parent: { _id: 'd1' } },
      { _id: 'c1', _rev: '1', type: 'clinic', parent: { _id: 'h1' } },
      { _id: 'p1', _rev: '1', type: 'person', parent: { _id: 'c1' } },
    ];
    await transformAndWrite(docs, client);

    expect(client.query.withArgs(matchSelectParents()).callCount).to.equal(0);

    const params = client.query.withArgs(matchInsertContacts()).firstCall.args[1];
    expect(params[4]).to.deep.equal([]);
    expect(params[13]).to.deep.equal(['d1']);
    expect(params[22]).to.deep.equal(['h1', 'd1']);
    expect(params[31]).to.deep.equal(['c1', 'h1', 'd1']);
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
    expect(insert.args[1]).to.have.length(6);
    expect(insert.args[1][0]).to.equal('good');
  });

  it('writes tombstones (docs with _deleted: true) to documents only', async () => {
    const client = makeClient();
    await transformAndWrite([
      { _id: 't1', _rev: '3-tomb', _deleted: true },
    ], client);

    const insert = client.query.withArgs(matchInsertDoc()).firstCall;
    expect(insert.args[1][5]).to.equal(true);  // deleted
    expect(insert.args[1][3]).to.equal(null);  // subject
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
