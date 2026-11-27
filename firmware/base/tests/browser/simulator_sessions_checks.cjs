/** @file Verify isolated desktop browsers cannot revoke each other's simulator session. */
'use strict';
const assert = require('node:assert/strict');

async function checkSimulatorSessions({ browser, createMock }) {
  let now = Date.now();
  const mock = createMock({ interactive: true, sessionNow: () => now });
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  const first = await browser.newContext();
  const second = await browser.newContext();
  const get = (client) => client.request.get(base + '/api/v1/config');
  const post = (client, route, data = {}) =>
    client.request.post(base + '/api/v1' + route, { data });
  const login = async (client) => {
    assert.equal((await post(client, '/login', { username: 'admin', password: '' })).status(), 200);
    return (await client.cookies(base)).find((cookie) => cookie.name === 'session').value;
  };
  try {
    const oldToken = await login(first);
    const otherToken = await login(second);
    assert.notEqual(oldToken, otherToken);
    assert.equal((await get(first)).status(), 200, 'A new browser login keeps the first signed in');
    assert.equal((await get(second)).status(), 200);
    await login(first);
    assert.equal(
      (
        await first.request.get(base + '/api/v1/config', {
          headers: { Cookie: `session=${oldToken}` },
        })
      ).status(),
      401,
      'Re-login rotates only that browser’s prior token',
    );
    assert.equal((await get(second)).status(), 200);
    assert.equal((await post(first, '/logout')).status(), 200);
    assert.equal((await get(first)).status(), 401);
    assert.equal((await get(second)).status(), 200, 'Logout revokes only the presented session');

    now += 8 * 60 * 60 * 1000 - 1;
    assert.equal((await get(second)).status(), 200);
    now += 1;
    assert.equal(
      (await get(second)).status(),
      401,
      'Reads do not extend the fixed eight-hour expiry',
    );

    await login(first);
    await login(second);
    assert.equal((await post(first, '/reboot')).status(), 200);
    const deadline = Date.now() + 3000;
    while ((await get(first)).status() !== 401) {
      assert.ok(Date.now() < deadline, 'Simulated reboot must revoke sessions');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await get(second)).status(), 401, 'Reboot revokes every browser session');
    console.log(
      'FCPLCn interactive sessions passed: concurrent browsers, isolated token rotation/logout, fixed expiry and reboot revocation.',
    );
  } finally {
    await first.close();
    await second.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}
module.exports = { checkSimulatorSessions };
