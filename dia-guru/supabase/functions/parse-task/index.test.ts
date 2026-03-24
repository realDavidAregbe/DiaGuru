import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "std/assert";

import { __test__ } from "./index.ts";

const {
  buildExtractionPrompts,
  cleanupQuestion,
  buildDeepSeekUserPrompt,
  pickDurationFromDuckling,
  pickDurationFromRegex,
  pickTemporalFromDuckling,
} = __test__;

function getPromptLine(prompt: string, prefix: string) {
  return prompt.split("\n").find((line) => line.startsWith(prefix)) ?? "";
}

Deno.test("cleanupQuestion flattens whitespace", () => {
  const prompt = cleanupQuestion("\nHow long will it take?\n");
  assertEquals(prompt, "How long will it take?");
});

Deno.test("cleanupQuestion returns null for blank input", () => {
  assertEquals(cleanupQuestion("   \n\t "), null);
});

Deno.test("buildDeepSeekUserPrompt embeds structured context", () => {
  const prompt = buildDeepSeekUserPrompt({
    content: "Finish the weekly summary",
    needed: ["estimated_minutes"],
    structured: { datetime: "2025-10-26T10:00:00Z", estimated_minutes: 45 },
    timezone: "America/New_York",
  });
  assertStringIncludes(prompt, "weekly summary");
  assertStringIncludes(prompt, "Missing fields: estimated_minutes");
  const alreadyParsedLine = getPromptLine(prompt, "Already parsed:");
  assertNotEquals(alreadyParsedLine, "");
  assertMatch(alreadyParsedLine, /\bestimated_minutes=45\b/);
  assertMatch(alreadyParsedLine, /\bdatetime=2025-10-26T10:00:00Z\b/);
});

Deno.test("buildDeepSeekUserPrompt mentions ambiguous time context", () => {
  const prompt = buildDeepSeekUserPrompt({
    content: "call mom at 6",
    needed: ["time_meridiem"],
    structured: {},
    timezone: "UTC",
    context: { ambiguousTime: "6" },
  });
  const normalized = prompt.toLowerCase();
  assertStringIncludes(normalized, "ambiguous time");
  assertStringIncludes(normalized, "6");
});

Deno.test("buildDeepSeekUserPrompt omits parsed line when nothing is parsed", () => {
  const prompt = buildDeepSeekUserPrompt({
    content: "Read two chapters",
    needed: ["estimated_minutes", "datetime"],
    structured: {},
    timezone: "UTC",
  });
  assertEquals(getPromptLine(prompt, "Already parsed:"), "");
});

Deno.test("buildDeepSeekUserPrompt includes parsed window details", () => {
  const prompt = buildDeepSeekUserPrompt({
    content: "Focus block",
    needed: ["estimated_minutes"],
    structured: {
      window: {
        start: "2026-01-10T10:00:00Z",
        end: "2026-01-10T11:00:00Z",
      },
    },
    timezone: "UTC",
  });
  const alreadyParsedLine = getPromptLine(prompt, "Already parsed:");
  assertStringIncludes(alreadyParsedLine, "window=");
  assertStringIncludes(alreadyParsedLine, "2026-01-10T10:00:00Z");
  assertStringIncludes(alreadyParsedLine, "2026-01-10T11:00:00Z");
});

Deno.test("buildExtractionPrompts includes local ISO with offset", () => {
  const referenceNow = new Date("2026-01-09T21:30:18.000Z");
  const { userPrompt } = buildExtractionPrompts({
    content: "Call a friend in 2 hours",
    timezone: "America/Chicago",
    referenceNow,
  });
  assertStringIncludes(userPrompt, "TimezoneOffsetMinutes: -360");
  assertStringIncludes(
    userPrompt,
    "Now (Local ISO): 2026-01-09T15:30:18-06:00",
  );
});

Deno.test("pickDurationFromRegex handles compact, fractional, and minute forms", () => {
  assertEquals(pickDurationFromRegex("plan for 1h 30m")?.minutes, 90);
  assertEquals(pickDurationFromRegex("plan for 1.5 hours")?.minutes, 90);
  assertEquals(pickDurationFromRegex("plan for 45 min")?.minutes, 45);
});

Deno.test("pickDurationFromRegex returns null when no valid duration is present", () => {
  assertEquals(pickDurationFromRegex("no duration here"), null);
  assertEquals(pickDurationFromRegex("0 hours"), null);
});

Deno.test("pickDurationFromDuckling supports seconds and normalized durations", () => {
  const fromSeconds = pickDurationFromDuckling([
    {
      dim: "duration",
      body: "90 seconds",
      value: { seconds: 90 },
    },
  ]);
  assertEquals(fromSeconds?.minutes, 2);
  assertEquals(fromSeconds?.source, "90 seconds");

  const fromNormalized = pickDurationFromDuckling([
    {
      dim: "duration",
      value: { normalized: { value: 2, unit: "hour" } },
    },
  ]);
  assertEquals(fromNormalized?.minutes, 120);
  assertEquals(fromNormalized?.source, "duckling");
});

Deno.test("pickTemporalFromDuckling supports value and partial interval", () => {
  const valueTemporal = pickTemporalFromDuckling([
    {
      dim: "time",
      body: "tomorrow at 8",
      value: { type: "value", value: "2026-01-10T08:00:00Z" },
    },
  ]);
  assertEquals(valueTemporal, {
    type: "value",
    iso: "2026-01-10T08:00:00Z",
    source: "tomorrow at 8",
  });

  const intervalTemporal = pickTemporalFromDuckling([
    {
      dim: "time",
      value: {
        type: "interval",
        from: { value: "2026-01-10T08:00:00Z" },
      },
    },
  ]);
  assertEquals(intervalTemporal?.type, "interval");
  assertEquals(intervalTemporal?.from, "2026-01-10T08:00:00Z");
  assertEquals(intervalTemporal?.to, undefined);
});
