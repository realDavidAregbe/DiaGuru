import { assertEquals } from "std/assert";

import { corsHeaders, json, maybeHandleCors } from "./cors.ts";

Deno.test("maybeHandleCors returns a preflight response for OPTIONS", async () => {
  const response = maybeHandleCors(
    new Request("https://example.com", { method: "OPTIONS" }),
  );

  assertEquals(response?.status, 200);
  assertEquals(
    response?.headers.get("Access-Control-Allow-Origin"),
    corsHeaders["Access-Control-Allow-Origin"],
  );
  assertEquals(await response?.text(), "ok");
});

Deno.test("maybeHandleCors ignores non-preflight requests", () => {
  const response = maybeHandleCors(
    new Request("https://example.com", { method: "POST" }),
  );

  assertEquals(response, null);
});

Deno.test("json includes cors and content-type headers", async () => {
  const response = json({ ok: true }, 201);

  assertEquals(response.status, 201);
  assertEquals(response.headers.get("Content-Type"), "application/json");
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    corsHeaders["Access-Control-Allow-Headers"],
  );
  assertEquals(await response.json(), { ok: true });
});
