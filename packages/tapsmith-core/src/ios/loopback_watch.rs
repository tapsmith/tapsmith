//! PILOT-320 — notice an iOS simulator app talking to a server on the Mac's
//! loopback interface, which network capture cannot see.
//!
//! A simulator shares the Mac's network stack, so an app that calls
//! `http://localhost:4610` reaches a server the developer (or the test) runs
//! on the Mac. Neither capture route sees that connection: macOS never offers
//! loopback flows to the Network Extension's transparent proxy (the
//! redirector's include rule names no remote network, and such a rule does not
//! match loopback), and the system-proxy fallback lists `localhost` and
//! `127.0.0.1` as proxy exceptions. The request works, but it is missing from
//! the trace and `device.route()` and the network waiters never see it.
//!
//! Since the connection itself cannot be intercepted, the daemon at least
//! notices it: while a simulator's capture runs it looks, every couple of
//! seconds, at the TCP sockets the simulator's app processes hold, and records
//! each loopback server they are connected to. The SDK turns that into a
//! warning. Sampling is best effort — a connection opened and closed between
//! two samples goes unnoticed — but HTTP clients keep connections alive for
//! seconds (Node's server default is 5 s), so a request is usually seen.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::IpAddr;
use std::time::Duration;

use tokio::process::Command;
use tracing::debug;

use crate::network_proxy::join_host_port;

/// How often a running simulator capture samples the app's sockets. As often
/// as the redirector's own PID refresh: one `ps` and one `lsof` of a few PIDs,
/// a few tens of milliseconds.
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// Remote ports never reported: the React Native and Expo dev tooling an app
/// talks to over loopback in a development build (Metro's bundler and
/// inspector on 8081, React DevTools on 8097, the legacy Expo CLI on
/// 19000–19002). That traffic is not the app's, and nobody wants it captured.
const DEV_TOOL_PORTS: &[u16] = &[8081, 8097, 19000, 19001, 19002];

/// Processes of the simulator runtime that make requests on an app's behalf
/// (as in `ios_redirect::simulator_flow_origin`): a `WKWebView`'s networking
/// process and background `URLSession`s.
const APP_NETWORKING_HELPERS: &[&str] = &["/com.apple.WebKit.Networking", "/nsurlsessiond"];

/// The PIDs, from a `ps -axo pid,ppid,command` listing, of the processes in
/// `udid`'s simulator that make the app's requests: installed apps (their
/// executable lives under the simulator's `…/<udid>/data/`), and the runtime
/// helpers above. Tapsmith's own XCTest runner is left out: its sockets are
/// the agent's, not the app's.
pub(crate) fn app_pids(ps_stdout: &str, udid: &str) -> Vec<u32> {
    let simulator: HashSet<u32> = crate::ios::simulator_processes::parse_ps_output(ps_stdout, udid)
        .into_iter()
        .collect();
    let data_marker = format!("/{udid}/data/");
    let mut pids: Vec<u32> = ps_stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid: u32 = fields.next()?.parse().ok()?;
            fields.next()?.parse::<u32>().ok()?;
            if !simulator.contains(&pid) {
                return None;
            }
            let command = line.trim_start();
            let installed_app = command.contains(&data_marker)
                && !command.contains("-Runner.app/")
                && !command.contains("launchd_sim");
            let helper = APP_NETWORKING_HELPERS.iter().any(|h| {
                command
                    .split_whitespace()
                    .any(|word| word.ends_with(h) || word.contains(&format!("{h}.xpc/")))
            });
            (installed_app || helper).then_some(pid)
        })
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Split an lsof `host:port` name (`127.0.0.1:4610`, `[::1]:4610`, `*:8080`).
fn split_endpoint(endpoint: &str) -> Option<(&str, u16)> {
    let (host, port) = endpoint.rsplit_once(':')?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    Some((host, port.parse().ok()?))
}

