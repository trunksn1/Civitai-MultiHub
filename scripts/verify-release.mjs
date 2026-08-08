import { variantNames, verifyRelease } from "./release-lib.mjs";

const requested = process.argv[2] || "chrome";
const variants = requested === "all" ? variantNames() : [requested];

try {
  for (const variantName of variants) {
    const verified = await verifyRelease({ variantName });
    console.log(`Verified ${verified.variant} v${verified.version}`);
    console.log(`SHA-256: ${verified.sha256}`);
    console.log(`Files: ${verified.files.length}; bytes: ${verified.bytes}`);
  }
} catch (error) {
  console.error(`Release verification failed: ${error.message}`);
  process.exitCode = 1;
}
