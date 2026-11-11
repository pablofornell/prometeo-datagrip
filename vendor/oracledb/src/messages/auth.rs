//-----------------------------------------------------------------------------
// Copyright (c) 2026, Oracle and/or its affiliates.
//
// This software is dual-licensed to you under the Universal Permissive License
// (UPL) 1.0 as shown at https://oss.oracle.com/licenses/upl and Apache License
// 2.0 as shown at http://www.apache.org/licenses/LICENSE-2.0. You may choose
// either license.
//
// If you elect to accept the software under the Apache License, Version 2.0,
// the following applies:
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
// auth.rs
//
// Defines the structure used for sending and receiving the auth message.
// This is the fourth (and fifth) messages sent to the database while
// establishing a connection and can be combined with the protocol and data
// types messages when fast authentication is available.
// -----------------------------------------------------------------------------

use aes::cipher::block_padding::NoPadding;
use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use des::cipher::{BlockCipherEncrypt, KeyInit};
use rand::RngExt;
use sha2::Digest;
use std::collections::HashMap;

use crate::client::Client;
use crate::constants;
use crate::error::Error;
use crate::messages::Message;
use crate::ora_version::OracleVersion;
use crate::response::Response;
use crate::write_buffer::WriteBuffer;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes192CbcDec = cbc::Decryptor<aes::Aes192>;
type Aes192CbcEnc = cbc::Encryptor<aes::Aes192>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

struct Pair {
    key: String,
    value: String,
    flags: u32,
}

impl Pair {
    fn new(key: &str, value: &str, flags: u32) -> Pair {
        Pair { key: String::from(key), value: String::from(value), flags }
    }
}

fn bad_auth(reason: impl Into<String>) -> Error {
    Error::invalid_auth_response(reason.into())
}

/// AES-CBC (zero IV, no padding) decryption. The key is 16 bytes (AES-128,
/// 10G verifiers and their combo key), 24 bytes (AES-192, 11G verifiers) or
/// 32 bytes (AES-256, 12C verifiers); the input length must
/// be a multiple of the block size.
fn decrypt_cbc(key: &[u8], encrypted_text: &[u8]) -> Result<Vec<u8>, Error> {
    let iv = [0u8; 16];
    let mut plain_text = vec![0u8; encrypted_text.len()];
    let result = match key.len() {
        16 => Aes128CbcDec::new_from_slices(key, &iv)
            .expect("key and IV lengths checked")
            .decrypt_padded_b2b::<NoPadding>(encrypted_text, &mut plain_text)
            .map(|_| ()),
        24 => Aes192CbcDec::new_from_slices(key, &iv)
            .expect("key and IV lengths checked")
            .decrypt_padded_b2b::<NoPadding>(encrypted_text, &mut plain_text)
            .map(|_| ()),
        32 => Aes256CbcDec::new_from_slices(key, &iv)
            .expect("key and IV lengths checked")
            .decrypt_padded_b2b::<NoPadding>(encrypted_text, &mut plain_text)
            .map(|_| ()),
        n => return Err(bad_auth(format!("unexpected key length {n}"))),
    };
    result.map_err(|_| {
        bad_auth(format!(
            "AUTH_SESSKEY has an invalid length ({} bytes)",
            encrypted_text.len()
        ))
    })?;
    Ok(plain_text)
}

/// AES-CBC (zero IV, no padding) encryption; see `decrypt_cbc`. Callers
/// always pass whole blocks.
fn encrypt_cbc(key: &[u8], plain_text: &[u8]) -> Vec<u8> {
    let iv = [0u8; 16];
    let mut encrypted_text = vec![0u8; plain_text.len()];
    match key.len() {
        16 => {
            Aes128CbcEnc::new_from_slices(key, &iv)
                .expect("key and IV lengths checked")
                .encrypt_padded_b2b::<NoPadding>(
                    plain_text,
                    &mut encrypted_text,
                )
                .expect("plain text is a whole number of blocks");
        }
        24 => {
            Aes192CbcEnc::new_from_slices(key, &iv)
                .expect("key and IV lengths checked")
                .encrypt_padded_b2b::<NoPadding>(
                    plain_text,
                    &mut encrypted_text,
                )
                .expect("plain text is a whole number of blocks");
        }
        32 => {
            Aes256CbcEnc::new_from_slices(key, &iv)
                .expect("key and IV lengths checked")
                .encrypt_padded_b2b::<NoPadding>(
                    plain_text,
                    &mut encrypted_text,
                )
                .expect("plain text is a whole number of blocks");
        }
        n => unreachable!("AES key of {n} bytes"),
    }
    encrypted_text
}

