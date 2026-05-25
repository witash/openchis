const chai = require('chai').use(require('chai-as-promised'));
const { expect } = chai;
const sinon = require('sinon');

const { write, sanitize, _sql } = require('../src/write');

const makeClient = () => ({
  query: sinon.stub().resolves({ rows: [] }),
});

describe('postgres-sync write', () => {
  afterEach(() => sinon.restore());

  it('issues no queries when records is empty/falsy', async () => {
    const client = makeClient();
    await write([], client);
    await write(null, client);
    await write(undefined, client);
    expect(client.query.callCount).to.equal(0);
  });

  it('emits a single bulk INSERT into documents for an array of records', async () => {
    const client = makeClient();
    const records = [
      {
        document: {
          _id: 'd1', _rev: '1-a',
          doc: { _id: 'd1', _rev: '1-a', type: 'data_record' },
          subject: 'p1', type: 'data_record', deleted: false,
        },
      },
      {
        document: {
          _id: 'd2', _rev: '1-b',
          doc: { _id: 'd2', _rev: '1-b', type: 'data_record' },
          subject: 'p2', type: 'data_record', deleted: false,
        },
      },
    ];
    await write(records, client);

    expect(client.query.callCount).to.equal(1);
    const [sql, params] = client.query.firstCall.args;
    expect(sql).to.match(/INSERT INTO\s+documents/);
    expect(sql).to.match(/ON CONFLICT\s*\(_id,\s*_rev\)\s*DO NOTHING/);
    expect(params).to.have.length(12);
    expect(params.slice(0, 6)).to.deep.equal([
      'd1', '1-a',
      JSON.stringify({ _id: 'd1', _rev: '1-a', type: 'data_record' }),
      'p1', 'data_record', false,
    ]);
    expect(params.slice(6)).to.deep.equal([
      'd2', '1-b',
      JSON.stringify({ _id: 'd2', _rev: '1-b', type: 'data_record' }),
      'p2', 'data_record', false,
    ]);
  });

  it('emits one bulk INSERT for documents and one for contacts per call', async () => {
    const client = makeClient();
    const records = [
      {
        document: {
          _id: 'c1', _rev: '1-aa',
          doc: { _id: 'c1', _rev: '1-aa', type: 'clinic' },
          subject: 'c1', type: 'clinic', deleted: false,
        },
        contact: {
          id: 'c1', type: 'clinic', contact_type: 'clinic',
          parent: 'd1', lineage: ['d1'],
          name: 'East Clinic', muted: null, phone: null, shortcode: null,
        },
      },
    ];
    await write(records, client);

    expect(client.query.callCount).to.equal(2);
    const docCall = client.query.firstCall;
    const contactCall = client.query.secondCall;

    expect(docCall.args[0]).to.match(/INSERT INTO\s+documents/);
    expect(contactCall.args[0]).to.match(/INSERT INTO\s+contacts/);
    expect(contactCall.args[0]).to.match(/ON CONFLICT\s*\(id\)\s*DO UPDATE SET/);

    expect(contactCall.args[1]).to.deep.equal([
      'c1', 'clinic', 'clinic', 'd1', ['d1'],
      'East Clinic', null, null, null,
    ]);
  });

  it('emits an UPSERT into reports when a report record is present', async () => {
    const client = makeClient();
    const records = [
      {
        document: {
          _id: 'r1', _rev: '1',
          doc: { _id: 'r1', _rev: '1', type: 'data_record' },
          subject: 'p1', type: 'data_record', deleted: false,
        },
        report: {
          id: 'r1', subject: 'p1', contact: 'c1',
          form: 'pregnancy', reported_date: 1234,
        },
      },
    ];
    await write(records, client);

    expect(client.query.callCount).to.equal(2);
    const reportCall = client.query.secondCall;
    expect(reportCall.args[0]).to.match(/INSERT INTO\s+reports/);
    expect(reportCall.args[0]).to.match(/ON CONFLICT\s*\(id\)\s*DO UPDATE SET/);
    expect(reportCall.args[1]).to.deep.equal(['r1', 'p1', 'c1', 'pregnancy', 1234]);
  });

  it('emits an UPSERT into tasks when a task record is present', async () => {
    const client = makeClient();
    const records = [
      {
        document: {
          _id: 't1', _rev: '1',
          doc: { _id: 't1', _rev: '1', type: 'task' },
          subject: 'u1', type: 'task', deleted: false,
        },
        task: {
          id: 't1', owner: 'c1', requester: 'c2', state: 'Ready',
        },
      },
    ];
    await write(records, client);

    expect(client.query.callCount).to.equal(2);
    const taskCall = client.query.secondCall;
    expect(taskCall.args[0]).to.match(/INSERT INTO\s+tasks/);
    expect(taskCall.args[0]).to.match(/ON CONFLICT\s*\(id\)\s*DO UPDATE SET/);
    expect(taskCall.args[1]).to.deep.equal(['t1', 'c1', 'c2', 'Ready']);
  });

  it('writes tombstones with deleted = true, subject/type null', async () => {
    const client = makeClient();
    const records = [
      {
        document: {
          _id: 't1', _rev: '3-tomb',
          doc: { _id: 't1', _rev: '3-tomb', _deleted: true },
          subject: null, type: null, deleted: true,
        },
      },
    ];
    await write(records, client);

    const params = client.query.firstCall.args[1];
    expect(params[0]).to.equal('t1');
    expect(params[1]).to.equal('3-tomb');
    expect(params[3]).to.equal(null);
    expect(params[4]).to.equal(null);
    expect(params[5]).to.equal(true);
    expect(JSON.parse(params[2])).to.deep.equal({
      _id: 't1', _rev: '3-tomb', _deleted: true,
    });
  });

  it('passes through stringified doc bodies and sanitises null bytes', async () => {
    const client = makeClient();
    const nul = String.fromCharCode(0);
    const dirty = JSON.stringify({ _id: 'd1', _rev: '1', evil: `hel${nul}lo` });
    const records = [
      {
        document: {
          _id: 'd1', _rev: '1',
          doc: dirty,
          subject: null, type: null, deleted: false,
        },
      },
    ];
    await write(records, client);
    const cleaned = client.query.firstCall.args[1][2];
    expect(cleaned.indexOf(nul)).to.equal(-1);
    expect(cleaned).to.include('hello');
  });

  it('accepts a single (non-array) record', async () => {
    const client = makeClient();
    await write({
      document: {
        _id: 'r1', _rev: '1',
        doc: { _id: 'r1', _rev: '1' },
        subject: null, type: null, deleted: false,
      },
    }, client);
    expect(client.query.callCount).to.equal(1);
    expect(client.query.firstCall.args[1]).to.have.length(6);
  });

  it('propagates errors from the documents insert', async () => {
    const client = makeClient();
    client.query.onFirstCall().rejects(new Error('disk full'));
    await expect(write(
      [{ document: { _id: 'r1', _rev: '1', doc: {}, subject: null, type: null, deleted: false } }],
      client,
    )).to.eventually.be.rejectedWith('disk full');
  });
});

