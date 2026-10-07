const encoder = new TextEncoder();
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid encoding");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function issueCredential(
  project: string,
  secret: string,
  now = Date.now(),
) {
  const payload = base64(
    encoder.encode(
      JSON.stringify({
        project,
        nonce: crypto.randomUUID(),
        expires: Math.floor(now / 1000) + 30 * 86400,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(payload),
  );
  return `mp.${payload}.${base64(new Uint8Array(signature))}`;
}
/** Reject random/forged/expired credentials before contacting a Durable Object. Roles/revocation still require SQLite. */
export async function verifyCredential(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    if (token.length > 256) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "mp") return false;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decode(parts[2]),
        encoder.encode(parts[1]),
      ))
    )
      return false;
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    return (
      typeof payload.project === "string" &&
      /^[a-zA-Z0-9_-]{1,40}$/.test(payload.project) &&
      typeof payload.nonce === "string" &&
      Number.isSafeInteger(payload.expires) &&
      payload.expires > Math.floor(now / 1000)
    );
  } catch {
    return false;
  }
}
