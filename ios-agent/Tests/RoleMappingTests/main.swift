// Unit tests for RoleMapping (PILOT-365), run on the host Mac without a
// simulator: `ios-agent/Tests/run-unit-tests.sh`. Swift seeds Dictionary
// hashing per process, so anything that depends on iteration order shows up
// here as a result that changes from one run to the next — the script runs
// this binary several times for that reason.

import XCTest

typealias ElementType = XCUIElement.ElementType

var failures = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T) {
    if got == want {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name): got \(got), want \(want)")
    }
}

let headerTrait: UInt64 = 1 << 16
let buttonTrait: UInt64 = 1 << 0
let imageTrait: UInt64 = 1 << 2

// ─── Static text ───

check("plain static text is \"text\"", RoleMapping.resolveRole(for: .staticText), "text")
check("plain static text with no traits is \"text\"",
      RoleMapping.resolveRole(for: .staticText, traits: 0), "text")
check("static text with the header trait is \"heading\"",
      RoleMapping.resolveRole(for: .staticText, traits: headerTrait), "heading")
check("the reverse map names static text \"text\"", RoleMapping.elementTypeToRole[.staticText], "text")
check("getByRole(\"heading\") still queries static text",
      (try? RoleMapping.elementTypes(for: "heading")) ?? [], [.staticText])
check("getByRole(\"text\") queries static text",
      (try? RoleMapping.elementTypes(for: "text")) ?? [], [.staticText])

// ─── Generic views ───

check(".other has no type-derived role", RoleMapping.resolveRole(for: .other), "")
check(".other with the button trait is \"button\"",
      RoleMapping.resolveRole(for: .other, traits: buttonTrait), "button")
check(".other with the image trait is \"image\"",
      RoleMapping.resolveRole(for: .other, traits: imageTrait), "image")

// ─── Round trip ───

// Every type the reverse map names must be queryable by the role it reports,
// or toHaveRole and getByRole disagree about the same element.
for (type, role) in RoleMapping.elementTypeToRole.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
    let types = (try? RoleMapping.elementTypes(for: role)) ?? []
    check("\(RoleMapping.typeName(for: type)) → \"\(role)\" round-trips", types.contains(type), true)
}
// …and every type in the forward map except .other gets a role back.
for (role, types) in RoleMapping.roleToElementTypes.sorted(by: { $0.key < $1.key }) {
    for type in types where type != .other {
        check("\(role): \(RoleMapping.typeName(for: type)) has a reported role",
              RoleMapping.elementTypeToRole[type] != nil, true)
    }
}

// ─── Order independence ───

// The reverse map must come out the same whatever order the forward entries
// are visited in, so every session reports the same role for an element.
let entries = RoleMapping.roleToElementTypes.sorted(by: { $0.key < $1.key }).map { (key: $0.key, value: $0.value) }
let reference = RoleMapping.buildReverseMap(entries, pins: RoleMapping.reverseRolePins)
check("sorted and reversed entries build the same map",
      RoleMapping.buildReverseMap(entries.reversed(), pins: RoleMapping.reverseRolePins), reference)
var rng = SystemRandomNumberGenerator()
var orderDependent = 0
for _ in 0..<200 where RoleMapping.buildReverseMap(entries.shuffled(using: &rng), pins: RoleMapping.reverseRolePins) != reference {
    orderDependent += 1
}
check("200 shuffled entry orders all build the same map", orderDependent, 0)
check("the shipped map matches the order-independent build", RoleMapping.elementTypeToRole, reference)

// A type listed under several roles must be pinned (or be .other), otherwise
// it silently loses its role — add it to reverseRolePins.
var claimedBy: [ElementType: [String]] = [:]
for (role, types) in entries { for type in types where type != .other { claimedBy[type, default: []].append(role) } }
for (type, roles) in claimedBy.sorted(by: { $0.key.rawValue < $1.key.rawValue }) where roles.count > 1 {
    check("\(RoleMapping.typeName(for: type)) (claimed by \(roles)) is pinned to one of its roles",
          RoleMapping.reverseRolePins[type].map(roles.contains) ?? false, true)
}
// …and every pin still resolves an actual ambiguity, so stale pins don't pile up.
for (type, role) in RoleMapping.reverseRolePins.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
    check("pin \(RoleMapping.typeName(for: type)) → \"\(role)\" is for an ambiguous type",
          (claimedBy[type]?.count ?? 0) > 1, true)
}

// An unpinned ambiguity gets no role, in either order, rather than a random one.
let clash: [(key: String, value: [ElementType])] = [(key: "a", value: [.button]), (key: "b", value: [.button])]
check("an unpinned ambiguous type gets no role",
      RoleMapping.buildReverseMap(clash, pins: [:])[.button], nil)
check("an unpinned ambiguous type gets no role, reversed",
      RoleMapping.buildReverseMap(clash.reversed(), pins: [:])[.button], nil)
check("a pinned ambiguous type gets its pin, in either order",
      [RoleMapping.buildReverseMap(clash, pins: [.button: "b"])[.button],
       RoleMapping.buildReverseMap(clash.reversed(), pins: [.button: "b"])[.button]], ["b", "b"])
check("a pin naming a role that doesn't list the type is ignored",
      RoleMapping.buildReverseMap(clash, pins: [.button: "z"])[.button], nil)
check(".other is never reverse-mapped, even when only one role lists it",
      RoleMapping.buildReverseMap([(key: "only", value: [.other])], pins: [:])[.other], nil)

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