/// DES-CBC (zero IV) of `input` (whole blocks); returns the last block.
fn des_cbc_last_block(key: &[u8; 8], input: &[u8]) -> [u8; 8] {
    let cipher = des::Des::new(key.into());
    let mut block = [0u8; 8];
    for chunk in input.chunks(8) {
        for (b, c) in block.iter_mut().zip(chunk) {
            *b ^= c;
        }
        let mut out = des::cipher::Block::<des::Des>::from(block);
        cipher.encrypt_block(&mut out);
        block = out.into();
    }
    block
}

/// The 10G (pre-11g) password hash: UTF-16BE of the upper-cased user and
/// password, zero padded to 8 bytes, DES-CBC with key 0x0123456789ABCDEF; the
/// last block is the key of a second DES-CBC pass, whose last block is the
/// hash (`dba_users.password` of 10g).
fn des_password_hash(user: &str, password: &[u8]) -> [u8; 8] {
    let text = format!("{}{}", user, String::from_utf8_lossy(password))
        .to_uppercase();
    let mut input: Vec<u8> =
        text.encode_utf16().flat_map(u16::to_be_bytes).collect();
    input.resize(input.len().div_ceil(8) * 8, 0);
    let key1 = des_cbc_last_block(
        &[0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef],
        &input,
    );
    des_cbc_last_block(&key1, &input)
}

fn get_derived_key(
    key: &[u8],
    salt: &[u8],
    iterations: u32,
    derived_key: &mut [u8],
) {
    pbkdf2::pbkdf2_hmac::<sha2::Sha512>(key, salt, iterations, derived_key);
}

/// Computes the key that encrypts the session key halves, from the password
/// and the verifier data sent by the server. Returns it together with the
/// PBKDF2 password key (12C only, needed for the "speedy" key).
///
/// - 12C: PBKDF2-SHA512(password, vfr_data || "AUTH_PBKDF2_SPEEDY_KEY",
///   VGEN_COUNT) = password_key; hash = SHA512(password_key || vfr_data)[..32]
/// - 11G: hash = SHA1(password || vfr_data) || 4 zero bytes (24 bytes)
/// - 10G: hash = the DES password hash of the user and password (see
///   `des_password_hash`) || 8 zero bytes (16 bytes, AES-128)
///
/// 12C and 11G are what python-oracledb does in thin mode (`AuthMessage
/// ._generate_verifier`); python-oracledb has no 10G, which follows JDBC thin.
fn password_hash(
    verifier_type: u32,
    user: &str,
    password: &[u8],
    verifier_data: &[u8],
    vgen_count: Option<u32>,
) -> Result<(Vec<u8>, Option<[u8; 64]>), Error> {
    if verifier_type == constants::VERIFIER_TYPE_12C as u32 {
        let iterations = vgen_count.ok_or_else(|| {
            bad_auth("AUTH_PBKDF2_VGEN_COUNT missing for a 12C verifier")
        })?;
        let mut salt = verifier_data.to_vec();
        salt.extend(b"AUTH_PBKDF2_SPEEDY_KEY");
        let mut password_key = [0u8; 64];
        get_derived_key(password, &salt, iterations, &mut password_key);
        let mut hasher = sha2::Sha512::new();
        hasher.update(password_key);
        hasher.update(verifier_data);
        Ok((hasher.finalize()[..32].to_vec(), Some(password_key)))
    } else if verifier_type == constants::VERIFIER_TYPE_11G_1 as u32
        || verifier_type == constants::VERIFIER_TYPE_11G_2 as u32
    {
        let mut hasher = sha1::Sha1::new();
        hasher.update(password);
        hasher.update(verifier_data);
        let mut hash = hasher.finalize().to_vec();
        hash.extend([0u8; 4]);
        Ok((hash, None))
    } else if verifier_type == constants::VERIFIER_TYPE_10G as u32 {
        let mut hash = des_password_hash(user, password).to_vec();
        hash.extend([0u8; 8]);
        Ok((hash, None))
    } else {
        Err(Error::unsupported_password_verifier(verifier_type))
    }
}