fn is_loopback(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(IpAddr::V6(v6)) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// The loopback servers (`addr:port`) that the processes in an
/// `lsof -nP -iTCP -F pnT` listing are connected to. A socket whose local port
/// is one its own process listens on is an incoming connection to a server
/// the app hosts, not a request it made, so it is left out; so are the remote
/// ports in `excluded_ports` (Tapsmith's own proxy), [`DEV_TOOL_PORTS`], and a
/// connection still in `SYN_SENT` or `CLOSED` (nothing answered it: a client
/// retrying against a server that is not running).
pub(crate) fn loopback_destinations(lsof_stdout: &str, excluded_ports: &[u16]) -> Vec<String> {
    struct Connection<'a> {
        pid: &'a str,
        local_port: u16,
        host: &'a str,
        port: u16,
        state: Option<&'a str>,
    }
    // Per process: the ports it listens on, and its connections.
    let mut listening: HashMap<&str, HashSet<u16>> = HashMap::new();
    let mut connections: Vec<Connection> = Vec::new();
    // The TCP state line follows the name of the socket it belongs to.
    let mut last_was_connection = false;
    let mut pid = "";
    for line in lsof_stdout.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p;
            last_was_connection = false;
            continue;
        }
        if let Some(state) = line.strip_prefix("TST=") {
            if last_was_connection {
                if let Some(c) = connections.last_mut() {
                    c.state = Some(state);
                }
            }
            continue;
        }
        let Some(name) = line.strip_prefix('n') else {
            if line.starts_with('f') {
                last_was_connection = false;
            }
            continue;
        };
        match name.split_once("->") {
            Some((local, remote)) => {
                if let (Some((_, local_port)), Some((host, port))) =
                    (split_endpoint(local), split_endpoint(remote))
                {
                    connections.push(Connection {
                        pid,
                        local_port,
                        host,
                        port,
                        state: None,
                    });
                    last_was_connection = true;
                }
            }
            None => {
                if let Some((_, port)) = split_endpoint(name) {
                    listening.entry(pid).or_default().insert(port);
                }
            }
        }
    }
    let destinations: BTreeSet<String> = connections
        .into_iter()
        .filter(|c| {
            is_loopback(c.host)
                && !matches!(c.state, Some("SYN_SENT" | "CLOSED"))
                && !excluded_ports.contains(&c.port)
                && !DEV_TOOL_PORTS.contains(&c.port)
                && !listening
                    .get(c.pid)
                    .is_some_and(|ports| ports.contains(&c.local_port))
        })
        .map(|c| join_host_port(c.host, c.port))
        .collect();
    destinations.into_iter().collect()
}

