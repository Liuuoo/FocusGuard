const fs = require("fs");
const crypto = require("crypto");

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("Usage: node src/extension-id.js <private-key.pem>");
  process.exit(1);
}

const privateKey = fs.readFileSync(keyPath, "utf8");
const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
const digest = crypto.createHash("sha256").update(publicKey).digest();
let extensionId = "";

for (const byte of digest.subarray(0, 16)) {
  extensionId += String.fromCharCode(97 + ((byte >> 4) & 0x0f));
  extensionId += String.fromCharCode(97 + (byte & 0x0f));
}

process.stdout.write(extensionId);
