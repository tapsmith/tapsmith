//! Whether the iOS simulator's HID helper can reach its touchscreen
//! (PILOT-1313).
//!
//! The helper sends touches through the simulator's legacy (Indigo) input.
//! Xcode 27's DeviceHub drives a simulator through CoreDevice instead: opened
//! on a simulator whose legacy touchscreen has not been touched yet in that
//! boot, it has that touchscreen switched off and its own put in its place.
//! The simulator then accepts every touch the helper sends and drops it, so a
//! tap would report success and do nothing. The agent reads the simulator's
//! input services (`hidTouchInput`) once a session, before the first HID
//! touch, and the daemon uses the agent's touches when the helper's would be
//! dropped.

use crate::agent_comms::AgentResponse;
use serde_json::Value;

/// What a session knows about the helper's reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum HidReach {
    /// The helper's touches land, or the agent cannot tell (an agent that
    /// predates the question, or services it cannot read): HID is used, as
    /// before the question existed.
    Reachable,
    /// The helper's touches would be dropped. The reason, for the fallback's
    /// log and for a refusal under `TAPSMITH_REQUIRE_IOS_HID`.
    Unreachable(String),
}

/// Why the helper's touches are dropped, as told to the user once.
pub(super) const UNREACHABLE_REASON: &str =
    "the simulator's touch input is driven by Xcode's DeviceHub (it was opened in DeviceHub \
     before its first touch in this boot), so touches sent through the simulator's HID input \
     never reach the app";

/// The session's reach from the agent's answer to `hidTouchInput`. `None`
/// when the answer says nothing that lasts (the agent did not answer, or
/// failed for a reason of its own): HID is used for this touch and the
/// question is asked again before the next.
pub(super) fn reach_from_answer<E>(answer: &Result<AgentResponse, E>) -> Option<HidReach> {
    let resp = answer.as_ref().ok()?;
    if !resp.success {
        // An agent that predates the question: it will never know.
        return super::scroll_step::is_unknown_method(resp, "hidTouchInput")
            .then_some(HidReach::Reachable);
    }
    Some(reach_from_data(&resp.data))
}

fn reach_from_data(data: &Value) -> HidReach {
    if data.get("known").and_then(Value::as_bool) != Some(true) {
        return HidReach::Reachable;
    }
    match data.get("legacyTouchscreen").and_then(Value::as_bool) {
        Some(false) => HidReach::Unreachable(UNREACHABLE_REASON.to_string()),
        _ => HidReach::Reachable,
    }
}

/// The scroll step's safety net: a HID drag after which the list held still
/// and the element is not on screen proves nothing about the list (it may be
/// at its end) until a HID drag has moved a list in this session. Until then
/// the step answers `unsupported`, so the SDK makes that scroll the old way,
/// with the agent's swipe, rather than giving up on a list the helper never
/// touched. A step that found the element on screen stands: the scroll is done.
/// So does every step when the HID route is required
/// (`TAPSMITH_REQUIRE_IOS_HID`): a HID drag that moved nothing must fail
/// there, not pass on the agent's swipe.
pub(super) fn distrust_still_step(
    step: &crate::proto::ScrollStepResponse,
    hid_drag_seen_moving: bool,
    hid_required: bool,
) -> bool {
    !hid_required
        && step.moved == crate::proto::scroll_step_response::Moved::No as i32
        && step.error_message.is_empty()
        && !step.elements.iter().any(|e| e.visible)
        && !hid_drag_seen_moving
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(data: Value) -> Result<AgentResponse, ()> {
        Ok(AgentResponse {
            success: true,
            error: None,
            error_type: None,
            data,
        })
    }

    fn failed(message: &str) -> Result<AgentResponse, ()> {
        Ok(AgentResponse {
            success: false,
            error: Some(message.to_string()),
            error_type: Some("ACTION_FAILED".to_string()),
            data: Value::Null,
        })
    }

    #[test]
    fn a_listed_legacy_touchscreen_is_reachable() {
        let answer =
            ok(json!({"known": true, "legacyTouchscreen": true, "coreDeviceTouchscreen": false}));
        assert_eq!(reach_from_answer(&answer), Some(HidReach::Reachable));
    }

    #[test]
    fn a_legacy_touchscreen_kept_beside_devicehubs_is_reachable() {
        let answer =
            ok(json!({"known": true, "legacyTouchscreen": true, "coreDeviceTouchscreen": true}));
        assert_eq!(reach_from_answer(&answer), Some(HidReach::Reachable));
    }

    #[test]
    fn devicehubs_touchscreen_alone_is_unreachable_and_says_why() {
        let answer =
            ok(json!({"known": true, "legacyTouchscreen": false, "coreDeviceTouchscreen": true}));
        match reach_from_answer(&answer) {
            Some(HidReach::Unreachable(why)) => assert!(why.contains("DeviceHub"), "{why}"),
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }

    #[test]
    fn an_agent_that_cannot_read_the_services_keeps_hid() {
        assert_eq!(
            reach_from_answer(&ok(json!({"known": false}))),
            Some(HidReach::Reachable)
        );
        assert_eq!(reach_from_answer(&ok(json!({}))), Some(HidReach::Reachable));
    }

    #[test]
    fn an_agent_that_predates_the_question_keeps_hid_for_good() {
        let answer = failed("Unknown method: hidTouchInput");
        assert_eq!(reach_from_answer(&answer), Some(HidReach::Reachable));
    }

    #[test]
    fn a_failed_or_missing_answer_is_asked_again() {
        assert_eq!(reach_from_answer(&failed("the agent is busy")), None);
        assert_eq!(reach_from_answer::<()>(&Err(())), None);
    }

    fn step(
        moved: crate::proto::scroll_step_response::Moved,
        visible: bool,
    ) -> crate::proto::ScrollStepResponse {
        crate::proto::ScrollStepResponse {
            moved: moved as i32,
            elements: vec![crate::proto::ElementInfo {
                visible,
                ..Default::default()
            }],
            swiped: true,
            ..Default::default()
        }
    }

    #[test]
    fn a_still_step_is_distrusted_until_a_hid_drag_has_moved_a_list() {
        use crate::proto::scroll_step_response::Moved;
        assert!(distrust_still_step(&step(Moved::No, false), false, false));
        assert!(
            !distrust_still_step(&step(Moved::No, false), true, false),
            "a list end, once HID is proven"
        );
        assert!(!distrust_still_step(&step(Moved::Yes, false), false, false));
        assert!(
            !distrust_still_step(&step(Moved::Unspecified, false), false, false),
            "the agent could not tell"
        );
        assert!(
            !distrust_still_step(&step(Moved::No, true), false, false),
            "the element is on screen: the scroll is done"
        );
        let mut failed = step(Moved::No, false);
        failed.error_message = "boom".into();
        assert!(
            !distrust_still_step(&failed, false, false),
            "a failed step reports its failure"
        );
        assert!(
            !distrust_still_step(&step(Moved::No, false), false, true),
            "under TAPSMITH_REQUIRE_IOS_HID a still step stands"
        );
    }
}
