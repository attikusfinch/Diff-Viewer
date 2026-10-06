use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{collections::HashMap, fs, io::Read, path::{Component, Path, PathBuf}, process::Command};

const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    pub staged: bool,
    pub signature: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub root: String,
    pub name: String,
    pub branch: String,
    pub branches: Vec<String>,
    pub base: String,
    pub base_commit: String,
    pub files: Vec<ChangedFile>,
    pub staged_count: usize,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub before: String,
    pub after: String,
    pub binary: bool,
    pub language: String,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<ImageComparison>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageSide {
    pub data_url: Option<String>,
    pub mime: Option<String>,
    pub bytes: usize,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Debug)]
pub struct ImageComparison { pub before: Option<ImageSide>, pub after: Option<ImageSide> }

pub fn run(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args).env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().map_err(|e| format!("Could not start Git. Install Git and add it to PATH. {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn text(root: &Path, args: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&run(root, args)?).trim().to_string())
}

pub fn repository(path: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|e| format!("Cannot open folder: {e}"))?;
    let root = text(&path, &["rev-parse", "--show-toplevel"])?;
    fs::canonicalize(root).map_err(|e| e.to_string())
}

pub fn safe_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if path.is_empty() || relative.components().any(|p| !matches!(p, Component::Normal(_)))
        || relative.components().any(|p| matches!(p, Component::Normal(s) if s.to_string_lossy().eq_ignore_ascii_case(".git"))) {
        return Err("File must be a relative path inside the repository.".into());
    }
    let joined = root.join(relative);
    // Resolve parent directories, but do not follow the final symlink: Git stores
    // a symlink's target path as its content, not the target file's bytes.
    let mut existing = joined.parent().ok_or("Invalid file path")?;
    while !existing.exists() {
        existing = existing.parent().ok_or("Invalid file path")?;
    }
    let resolved = fs::canonicalize(existing).map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) { return Err("File resolves outside the repository.".into()); }
    if resolved.strip_prefix(root).map_err(|e| e.to_string())?.components()
        .any(|p| matches!(p, Component::Normal(s) if s.to_string_lossy().eq_ignore_ascii_case(".git"))) {
        return Err("Git metadata is outside the preview scope.".into());
    }
    #[cfg(windows)] if path.contains(':') { return Err("Alternate file streams are outside the preview scope.".into()); }
    Ok(joined)
}

fn empty_tree(root: &Path) -> Result<String, String> {
    // Git's empty-tree ID depends on the repository object format.
    text(root, &["hash-object", "-t", "tree", "--stdin"])
}

pub fn resolve_base(root: &Path, base: &str) -> Result<String, String> {
    if base == "working" || base == "staged" {
        return text(root, &["rev-parse", "--verify", "HEAD"]).or_else(|_| empty_tree(root));
    }
    if base.is_empty() || base.starts_with('-') || base.contains(['\n', '\r', '\0']) {
        return Err("Invalid comparison reference.".into());
    }
    let commit = text(root, &["rev-parse", "--verify", &format!("{base}^{{commit}}")])?;
    // Compare branch changes from the common ancestor, including local edits.
    text(root, &["merge-base", &commit, "HEAD"]).or(Ok(commit))
}

fn records(bytes: &[u8]) -> Vec<String> {
    bytes.split(|b| *b == 0).filter(|x| !x.is_empty())
        .map(|x| String::from_utf8_lossy(x).into_owned()).collect()
}

