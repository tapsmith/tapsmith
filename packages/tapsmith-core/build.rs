use std::path::{Path, PathBuf};
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Use a vendored protoc by default so builds do not depend on runner/container
    // packages, but allow callers to override PROTOC explicitly.
    if std::env::var_os("PROTOC").is_none() {
        let protoc = protoc_bin_vendored::protoc_bin_path()?;
        std::env::set_var("PROTOC", protoc);
    }

    // Try monorepo-relative path first, fall back to local copy (used by cross builds
    // where only the crate directory is mounted into the Docker container).
    let (proto_path, include_dir): (PathBuf, PathBuf) = if PathBuf::from(
        "../../proto/tapsmith.proto",
    )
    .exists()
    {
        (
            PathBuf::from("../../proto/tapsmith.proto"),
            PathBuf::from("../../proto"),
        )
    } else if PathBuf::from("proto/tapsmith.proto").exists() {
        (
            PathBuf::from("proto/tapsmith.proto"),
            PathBuf::from("proto"),
        )
    } else {
        panic!(
            "Proto file not found. Expected at ../../proto/tapsmith.proto (monorepo) or proto/tapsmith.proto (cross build)"
        );
    };

    let mut protos: Vec<PathBuf> = vec![proto_path.clone()];
    let mut includes: Vec<PathBuf> = vec![include_dir];

    // The mitmproxy_ipc IPC proto is only needed on macOS (the ios_redirect
    // module that uses it is cfg-gated). Compiling it only when targeting
    // macOS keeps the Linux build surface minimal and avoids unused-code
    // warnings from generated types.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let vendored = PathBuf::from("vendor/mitmproxy_ipc.proto");
        if !vendored.exists() {
            panic!(
                "Vendored proto missing at {:?}. See vendor header for upstream source.",
                vendored
            );
        }
        protos.push(vendored);
        includes.push(PathBuf::from("vendor"));
        println!("cargo:rerun-if-changed=vendor/mitmproxy_ipc.proto");
    }

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&protos, &includes)?;

    println!("cargo:rerun-if-changed={}", proto_path.display());

    // ─── iOS HID helper (macOS only) ───
    // Compile the native `tapsmith-ios-hid` helper next to the daemon binary so
    // the daemon resolves it as a sibling and the release workflow bundles it
    // into the macOS @tapsmith/core-* packages. CoreSimulator/SimulatorKit are
    // dlopen'd by the helper at runtime, so only public frameworks are linked.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // OUT_DIR sits under the profile dir's `build/` folder, at a depth
        // that depends on the Cargo version:
        //   Cargo < 1.100: target/<profile>/build/<crate>-<hash>/out
        //   Cargo ≥ 1.100: target/<profile>/build/<crate>/<hash>/out
        // (with an extra <triple> segment before <profile> under --target).
        // The profile dir, where the daemon binary lands, is the parent of
        // the nearest `build` ancestor in both layouts.
        let out_dir = std::env::var("OUT_DIR")?;
        let profile_dir = profile_dir_from_out_dir(Path::new(&out_dir))
            .ok_or_else(|| format!("could not derive profile dir from OUT_DIR={out_dir}"))?;
        let helper_out = profile_dir.join("tapsmith-ios-hid");
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("x86_64") => "x86_64",
            _ => "arm64",
        };
        let status = Command::new("clang")
            .args(["-fobjc-arc", "-arch", arch])
            .args(["-framework", "Foundation", "-framework", "CoreGraphics"])
            .arg("-o")
            .arg(&helper_out)
            .arg("native/tapsmith-ios-hid.m")
            .arg("native/hid_protocol.c")
            .status()
            .map_err(|e| format!("failed to run clang for tapsmith-ios-hid: {e}"))?;
        if !status.success() {
            return Err(format!("clang failed to build tapsmith-ios-hid: {status}").into());
        }
        println!("cargo:rerun-if-changed=native/tapsmith-ios-hid.m");
        println!("cargo:rerun-if-changed=native/hid_protocol.c");
        println!("cargo:rerun-if-changed=native/hid_protocol.h");
    }

    Ok(())
}

/// The profile dir (`target/[<triple>/]<profile>`) that holds a build script's
/// `OUT_DIR`: the parent of the nearest ancestor named `build`.
fn profile_dir_from_out_dir(out_dir: &Path) -> Option<PathBuf> {
    out_dir
        .ancestors()
        .skip(1)
        .find(|p| p.file_name().is_some_and(|n| n == "build"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}
