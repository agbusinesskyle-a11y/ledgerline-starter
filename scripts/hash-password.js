import bcrypt from 'bcryptjs';
let password = '';
for await (const chunk of process.stdin) {
  password += chunk;
  if (Buffer.byteLength(password) > 4096) { console.error('password input too large'); process.exit(1); }
}
password = password.replace(/\r?\n$/, '');
if (!password || Buffer.byteLength(password) > 72) { console.error('password must be 1–72 UTF-8 bytes'); process.exitCode = 1; }
else console.log(await bcrypt.hash(password, 12));