pub fn snapshot(root: &Path, base: &str) -> Result<Snapshot, String> {
    let commit = resolve_base(root, base)?;
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--name-status", "-z"];
    if base == "staged" { args.push("--cached"); }
    args.extend([commit.as_str(), "--"]);
    let names = records(&run(root, &args)?);
    let staged = records(&run(root, &["diff", "--cached", "--name-only", "-z"])?);
    let mut files = vec![];
    let mut i = 0;
    while i < names.len() {
        let status = names[i].chars().next().unwrap_or('M');
        i += 1;
        if i >= names.len() { break; }
        let mut path = names[i].clone();
        i += 1;
        let original_path = if status == 'R' || status == 'C' {
            if i >= names.len() { break; }
            let old = path;
            path = names[i].clone();
            i += 1;
            Some(old)
        } else { None };
        files.push(ChangedFile { staged: staged.contains(&path), path, original_path,
            status: status.to_string(), additions: 0, deletions: 0, binary: false, signature: String::new() });
    }
    let mut num_args = vec!["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z"];
    if base == "staged" { num_args.push("--cached"); }
    num_args.extend([commit.as_str(), "--"]);
    let stats = records(&run(root, &num_args)?);
    let mut map = HashMap::new();
    let mut i = 0;
    while i < stats.len() {
        let parts: Vec<_> = stats[i].splitn(3, '\t').collect();
        i += 1;
        if parts.len() != 3 { continue; }
        let path = if parts[2].is_empty() {
            // In -z mode a rename is: stats NUL old NUL new NUL.
            if i + 1 >= stats.len() { break; }
            i += 2;
            stats[i - 1].clone()
        } else { parts[2].to_string() };
        map.insert(path, (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0), parts[0] == "-"));
    }
    for file in &mut files {
        if let Some(&(adds, dels, binary)) = map.get(&file.path) {
            file.additions = adds; file.deletions = dels; file.binary = binary;
        }
    }
    if base != "staged" {
        for path in records(&run(root, &["ls-files", "--others", "--exclude-standard", "-z"])? ) {
            if files.iter().any(|f| f.path == path) { continue; }
            let content = read_working(root, &path)?;
            let binary = content.contains(&0) || std::str::from_utf8(&content).is_err();
            files.push(ChangedFile { path, original_path: None, status: "A".into(),
                additions: if binary { 0 } else { String::from_utf8_lossy(&content).lines().count() },
                deletions: 0, binary, staged: false, signature: String::new() });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    let index = records(&run(root, &["ls-files", "--stage", "-z"])?);
    let index_ids: HashMap<_, _> = index.iter().filter_map(|record| {
        let (info, path) = record.split_once('\t')?;
        Some((path, info.split_whitespace().nth(1).unwrap_or("")))
    }).collect();
    for file in &mut files {
        let content_version = if base == "staged" { index_ids.get(file.path.as_str()).unwrap_or(&"").to_string() }
        else {
            fs::metadata(safe_path(root, &file.path)?).ok().map(|m| format!("{}:{}", m.len(),
                m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)))
                .unwrap_or_else(|| "deleted".into())
        };
        file.signature = format!("{}:{}:{}", commit, file.status, content_version);
    }
    let branch = text(root, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_else(|_| "detached HEAD".into());
    let branches = text(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])?
        .lines().filter(|s| !s.ends_with("/HEAD")).map(str::to_string).collect();
    Ok(Snapshot { root: root.to_string_lossy().into_owned(),
        name: root.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        branch, branches, base: base.into(), base_commit: commit, files, staged_count: staged.len() })
}

fn read_working(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    read_working_limit(root, path, MAX_FILE)
}

fn size_marker(limit: u64) -> Vec<u8> {
    format!("\0File exceeds the {} MB preview limit.", limit / 1024 / 1024).into_bytes()
}

fn read_working_limit(root: &Path, path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let full = safe_path(root, path)?;
    let meta = match fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_symlink() {
        return fs::read_link(&full).map(|p| p.to_string_lossy().as_bytes().to_vec()).map_err(|e| e.to_string());
    }
    if meta.len() > limit { return Ok(size_marker(limit)); }
    let mut bytes = vec![];
    fs::File::open(full).map_err(|e| e.to_string())?.take(limit + 1)
        .read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(if bytes.len() as u64 > limit { size_marker(limit) } else { bytes })
}

fn read_object(root: &Path, spec: &str, limit: u64) -> Result<Vec<u8>, String> {
    let size = match text(root, &["cat-file", "-s", spec]) {
        Ok(s) => s.parse::<u64>().map_err(|e| e.to_string())?,
        Err(_) => return Ok(vec![]), // Added, deleted or not present in the comparison tree.
    };
    if size > limit { return Ok(size_marker(limit)); }
    run(root, &["cat-file", "blob", spec])
}

pub fn file_content(root: &Path, base: &str, path: &str) -> Result<FileContent, String> {
    read_content(root, base, path, false)
}

pub fn file_preview(root: &Path, base: &str, path: &str) -> Result<FileContent, String> {
    read_content(root, base, path, true)
}

