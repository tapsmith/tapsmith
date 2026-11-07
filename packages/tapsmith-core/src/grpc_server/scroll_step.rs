//! scrollIntoView()'s one-call scroll step (PILOT-998): the pure parts —
//! mapping the agent's answer onto the response, and the path of the iOS
//! simulator's HID drag.

use serde_json::Value;

use super::{parse_element_list, proto, AgentResponse};
use tonic::Status;

/// How long the device may spend on a step beyond the find's own read budget:
/// the first Android step's confirm (a find, up to 1.5 s waiting for quiet as
/// the SDK's `waitForIdle(1500)` did, and a find), the drag (~0.2 s on
/// Android, ~0.45 s through the iOS HID helper), the quiet wait (at most
/// 0.5 s on Android, 0.9 s on iOS), the find, and up to two re-finds, each
/// after another quiet wait. A loaded emulator's finds take ~0.5 s each.
pub(super) const SCROLL_STEP_WORK_MS: u64 = 6_000;

/// The answer of an agent that predates the step's command.
pub(super) fn is_unknown_method(resp: &AgentResponse, method: &str) -> bool {
    !resp.success
        && resp
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("Unknown method") && e.contains(method))
}

/// A step the device cannot make: the caller scrolls the old way.
pub(super) fn unsupported(request_id: String) -> proto::ScrollStepResponse {
    proto::ScrollStepResponse {
        request_id,
        unsupported: true,
        ..Default::default()
    }
}

/// The response for one step's agent answer. `region` is the one the daemon
/// dragged in, when it chose it (iOS); otherwise the agent's answer names it.
pub(super) fn step_response(
    request_id: String,
    method: &str,
    result: Result<AgentResponse, Status>,
    region: Option<proto::Bounds>,
) -> proto::ScrollStepResponse {
    let resp = match result {
        Ok(resp) => resp,
        Err(status) => {
            return proto::ScrollStepResponse {
                request_id,
                error_message: status.message().to_string(),
                ..Default::default()
            }
        }
    };
    if is_unknown_method(&resp, method) {
        return unsupported(request_id);
    }
    if !resp.success {
        return proto::ScrollStepResponse {
            request_id,
            error_message: resp.error.unwrap_or_default(),
            ..Default::default()
        };
    }
    let data = &resp.data;
    let moved = match data.get("moved").and_then(Value::as_bool) {
        Some(true) => proto::scroll_step_response::Moved::Yes,
        Some(false) => proto::scroll_step_response::Moved::No,
        None => proto::scroll_step_response::Moved::Unspecified,
    };
    let swiped = data.get("swiped").and_then(Value::as_bool).unwrap_or(true);
    let region = if swiped {
        region.or_else(|| data.get("region").and_then(bounds_from_json))
    } else {
        None
    };
    proto::ScrollStepResponse {
        request_id,
        elements: parse_element_list(data),
        error_message: String::new(),
        moved: moved as i32,
        region,
        swiped,
        unsupported: false,
    }
}

fn bounds_from_json(v: &Value) -> Option<proto::Bounds> {
    let get = |k: &str| v.get(k).and_then(Value::as_f64).map(|n| n.round() as i32);
    let b = proto::Bounds {
        left: get("left")?,
        top: get("top")?,
        right: get("right")?,
        bottom: get("bottom")?,
    };
    (b.right > b.left && b.bottom > b.top).then_some(b)
}

/// One sample of a HID drag: where the finger is `at_ms` after the press.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct DragSample {
    pub at_ms: f64,
    pub x: f64,
    pub y: f64,
}

/// Moves are this far apart in time: the HID helper injects events at least
/// 12 ms apart, so a faster timeline would only queue up behind it and the
/// drag would end (and the step's find start) before the helper had made it.
const DRAG_MOVE_INTERVAL_MS: f64 = 12.0;
/// The drag's three segments: a short kick that gets past the scroll view's
/// touch slop, the bulk of the length, then a slow tail. Each ends on the
/// move interval's grid, so no two samples are closer than it.
const DRAG_KICK_PT: f64 = 12.0;
const DRAG_KICK_END_MS: f64 = 36.0;
const DRAG_BULK_END_MS: f64 = 192.0;
const DRAG_TAIL_PT: f64 = 40.0;
const DRAG_TAIL_END_MS: f64 = 396.0;
/// The finger holds still at the end for this long before it lifts, so the
/// velocity UIKit measures at the lift is ~0 and the list does not decelerate
/// on its own (a 200 pt/s tail alone still flung a long list ~600 pt).
pub(super) const DRAG_HOLD_MS: f64 = 60.0;
/// A drag shorter than half the region is a nudge (scrollIntoView()'s
/// scroll-back and cut-by-edge moves, PILOT-935): centred on the region.
const NUDGE_BELOW: f32 = 0.5;
/// Where a full drag starts, as a fraction of the region from the edge the
/// finger moves away from: clear of the region's edge, so it does not start
/// on a header or the home indicator.
const DRAG_START_INSET: f64 = 0.1;

