import { describe, it, expect as vitestExpect, vi, beforeEach, afterEach } from "vitest";
import { expect as tapsmithExpect, flushSoftErrors, takeSoftErrors } from "../expect.js";
import { ElementHandle } from "../element-handle.js";
import { _text } from "../selectors.js";
import type {
  TapsmithGrpcClient,
  FindElementResponse,
  ElementInfo,
} from "../grpc-client.js";

// ─── Helpers ───

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: "el-1",
    className: "android.widget.TextView",
    text: "",
    contentDescription: "",
    resourceId: "",
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: "",
    checked: false,
    selected: false,
    focused: false,
    role: "",
    viewportRatio: 1.0,
    ...overrides,
  };
}

function makeMockClient(
  findElementImpl: () => Promise<FindElementResponse>,
): TapsmithGrpcClient {
  return {
    findElement: vi.fn(findElementImpl),
    // Assertions resolve through findElements (strict mode, PILOT-226) —
    // derive the list from the single-element impl.
    findElements: vi.fn(async () => {
      const res = await findElementImpl();
      return {
        requestId: "1",
        elements: res.found && res.element ? [res.element] : [],
        errorMessage: "",
      };
    }),
  } as unknown as TapsmithGrpcClient;
}

function makeHandle(
  client: TapsmithGrpcClient,
  selector = _text("Hello"),
  timeoutMs = 100,
): ElementHandle {
  return new ElementHandle(client, selector, timeoutMs);
}

// ════════════════════════════════════════════════════════════════
// PILOT-42: Generic value assertions
// ════════════════════════════════════════════════════════════════