fn image_side(bytes: &[u8], absent: bool) -> Option<ImageSide> {
    if absent && bytes.is_empty() { return None; }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
        else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { Some("image/jpeg") }
        else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { Some("image/webp") }
        else { None };
    let error = if bytes.starts_with(b"\0File exceeds") { Some(String::from_utf8_lossy(&bytes[1..]).into_owned()) }
        else if mime.is_none() { Some("File content is not a PNG, JPEG or WebP image.".into()) }
        else { None };
    Some(ImageSide { data_url: mime.map(|mime| format!("data:{mime};base64,{}", STANDARD.encode(bytes))),
        mime: mime.map(str::to_string), bytes: if bytes.starts_with(b"\0File exceeds") { 0 } else { bytes.len() }, error })
}

fn read_content(root: &Path, base: &str, path: &str, preview: bool) -> Result<FileContent, String> {
    safe_path(root, path)?;
    let snap = snapshot(root, base)?;
    let entry = snap.files.iter().find(|f| f.path == path);
    let original = entry.and_then(|f| f.original_path.as_deref()).unwrap_or(path);
    let language = Path::new(path).extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    let image = preview && ["png", "jpg", "jpeg", "webp"].contains(&language.as_str());
    let limit = if image { MAX_IMAGE } else { MAX_FILE };
    let before = read_object(root, &format!("{}:{original}", snap.base_commit), limit)?;
    let after = if base == "staged" { read_object(root, &format!(":{path}"), limit)? }
        else { read_working_limit(root, path, limit)? };
    let images = image.then(|| ImageComparison {
        before: image_side(&before, entry.is_some_and(|f| f.status == "A") || before.is_empty()),
        after: image_side(&after, entry.is_some_and(|f| f.status == "D")),
    });
    let binary = image || before.contains(&0) || after.contains(&0)
        || std::str::from_utf8(&before).is_err() || std::str::from_utf8(&after).is_err();
    Ok(FileContent { path: path.into(), before: if binary { String::new() } else { String::from_utf8_lossy(&before).into_owned() },
        after: if binary { String::new() } else { String::from_utf8_lossy(&after).into_owned() }, binary,
        language, signature: entry.map(|f| f.signature.clone()).unwrap_or_default(), images })
}

pub fn stage(root: &Path, path: &str, staged: bool) -> Result<(), String> {
    safe_path(root, path)?;
    let snap = snapshot(root, "working")?;
    let old = snap.files.iter().find(|f| f.path == path).and_then(|f| f.original_path.as_deref());
    let mut paths = vec![path];
    if let Some(old) = old { paths.push(old); }
    let mut args = if staged { vec!["add", "-A", "--"] }
        else if text(root, &["rev-parse", "--verify", "HEAD"]).is_ok() { vec!["reset", "-q", "HEAD", "--"] }
        else { vec!["rm", "--cached", "--ignore-unmatch", "--"] };
    args.extend(paths);
    run(root, &args)?;
    Ok(())
}