/// Builds the combo key (the key that encrypts the password) from both
/// halves of the session key. 10G: MD5 of the XOR of bytes 16..32 of the
/// halves (what JDBC thin and go-ora do); 48-byte session keys (11G) XOR
/// bytes 16..40 of the halves; 32-byte ones (12C) run PBKDF2 over the hex of
/// both halves.
fn combo_key(
    verifier_type: u32,
    part_a: &[u8],
    part_b: &[u8],
    key_len: usize,
    csk_salt: Option<&[u8]>,
    sder_count: Option<u32>,
) -> Result<Vec<u8>, Error> {
    if verifier_type == constants::VERIFIER_TYPE_10G as u32
        && csk_salt.is_none()
    {
        let xor: Vec<u8> = part_a[16..32]
            .iter()
            .zip(&part_b[16..32])
            .map(|(a, b)| a ^ b)
            .collect();
        Ok(md5::Md5::digest(&xor).to_vec())
    } else if part_a.len() == 48 {
        Ok(part_a[16..40]
            .iter()
            .zip(&part_b[16..40])
            .map(|(a, b)| a ^ b)
            .collect())
    } else {
        let salt = csk_salt
            .ok_or_else(|| bad_auth("AUTH_PBKDF2_CSK_SALT missing"))?;
        let iterations = sder_count
            .ok_or_else(|| bad_auth("AUTH_PBKDF2_SDER_COUNT missing"))?;
        let mut raw_temp_key = part_b[..key_len].to_vec();
        raw_temp_key.extend(&part_a[..key_len]);
        let temp_key = base16ct::upper::encode_string(&raw_temp_key);
        let mut combo_key = vec![0u8; key_len];
        get_derived_key(temp_key.as_bytes(), salt, iterations, &mut combo_key);
        Ok(combo_key)
    }
}

pub struct AuthMessage {
    pub session_data: HashMap<String, String>,
    pairs: Vec<Pair>,
    combo_key: Option<Vec<u8>>,
    resend_needed: bool,
    /// Flags of the AUTH_VFR_DATA pair sent by the server: the type of the
    /// account's password verifier (`constants::VERIFIER_TYPE_*`).
    verifier_type: Option<u32>,
}

impl AuthMessage {
    /// Adds a key/value pair to the list of key/value pairs being sent to the
    /// database during authentication.
    fn add_pair(&mut self, key: &str, value: &str, flags: u32) {
        self.pairs.push(Pair::new(key, value, flags));
    }

    /// Adds a key/value pair to the list of key/value pairs being sent to the
    /// database during authentication, but hex encodes the binary value first.
    fn add_pair_binary(&mut self, key: &str, value: &[u8], flags: u32) {
        let str_value = base16ct::upper::encode_string(value);
        self.add_pair(key, &str_value, flags);
    }

    /// Encrypts a password and adds a key/value pair containing the encrypted
    /// password.
    fn encrypt_password(
        &mut self,
        key: &str,
        password: &[u8],
        combo_key: &[u8],
    ) {
        let pad_amount = 16 - password.len() % 16;
        let mut padded_input = vec![0u8; password.len() + pad_amount + 16];
        rand::rng().fill(&mut padded_input[..16]);
        padded_input[16..16 + password.len()].copy_from_slice(password);
        let offset = password.len() + 16;
        let pad_byte: u8 = pad_amount.try_into().unwrap();
        for i in 0..pad_amount {
            padded_input[offset + i] = pad_byte;
        }
        let output_val = encrypt_cbc(combo_key, &padded_input);
        self.add_pair_binary(key, &output_val[..], 0);
    }