describe("PILOT-42: Generic value assertions", () => {
  // ─── toBe ───
  describe("toBe()", () => {
    it("passes for strict equality", () => {
      tapsmithExpect(5).toBe(5);
      tapsmithExpect("hello").toBe("hello");
      tapsmithExpect(true).toBe(true);
      tapsmithExpect(null).toBe(null);
    });

    it("fails when values differ", () => {
      vitestExpect(() => tapsmithExpect(5).toBe(6)).toThrow(
        'Expected 5 to be 6',
      );
    });

    it("uses Object.is semantics (NaN === NaN, +0 !== -0)", () => {
      tapsmithExpect(NaN).toBe(NaN);
      vitestExpect(() => tapsmithExpect(+0).toBe(-0)).toThrow();
    });

    it("does not deep-compare objects", () => {
      vitestExpect(() => tapsmithExpect({ a: 1 }).toBe({ a: 1 })).toThrow();
    });

    it("works with .not", () => {
      tapsmithExpect(5).not.toBe(6);
      vitestExpect(() => tapsmithExpect(5).not.toBe(5)).toThrow(
        'Expected 5 not to be 5',
      );
    });
  });

  // ─── toEqual ───
  describe("toEqual()", () => {
    it("passes for deep equality", () => {
      tapsmithExpect({ a: 1, b: [2, 3] }).toEqual({ a: 1, b: [2, 3] });
      tapsmithExpect([1, 2, 3]).toEqual([1, 2, 3]);
    });

    it("fails when deeply different", () => {
      vitestExpect(() =>
        tapsmithExpect({ a: 1 }).toEqual({ a: 2 }),
      ).toThrow("to equal");
    });

    it("fails for objects with same number of keys but different key names", () => {
      vitestExpect(() =>
        tapsmithExpect({ a: 1, b: 2 }).toEqual({ a: 1, c: 2 }),
      ).toThrow("to equal");
    });

    it("compares dates by value", () => {
      tapsmithExpect(new Date("2024-01-01")).toEqual(new Date("2024-01-01"));
    });

    it("compares regexes by string representation", () => {
      tapsmithExpect(/abc/gi).toEqual(/abc/gi);
      vitestExpect(() => tapsmithExpect(/abc/g).toEqual(/abc/i)).toThrow();
    });

    it("works with .not", () => {
      tapsmithExpect({ a: 1 }).not.toEqual({ a: 2 });
    });

    it("handles circular references", () => {
      const a: Record<string, unknown> = { x: 1 };
      a.self = a;
      const b: Record<string, unknown> = { x: 1 };
      b.self = b;
      tapsmithExpect(a).toEqual(b);
    });

    it("handles circular references that differ", () => {
      const a: Record<string, unknown> = { x: 1 };
      a.self = a;
      const b: Record<string, unknown> = { x: 2 };
      b.self = b;
      vitestExpect(() => tapsmithExpect(a).toEqual(b)).toThrow("to equal");
    });
  });

  // ─── toStrictEqual ───
  describe("toStrictEqual()", () => {
    it("passes for identical structure and types", () => {
      tapsmithExpect({ a: 1 }).toStrictEqual({ a: 1 });
    });

    it("fails when undefined property is missing vs present", () => {
      vitestExpect(() =>
        tapsmithExpect({ a: 1, b: undefined }).toStrictEqual({ a: 1 }),
      ).toThrow("to strictly equal");
    });

    it("fails for different constructors", () => {
      class A { x = 1; }
      class B { x = 1; }
      vitestExpect(() =>
        tapsmithExpect(new A()).toStrictEqual(new B()),
      ).toThrow();
    });

    it("handles circular references", () => {
      const a: Record<string, unknown> = { x: 1 };
      a.self = a;
      const b: Record<string, unknown> = { x: 1 };
      b.self = b;
      tapsmithExpect(a).toStrictEqual(b);
    });
  });

  // ─── toBeTruthy / toBeFalsy ───
  describe("toBeTruthy()", () => {
    it("passes for truthy values", () => {
      tapsmithExpect(1).toBeTruthy();
      tapsmithExpect("hello").toBeTruthy();
      tapsmithExpect([]).toBeTruthy();
      tapsmithExpect({}).toBeTruthy();
    });

    it("fails for falsy values", () => {
      vitestExpect(() => tapsmithExpect(0).toBeTruthy()).toThrow("to be truthy");
      vitestExpect(() => tapsmithExpect("").toBeTruthy()).toThrow();
      vitestExpect(() => tapsmithExpect(null).toBeTruthy()).toThrow();
      vitestExpect(() => tapsmithExpect(undefined).toBeTruthy()).toThrow();
    });
  });

  describe("toBeFalsy()", () => {
    it("passes for falsy values", () => {
      tapsmithExpect(0).toBeFalsy();
      tapsmithExpect("").toBeFalsy();
      tapsmithExpect(null).toBeFalsy();
      tapsmithExpect(undefined).toBeFalsy();
      tapsmithExpect(false).toBeFalsy();
    });

    it("fails for truthy values", () => {
      vitestExpect(() => tapsmithExpect(1).toBeFalsy()).toThrow("to be falsy");
    });
  });

  // ─── toBeDefined / toBeUndefined / toBeNull / toBeNaN ───
  describe("toBeDefined()", () => {
    it("passes for defined values", () => {
      tapsmithExpect(0).toBeDefined();
      tapsmithExpect(null).toBeDefined();
      tapsmithExpect("").toBeDefined();
    });

    it("fails for undefined", () => {
      vitestExpect(() => tapsmithExpect(undefined).toBeDefined()).toThrow(
        "to be defined",
      );
    });
  });

  describe("toBeUndefined()", () => {
    it("passes for undefined", () => {
      tapsmithExpect(undefined).toBeUndefined();
    });

    it("fails for defined values", () => {
      vitestExpect(() => tapsmithExpect(null).toBeUndefined()).toThrow(
        "to be undefined",
      );
    });
  });

  describe("toBeNull()", () => {
    it("passes for null", () => {
      tapsmithExpect(null).toBeNull();
    });

    it("fails for non-null", () => {
      vitestExpect(() => tapsmithExpect(undefined).toBeNull()).toThrow("to be null");
    });

    it("works with .not", () => {
      tapsmithExpect(42).not.toBeNull();
    });
  });

  describe("toBeNaN()", () => {
    it("passes for NaN", () => {
      tapsmithExpect(NaN).toBeNaN();
    });

    it("fails for numbers", () => {
      vitestExpect(() => tapsmithExpect(42).toBeNaN()).toThrow("to be NaN");
    });
  });

  // ─── toContain ───
  describe("toContain()", () => {
    it("passes for string containing substring", () => {
      tapsmithExpect("hello world").toContain("world");
    });

    it("passes for array containing item", () => {
      tapsmithExpect([1, 2, 3]).toContain(2);
    });

    it("fails when not contained", () => {
      vitestExpect(() => tapsmithExpect("hello").toContain("xyz")).toThrow(
        "to contain",
      );
    });

    it("uses reference equality for arrays", () => {
      vitestExpect(() =>
        tapsmithExpect([{ a: 1 }]).toContain({ a: 1 }),
      ).toThrow();
    });

    it("works with .not", () => {
      tapsmithExpect("hello").not.toContain("xyz");
    });
  });

  // ─── toContainEqual ───
  describe("toContainEqual()", () => {
    it("passes when array contains deep-equal item", () => {
      tapsmithExpect([{ a: 1 }, { b: 2 }]).toContainEqual({ a: 1 });
    });

    it("fails when no deep match", () => {
      vitestExpect(() =>
        tapsmithExpect([{ a: 1 }]).toContainEqual({ a: 2 }),
      ).toThrow("to contain equal");
    });
  });

  // ─── toHaveLength ───
  describe("toHaveLength()", () => {
    it("passes for matching length", () => {
      tapsmithExpect([1, 2, 3]).toHaveLength(3);
      tapsmithExpect("hello").toHaveLength(5);
    });

    it("fails for mismatching length", () => {
      vitestExpect(() => tapsmithExpect([1, 2]).toHaveLength(3)).toThrow(
        "Expected length 3, but got 2",
      );
    });
  });

  // ─── toHaveProperty ───
  describe("toHaveProperty()", () => {
    it("passes when property exists", () => {
      tapsmithExpect({ a: { b: 42 } }).toHaveProperty("a");
    });

    it("supports dot-separated paths", () => {
      tapsmithExpect({ a: { b: 42 } }).toHaveProperty("a.b");
    });

    it("supports array paths", () => {
      tapsmithExpect({ a: { b: 42 } }).toHaveProperty(["a", "b"]);
    });

    it("checks value when provided", () => {
      tapsmithExpect({ a: { b: 42 } }).toHaveProperty("a.b", 42);
      vitestExpect(() =>
        tapsmithExpect({ a: { b: 42 } }).toHaveProperty("a.b", 99),
      ).toThrow();
    });

    it("fails for missing property", () => {
      vitestExpect(() =>
        tapsmithExpect({ a: 1 }).toHaveProperty("b"),
      ).toThrow("to exist");
    });

    it("works with .not", () => {
      tapsmithExpect({ a: 1 }).not.toHaveProperty("b");
    });
  });

  // ─── toMatch ───
  describe("toMatch()", () => {
    it("matches regex", () => {
      tapsmithExpect("hello world").toMatch(/world/);
    });

    it("matches string substring", () => {
      tapsmithExpect("hello world").toMatch("world");
    });

    it("fails on no match", () => {
      vitestExpect(() => tapsmithExpect("hello").toMatch(/xyz/)).toThrow(
        "to match",
      );
    });
  });

  // ─── toMatchObject ───
  describe("toMatchObject()", () => {
    it("passes when object contains subset", () => {
      tapsmithExpect({ a: 1, b: 2, c: 3 }).toMatchObject({ a: 1, c: 3 });
    });

    it("matches nested subsets", () => {
      tapsmithExpect({ a: { b: 1, c: 2 } }).toMatchObject({ a: { b: 1 } });
    });

    it("fails when subset doesn't match", () => {
      vitestExpect(() =>
        tapsmithExpect({ a: 1 }).toMatchObject({ a: 2 }),
      ).toThrow("to match object");
    });

    it("fails for non-objects", () => {
      vitestExpect(() =>
        tapsmithExpect(42).toMatchObject({ a: 1 }),
      ).toThrow();
    });
  });

  // ─── Numeric comparisons ───
  describe("toBeGreaterThan()", () => {
    it("passes when greater", () => {
      tapsmithExpect(5).toBeGreaterThan(3);
    });
    it("fails when not greater", () => {
      vitestExpect(() => tapsmithExpect(3).toBeGreaterThan(5)).toThrow(
        "to be greater than",
      );
    });
    it("fails for equal values", () => {
      vitestExpect(() => tapsmithExpect(5).toBeGreaterThan(5)).toThrow();
    });
  });

  describe("toBeGreaterThanOrEqual()", () => {
    it("passes for equal", () => {
      tapsmithExpect(5).toBeGreaterThanOrEqual(5);
    });
    it("passes for greater", () => {
      tapsmithExpect(6).toBeGreaterThanOrEqual(5);
    });
  });

  describe("toBeLessThan()", () => {
    it("passes when less", () => {
      tapsmithExpect(3).toBeLessThan(5);
    });
    it("fails when not less", () => {
      vitestExpect(() => tapsmithExpect(5).toBeLessThan(3)).toThrow(
        "to be less than",
      );
    });
  });

  describe("toBeLessThanOrEqual()", () => {
    it("passes for equal", () => {
      tapsmithExpect(5).toBeLessThanOrEqual(5);
    });
    it("passes for less", () => {
      tapsmithExpect(4).toBeLessThanOrEqual(5);
    });
  });

  describe("numeric assertions reject non-numbers", () => {
    it("toBeGreaterThan rejects strings", () => {
      vitestExpect(() => tapsmithExpect("10").toBeGreaterThan(5)).toThrow(
        "Expected a number for toBeGreaterThan but got string",
      );
    });

    it("toBeGreaterThanOrEqual rejects strings", () => {
      vitestExpect(() => tapsmithExpect("10").toBeGreaterThanOrEqual(5)).toThrow(
        "Expected a number for toBeGreaterThanOrEqual but got string",
      );
    });

    it("toBeLessThan rejects strings", () => {
      vitestExpect(() => tapsmithExpect("3").toBeLessThan(5)).toThrow(
        "Expected a number for toBeLessThan but got string",
      );
    });

    it("toBeLessThanOrEqual rejects strings", () => {
      vitestExpect(() => tapsmithExpect("3").toBeLessThanOrEqual(5)).toThrow(
        "Expected a number for toBeLessThanOrEqual but got string",
      );
    });

    it("toBeCloseTo rejects strings", () => {
      vitestExpect(() => tapsmithExpect("0.3").toBeCloseTo(0.3)).toThrow(
        "Expected a number for toBeCloseTo but got string",
      );
    });
  });

  // ─── toBeCloseTo ───
  describe("toBeCloseTo()", () => {
    it("passes for close floating point values", () => {
      tapsmithExpect(0.1 + 0.2).toBeCloseTo(0.3);
    });

    it("fails for distant values", () => {
      vitestExpect(() => tapsmithExpect(0.5).toBeCloseTo(0.3)).toThrow(
        "to be close to",
      );
    });

    it("respects custom precision", () => {
      tapsmithExpect(0.54).toBeCloseTo(0.5, 1);
      vitestExpect(() => tapsmithExpect(0.56).toBeCloseTo(0.5, 1)).toThrow();
    });
  });

  // ─── toBeInstanceOf ───
  describe("toBeInstanceOf()", () => {
    it("passes for correct instance", () => {
      tapsmithExpect(new Date()).toBeInstanceOf(Date);
      tapsmithExpect(new Error("x")).toBeInstanceOf(Error);
    });

    it("fails for wrong type", () => {
      vitestExpect(() => tapsmithExpect("hello").toBeInstanceOf(Date)).toThrow(
        "to be instance of Date",
      );
    });
  });

  // ─── toThrow ───
  describe("toThrow()", () => {
    it("passes when function throws", () => {
      tapsmithExpect(() => {
        throw new Error("boom");
      }).toThrow();
    });

    it("fails when function does not throw", () => {
      vitestExpect(() => tapsmithExpect(() => {}).toThrow()).toThrow(
        "Expected function to throw",
      );
    });

    it("matches string in error message", () => {
      tapsmithExpect(() => {
        throw new Error("something went wrong");
      }).toThrow("went wrong");
    });

    it("fails when string doesn't match", () => {
      vitestExpect(() =>
        tapsmithExpect(() => {
          throw new Error("something went wrong");
        }).toThrow("different"),
      ).toThrow('Expected thrown error to include "different"');
    });

    it("matches regex in error message", () => {
      tapsmithExpect(() => {
        throw new Error("error code: 42");
      }).toThrow(/code: \d+/);
    });

    it("matches Error instance by message", () => {
      tapsmithExpect(() => {
        throw new Error("exact message");
      }).toThrow(new Error("exact message"));
    });

    it("works with .not", () => {
      tapsmithExpect(() => {}).not.toThrow();
      vitestExpect(() =>
        tapsmithExpect(() => {
          throw new Error("oops");
        }).not.toThrow(),
      ).toThrow("Expected function not to throw");
    });

    it(".not.toThrow(expected) passes when thrown error does not match", () => {
      tapsmithExpect(() => {
        throw new Error("something unexpected");
      }).not.toThrow("specific error");

      tapsmithExpect(() => {
        throw new Error("something unexpected");
      }).not.toThrow(/specific/);

      tapsmithExpect(() => {
        throw new Error("something unexpected");
      }).not.toThrow(new Error("specific error"));
    });

    it(".not.toThrow(expected) fails when thrown error matches", () => {
      vitestExpect(() =>
        tapsmithExpect(() => {
          throw new Error("specific error occurred");
        }).not.toThrow("specific error"),
      ).toThrow("Expected function not to throw error matching");

      vitestExpect(() =>
        tapsmithExpect(() => {
          throw new Error("error code: 42");
        }).not.toThrow(/code: \d+/),
      ).toThrow("Expected function not to throw error matching");

      vitestExpect(() =>
        tapsmithExpect(() => {
          throw new Error("exact message");
        }).not.toThrow(new Error("exact message")),
      ).toThrow("Expected function not to throw error matching");
    });

    it("errors if actual is not a function", () => {
      vitestExpect(() => tapsmithExpect(42).toThrow()).toThrow(
        "Expected a function for toThrow()",
      );
    });
  });

  // ─── .not chaining ───
  describe(".not chaining", () => {
    it("negates toBeTruthy", () => {
      tapsmithExpect(0).not.toBeTruthy();
    });

    it("negates toContain", () => {
      tapsmithExpect([1, 2]).not.toContain(3);
    });

    it("negates toEqual", () => {
      tapsmithExpect({ a: 1 }).not.toEqual({ a: 2 });
    });

    it("double negation is positive", () => {
      tapsmithExpect(5).not.not.toBe(5);
    });
  });

  // ─── Circular object handling ───
  describe("circular object formatting", () => {
    it("handles circular references in error messages", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      vitestExpect(() => tapsmithExpect(obj).toBe("x")).toThrow("[Circular Object]");
    });
  });

  // ─── ElementHandle still works ───
  describe("ElementHandle expect() still returns locator assertions", () => {
    it("returns TapsmithAssertions with toBeVisible", async () => {
      const client = makeMockClient(async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: true }),
        errorMessage: "",
      }));
      const handle = makeHandle(client);
      await tapsmithExpect(handle).toBeVisible();
    });
  });
});

