//! MITM Certificate Authority for HTTPS interception.
//!
//! Generates a root CA on first use, persists it to `~/.tapsmith/`, and creates
//! per-host leaf certificates signed by that CA. Each host's `ServerConfig`
//! is cached so TLS handshakes are fast on repeat visits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use md5::{Digest, Md5};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::pki_types::CertificateDer;
use rustls::ServerConfig;
use time::{Duration, OffsetDateTime};
use tokio::sync::Mutex;
use tracing::{debug, info};
use x509_parser::prelude::FromDer;

/// Directory under the user's home where CA files are stored.
const TAPSMITH_DIR: &str = ".tapsmith";
const CA_CERT_FILENAME: &str = "ca.pem";
const CA_KEY_FILENAME: &str = "ca-key.pem";

/// MITM certificate authority that generates per-host TLS certificates.
pub struct MitmAuthority {
    /// DER of the CA certificate exactly as persisted in `ca.pem` (the one
    /// pushed to devices).
    ca_cert_der: CertificateDer<'static>,
    /// Issuer (subject DN, key identifier method, key usages and signing key)
    /// used to sign per-host leaf certificates.
    ca_issuer: Issuer<'static, KeyPair>,
    ca_pem_path: PathBuf,
    host_cache: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

impl MitmAuthority {
    /// Load an existing CA from disk, or generate a new one.
    pub fn load_or_create() -> Result<Self> {
        let tapsmith_dir = Self::tapsmith_dir()?;
        std::fs::create_dir_all(&tapsmith_dir)
            .with_context(|| format!("Failed to create {}", tapsmith_dir.display()))?;

        let cert_path = tapsmith_dir.join(CA_CERT_FILENAME);
        let key_path = tapsmith_dir.join(CA_KEY_FILENAME);

        if cert_path.exists() && key_path.exists() {
            info!(path = %cert_path.display(), "Loading existing MITM CA");
            Self::load_from_disk(&cert_path, &key_path)
        } else {
            info!(path = %cert_path.display(), "Generating new MITM CA");
            Self::generate_new(&cert_path, &key_path)
        }
    }

    /// Path to the CA PEM certificate file (for pushing to device).
    pub fn ca_pem_path(&self) -> &Path {
        &self.ca_pem_path
    }

    /// Compute the Android `subject_hash_old` filename for this CA certificate.
    ///
    /// Android's user CA store (`/data/misc/user/0/cacerts-added/`) requires
    /// certificates to be named `<hash>.0` where `<hash>` is the OpenSSL
    /// "old-style" subject hash: MD5 of the DER-encoded subject name,
    /// first 4 bytes read as little-endian u32, formatted as 8-char lowercase hex.
    pub fn device_cert_filename(&self) -> Result<String> {
        let der = &self.ca_cert_der;
        let (_, cert) = x509_parser::certificate::X509Certificate::from_der(der)
            .map_err(|e| anyhow::anyhow!("Failed to parse CA cert DER: {e}"))?;

        let subject_der = cert.subject().as_raw();
        let digest = Md5::digest(subject_der);
        let hash = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
        Ok(format!("{hash:08x}.0"))
    }

    /// Get or create a `rustls::ServerConfig` for the given hostname.
    /// Results are cached so subsequent calls for the same host are fast.
    pub async fn server_config_for_host(&self, hostname: &str) -> Result<Arc<ServerConfig>> {
        // Fast path: check cache
        let mut cache = self.host_cache.lock().await;
        if let Some(config) = cache.get(hostname) {
            return Ok(config.clone());
        }

        debug!(hostname, "Generating leaf certificate for MITM");

        let host_key = KeyPair::generate().context("Failed to generate host key pair")?;

        let mut params = CertificateParams::new(vec![hostname.to_string()])
            .context("Failed to create cert params for host")?;

        let now = OffsetDateTime::now_utc();
        params.not_before = now.checked_sub(Duration::days(1)).unwrap_or(now);
        params.not_after = now.checked_add(Duration::days(365)).unwrap_or(now);

        params.distinguished_name.push(DnType::CommonName, hostname);
        params.key_usages.push(KeyUsagePurpose::DigitalSignature);
        params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ServerAuth);

        let cert = params
            .signed_by(&host_key, &self.ca_issuer)
            .context("Failed to sign host certificate")?;

        let cert_der = cert.der().clone();
        let key_der = rustls::pki_types::PrivatePkcs8KeyDer::from(host_key.serialize_der()).into();