/// The path of an iOS scroll step's drag through the HID helper, idea from
/// Speedrun's iOS agent (Apache-2.0; our own code): a 12 pt kick in 36 ms, the
/// bulk in 156 ms, the last 40 pt slowly, then a still hold before the lift,
/// so nothing flings. A drag of `distance` ≥ 0.5 starts 10% in from the edge
/// the finger moves away from; a shorter one is centred on the region. The
/// last sample is where the finger lifts. None for an empty region, an
/// unknown direction or a non-positive distance.
pub(super) fn hid_drag_path(
    direction: &str,
    region: &proto::Bounds,
    distance: f32,
) -> Option<Vec<DragSample>> {
    let (l, t, r, b) = (
        f64::from(region.left),
        f64::from(region.top),
        f64::from(region.right),
        f64::from(region.bottom),
    );
    if r <= l || b <= t || distance <= 0.0 {
        return None;
    }
    // Rounded: an f32 0.8 is 0.800000011… as an f64.
    let d = (f64::from(distance) * 1e4).round() / 1e4;
    let d = d.clamp(0.05, 1.0 - 2.0 * DRAG_START_INSET);
    let (w, h) = (r - l, b - t);
    let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0);
    let ((x0, y0), (x1, y1)) = if distance < NUDGE_BELOW {
        let (hw, hh) = (w * d / 2.0, h * d / 2.0);
        match direction {
            "up" => ((cx, cy + hh), (cx, cy - hh)),
            "down" => ((cx, cy - hh), (cx, cy + hh)),
            "left" => ((cx + hw, cy), (cx - hw, cy)),
            "right" => ((cx - hw, cy), (cx + hw, cy)),
            _ => return None,
        }
    } else {
        let (sx, sy) = (DRAG_START_INSET * w, DRAG_START_INSET * h);
        match direction {
            "up" => ((cx, b - sy), (cx, b - sy - d * h)),
            "down" => ((cx, t + sy), (cx, t + sy + d * h)),
            "left" => ((r - sx, cy), (r - sx - d * w, cy)),
            "right" => ((l + sx, cy), (l + sx + d * w, cy)),
            _ => return None,
        }
    };
    let (dx, dy) = (x1 - x0, y1 - y0);
    let length = (dx * dx + dy * dy).sqrt();
    if length < 1.0 {
        return None;
    }
    let along = |s: f64| (x0 + dx * s / length, y0 + dy * s / length);
    let kick = DRAG_KICK_PT.min(length / 10.0);
    let tail = DRAG_TAIL_PT.min(length / 4.0);
    let segments = [
        (kick, DRAG_KICK_END_MS),
        (length - tail, DRAG_BULK_END_MS),
        (length, DRAG_TAIL_END_MS),
    ];
    let mut path = vec![DragSample {
        at_ms: 0.0,
        x: x0,
        y: y0,
    }];
    let (mut from_s, mut from_ms) = (0.0_f64, 0.0_f64);
    for (to_s, to_ms) in segments {
        let mut ms = from_ms + DRAG_MOVE_INTERVAL_MS;
        while ms < to_ms {
            let (x, y) = along(from_s + (to_s - from_s) * (ms - from_ms) / (to_ms - from_ms));
            path.push(DragSample { at_ms: ms, x, y });
            ms += DRAG_MOVE_INTERVAL_MS;
        }
        let (x, y) = along(to_s);
        path.push(DragSample { at_ms: to_ms, x, y });
        (from_s, from_ms) = (to_s, to_ms);
    }
    // The still hold: the same point, sampled on, so UIKit's velocity
    // estimate decays to zero before the lift.
    let mut ms = DRAG_TAIL_END_MS + DRAG_MOVE_INTERVAL_MS;
    while ms <= DRAG_TAIL_END_MS + DRAG_HOLD_MS {
        path.push(DragSample {
            at_ms: ms,
            x: x1,
            y: y1,
        });
        ms += DRAG_MOVE_INTERVAL_MS;
    }
    Some(path)
}

/// The drag's points as `scrollStepPoints` takes them.
pub(super) fn drag_points(path: &[DragSample]) -> Vec<[f64; 2]> {
    path.iter().map(|s| [s.x, s.y]).collect()
}