// ════════════════════════════════════════════════════════════════
// PILOT-43: Soft assertions
// ════════════════════════════════════════════════════════════════

describe("PILOT-43: expect.soft()", () => {
  beforeEach(() => {
    takeSoftErrors(); // Clear any leftover errors
  });

  describe("generic soft assertions", () => {
    it("does not throw on failure", () => {
      tapsmithExpect.soft(5).toBe(6);
      // No error thrown
    });

    it("collects failures for later retrieval", () => {
      tapsmithExpect.soft(5).toBe(6);
      tapsmithExpect.soft("hello").toContain("xyz");
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(2);
      vitestExpect(errors[0].message).toContain("to be 6");
      vitestExpect(errors[1].message).toContain("to contain");
    });

    it("flushSoftErrors returns only the failures since its previous call, and keeps them for the runner", () => {
      tapsmithExpect.soft(5).toBe(6);
      const errors1 = flushSoftErrors();
      vitestExpect(errors1).toHaveLength(1);
      vitestExpect(flushSoftErrors()).toHaveLength(0);
      tapsmithExpect.soft(7).toBe(8);
      const errors2 = flushSoftErrors();
      vitestExpect(errors2.map((e) => e.message)).toEqual(["Expected 7 to be 8"]);
      vitestExpect(takeSoftErrors().map((e) => e.message)).toEqual(["Expected 5 to be 6", "Expected 7 to be 8"]);
      vitestExpect(takeSoftErrors()).toHaveLength(0);
      vitestExpect(flushSoftErrors()).toHaveLength(0);
    });

    it("does not collect passing assertions", () => {
      tapsmithExpect.soft(5).toBe(5);
      tapsmithExpect.soft("hello").toContain("ell");
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(0);
    });

    it("supports .not", () => {
      tapsmithExpect.soft(5).not.toBe(5);
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(1);
      vitestExpect(errors[0].message).toContain("not to be 5");
    });

    it("mixed pass and fail", () => {
      tapsmithExpect.soft(5).toBe(5);
      tapsmithExpect.soft(10).toBeGreaterThan(20);
      tapsmithExpect.soft("abc").toHaveLength(3);
      tapsmithExpect.soft(null).toBeDefined();
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(1);
      vitestExpect(errors[0].message).toContain("to be greater than");
    });
  });

  describe("locator soft assertions", () => {
    it("does not throw when locator assertion fails", async () => {
      const client = makeMockClient(async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: false }),
        errorMessage: "",
      }));
      const handle = makeHandle(client);
      await tapsmithExpect.soft(handle).toBeVisible();
      // No error thrown
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(1);
      vitestExpect(errors[0].message).toContain("to be visible");
    });

    it("does not collect passing locator assertions", async () => {
      const client = makeMockClient(async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: true }),
        errorMessage: "",
      }));
      const handle = makeHandle(client);
      await tapsmithExpect.soft(handle).toBeVisible();
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(0);
    });

    it("supports .not for locator soft assertions", async () => {
      const client = makeMockClient(async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: true }),
        errorMessage: "",
      }));
      const handle = makeHandle(client);
      await tapsmithExpect.soft(handle).not.toBeVisible();
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(1);
      vitestExpect(errors[0].message).toContain("NOT to be visible");
    });

    it("collects multiple locator failures", async () => {
      const client = makeMockClient(async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: false, enabled: false }),
        errorMessage: "",
      }));
      const handle = makeHandle(client);
      await tapsmithExpect.soft(handle).toBeVisible();
      await tapsmithExpect.soft(handle).toBeEnabled();
      const errors = flushSoftErrors();
      vitestExpect(errors).toHaveLength(2);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// PILOT-44: expect.poll()