    /// Encrypts the main password (and the new password, if applicable).
    fn encrypt_passwords(&mut self, client: &mut Client, combo_key: &[u8]) {
        self.encrypt_password(
            "AUTH_PASSWORD",
            &client.config().get_password_bytes(),
            combo_key,
        );
        if let Some(new_password) = client.config().get_new_password_bytes() {
            self.encrypt_password(
                "AUTH_NEWPASSWORD",
                &new_password,
                combo_key,
            );
        }
    }

    /// Returns an optional hex-encoded session data value, decoded.
    fn session_hex(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        self.session_data
            .get(key)
            .map(|v| {
                base16ct::mixed::decode_vec(v)
                    .map_err(|_| bad_auth(format!("{key} is not valid hex")))
            })
            .transpose()
    }

    /// Returns an optional numeric session data value.
    fn session_u32(&self, key: &str) -> Result<Option<u32>, Error> {
        self.session_data
            .get(key)
            .map(|v| {
                v.trim()
                    .parse::<u32>()
                    .map_err(|_| bad_auth(format!("{key} is not a number")))
            })
            .transpose()
    }

    /// Generates the "speedy" key used by the server for validation without
    /// requiring time consuming calculations (12C verifiers only).
    fn generate_speedy_key(&mut self, password_key: &[u8], combo_key: &[u8]) {
        let mut input_val = [0u8; 80];
        rand::rng().fill(&mut input_val[..16]);
        input_val[16..].copy_from_slice(password_key);
        let speedy_key = encrypt_cbc(combo_key, &input_val);
        self.add_pair_binary("AUTH_PBKDF2_SPEEDY_KEY", &speedy_key, 0);
    }

    /// Generates the password verifier and the various keys required by the
    /// server for validation. Supports 12C, 11G and 10G password verifiers
    /// (others give a clear error instead of a panic).
    fn generate_verifier(&mut self, client: &mut Client) -> Result<(), Error> {
        let verifier_type = self
            .verifier_type
            .ok_or_else(|| bad_auth("AUTH_VFR_DATA missing"))?;
        let verifier_data = self
            .session_hex("AUTH_VFR_DATA")?
            .ok_or_else(|| bad_auth("AUTH_VFR_DATA missing"))?;
        let password = client.config().get_password_bytes();
        let user = client.config().user().unwrap_or_default();
        let (password_hash, password_key) = password_hash(
            verifier_type,
            user,
            &password,
            &verifier_data,
            self.session_u32("AUTH_PBKDF2_VGEN_COUNT")?,
        )?;
        let key_len = password_hash.len();

        // decrypt first half of session key
        let encoded_server_key = self
            .session_hex("AUTH_SESSKEY")?
            .ok_or_else(|| bad_auth("AUTH_SESSKEY missing"))?;
        let session_key_part_a =
            decrypt_cbc(&password_hash, &encoded_server_key)?;
        if session_key_part_a.len() != 48 && session_key_part_a.len() < 32 {
            return Err(bad_auth(format!(
                "AUTH_SESSKEY has an unexpected length ({} bytes)",
                session_key_part_a.len()
            )));
        }

        // generate second half of session key: 48 bytes for a 48-byte server
        // half, otherwise 32 (python-oracledb sends 96 or 64 hex digits)
        let part_b_len = if session_key_part_a.len() == 48 { 48 } else { 32 };
        let mut session_key_part_b = vec![0u8; part_b_len];
        rand::rng().fill(&mut session_key_part_b[..]);
        let session_key = encrypt_cbc(&password_hash, &session_key_part_b);
        self.add_pair_binary("AUTH_SESSKEY", &session_key, 1);

        // calculate combo key
        let combo_key = combo_key(
            verifier_type,
            &session_key_part_a,
            &session_key_part_b,
            key_len,
            self.session_hex("AUTH_PBKDF2_CSK_SALT")?.as_deref(),
            self.session_u32("AUTH_PBKDF2_SDER_COUNT")?,
        )?;

        // generate speedy key (12C verifiers only)
        if let Some(password_key) = password_key {
            self.generate_speedy_key(&password_key, &combo_key);
        }

        // encrypt password(s)
        self.encrypt_passwords(client, &combo_key);
        self.combo_key = Some(combo_key);
        Ok(())
    }