describe('postgres-sync write — sanitize', () => {
  it('strips literal U+0000 characters', () => {
    const dirty = 'hel' + String.fromCharCode(0) + 'lo';
    expect(sanitize(dirty)).to.equal('hello');
  });

  it('strips escaped \\u0000 sequences', () => {
    expect(sanitize('good\\u0000bad')).to.equal('goodbad');
  });

  it('returns undefined/null unchanged', () => {
    expect(sanitize(undefined)).to.equal(undefined);
    expect(sanitize(null)).to.equal(null);
  });
});

describe('postgres-sync write — SQL contract', () => {
  it('builds DO NOTHING conflict clause on documents', () => {
    expect(_sql.insertDocumentsSQL(1)).to.match(/ON CONFLICT\s*\(_id,\s*_rev\)\s*DO NOTHING/);
  });

  it('builds DO UPDATE conflict clause on contacts', () => {
    const sql = _sql.upsertContactsSQL(1);
    expect(sql).to.match(/ON CONFLICT\s*\(id\)\s*DO UPDATE SET/);
    expect(sql).to.match(/lineage\s*=\s*EXCLUDED\.lineage/);
  });

  it('builds DO UPDATE conflict clause on reports', () => {
    expect(_sql.upsertReportsSQL(1)).to.match(/ON CONFLICT\s*\(id\)\s*DO UPDATE SET/);
  });

  it('builds DO UPDATE conflict clause on tasks', () => {
    expect(_sql.upsertTasksSQL(1)).to.match(/ON CONFLICT\s*\(id\)\s*DO UPDATE SET/);
  });
});
