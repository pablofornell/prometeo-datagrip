fn main() {
    // tauri-build links its Windows resource (icon, version, manifest) into the binaries only. A test
    // executable without the common-controls v6 manifest fails at start with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139, TaskDialogIndirect). So tauri-build gets no manifest, and the manifest goes in its own
    // resource that is linked into every artifact (binaries and tests), once.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("tauri-build failed");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=manifest.rc");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        embed_resource::compile_for_everything("manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("the Windows manifest resource could not be compiled");
    }
}