    /// Returns the alter session statement that is sent during the initial
    /// connection to the database. This includes the directive to change the
    /// session time zone to match the time zone in use by the system.
    fn get_alter_session_statement(&self) -> String {
        let tz_repr = if let Ok(value) = std::env::var("ORA_SDTZ")
            && !value.is_empty()
        {
            match value.to_uppercase().as_str() {
                "LOCAL" | "DBTIMEZONE" => value,
                _ => crate::enquote_literal(&value),
            }
        } else {
            let offset_seconds =
                chrono::Local::now().offset().local_minus_utc();
            let tz_hour = offset_seconds / 3600;
            let tz_minute = (offset_seconds - (tz_hour * 3600)) / 60;
            if tz_hour < 0 || tz_minute < 0 {
                format!("'-{:02}:{:02}'", tz_hour.abs(), tz_minute.abs())
            } else {
                format!("'+{:02}:{:02}'", tz_hour, tz_minute)
            }
        };
        format!("ALTER SESSION SET TIME_ZONE={}\0", tz_repr)
    }

    /// Returns the authorization mode to use when performing authentication.
    fn get_auth_mode(&self, client: &Client) -> u32 {
        let mut auth_mode: u32 = 0;
        if self.get_is_phase_one() {
            auth_mode |= constants::TTC_AUTH_MODE_LOGON;
        } else {
            auth_mode |= constants::TTC_AUTH_MODE_WITH_PASSWORD;
            if client.config().get_new_password_bytes().is_some() {
                auth_mode |= constants::TTC_AUTH_MODE_CHANGE_PASSWORD;
            } else {
                auth_mode |= constants::TTC_AUTH_MODE_LOGON;
            }
        }
        let user_auth_mode = client.config().auth_mode();
        if user_auth_mode & constants::AUTH_MODE_SYSASM != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSASM;
        }
        if user_auth_mode & constants::AUTH_MODE_SYSBKP != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSBKP;
        }
        if user_auth_mode & constants::AUTH_MODE_SYSDBA != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSDBA;
        }
        if user_auth_mode & constants::AUTH_MODE_SYSDGD != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSDGD;
        }
        if user_auth_mode & constants::AUTH_MODE_SYSKMT != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSKMT;
        }
        if user_auth_mode & constants::AUTH_MODE_SYSOPER != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSOPER;
        }
        if user_auth_mode & constants::AUTH_MODE_SYSRAC != 0 {
            auth_mode |= constants::TTC_AUTH_MODE_SYSRAC;
        }
        auth_mode
    }

    /// Returns whether phase one authorization is taking place or phase two
    /// authorization. Phase one is only used on logon.
    fn get_is_phase_one(&self) -> bool {
        self.combo_key.is_none() && self.session_data.is_empty()
    }

    /// Returns the TTC meessage type to use when sending the request to the
    /// database.
    fn get_ttc_message_type(&self) -> u8 {
        if self.get_is_phase_one() {
            constants::TTC_RPC_AUTH_PHASE_ONE
        } else {
            constants::TTC_RPC_AUTH_PHASE_TWO
        }
    }

    /// Writes a key/value pair to the network buffers.
    fn write_pair(&self, buf: &mut WriteBuffer, pair: &Pair) {
        let key_bytes = pair.key.as_bytes();
        let value_bytes = pair.value.as_bytes();
        buf.write_ub4(key_bytes.len().try_into().unwrap());
        buf.write_bytes_with_length(key_bytes);
        buf.write_ub4(value_bytes.len().try_into().unwrap());
        if !value_bytes.is_empty() {
            buf.write_bytes_with_length(value_bytes);
        }
        buf.write_ub4(pair.flags);
    }

    /// Returns the domain of the database.
    pub(crate) fn get_db_domain(&self) -> String {
        if let Some(value) = self.session_data.get("AUTH_SC_DB_DOMAIN") {
            value.to_string()
        } else {
            String::new()
        }
    }

    /// Returns the name of the database.
    pub(crate) fn get_db_name(&self) -> String {
        if let Some(value) = self.session_data.get("AUTH_SC_DBUNIQUE_NAME") {
            value.to_string()
        } else {
            String::new()
        }
    }

    /// Returns the instance name used to connect to the database.
    pub(crate) fn get_instance_name(&self) -> String {
        if let Some(value) = self.session_data.get("AUTH_INSTANCENAME") {
            value.to_string()
        } else {
            String::new()
        }
    }

    /// Returns the maximum number of bytes allowed to be used in identifiers.
    pub(crate) fn get_max_identifier_length(&self) -> usize {
        if let Some(value) = self.session_data.get("AUTH_MAX_IDEN_LENGTH") {
            value.parse::<usize>().unwrap()
        } else {
            30
        }
    }

    /// Returns the maximum number of open cursors allowed by the database.
    pub(crate) fn get_max_open_cursors(&self) -> usize {
        if let Some(value) = self.session_data.get("AUTH_MAX_OPEN_CURSORS") {
            value.parse::<usize>().unwrap()
        } else {
            0
        }
    }

    /// Returns the serial number associated with the connection to the
    /// database.
    pub(crate) fn get_serial_num(&self) -> usize {
        self.session_data
            .get("AUTH_SERIAL_NUM")
            .unwrap()
            .parse::<usize>()
            .unwrap()
    }

    /// Returns the server version.
    pub(crate) fn get_server_version(&self, client: &Client) -> OracleVersion {
        let full_version_num = self
            .session_data
            .get("AUTH_VERSION_NO")
            .unwrap()
            .parse::<usize>()
            .unwrap();
        if client.supports_ttc_field_version(
            constants::TTC_FIELD_VERSION_18_1_EXT_1,
        ) {
            OracleVersion(
                (full_version_num >> 24) & 0xff,
                (full_version_num >> 16) & 0xff,
                (full_version_num >> 12) & 0x0f,
                (full_version_num >> 4) & 0xff,
                full_version_num & 0x0f,
            )
        } else {
            OracleVersion(
                (full_version_num >> 24) & 0xff,
                (full_version_num >> 20) & 0x0f,
                (full_version_num >> 12) & 0x0f,
                (full_version_num >> 8) & 0x0f,
                full_version_num & 0x0f,
            )
        }
    }

    /// Returns the service name used to connect to the database.
    pub(crate) fn get_service_name(&self) -> String {
        if let Some(value) = self.session_data.get("AUTH_SC_SERVICE_NAME") {
            value.to_string()
        } else {
            String::new()
        }
    }

    /// Returns the session id associated with the connection to the database.
    pub(crate) fn get_session_id(&self) -> usize {
        self.session_data
            .get("AUTH_SESSION_ID")
            .unwrap()
            .parse::<usize>()
            .unwrap()
    }

    /// Creates a new auth message.
    pub(crate) fn new() -> AuthMessage {
        AuthMessage {
            session_data: HashMap::new(),
            pairs: Vec::<Pair>::new(),
            combo_key: None,
            resend_needed: false,
            verifier_type: None,
        }
    }

    /// Sets the combo key to use for performing authentication.
    pub(crate) fn set_combo_key(&mut self, combo_key: Vec<u8>) {
        self.combo_key = Some(combo_key);
    }

    /// Takes the combo key from the auth message so it can be stored
    /// elsewhere.
    pub(crate) fn take_combo_key(&mut self) -> Option<Vec<u8>> {
        self.combo_key.take()
    }
}

