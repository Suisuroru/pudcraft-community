import assert from "node:assert/strict";
import path from "node:path";
import { getPublicUrl, resolveLocalStorageTarget } from "../src/lib/storage";

function main() {
  process.env.STORAGE_DRIVER = "local";

  const modpackTarget = resolveLocalStorageTarget("pudcraft/modpacks/server-1/demo.mrpack");
  assert.equal(modpackTarget.visibility, "private");
  assert.equal(
    modpackTarget.absolutePath,
    path.join(process.cwd(), "storage", "modpacks", "server-1", "demo.mrpack"),
  );

  const iconTarget = resolveLocalStorageTarget("pudcraft/server-icons/server-1/icon.webp");
  assert.equal(iconTarget.visibility, "public");
  assert.equal(
    iconTarget.absolutePath,
    path.join(process.cwd(), "public", "uploads", "server-icons", "server-1", "icon.webp"),
  );

  const legacyInputs = [
    "pudcraft/avatars/user-1/avatar.webp",
    "/uploads/avatars/user-1/avatar.webp",
    "uploads/avatars/user-1/avatar.webp",
    "public/uploads/avatars/user-1/avatar.webp",
    "/Users/demo/app/public/uploads/avatars/user-1/avatar.webp",
    "https://static.example.com/uploads/avatars/user-1/avatar.webp?version=1",
  ] as const;

  for (const input of legacyInputs) {
    const url = getPublicUrl(input);
    assert.equal(url, "/uploads/avatars/user-1/avatar.webp");
  }

  assert.equal(getPublicUrl("/tmp/not-managed-file.png"), null);

  console.log("Storage compatibility checks passed.");
}

main();
