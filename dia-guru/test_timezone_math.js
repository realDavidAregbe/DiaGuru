// Test timezone conversion math for sleep window calculation
// Run with: node test_timezone_math.js

const offsetMinutes = -360; // CST offset
const now = new Date(); // Current time

console.log("=== INPUTS ===");
console.log("Current time (UTC):", now.toISOString());
console.log("Offset minutes:", offsetMinutes);
console.log("Offset hours:", offsetMinutes / 60);

// Step 1: Calculate "local now" by shifting UTC time by offset
const localNowMs = now.getTime() + offsetMinutes * 60000;
const localDate = new Date(localNowMs);

console.log("\n=== STEP 1: Local Time Representation ===");
console.log("localNowMs:", localNowMs);
console.log("localDate (components treated as UTC):", localDate.toISOString());

// Step 2: Extract components
const localYear = localDate.getUTCFullYear();
const localMonth = localDate.getUTCMonth();
const localDay = localDate.getUTCDate();
const localHour = localDate.getUTCHours();

console.log("\n=== STEP 2: Extracted Components ===");
console.log("Year:", localYear);
console.log("Month:", localMonth, "(0-indexed, so", localMonth, "= November)");
console.log("Day:", localDay);
console.log("Hour:", localHour);

// Step 3: Check if past 22:00
const dayOffset = localHour >= 22 ? 1 : 0;

console.log("\n=== STEP 3: Day Offset ===");
console.log("Is hour >= 22?", localHour >= 22);
console.log("Day offset:", dayOffset);

// Step 4: Build timestamps
const localNightStartMs = Date.UTC(localYear, localMonth, localDay + dayOffset, 22, 0, 0, 0);
const localNightEndMs = Date.UTC(localYear, localMonth, localDay + dayOffset + 1, 7, 30, 0, 0);

console.log("\n=== STEP 4: Build Timestamps (as if local time were UTC) ===");
console.log("localNightStartMs:", localNightStartMs);
console.log("As date:", new Date(localNightStartMs).toISOString(), "(Nov 21/22, 22:00 'UTC')");
console.log("localNightEndMs:", localNightEndMs);
console.log("As date:", new Date(localNightEndMs).toISOString(), "(Nov 22/23, 07:30 'UTC')");

// Step 5: Convert to actual UTC
const nightStart = new Date(localNightStartMs - offsetMinutes * 60000);
const nightEnd = new Date(localNightEndMs - offsetMinutes * 60000);

console.log("\n=== STEP 5: Convert to Actual UTC ===");
console.log("Calculation: timestamp - offsetMinutes * 60000");
console.log("           = timestamp - (", offsetMinutes, "* 60000)");
console.log("           = timestamp - (", offsetMinutes * 60000, ")");
console.log("           = timestamp + ", -offsetMinutes * 60000, "(adding", -offsetMinutes / 60, "hours)");

console.log("\n=== FINAL RESULT ===");
console.log("nightStart (UTC):", nightStart.toISOString());
console.log("nightEnd (UTC):", nightEnd.toISOString());

// Verify conversion back
const verifyStart = new Date(nightStart.getTime() - 6 * 60 * 60 * 1000);
const verifyEnd = new Date(nightEnd.getTime() - 6 * 60 * 60 * 1000);
console.log("\n=== VERIFICATION (subtract 6 hours to get CST) ===");
console.log("nightStart - 6hrs:", verifyStart.toISOString(), "(should show 22:00)");
console.log("nightEnd - 6hrs:", verifyEnd.toISOString(), "(should show 07:30)");

console.log("\n=== EXPECTED VALUES ===");
console.log("window_start should be: 2025-11-22T04:00:00.000Z");
console.log("window_end should be:   2025-11-22T13:30:00.000Z");
console.log("\n=== ACTUAL VALUES ===");
console.log("window_start:", nightStart.toISOString());
console.log("window_end:", nightEnd.toISOString());
console.log("\n=== MATCH? ===");
console.log("Start matches?", nightStart.toISOString() === "2025-11-22T04:00:00.000Z");
console.log("End matches?", nightEnd.toISOString() === "2025-11-22T13:30:00.000Z");