impl Message for AuthMessage {
    fn deserialize_return_parameters(
        &mut self,
        _client: &Client,
        resp: &mut Response,
    ) -> Result<(), Error> {
        let num_params = resp.read_ub2()?;
        for _ in 0..num_params {
            let key = resp.read_utf8_with_double_length()?.to_string();
            let value = resp.read_utf8_with_double_length()?.to_string();
            let flags = resp.read_ub4()?;
            if key == "AUTH_VFR_DATA" {
                self.verifier_type = Some(flags);
            }
            self.session_data.insert(key, value);
        }
        Ok(())
    }

    fn pre_process(&mut self, client: &mut Client) -> Result<(), Error> {
        self.pairs.clear();
        if self.get_is_phase_one() {
            self.add_pair("AUTH_TERMINAL", client.config().terminal(), 0);
            self.add_pair("AUTH_PROGRAM_NM", client.config().program(), 0);
            self.add_pair("AUTH_MACHINE", client.config().machine(), 0);
            self.add_pair("AUTH_PID", &std::process::id().to_string(), 0);
            self.add_pair("AUTH_SID", client.config().osuser(), 0);
            self.resend_needed = true;
        } else if let Some(combo_key) = self.combo_key.clone() {
            self.encrypt_passwords(client, &combo_key);
        } else {
            self.generate_verifier(client)?;
            self.add_pair(
                "SESSION_CLIENT_CHARSET",
                &constants::CHARSET_ID_UTF8.to_string(),
                0,
            );
            self.add_pair(
                "SESSION_CLIENT_DRIVER_NAME",
                client.config().driver_name(),
                0,
            );
            let major =
                env!("CARGO_PKG_VERSION_MAJOR").parse::<usize>().unwrap();
            let minor =
                env!("CARGO_PKG_VERSION_MINOR").parse::<usize>().unwrap();
            let patch =
                env!("CARGO_PKG_VERSION_PATCH").parse::<usize>().unwrap();
            let full_version_num = major << 24 | minor << 20 | patch << 12;
            self.add_pair(
                "SESSION_CLIENT_VERSION",
                &full_version_num.to_string(),
                0,
            );
            self.add_pair(
                "AUTH_ALTER_SESSION",
                &self.get_alter_session_statement(),
                1,
            );
            if let Some(cclass) = client.config().cclass() {
                self.add_pair("AUTH_KPPL_CONN_CLASS", cclass, 0);
            }
            self.resend_needed = false;
        }
        Ok(())
    }