// ════════════════════════════════════════════════════════════════

describe("PILOT-44: expect.poll()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes immediately when condition is met", async () => {
    await tapsmithExpect.poll(() => 5, { timeout: 1000 }).toBe(5);
  });

  it("polls until condition is met", async () => {
    let count = 0;
    const promise = tapsmithExpect
      .poll(
        () => {
          count++;
          return count;
        },
        { timeout: 2000, intervals: [50] },
      )
      .toBeGreaterThan(3);

    await vi.advanceTimersByTimeAsync(250);
    await promise;

    vitestExpect(count).toBeGreaterThanOrEqual(4);
  });

  it("times out when condition is never met", async () => {
    const promise = tapsmithExpect.poll(() => 1, { timeout: 200, intervals: [50] }).toBe(999);
    // Attach rejection handler before advancing to prevent unhandled rejection
    const expectation = vitestExpect(promise).rejects.toThrow("to be 999");
    await vi.runAllTimersAsync();
    await expectation;
  });

  it("works with async functions", async () => {
    let count = 0;
    const promise = tapsmithExpect
      .poll(
        async () => {
          count++;
          return count;
        },
        { timeout: 2000, intervals: [50] },
      )
      .toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(150);
    await promise;
  });

  it("supports .not", async () => {
    await tapsmithExpect
      .poll(() => 5, { timeout: 500 })
      .not.toBe(6);
  });

  it("supports toContain", async () => {
    let items = [1, 2];
    setTimeout(() => {
      items = [1, 2, 3];
    }, 100);

    const promise = tapsmithExpect
      .poll(() => items, { timeout: 2000, intervals: [50] })
      .toContain(3);

    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });

  it("supports toHaveLength", async () => {
    let arr = [1];
    setTimeout(() => {
      arr = [1, 2, 3];
    }, 100);

    const promise = tapsmithExpect
      .poll(() => arr, { timeout: 2000, intervals: [50] })
      .toHaveLength(3);

    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });

  it("supports toBeTruthy", async () => {
    let value: unknown = null;
    setTimeout(() => {
      value = "loaded";
    }, 100);

    const promise = tapsmithExpect
      .poll(() => value, { timeout: 2000, intervals: [50] })
      .toBeTruthy();

    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });

  it("handles errors thrown by the polled function", async () => {
    let count = 0;
    const promise = tapsmithExpect
      .poll(
        () => {
          count++;
          if (count < 3) throw new Error("not ready");
          return count;
        },
        { timeout: 2000, intervals: [50] },
      )
      .toBeGreaterThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });

  it("uses default timeout when none provided", async () => {
    await tapsmithExpect.poll(() => 42).toBe(42);
  });

  it("throws for invalid/misspelled assertion methods", async () => {
    const promise = (tapsmithExpect.poll(() => 5, { timeout: 100 }) as unknown as Record<string, (...args: unknown[]) => Promise<void>>)
      .toBee(5);
    // Attach handler immediately to prevent unhandled rejection
    await vitestExpect(promise).rejects.toThrow('"toBee" is not a valid assertion method');
  });
});
