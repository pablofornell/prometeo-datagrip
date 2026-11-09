# Security: where secrets live

Prometeo DataGrip keeps data source passwords out of its configuration files whenever the
operating system offers a credential store. This page says where each secret goes, what happens
when no store is available, and what the export files contain.

## Where passwords are stored

| OS | Store | Entry |
|---|---|---|
| Windows | Credential Manager (Generic credential) | service `dev.prometeo.datagrip`, user `data-source:<data source id>` |
| macOS | Keychain | same service and account |
| Linux | Secret Service (GNOME Keyring, KWallet) over D-Bus | same service and attribute |

The data source file `data-sources.json` (folder: see below) holds the connection settings, a
`hasPassword` flag and `passwordStorage: "keyring"`. It does not hold the password. A password
typed into a connection URL (`user:pass@host`, `?password=`, Oracle `user/pass@host`) is moved to
the store on save and removed from the URL, so neither the file nor the UI ever show it again.
Error messages and the log have passwords masked.

Configuration folder: `%APPDATA%\dev.prometeo.datagrip` (Windows),
`~/Library/Application Support/dev.prometeo.datagrip` (macOS), `~/.config/dev.prometeo.datagrip`
(Linux). `PROMETEO_CONFIG_DIR` overrides it.

## When the OS store is not available

The store is probed lazily, the first time a password is saved or has to be moved (not at every
launch): the app writes, reads back and deletes a throw-away entry under a fresh account name.
Concurrent first uses share one probe. If that does
not work (no Secret Service running on a headless Linux box, a locked keychain, a locked-down
Windows profile) passwords are stored **in plain text** in `data-sources.json` and the data
source is flagged `passwordStorage: "file"`.

* The Data Sources dialog shows a warning in its footer for as long as that is the case.
* One failed write to the store (a locked entry) does not switch the whole session to the file: only
  that data source's password goes to the file, the others keep using the store.
* The file is created readable by its owner only: mode `0600` on Linux and macOS; on Windows the
  inherited ACL is removed and only the current user keeps access (`icacls`), applied to the temporary file while it is still empty, before any content is
  written. Leftover temporary files of a crashed run (`data-sources.tmp<pid>`) are deleted at
  start, and a backup copy of the file (`.corrupt-` / `.newer-`) gets the same protection. The
  strict protection also applies when the file holds a secret option or a secret URL parameter
  (`sslpassword`, `token`...), not only a password.
* The next time the app starts and the store works, passwords that were saved in the file are
  written to the store, read back, and removed from the file, which is rewritten atomically. No
  backup copy of the old file is kept, so no second plain-text copy is left behind. A password
  that cannot be moved stays in the file and is retried at the next start.

Anyone who can read your account's files (other programs running as you, backups of the folder,
disk images) can read a password kept in the file. Prefer fixing the store (start a Secret
Service, unlock the keychain) over living with the fallback.

## Export and import of data sources

*Data Sources dialog > More (...) > Export Data Sources / Import Data Sources.*

An export is a JSON file: `{ "format": "prometeo-datagrip/data-sources", "version": 1, ... }`.

It contains, per data source: name, driver, host, port, database, user name, SQLite file path,
connection URL, options (SSL mode and the **paths** of the CA, client certificate and client key
files, application name, timeouts...), colour, read-only flag, and `hasPassword`.

It never contains:

* passwords or tokens, from the store or from the file fallback: only the `hasPassword` flag;
* a password inside a connection URL (stripped);
* options or URL query parameters whose name looks like a secret (`password`, `passwd`, `pwd`,
  `passphrase`, `secret`, `token`, `credential`, or any name with `key` such as `apiKey`,
  `accessKey`, `privateKey`; the SSL file options `sslkey`, `sslcert`, `sslrootcert` are paths and
  stay), and a password inside an option value;
* the contents of certificate or key files (only their paths);
* internal ids (an import creates new ones).

The user name and server addresses are in the file: treat it as internal information.

Importing creates new data sources with new ids. A name that is taken gets a suffix
(`name (2)`). Entries that had a password are listed in the result as needing one: the user
types it in the dialog. A file with another format, or written by a newer version of the app, is
refused without changes; an entry that cannot be read is skipped and reported. A password found
in a hand-edited file is ignored, a file with more than 1000 data sources or more than 8 MB is
refused, and paths that point at another machine (UNC paths or `//host/share`) are listed in
the result as a warning; nothing connects to them or reads them during the import. The same text can be imported from the clipboard.

Files are written and read by the backend only through the native save and open dialogs; the
web view cannot make it touch any other path.

## Export and import of IDE settings

*File > Manage IDE Settings > Export Settings / Import Settings.*

One JSON file (`"format": "prometeo-datagrip/settings"`) with the UI settings, keymap, editor
colour scheme, theme and tool window layout. It holds no data source, no password, no history
and no console text. Import asks for confirmation, ignores values it does not understand, and
refuses files from a newer version.

## Config file versions

`data-sources.json` carries a `version`. A file from an older version is migrated and rewritten.
A file written by a **newer** version of the app is never overwritten: it is renamed to
`data-sources.json.newer-<unix seconds>`, the app starts with an empty list and shows a warning
with the path. Likewise an unreadable file becomes `<name>.corrupt-<unix seconds>`. Passwords
in the store stay there, so going back to the newer version with the renamed file restores
everything.

## `PROMETEO_NO_KEYRING`

Setting `PROMETEO_NO_KEYRING=1` in the environment makes the app behave as if no store existed:
passwords go to `data-sources.json` (with the warning above). It exists for automated tests and
demos with throw-away configuration folders; do not use it with real credentials unless you
accept the plain-text file.
