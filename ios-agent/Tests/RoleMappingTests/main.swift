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

// ─── Role matching (PILOT-608) ───

let linkTrait: UInt64 = 1 << 1

func matches(_ role: String, _ type: ElementType, traits: UInt64 = 0, value: String? = nil, named: Bool = false) -> Bool {
    RoleMapping.matches(role: role, elementType: type, traits: traits, value: value, hasNameFilter: named)
}

// heading: the header trait, whatever the element type.
check("plain static text is not a heading", matches("heading", .staticText), false)
check("plain static text is not a heading, even by name", matches("heading", .staticText, named: true), false)
check("static text with the header trait is a heading", matches("heading", .staticText, traits: headerTrait), true)
check("a generic view with the header trait is a heading", matches("heading", .other, traits: headerTrait), true)
check("the \"header\" alias matches by the trait too", matches("header", .other, traits: headerTrait), true)
check("the \"header\" alias doesn't match plain static text", matches("Header", .staticText), false)
check("plain static text is still \"text\"", matches("text", .staticText), true)

// checkbox / radiobutton: the native type, or a generic view carrying React
// Native's role description (the first part of its accessibilityValue).
check("a native checkbox is a checkbox", matches("checkbox", .checkBox), true)
check("a native radio button is a radio button", matches("radiobutton", .radioButton), true)
check("a generic view is not a checkbox", matches("checkbox", .other), false)
check("a generic view is not a radio button", matches("radiobutton", .other), false)
check("an RN checkbox (\"checkbox, unchecked\") is a checkbox",
      matches("checkbox", .other, value: "checkbox, unchecked"), true)
check("an RN checkbox with a custom value is a checkbox",
      matches("checkbox", .other, value: "Checkbox, checked, 3 of 4"), true)
check("an RN radio (\"radio button, checked\") is a radio button",
      matches("radiobutton", .other, value: "radio button, checked"), true)
check("an RN radio is not a checkbox", matches("checkbox", .other, value: "radio button, checked"), false)
check("an RN radio is not a checkbox, even by name",
      matches("checkbox", .other, value: "radio button, checked", named: true), false)
check("an RN checkbox is not a radio button",
      matches("radiobutton", .other, value: "checkbox, checked", named: true), false)
check("a value that only mentions the word isn't a description",
      matches("checkbox", .other, value: "tick the checkbox below"), false)
check("only the leading part is a description: a radio valued \"Alert\" isn't an alert",
      matches("alert", .other, value: "radio button, checked, Alert"), false)
check("…not even by name", matches("alert", .other, value: "radio button, checked, Alert", named: true), false)
check("…and it is still a radio button",
      matches("radiobutton", .other, value: "radio button, checked, Alert"), true)
check("a checkbox whose value text names another role is still a checkbox",
      matches("checkbox", .other, value: "checkbox, checked, combo box"), true)
check("static text is never a checkbox", matches("checkbox", .staticText, value: "checkbox", named: true), false)

// alert / combobox: no native type; RN's old architecture describes them in
// the value, the new architecture publishes nothing at all.
check("a generic view is not an alert", matches("alert", .other), false)
check("a generic view is not a combobox", matches("combobox", .other), false)
check("an \"alert\"-described view is an alert", matches("alert", .other, value: "alert"), true)
check("a \"combo box\"-described view is a combobox", matches("combobox", .other, value: "combo box, expanded"), true)

// A named query still finds an undescribed generic view (Fabric alert/combobox,
// or a description in another language) — but not one that is evidently
// something else.
check("a named alert query finds an undescribed generic view", matches("alert", .other, named: true), true)
check("a named checkbox query finds an undescribed generic view", matches("checkbox", .other, named: true), true)
check("a named alert query skips a button-trait view",
      matches("alert", .other, traits: buttonTrait, named: true), false)
check("a named combobox query skips a link-trait view",
      matches("combobox", .other, traits: linkTrait, named: true), false)
check("a named alert query skips a heading",
      matches("alert", .other, traits: headerTrait, named: true), false)
check("a named alert query skips a described checkbox",
      matches("alert", .other, value: "checkbox, checked", named: true), false)

// ─── React Native's other generic-view roles (PILOT-664) ───

let rnGenericRoles = ["menu", "menubar", "menuitem", "radiogroup", "scrollbar", "spinbutton", "summary", "tablist", "timer"]
for role in rnGenericRoles {
    check("getByRole(\"\(role)\") is a known role", (try? RoleMapping.elementTypes(for: role)) ?? [], [.other])
    check("an unnamed \(role) query doesn't match a generic view", matches(role, .other), false)
    check("a named \(role) query finds an undescribed generic view", matches(role, .other, named: true), true)
    check("a named \(role) query skips a button-trait view", matches(role, .other, traits: buttonTrait, named: true), false)
    check("a named \(role) query skips a described checkbox",
          matches(role, .other, value: "checkbox, checked", named: true), false)
    check("a \(role) query doesn't match a native button", matches(role, .button, named: true), false)
}
// RN's old architecture leads the value with the role's description.
check("a \"menu item\"-described view is a menuitem", matches("menuitem", .other, value: "menu item"), true)
check("a \"tab list\"-described view is a tablist", matches("tablist", .other, value: "tab list"), true)
check("a \"timer\"-described view is a timer", matches("timer", .other, value: "timer, 00:42"), true)
check("a \"menu item\"-described view is not a menu", matches("menu", .other, value: "menu item", named: true), false)
check("a \"menu item\"-described view is not a checkbox",
      matches("checkbox", .other, value: "menu item", named: true), false)
check("a described view is not a summary, even by name",
      matches("summary", .other, value: "menu item", named: true), false)
// A trait marks another role even when the value leads with a description:
// a button whose own value text is "Menu" is not a menu.
check("a button-trait view valued \"Menu\" is not a menu", matches("menu", .other, traits: buttonTrait, value: "Menu"), false)
check("a link-trait view valued \"Timer\" is not a timer", matches("timer", .other, traits: linkTrait, value: "Timer", named: true), false)
// "radio" is React Native's and ARIA's spelling of radiobutton.
check("the \"radio\" alias matches an RN radio", matches("radio", .other, value: "radio button, checked"), true)
check("the \"radio\" alias matches a native radio button", matches("Radio", .radioButton), true)
check("the \"radio\" alias queries radio button types",
      (try? RoleMapping.elementTypes(for: "radio")) ?? [], [.radioButton, .other])

// Roles matched by type or trait alone are unchanged.
check("a button is a button", matches("button", .button), true)
check("a button-trait view is a button", matches("button", .other, traits: buttonTrait), true)
check("a generic view is not a button", matches("button", .other, named: true), false)
check("a link-trait view is a link", matches("link", .other, traits: linkTrait), true)
check("a switch is a switch", matches("switch", .switch), true)
check("an unknown role matches nothing", matches("row", .other, named: true), false)

// Role-only live re-resolution goes by the matched node's label for the roles
// a type query can't express.
for role in ["heading", "header", "checkbox", "radiobutton", "radio", "alert", "combobox"] + rnGenericRoles {
    check("role-only \(role) re-resolves by label", RoleMapping.needsLabelReResolution(role: role), true)
}
for role in ["button", "text", "switch", "textfield"] {
    check("role-only \(role) re-resolves by type", RoleMapping.needsLabelReResolution(role: role), false)
}

print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
