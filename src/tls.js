import fs from 'node:fs';
import os from 'node:os';
import selfsigned from 'selfsigned';

/**
 * Self-signed certificate so the same port also answers HTTPS. Browsers only allow the microphone on
 * secure pages; after you accept the certificate warning once, https://ip:port works for that.
 * The key never leaves this machine and is kept in .botdeck-cert.json (owner-only, git-ignored).
 */
export function loadOrCreateCert(file, extraHosts = []) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.key && c.cert && c.expires > Date.now() + 7 * 864e5) return c;
  } catch { /* create a new one */ }
  const ips = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.address) ips.add(i.address);
  const altNames = [{ type: 2, value: 'localhost' }];
  for (const h of extraHosts.filter(Boolean)) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) ips.add(h); else altNames.push({ type: 2, value: h });
  }
  for (const ip of ips) altNames.push({ type: 7, ip });
  const days = 365 * 3;
  const pems = selfsigned.generate([{ name: 'commonName', value: 'BotDeck' }], {
    days, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }],
  });
  const c = { key: pems.private, cert: pems.cert, expires: Date.now() + days * 864e5 };
  try { fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 }); } catch { /* read-only disk: regenerated next start */ }
  return c;
}