    fn resend_needed(&self) -> bool {
        self.resend_needed
    }

    fn serialize(&self, client: &Client, buf: &mut WriteBuffer) {
        buf.write_function_header(client, self.get_ttc_message_type());
        let user_bytes = client.config().user().unwrap().as_bytes();
        buf.write_u8(1); // pointer (user)
        buf.write_ub4(user_bytes.len().try_into().unwrap());
        buf.write_ub4(self.get_auth_mode(client));
        buf.write_u8(1); // pointer (authivl)
        buf.write_ub4(self.pairs.len().try_into().unwrap());
        buf.write_u8(1); // pointer (authovl)
        buf.write_u8(1); // pointer (authovln)
        buf.write_bytes_with_length(user_bytes);
        for pair in self.pairs.iter() {
            self.write_pair(buf, pair);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn des_password_hash_matches_the_10g_verifier() {
        // dba_users.password of SCOTT / TIGER on 10g
        assert_eq!(
            base16ct::upper::encode_string(&des_password_hash(
                "scott", b"tiger"
            )),
            "F894844C34402B67"
        );
        assert_eq!(
            base16ct::upper::encode_string(&des_password_hash(
                "SYSTEM", b"MANAGER"
            )),
            "D4DF7931AB130E37"
        );
    }

    #[test]
    fn combo_key_10g_is_md5_of_the_xor() {
        let a: Vec<u8> = (0..32).collect();
        let b = vec![0u8; 32];
        let key = combo_key(
            constants::VERIFIER_TYPE_10G as u32,
            &a,
            &b,
            16,
            None,
            None,
        )
        .unwrap();
        assert_eq!(key, md5::Md5::digest(&a[16..32]).to_vec());
    }
}