        let mut config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der], key_der)
            .context("Failed to build rustls ServerConfig for host")?;
        // Advertise both http/1.1 and h2 via ALPN, http/1.1 FIRST. rustls
        // negotiates by server preference, so dual-protocol clients (NSURLSession,
        // OkHttp, browsers) keep negotiating http/1.1 — the battle-tested path,
        // and the one that reaches http/1.1-only origins without trouble. Only
        // h2-only clients (gRPC, Firestore) negotiate h2 and take the new HTTP/2
        // pipeline (PILOT-245); those always talk to h2 origins, so the upstream
        // is virtually always h2 too. Clients with no ALPN extension are handled
        // as HTTP/1.1. The negotiated protocol is read back from the completed
        // handshake to pick the pipeline.
        config.alpn_protocols = vec![b"http/1.1".to_vec(), b"h2".to_vec()];

        let config = Arc::new(config);
        cache.insert(hostname.to_string(), config.clone());
        Ok(config)
    }

    // ─── Private helpers ───

    fn tapsmith_dir() -> Result<PathBuf> {
        let home = dirs::home_dir().context("Could not determine home directory")?;
        Ok(home.join(TAPSMITH_DIR))
    }

    pub(crate) fn generate_new(cert_path: &Path, key_path: &Path) -> Result<Self> {
        let ca_key = KeyPair::generate().context("Failed to generate CA key pair")?;

        let mut params =
            CertificateParams::new(Vec::default()).context("Failed to create CA cert params")?;

        let now = OffsetDateTime::now_utc();
        params.not_before = now.checked_sub(Duration::days(1)).unwrap_or(now);
        params.not_after = now.checked_add(Duration::days(3650)).unwrap_or(now);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, "Tapsmith MITM CA");
        params
            .distinguished_name
            .push(DnType::OrganizationName, "Tapsmith");
        params.key_usages.push(KeyUsagePurpose::KeyCertSign);
        params.key_usages.push(KeyUsagePurpose::CrlSign);

        let ca_cert = params
            .self_signed(&ca_key)
            .context("Failed to self-sign CA certificate")?;

        // Persist to disk
        let cert_pem = ca_cert.pem();
        let key_pem = ca_key.serialize_pem();
        let ca_cert_der = ca_cert.der().clone();
        let ca_issuer = Issuer::new(params, ca_key);
        std::fs::write(cert_path, &cert_pem)
            .with_context(|| format!("Failed to write CA cert to {}", cert_path.display()))?;
        std::fs::write(key_path, &key_pem)
            .with_context(|| format!("Failed to write CA key to {}", key_path.display()))?;

        // Restrict key file permissions to owner-only (0600)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("Failed to set permissions on {}", key_path.display()))?;
        }

        info!(path = %cert_path.display(), "MITM CA certificate saved");

        Ok(Self {
            ca_cert_der,
            ca_issuer,
            ca_pem_path: cert_path.to_path_buf(),
            host_cache: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn load_from_disk(cert_path: &Path, key_path: &Path) -> Result<Self> {
        let cert_pem = std::fs::read_to_string(cert_path)
            .with_context(|| format!("Failed to read CA cert from {}", cert_path.display()))?;
        let key_pem = std::fs::read_to_string(key_path)
            .with_context(|| format!("Failed to read CA key from {}", key_path.display()))?;

        let ca_key = KeyPair::from_pem(&key_pem).context("Failed to parse CA key from PEM")?;

        let ca_cert_der = rustls_pemfile::certs(&mut cert_pem.as_bytes())
            .next()
            .context("No certificate found in CA PEM")?
            .context("Failed to parse CA cert PEM")?;

        // Use the stored CA cert as the issuer of leaf certificates. Leaves
        // are signed with the issuer's subject and key identifier, so they
        // chain to the cert already installed on devices.
        let ca_issuer = Issuer::from_ca_cert_der(&ca_cert_der, ca_key)
            .context("Failed to parse CA cert params from PEM")?;

        Ok(Self {
            ca_cert_der,
            ca_issuer,
            ca_pem_path: cert_path.to_path_buf(),
            host_cache: Mutex::new(HashMap::new()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn generate_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("ca.pem");
        let key_path = dir.path().join("ca-key.pem");

        // Generate new CA
        let ca = MitmAuthority::generate_new(&cert_path, &key_path).unwrap();
        assert!(cert_path.exists());
        assert!(key_path.exists());

        // Key file should have restricted permissions on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::metadata(&key_path).unwrap().permissions();
            assert_eq!(perms.mode() & 0o777, 0o600);
        }

        // Verify CA PEM path is correct
        assert_eq!(ca.ca_pem_path(), cert_path.as_path());

        // Load from disk should succeed
        let _loaded = MitmAuthority::load_from_disk(&cert_path, &key_path).unwrap();

        // device_cert_filename should return a valid hash-based name
        let filename = ca.device_cert_filename().unwrap();
        assert!(
            filename.ends_with(".0"),
            "filename should end with .0, got: {filename}"
        );
        let hash_part = filename.strip_suffix(".0").unwrap();
        assert_eq!(hash_part.len(), 8, "hash should be 8 hex chars");
        assert!(
            hash_part.chars().all(|c| c.is_ascii_hexdigit()),
            "hash should be hex, got: {hash_part}"
        );

        // Loaded CA should produce the same filename
        let loaded = MitmAuthority::load_from_disk(&cert_path, &key_path).unwrap();
        assert_eq!(loaded.device_cert_filename().unwrap(), filename);
    }

    #[test]
    fn device_cert_filename_matches_openssl() {
        // Verify our subject_hash_old matches `openssl x509 -subject_hash_old`
        // against the real CA cert if it exists.
        let home = std::env::var("HOME").unwrap();
        let cert_path = PathBuf::from(&home).join(".tapsmith/ca.pem");
        let key_path = PathBuf::from(&home).join(".tapsmith/ca-key.pem");
        if !cert_path.exists() || !key_path.exists() {
            eprintln!("Skipping: ~/.tapsmith/ca.pem not found");
            return;
        }

        let ca = MitmAuthority::load_from_disk(&cert_path, &key_path).unwrap();
        let filename = ca.device_cert_filename().unwrap();

        let openssl_output = std::process::Command::new("openssl")
            .args(["x509", "-subject_hash_old", "-noout", "-in"])
            .arg(&cert_path)
            .output()
            .expect("openssl must be installed");
        let expected_hash = String::from_utf8(openssl_output.stdout)
            .unwrap()
            .trim()
            .to_string();

        assert_eq!(
            filename,
            format!("{expected_hash}.0"),
            "Our hash must match openssl x509 -subject_hash_old"
        );
    }

    /// Run an in-memory TLS handshake for `host` against `server_config`,
    /// with a client that trusts only the CA in `ca_pem`.
    fn handshake_trusting(ca_pem: &Path, host: &str, server_config: Arc<ServerConfig>) {
        let mut roots = rustls::RootCertStore::empty();
        let pem = fs::read(ca_pem).unwrap();
        for cert in rustls_pemfile::certs(&mut pem.as_slice()) {
            roots.add(cert.unwrap()).unwrap();
        }
        let client_config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let server_name = rustls::pki_types::ServerName::try_from(host.to_string()).unwrap();
        let mut client =
            rustls::ClientConnection::new(Arc::new(client_config), server_name).unwrap();
        let mut server = rustls::ServerConnection::new(server_config).unwrap();

        for _ in 0..10 {
            if !client.is_handshaking() && !server.is_handshaking() {
                return;
            }
            let mut buf = Vec::new();
            client.write_tls(&mut buf).unwrap();
            server.read_tls(&mut buf.as_slice()).unwrap();
            server.process_new_packets().unwrap();
            let mut buf = Vec::new();
            server.write_tls(&mut buf).unwrap();
            client.read_tls(&mut buf.as_slice()).unwrap();
            client
                .process_new_packets()
                .expect("client must accept the leaf as chaining to the persisted CA");
        }
        panic!("TLS handshake did not complete");
    }

    #[tokio::test]
    async fn leaf_certs_chain_to_persisted_ca_after_reload() {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("ca.pem");
        let key_path = dir.path().join("ca-key.pem");
        let fresh = MitmAuthority::generate_new(&cert_path, &key_path).unwrap();
        let config = fresh.server_config_for_host("example.com").await.unwrap();
        handshake_trusting(&cert_path, "example.com", config);

        // A CA loaded from disk (the common path: every daemon start after the
        // first) must sign leaves that chain to the cert devices already trust.
        let loaded = MitmAuthority::load_from_disk(&cert_path, &key_path).unwrap();
        let config = loaded.server_config_for_host("example.com").await.unwrap();
        handshake_trusting(&cert_path, "example.com", config);
    }

    #[tokio::test]
    async fn server_config_for_host_generates_and_caches() {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("ca.pem");
        let key_path = dir.path().join("ca-key.pem");
        let ca = MitmAuthority::generate_new(&cert_path, &key_path).unwrap();

        // First call generates
        let config1 = ca.server_config_for_host("example.com").await.unwrap();
        // Second call should return cached config (same Arc)
        let config2 = ca.server_config_for_host("example.com").await.unwrap();
        assert!(Arc::ptr_eq(&config1, &config2));

        // Different host should generate a different config
        let config3 = ca.server_config_for_host("other.com").await.unwrap();
        assert!(!Arc::ptr_eq(&config1, &config3));
    }
}
