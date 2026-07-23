const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'ui', 'ai-exe.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'ui', 'chat-renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'ui', 'ai-exe.css'), 'utf8');

assert.match(app, /indexedDB\.open\(attachmentMediaDbName, 1\)/, 'original images use durable IndexedDB storage');
assert.match(app, /window\.showOpenFilePicker/, 'desktop-capable WebViews use durable local file handles');
assert.match(app, /sourceHandle \? \{ handle: sourceHandle \}/, 'a file handle replaces copied original bytes when available');
assert.match(app, /!sourceHandle && !remoteUrl && isImage \? \{ blob: exactBlob \}/, 'pathless local images retain an exact byte fallback');
assert.match(app, /if \(!sourceHandle && !remoteUrl && !isImage\) return;/, 'regular files without durable local or online references do not create empty media records');
assert.match(app, /installComposerAttachmentPasteTarget/, 'pasted clipboard images use the same validated attachment pipeline');
assert.match(app, /fetchRemoteAttachmentFile/, 'dragged online images and files are downloaded through a bounded attachment pipeline');
assert.match(app, /credentials: 'omit'/, 'online attachment downloads never send website credentials');
assert.match(app, /referrerPolicy: 'no-referrer'/, 'online attachment downloads do not leak the current app URL');
assert.match(app, /if \(total > globalLimit\)/, 'streamed online files are stopped before exceeding the global size ceiling');
assert.match(app, /attachmentRemoteSourceUrls\.set\(file, response\.url \|\| cleanUrl\)/, 'online files retain a tiny source reference instead of duplicating original bytes');
assert.match(app, /!sourceHandle && !remoteUrl && isImage \? \{ blob: exactBlob \}/, 'only pathless local images require an exact stored Blob');
assert.match(renderer, /https:\\\/\\\//, 'online image originals can be restored from their durable HTTPS reference');
assert.match(app, /await rememberAndPersistAttachmentFile\(base\.id, file\)/, 'images and regular files persist their local reference before send');
assert.match(app, /createImageAttachmentModelData\(file\).*createImageAttachmentFullData\(file\)/s, 'the Venice payload remains an independent optimized derivative');
assert.match(app, /void hydrateAndPruneAttachmentDisplayImages\(\)/, 'orphaned original images are pruned during UI refresh');
assert.match(app, /void hydrateAttachmentDisplayImage\(key\)/, 'opening an older message lazily restores its exact image');
assert.match(renderer, /data:image\\\/\|blob:\|https:/, 'message rendering accepts restored local and HTTPS image sources');
assert.match(renderer, /item\.thumbDataUrl \|\| item\.previewDataUrl/, 'small message cards prefer the prepared high-quality thumbnail');
assert.match(renderer, /img\.src = previewDataUrl/, 'the small card does not ask WebKit to shrink the full original');
assert.match(app, /ctx\.imageSmoothingQuality = 'high'/, 'thumbnail downscaling requests high-quality interpolation');
assert.match(app, /const selectedFiles = Array\.from\(attachFileInput\.files \|\| \[\]\)/, 're-selecting the same local file works after removal');
assert.doesNotMatch(styles, /body::before[\s\S]{0,300}repeating-linear-gradient/, 'global scanlines never degrade uploaded images');
assert.doesNotMatch(app, /attachmentFullImage\.set\(base\.id,\s*attachmentDisplayImage/, 'display originals are never reused as the normal Venice payload');

console.log('Passed attachment image persistence checks.');