/// One sample: the loopback servers the app processes of `udid`'s simulator
/// are connected to right now, minus `proxy_port` (on the system-proxy route
/// the app reaches Tapsmith's proxy over loopback). Empty when `ps` or `lsof`
/// cannot be run.
pub async fn sample(udid: &str, proxy_port: u16) -> Vec<String> {
    let ps = match Command::new("ps")
        .args(["-axo", "pid,ppid,command"])
        .output()
        .await
    {
        Ok(out) => out,
        Err(e) => {
            debug!(error = %e, "loopback watch: ps failed");
            return Vec::new();
        }
    };
    let pids = app_pids(&String::from_utf8_lossy(&ps.stdout), udid);
    if pids.is_empty() {
        return Vec::new();
    }
    let pid_list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    // `-a` ANDs the PID and TCP selections. lsof exits 1 when nothing matches,
    // so the exit status says nothing; the output is all that counts.
    match Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid_list, "-iTCP", "-F", "pnT"])
        .output()
        .await
    {
        Ok(out) => loopback_destinations(&String::from_utf8_lossy(&out.stdout), &[proxy_port]),
        Err(e) => {
            debug!(error = %e, "loopback watch: lsof failed");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDID: &str = "972FB67E-B94F-40EC-9388-7F3EFB761246";

    const PS: &str = "\
  PID  PPID COMMAND
    1     0 /sbin/launchd
  612     1 /usr/libexec/nsurlsessiond
11320     1 launchd_sim /Users/sam/Library/Developer/CoreSimulator/Devices/972FB67E-B94F-40EC-9388-7F3EFB761246/data/var/run/launchd_bootstrap.plist
14646 11320 /Users/sam/Library/Developer/CoreSimulator/Devices/972FB67E-B94F-40EC-9388-7F3EFB761246/data/Containers/Bundle/Application/F9BAB21E/Chatter.app/Chatter
14650 11320 /Library/Developer/CoreSimulator/Volumes/iOS_23E/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.Networking.xpc/com.apple.WebKit.Networking
14653 11320 /Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/System/Library/ExtensionKit/Extensions/NetworkingExtension.appex/com.apple.WebKit.Networking -LaunchArguments eyJzZXJ2aWNl
14651 11320 /Library/Developer/CoreSimulator/Volumes/iOS_23E/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/nsurlsessiond
14652 11320 /Library/Developer/CoreSimulator/Volumes/iOS_23E/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/trustd
14700 11320 /Users/sam/Library/Developer/CoreSimulator/Devices/972FB67E-B94F-40EC-9388-7F3EFB761246/data/Containers/Bundle/Application/0CD2681B/TapsmithAgentUITests-Runner.app/TapsmithAgentUITests-Runner
20000     1 /Users/sam/Library/Developer/CoreSimulator/Devices/6C21330D-1440-40AC-8E5E-F23F9164C6B6/data/Containers/Bundle/Application/AAAA/Other.app/Other
";

    #[test]
    fn app_pids_are_the_apps_and_their_networking_helpers() {
        // iOS 26 runs WebKit's networking process from an ExtensionKit
        // `.appex` (14653), older runtimes from an XPC service (14650).
        // Not launchd_sim, trustd, the agent runner, the host's own
        // nsurlsessiond, or another simulator's app.
        assert_eq!(app_pids(PS, UDID), vec![14646, 14650, 14651, 14653]);
    }

    #[test]
    fn app_pids_of_a_simulator_that_is_not_booted_are_empty() {
        assert!(app_pids(PS, "00000000-0000-0000-0000-000000000000").is_empty());
    }

    #[test]
    fn reports_loopback_servers_the_app_connected_to() {
        let lsof = "\
p14646
f20
n127.0.0.1:52100->127.0.0.1:4610
f21
n[::1]:52101->[::1]:4611
f22
n192.168.4.30:52102->17.253.144.10:443
f23
n127.0.0.1:52103->127.0.0.1:4610
";
        assert_eq!(
            loopback_destinations(lsof, &[]),
            vec!["127.0.0.1:4610".to_string(), "[::1]:4611".to_string()]
        );
    }

    #[test]
    fn ipv4_mapped_loopback_counts() {
        let lsof = "p1\nf3\nn[::ffff:127.0.0.1]:5000->[::ffff:127.0.0.1]:4610\n";
        assert_eq!(
            loopback_destinations(lsof, &[]),
            vec!["[::ffff:127.0.0.1]:4610".to_string()]
        );
    }

    #[test]
    fn leaves_out_dev_tools_the_proxy_and_incoming_connections() {
        let lsof = "\
p14646
f10
n127.0.0.1:52000->127.0.0.1:8081
f11
n127.0.0.1:52001->127.0.0.1:55000
f12
n*:9000
f13
n127.0.0.1:9000->127.0.0.1:61000
p14650
f5
n127.0.0.1:61000->127.0.0.1:9000
";
        // 8081: Metro. 55000: Tapsmith's proxy (system-proxy route). The
        // app's own server on 9000: the incoming side is left out, but the
        // WebKit process connecting to it is a request like any other.
        assert_eq!(
            loopback_destinations(lsof, &[55000]),
            vec!["127.0.0.1:9000".to_string()]
        );
    }

    #[test]
    fn leaves_out_connections_that_never_reached_a_server() {
        // A fetch retrying against a port nothing listens on sits in SYN_SENT;
        // the TCP state follows the name in `-F pnT` output.
        let lsof = "\
p14646
f10
n127.0.0.1:52000->127.0.0.1:4699
TST=SYN_SENT
TQR=0
f11
n127.0.0.1:52001->127.0.0.1:4610
TST=ESTABLISHED
f12
n127.0.0.1:52002->127.0.0.1:4611
TST=CLOSE_WAIT
";
        assert_eq!(
            loopback_destinations(lsof, &[]),
            vec!["127.0.0.1:4610".to_string(), "127.0.0.1:4611".to_string()]
        );
    }

    #[test]
    fn empty_or_unparseable_output_reports_nothing() {
        assert!(loopback_destinations("", &[]).is_empty());
        assert!(loopback_destinations("p1\nfcwd\nnnot-a-socket\n", &[]).is_empty());
    }
}
