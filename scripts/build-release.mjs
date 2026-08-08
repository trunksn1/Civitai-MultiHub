import { buildRelease, variantNames, verifyRelease } from "./release-lib.mjs";

const requested = process.argv[2] || "chrome";
const variants = requested === "all" ? variantNames() : [requested];

try {
  for (const variantName of variants) {
    const built = await buildRelease({ variantName });
    const verified = await verifyRelease({ variantName });
    console.log(`Built ${built.variant} v${built.version}`);
    console.log(`ZIP: ${verified.zipPath}`);
    console.log(`SHA-256: ${verified.sha256}`);
    console.log(`Files: ${verified.files.length}; bytes: ${verified.bytes}`);
  }
} catch (error) {
  console.error(`Release build failed: ${error.message}`);
  process.exitCode = 1;
}
