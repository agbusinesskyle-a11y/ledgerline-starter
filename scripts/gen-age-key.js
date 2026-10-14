import { writeFile } from 'node:fs/promises';
import { generateIdentity, identityToRecipient } from 'age-encryption';
const path = process.argv[2];
if (!path) { console.error('usage: node scripts/gen-age-key.js <identity-file>'); process.exitCode = 1; }
else {
  try {
    const identity = await generateIdentity();
    await writeFile(path, `${identity}\n`, { mode: 0o600, flag: 'wx' });
    console.log(await identityToRecipient(identity));
  } catch { console.error('age key generation failed; use a new writable identity-file path'); process.exitCode = 1; }
}
