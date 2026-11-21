/** @file Repeatable offline creation of FCPLCn deployment secrets and broker TLS identity. */
import { randomBytes, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.umask(0o077);
const root = '/state/private';
const broker = '/state/broker';
const cloud = '/state/cloud';
const host = '/state/host';

/** Run a fixed utility with private arguments, discarding output that could contain credentials. */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'pipe', timeout: 30000 });
  if (result.status !== 0) throw new Error(`Deployment utility failed: ${command}`);
}

/** Reject unexpected links and enforce the numeric identities used by the runtime images. */
function directory(path, uid, gid, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error('Deployment storage must contain regular directories.');
  chownSync(path, uid, gid);
  chmodSync(path, mode);
}

/** Persist private data atomically; a process interruption never publishes a partial key. */
function atomic(path, data, uid, gid, mode = 0o600) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('Deployment storage contains an unexpected file.');
  const next = path + '.next-' + randomBytes(6).toString('hex');
  let fd;
  try {
    fd = openSync(next, 'wx', mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chownSync(next, uid, gid);
    chmodSync(next, mode);
    renameSync(next, path);
    const parent = openSync(dirname(path), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(next, { force: true });
  }
}

/** Existing secrets remain byte-for-byte unchanged on every repeat of setup. */
function secret(path, create, uid, gid) {
  if (!existsSync(path)) atomic(path, create() + '\n', uid, gid);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('A deployment secret is not a regular file.');
  chownSync(path, uid, gid);
  chmodSync(path, 0o600);
  const value = readFileSync(path, 'utf8').trim();
  if (!value || value.length > 4096) throw new Error('A deployment secret is empty or invalid.');
  return value;
}

/** Bootstrap one service account; individual hub roles are provisioned later by BrokerAdmin. */
function initializeBroker(username, password) {
  const file = join(broker, 'dynamic-security.json');
  if (!existsSync(file)) {
    const temporary = join(broker, 'initial-security-' + randomBytes(6).toString('hex') + '.json');
    try {
      run('mosquitto_ctrl', ['dynsec', 'init', temporary, username, password]);
      const initial = JSON.parse(readFileSync(temporary, 'utf8'));
      const client = initial.clients?.find((entry) => entry.username === username);
      if (!client?.password || !client.salt)
        throw new Error('Could not initialize broker account.');
      client.roles = [{ rolename: 'fcplcn-cloud-service', priority: 1 }];
      const acl = (acltype, topic) => ({ acltype, topic, allow: true, priority: 1 });
      const received = ['hello', 'state', 'reply'].map((part) => `fcplcn-cloud/v1/hubs/+/${part}`);
      const response = '$CONTROL/dynamic-security/v1/response';
      atomic(
        file,
        JSON.stringify(
          {
            clients: [client],
            groups: [],
            roles: [
              {
                rolename: 'fcplcn-cloud-service',
                acls: [
                  acl('publishClientSend', '$CONTROL/dynamic-security/v1'),
                  acl('publishClientReceive', response),
                  acl('subscribeLiteral', response),
                  acl('unsubscribeLiteral', response),
                  acl('publishClientSend', 'fcplcn-cloud/v1/hubs/+/request'),
                  ...received.flatMap((topic) => [
                    acl('publishClientReceive', topic),
                    acl('subscribeLiteral', topic),
                    acl('unsubscribeLiteral', topic),
                  ]),
                ],
              },
            ],
            defaultACLAccess: {
              publishClientSend: false,
              publishClientReceive: false,
              subscribe: false,
              unsubscribe: false,
            },
          },
          null,
          2,
        ) + '\n',
        1883,
        1883,
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const existing = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !existing.clients?.some((client) => client.username === username) ||
    Object.values(existing.defaultACLAccess || {}).length !== 4 ||
    Object.values(existing.defaultACLAccess).some((value) => value !== false)
  )
    throw new Error('Existing broker security does not match this deployment; it was preserved.');
  chownSync(file, 1883, 1883);
  chmodSync(file, 0o600);
}

/** Keep the issuing CA stable; renew only the expiring server certificate or on explicit request. */
function certificates(domain, renew) {
  const issuer = join(root, 'issuer');
  const tls = join(broker, 'tls');
  directory(issuer, 0, 0);
  directory(tls, 1883, 1883);
  const caKey = join(issuer, 'ca.key');
  const caCert = join(issuer, 'ca.crt');
  if (existsSync(caKey) !== existsSync(caCert))
    throw new Error('The existing broker CA is incomplete; no key was replaced.');
  if (!existsSync(caKey)) {
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-sha256',
      '-days',
      '3650',
      '-subj',
      '/CN=FCPLCn private broker CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',
      caKey,
      '-out',
      caCert,
    ]);
  }
  chmodSync(caKey, 0o600);
  chmodSync(caCert, 0o600);
  const certificate = new X509Certificate(readFileSync(caCert));
  if (Date.parse(certificate.validTo) < Date.now() + 45 * 86400000)
    throw new Error('The broker CA is expiring. Plan an explicit CA migration and re-pair hubs.');
  const serverKey = join(tls, 'server.key');
  const serverCert = join(tls, 'server.crt');
  let matches = false;
  if (existsSync(serverCert)) {
    const saved = new X509Certificate(readFileSync(serverCert));
    matches = Boolean(
      saved.checkHost(domain) &&
      saved.checkHost('broker') &&
      saved.checkIP('127.0.0.1') &&
      saved.verify(certificate.publicKey),
    );
  }
  const valid =
    matches &&
    existsSync(serverKey) &&
    existsSync(serverCert) &&
    spawnSync('openssl', ['x509', '-checkend', '2592000', '-noout', '-in', serverCert], {
      stdio: 'pipe',
    }).status === 0;
  if (!valid || renew) {
    const temporary = join(issuer, 'server-' + randomBytes(6).toString('hex'));
    try {
      run('openssl', [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-subj',
        `/CN=${domain}`,
        '-keyout',
        temporary + '.key',
        '-out',
        temporary + '.csr',
      ]);
      atomic(
        temporary + '.ext',
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${domain},DNS:broker,DNS:localhost,IP:127.0.0.1,IP:::1\n`,
        0,
        0,
      );
      run('openssl', [
        'x509',
        '-req',
        '-in',
        temporary + '.csr',
        '-CA',
        caCert,
        '-CAkey',
        caKey,
        '-set_serial',
        '0x' + randomBytes(16).toString('hex'),
        '-days',
        '365',
        '-sha256',
        '-extfile',
        temporary + '.ext',
        '-out',
        temporary + '.crt',
      ]);
      atomic(serverKey, readFileSync(temporary + '.key'), 1883, 1883);
      atomic(serverCert, readFileSync(temporary + '.crt'), 1883, 1883);
    } finally {
      for (const extension of ['.key', '.csr', '.ext', '.crt'])
        rmSync(temporary + extension, { force: true });
    }
  }
  atomic(join(tls, 'ca.crt'), readFileSync(caCert), 1883, 1883);
  atomic(join(root, 'cloud', 'broker-ca.crt'), readFileSync(caCert), 1000, 1000);
  for (const path of [serverKey, serverCert]) {
    chownSync(path, 1883, 1883);
    chmodSync(path, 0o600);
  }
}

/** Initialize private volumes without opening listeners or altering an existing installation. */
function main() {
  if (process.argv.includes('--show-setup-key')) {
    const path = join(root, 'cloud', 'setup-key');
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('Run setup before retrieving the owner key.');
    process.stdout.write(readFileSync(path));
    return;
  }
  const domain = (process.env.FCPLCN_SETUP_DOMAIN || '').toLowerCase();
  const project = process.env.FCPLCN_SETUP_PROJECT || '';
  const uid = Number(process.env.FCPLCN_SETUP_UID);
  const gid = Number(process.env.FCPLCN_SETUP_GID);
  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      domain,
    ) ||
    !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(project) ||
    !Number.isInteger(uid) ||
    uid < 0 ||
    !Number.isInteger(gid) ||
    gid < 0
  )
    throw new Error('Specify a public DNS name and a valid deployment project.');
  const metadataFile = join(root, 'deployment.json');
  const existed = existsSync(metadataFile);
  if (existed) {
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    if (metadata.domain !== domain || metadata.project !== project)
      throw new Error(
        'Existing deployment belongs to another domain or project; it was preserved.',
      );
  }
  directory(root, 0, 0, 0o711);
  directory(join(root, 'cloud'), 1000, 1000);
  directory(join(root, 'postgres'), 70, 70);
  directory(broker, 1883, 1883);
  directory(cloud, 1000, 1000);
  directory(host, uid, gid);
  const bytes = () => randomBytes(32).toString('hex');
  const appPassword = secret(join(root, 'postgres', 'app-password'), bytes, 70, 70);
  secret(join(root, 'postgres', 'root-password'), bytes, 70, 70);
  secret(join(root, 'cloud', 'master-key'), bytes, 1000, 1000);
  secret(join(root, 'cloud', 'setup-key'), bytes, 1000, 1000);
  const username = secret(
    join(root, 'cloud', 'mqtt-username'),
    () => 'fcplcn-cloud-service',
    1000,
    1000,
  );
  const password = secret(join(root, 'cloud', 'mqtt-password'), bytes, 1000, 1000);
  const databaseUrl = `postgresql://fcplcn_app:${encodeURIComponent(appPassword)}@db:5432/fcplcn`;
  const savedUrl = secret(join(root, 'cloud', 'database-url'), () => databaseUrl, 1000, 1000);
  if (savedUrl !== databaseUrl)
    throw new Error('Database credentials do not match; existing data was preserved.');
  initializeBroker(username, password);
  certificates(domain, process.env.FCPLCN_SETUP_RENEW === '1');
  const environment = `FCPLCN_PROJECT=${project}\nFCPLCN_DOMAIN=${domain}\n`;
  const environmentFile = join(host, '.env');
  if (existsSync(environmentFile) && readFileSync(environmentFile, 'utf8') !== environment)
    throw new Error('Existing Compose environment does not match; it was preserved.');
  atomic(environmentFile, environment, uid, gid);
  if (!existed)
    atomic(
      metadataFile,
      JSON.stringify({ version: 1, project, domain, createdAt: new Date().toISOString() }) + '\n',
      0,
      0,
    );
}

try {
  main();
} catch (error) {
  // Utility output, secret values and connection URLs are deliberately never included here.
  console.error(error instanceof Error ? error.message : 'FCPLCn deployment setup failed.');
  process.exitCode = 1;
}
