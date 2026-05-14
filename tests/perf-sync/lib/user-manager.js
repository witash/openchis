'use strict';

// Create / tear down test users against a running CHT API.
//
// Each call hits /api/v1/users with admin credentials; the API creates the
// CouchDB user, the user-settings doc, and the place/contact. Teardown
// removes the user account and (best-effort) the seeded fixtures.

const buildAuth = (admin) => 'Basic ' + Buffer.from(`${admin.username}:${admin.password}`).toString('base64');

const buildUserPayload = ({ spec, hierarchy }) => {
  // Mirror the shape that /api/v1/users expects: contact + place inlined
  // along with the username, password, and roles.
  return {
    username: spec.username,
    password: spec.password,
    type: spec.type || 'person',
    roles: spec.roles || ['chw'],
    place: {
      _id: hierarchy.healthCenter._id,
      type: hierarchy.healthCenter.type,
      name: hierarchy.healthCenter.name,
      parent: hierarchy.healthCenter.parent,
    },
    contact: {
      _id: hierarchy.userContact._id,
      type: hierarchy.userContact.type,
      name: hierarchy.userContact.name,
      phone: hierarchy.userContact.phone,
    },
  };
};

class UserManager {
  constructor({ baseUrl, admin, fetchFn }) {
    this.baseUrl = baseUrl;
    this.admin = admin;
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  async createUser({ spec, hierarchy }) {
    const payload = buildUserPayload({ spec, hierarchy });
    const res = await this.fetchFn(`${this.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: buildAuth(this.admin),
      },
      body: JSON.stringify(payload),
    });
    if (!res || !res.ok) {
      const text = res && typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`createUser ${spec.username} failed status=${res && res.status} body=${text}`);
    }
    return res.json();
  }

  async deleteUser({ username }) {
    const res = await this.fetchFn(`${this.baseUrl}/api/v1/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { Authorization: buildAuth(this.admin) },
    });
    if (!res || !res.ok) {
      const text = res && typeof res.text === 'function' ? await res.text() : '';
      // Don't throw — teardown is best-effort. The caller logs.
      return { ok: false, status: res && res.status, body: text };
    }
    return { ok: true };
  }

  async createMany({ specs, hierarchies }) {
    const out = [];
    for (let i = 0; i < specs.length; i++) {
      const created = await this.createUser({ spec: specs[i], hierarchy: hierarchies[i] });
      out.push(created);
    }
    return out;
  }

  async deleteMany({ specs }) {
    const out = [];
    for (const spec of specs) {
      out.push(await this.deleteUser({ username: spec.username }));
    }
    return out;
  }
}

module.exports = {
  UserManager,
  buildAuth,
  buildUserPayload,
};
