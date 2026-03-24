import { assertEquals, assertStrictEquals } from "std/assert";
import { extractGoogleError, parseEventDate } from "./index.ts";

Deno.test("extractGoogleError returns nested message", () => {
  const payload = {
    error: {
      message: "Invalid credentials",
      errors: [{ reason: "authError", message: "Invalid credentials" }],
    },
  };
  assertStrictEquals(extractGoogleError(payload), "Invalid credentials");
});

Deno.test("extractGoogleError falls back to top-level message", () => {
  const payload = { message: "Something went wrong" };
  assertStrictEquals(extractGoogleError(payload), "Something went wrong");
});

Deno.test("extractGoogleError falls back to nested reason", () => {
  const payload = {
    error: {
      errors: [{ reason: "authError" }],
    },
  };
  assertStrictEquals(extractGoogleError(payload), "authError");
});

Deno.test("extractGoogleError handles string and unknown payloads", () => {
  assertStrictEquals(extractGoogleError("raw-error"), "raw-error");
  assertStrictEquals(extractGoogleError({}), null);
  assertStrictEquals(extractGoogleError(null), null);
});

Deno.test("parseEventDate handles dateTime and date", () => {
  const dateTime = parseEventDate({ dateTime: "2025-10-25T10:00:00Z" });
  assertEquals(dateTime?.toISOString(), "2025-10-25T10:00:00.000Z");
  const date = parseEventDate({ date: "2025-10-26" });
  assertEquals(date?.toISOString(), "2025-10-26T00:00:00.000Z");
});

Deno.test("parseEventDate returns null for missing values", () => {
  assertStrictEquals(parseEventDate(null), null);
  assertStrictEquals(parseEventDate({}), null);
});