/// The drag in the HID helper's native portrait space, from the agent's
/// `scrollStepPoints` answer: the same timeline at the mapped points. None
/// when the agent could not map them (it cannot tell how the screen is
/// turned) or answered something else.
pub(super) fn native_path(path: &[DragSample], answer: &Value) -> Option<Vec<DragSample>> {
    let points = answer.get("points")?.as_array()?;
    if points.len() != path.len() {
        return None;
    }
    path.iter()
        .zip(points)
        .map(|(s, p)| {
            let p = p.as_array()?;
            Some(DragSample {
                at_ms: s.at_ms,
                x: p.first()?.as_f64()?,
                y: p.get(1)?.as_f64()?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answer(success: bool, error: Option<&str>, data: Value) -> Result<AgentResponse, Status> {
        Ok(AgentResponse {
            success,
            error: error.map(str::to_string),
            error_type: None,
            data,
        })
    }

    const REGION: proto::Bounds = proto::Bounds {
        left: 0,
        top: 100,
        right: 400,
        bottom: 900,
    };

    #[test]
    fn maps_a_step_that_moved_and_found_nothing() {
        let r = step_response(
            "r".into(),
            "scrollStep",
            answer(
                true,
                None,
                json!({"elements": [], "moved": true, "region": {"left": 0, "top": 200, "right": 1080, "bottom": 1800}}),
            ),
            None,
        );
        assert_eq!(r.moved, proto::scroll_step_response::Moved::Yes as i32);
        assert!(r.swiped);
        assert!(!r.unsupported);
        assert_eq!(r.region.unwrap().top, 200);
        assert!(r.elements.is_empty());
    }

    #[test]
    fn maps_a_still_step_and_the_daemons_region() {
        let r = step_response(
            "r".into(),
            "scrollStepFind",
            answer(true, None, json!({"elements": [], "moved": false})),
            Some(REGION),
        );
        assert_eq!(r.moved, proto::scroll_step_response::Moved::No as i32);
        assert_eq!(r.region, Some(REGION));
    }

    #[test]
    fn leaves_moved_unspecified_when_the_agent_cannot_tell() {
        let r = step_response(
            "r".into(),
            "scrollStep",
            answer(true, None, json!({"elements": []})),
            None,
        );
        assert_eq!(
            r.moved,
            proto::scroll_step_response::Moved::Unspecified as i32
        );
        assert!(r.region.is_none());
    }

    #[test]
    fn a_confirmed_first_step_reports_no_swipe_and_no_region() {
        let r = step_response(
            "r".into(),
            "scrollStep",
            answer(
                true,
                None,
                json!({"elements": [{"elementId": "e1", "text": "Row 1", "visible": true}], "swiped": false, "region": {"left": 0, "top": 200, "right": 1080, "bottom": 1800}}),
            ),
            None,
        );
        assert!(!r.swiped);
        assert!(r.region.is_none());
        assert_eq!(r.elements.len(), 1);
    }

    #[test]
    fn an_agent_without_the_command_is_unsupported() {
        let r = step_response(
            "r".into(),
            "scrollStep",
            answer(false, Some("Unknown method: scrollStep"), json!({})),
            None,
        );
        assert!(r.unsupported);
        assert!(r.error_message.is_empty());
    }

    #[test]
    fn an_ios_agent_without_the_point_mapping_is_unsupported_before_any_drag() {
        // Asked before the drag, so an older agent's answer means nothing moved.
        let r = step_response(
            "r".into(),
            "scrollStepPoints",
            answer(false, Some("Unknown method: scrollStepPoints"), json!({})),
            None,
        );
        assert!(r.unsupported);
    }

    #[test]
    fn agent_failures_and_transport_errors_are_errors() {
        let r = step_response(
            "r".into(),
            "scrollStep",
            answer(
                false,
                Some("Failed to swipe up: the device refused the drag"),
                json!({}),
            ),
            None,
        );
        assert!(!r.unsupported);
        assert!(r.error_message.contains("refused"));
        let r = step_response(
            "r".into(),
            "scrollStep",
            Err(Status::deadline_exceeded("Agent command timed out")),
            None,
        );
        assert!(r.error_message.contains("timed out"));
    }

    #[test]
    fn drops_an_empty_agent_region() {
        assert!(
            bounds_from_json(&json!({"left": 0, "top": 10, "right": 0, "bottom": 20})).is_none()
        );
        assert!(bounds_from_json(&json!({"left": 0})).is_none());
    }

    #[test]
    fn a_full_drag_moves_up_inside_the_region_and_holds_before_the_lift() {
        let path = hid_drag_path("up", &REGION, 0.8).unwrap();
        let first = path[0];
        let last = *path.last().unwrap();
        // 10% in from the bottom edge, 0.8 of the region's height upward.
        assert!((first.y - 820.0).abs() < 1e-6, "{first:?}");
        assert!((last.y - 180.0).abs() < 1e-6, "{last:?}");
        assert_eq!(first.x, 200.0);
        assert!(path.iter().all(|s| s.x == 200.0));
        // Monotonic in time and position; samples at most 8 ms apart.
        for w in path.windows(2) {
            assert!(w[1].at_ms > w[0].at_ms);
            assert!(w[1].at_ms - w[0].at_ms <= DRAG_MOVE_INTERVAL_MS + 1e-9);
            assert!(w[1].y <= w[0].y);
        }
        // The finger is still for the last DRAG_HOLD_MS.
        let hold_from = last.at_ms - DRAG_HOLD_MS;
        assert!(path
            .iter()
            .filter(|s| s.at_ms >= hold_from - 1e-9)
            .all(|s| s.y == last.y));
        assert!(last.at_ms >= DRAG_TAIL_END_MS + DRAG_HOLD_MS - DRAG_MOVE_INTERVAL_MS);
    }

    #[test]
    fn samples_are_no_closer_than_the_helper_injects_them() {
        // The helper spaces its injections at least 12 ms apart; a faster
        // timeline would leave the drag queued behind it when the step's find
        // starts.
        for (dir, distance) in [("up", 0.8), ("down", 0.3), ("left", 0.8)] {
            let path = hid_drag_path(dir, &REGION, distance).unwrap();
            for w in path.windows(2) {
                assert!(w[1].at_ms - w[0].at_ms >= 12.0 - 1e-9, "{dir}: {w:?}");
            }
        }
    }

    #[test]
    fn the_tail_is_slow() {
        let path = hid_drag_path("up", &REGION, 0.8).unwrap();
        let tail: Vec<_> = path
            .iter()
            .filter(|s| s.at_ms > DRAG_BULK_END_MS && s.at_ms <= DRAG_TAIL_END_MS)
            .collect();
        let pts = tail.first().unwrap().y - tail.last().unwrap().y;
        let secs = (tail.last().unwrap().at_ms - tail.first().unwrap().at_ms) / 1000.0;
        assert!(pts / secs < 250.0, "tail {pts} pt over {secs} s");
    }

    #[test]
    fn each_direction_starts_clear_of_the_edge_it_leaves() {
        let first_last = |dir: &str| {
            let p = hid_drag_path(dir, &REGION, 0.8).unwrap();
            (p[0], *p.last().unwrap())
        };
        let (f, l) = first_last("down");
        assert!((f.y - 180.0).abs() < 1e-6 && (l.y - 820.0).abs() < 1e-6);
        let (f, l) = first_last("left");
        assert!((f.x - 360.0).abs() < 1e-6 && (l.x - 40.0).abs() < 1e-6 && f.y == 500.0);
        let (f, l) = first_last("right");
        assert!((f.x - 40.0).abs() < 1e-6 && (l.x - 360.0).abs() < 1e-6);
    }

    #[test]
    fn a_nudge_is_centred_on_the_region() {
        let p = hid_drag_path("down", &REGION, 0.3).unwrap();
        assert!((p[0].y - 380.0).abs() < 1e-6, "{:?}", p[0]);
        assert!((p.last().unwrap().y - 620.0).abs() < 1e-6);
    }

    #[test]
    fn a_drag_is_made_at_the_points_the_agent_mapped_on_its_timeline() {
        // A landscape app: the agent maps each interface point into the
        // helper's portrait space (x' = W - y, y' = x for landscapeLeft).
        let path = hid_drag_path("up", &REGION, 0.8).unwrap();
        let mapped: Vec<Value> = drag_points(&path)
            .iter()
            .map(|[x, y]| json!([400.0 - y, x]))
            .collect();
        let native = native_path(&path, &json!({ "points": mapped })).unwrap();
        assert_eq!(native.len(), path.len());
        for (n, s) in native.iter().zip(&path) {
            assert_eq!(n.at_ms, s.at_ms);
            assert_eq!(n.x, 400.0 - s.y);
            assert_eq!(n.y, s.x);
        }
    }

    #[test]
    fn no_drag_when_the_agent_cannot_map_the_points() {
        let path = hid_drag_path("up", &REGION, 0.8).unwrap();
        assert!(native_path(&path, &json!({ "points": null })).is_none());
        assert!(native_path(&path, &json!({})).is_none());
        assert!(native_path(&path, &json!({ "points": [[1.0, 2.0]] })).is_none());
    }

    #[test]
    fn refuses_what_it_cannot_drag() {
        assert!(hid_drag_path("up", &proto::Bounds::default(), 0.8).is_none());
        assert!(hid_drag_path("sideways", &REGION, 0.8).is_none());
        assert!(hid_drag_path("up", &REGION, 0.0).is_none());
    }
}