pub fn commit(root: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() { return Err("Write a commit message first.".into()); }
    text(root, &["commit", "-m", message])
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("patchwork-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            run(&p, &["init", "-b", "main"]).unwrap();
            run(&p, &["config", "user.email", "test@patchwork.local"]).unwrap();
            run(&p, &["config", "user.name", "Patchwork test"]).unwrap();
            run(&p, &["config", "core.autocrlf", "false"]).unwrap();
            run(&p, &["config", "commit.gpgsign", "false"]).unwrap();
            Self(fs::canonicalize(p).unwrap())
        }
        fn write(&self, path: &str, value: &[u8]) { fs::write(self.0.join(path), value).unwrap(); }
    }
    impl Drop for Repo { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn unborn_staging_and_commit() {
        let r = Repo::new();
        r.write("file with spaces.txt", b"hello\nworld\n");
        let s = snapshot(&r.0, "working").unwrap();
        assert_eq!(s.files[0].additions, 2);
        stage(&r.0, "file with spaces.txt", true).unwrap();
        assert_eq!(snapshot(&r.0, "staged").unwrap().files.len(), 1);
        stage(&r.0, "file with spaces.txt", false).unwrap();
        assert_eq!(snapshot(&r.0, "staged").unwrap().files.len(), 0);
        stage(&r.0, "file with spaces.txt", true).unwrap();
        commit(&r.0, "Initial commit").unwrap();
        assert!(snapshot(&r.0, "working").unwrap().files.is_empty());
    }
    #[test]
    fn staged_content_differs_from_working_content() {
        let r = Repo::new();
        r.write("a.txt", b"base\n"); stage(&r.0, "a.txt", true).unwrap(); commit(&r.0, "base").unwrap();
        r.write("a.txt", b"staged\n"); stage(&r.0, "a.txt", true).unwrap();
        r.write("a.txt", b"working\n");
        assert_eq!(file_content(&r.0, "staged", "a.txt").unwrap().after, "staged\n");
        assert_eq!(file_content(&r.0, "working", "a.txt").unwrap().after, "working\n");
        assert_eq!(snapshot(&r.0, "working").unwrap().files[0].deletions, 1);
    }
    #[test]
    fn renamed_binary_and_deleted_files() {
        let r = Repo::new();
        r.write("old.txt", b"one\ntwo\nthree\n"); r.write("binary.dat", &[0,1,2]);
        stage(&r.0, "old.txt", true).unwrap(); stage(&r.0, "binary.dat", true).unwrap(); commit(&r.0, "base").unwrap();
        run(&r.0, &["mv", "old.txt", "new.txt"]).unwrap();
        r.write("binary.dat", &[0,2,3]);
        let s = snapshot(&r.0, "working").unwrap();
        assert!(s.files.iter().any(|f| f.status == "R" && f.original_path.as_deref() == Some("old.txt")));
        assert!(s.files.iter().find(|f| f.path == "binary.dat").unwrap().binary);
        assert_eq!(file_content(&r.0, "working", "new.txt").unwrap().before, "one\ntwo\nthree\n");
        fs::remove_file(r.0.join("new.txt")).unwrap();
        assert!(file_content(&r.0, "working", "new.txt").unwrap().after.is_empty());
    }
    #[test]
    fn branch_comparison_and_traversal() {
        let r = Repo::new();
        r.write("a.txt", b"base\n"); stage(&r.0, "a.txt", true).unwrap(); commit(&r.0, "base").unwrap();
        run(&r.0, &["checkout", "-b", "feature"]).unwrap();
        r.write("a.txt", b"feature\n"); stage(&r.0, "a.txt", true).unwrap(); commit(&r.0, "feature").unwrap();
        assert!(snapshot(&r.0, "working").unwrap().files.is_empty());
        assert_eq!(snapshot(&r.0, "main").unwrap().files.len(), 1);
        assert!(safe_path(&r.0, "../secret").is_err());
        assert!(safe_path(&r.0, ".git/config").is_err());
        assert!(safe_path(&r.0, "C:/Windows/system.ini").is_err());
        assert!(resolve_base(&r.0, "--output=file").is_err());
    }
    #[test]
    fn review_signature_changes_with_either_side() {
        let r = Repo::new();
        r.write("a.txt", b"base\n"); stage(&r.0, "a.txt", true).unwrap(); commit(&r.0, "base").unwrap();
        r.write("a.txt", b"first\n");
        let first = snapshot(&r.0, "working").unwrap().files[0].signature.clone();
        r.write("a.txt", b"a new revision\n");
        let second = snapshot(&r.0, "working").unwrap().files[0].signature.clone();
        assert_ne!(first, second);
        stage(&r.0, "a.txt", true).unwrap();
        let staged = snapshot(&r.0, "staged").unwrap().files[0].signature.clone();
        r.write("a.txt", b"local-only change\n");
        assert_eq!(staged, snapshot(&r.0, "staged").unwrap().files[0].signature);
    }
    fn image_bytes(side: &Option<ImageSide>) -> Vec<u8> {
        let url = side.as_ref().unwrap().data_url.as_ref().unwrap();
        STANDARD.decode(url.split_once(',').unwrap().1).unwrap()
    }
    #[test]
    fn image_previews_use_the_requested_git_revision() {
        let r = Repo::new();
        let original = include_bytes!("../icons/32x32.png");
        let staged = include_bytes!("../icons/64x64.png");
        let working = include_bytes!("../icons/128x128.png");
        r.write("logo.png", original); stage(&r.0, "logo.png", true).unwrap(); commit(&r.0, "base").unwrap();
        r.write("logo.png", staged); stage(&r.0, "logo.png", true).unwrap();
        r.write("logo.png", working);
        let preview = file_preview(&r.0, "working", "logo.png").unwrap();
        assert!(preview.binary);
        assert!(!preview.signature.is_empty());
        let images = preview.images.unwrap();
        assert_eq!(image_bytes(&images.before), original);
        assert_eq!(image_bytes(&images.after), working);
        let images = file_preview(&r.0, "staged", "logo.png").unwrap().images.unwrap();
        assert_eq!(image_bytes(&images.before), original);
        assert_eq!(image_bytes(&images.after), staged);
        assert!(file_content(&r.0, "working", "logo.png").unwrap().images.is_none());
        commit(&r.0, "staged image").unwrap();
        run(&r.0, &["checkout", "-b", "feature"]).unwrap();
        stage(&r.0, "logo.png", true).unwrap(); commit(&r.0, "working image").unwrap();
        let images = file_preview(&r.0, "main", "logo.png").unwrap().images.unwrap();
        assert_eq!(image_bytes(&images.before), staged);
        assert_eq!(image_bytes(&images.after), working);
    }
    #[test]
    fn image_formats_additions_deletions_and_renames() {
        let r = Repo::new();
        let jpg = include_bytes!("../../public/demo/before.jpg");
        let webp = include_bytes!("../../public/demo/before.webp");
        r.write("photo.JPG", jpg); r.write("asset.webp", webp);
        let images = file_preview(&r.0, "working", "photo.JPG").unwrap().images.unwrap();
        assert!(images.before.is_none());
        assert_eq!(images.after.as_ref().unwrap().mime.as_deref(), Some("image/jpeg"));
        assert_eq!(image_bytes(&images.after), jpg);
        stage(&r.0, "photo.JPG", true).unwrap(); stage(&r.0, "asset.webp", true).unwrap(); commit(&r.0, "base").unwrap();
        run(&r.0, &["mv", "photo.JPG", "renamed.jpeg"]).unwrap();
        let images = file_preview(&r.0, "staged", "renamed.jpeg").unwrap().images.unwrap();
        assert_eq!(image_bytes(&images.before), jpg);
        assert_eq!(image_bytes(&images.after), jpg);
        fs::remove_file(r.0.join("asset.webp")).unwrap();
        let images = file_preview(&r.0, "working", "asset.webp").unwrap().images.unwrap();
        assert_eq!(images.before.as_ref().unwrap().mime.as_deref(), Some("image/webp"));
        assert_eq!(image_bytes(&images.before), webp);
        assert!(images.after.is_none());
        assert!(file_preview(&r.0, "working", "../secret.png").is_err());
    }
    #[test]
    fn image_limits_and_invalid_headers() {
        let r = Repo::new();
        let mut png = include_bytes!("../icons/32x32.png").to_vec();
        png.resize(MAX_FILE as usize + 1, 0);
        r.write("large.png", &png);
        let image = file_preview(&r.0, "working", "large.png").unwrap().images.unwrap().after.unwrap();
        assert_eq!(image.bytes, png.len());
        assert!(image.data_url.is_some());
        stage(&r.0, "large.png", true).unwrap(); commit(&r.0, "large base").unwrap();
        fs::File::options().write(true).open(r.0.join("large.png")).unwrap().set_len(MAX_IMAGE + 1).unwrap();
        let images = file_preview(&r.0, "working", "large.png").unwrap().images.unwrap();
        assert!(images.before.unwrap().data_url.is_some());
        let after = images.after.unwrap();
        assert!(after.data_url.is_none());
        assert!(after.error.unwrap().contains("20 MB"));
        stage(&r.0, "large.png", true).unwrap();
        assert!(file_preview(&r.0, "staged", "large.png").unwrap().images.unwrap().after.unwrap().error.unwrap().contains("20 MB"));
        r.write("invalid.jpg", b"This is a text file.");
        let image = file_preview(&r.0, "working", "invalid.jpg").unwrap().images.unwrap().after.unwrap();
        assert!(image.data_url.is_none());
        assert!(image.error.is_some());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_show_the_link_without_reading_the_target() {
        let r = Repo::new();
        std::os::unix::fs::symlink("/etc/passwd", r.0.join("link.txt")).unwrap();
        assert_eq!(read_working(&r.0, "link.txt").unwrap(), b"/etc/passwd");
        std::os::unix::fs::symlink(r.0.join(".git"), r.0.join("metadata")).unwrap();
        assert!(safe_path(&r.0, "metadata/config").is_err());
    }
}
