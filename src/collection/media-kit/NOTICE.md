# MediaKit

Vendored from [SongJohnHannah/media-kit](https://github.com/SongJohnHannah/media-kit), version 1.1.0, under its declared MIT license. Source hashes are in manifest.json.

Switch Notion disables automatic compression, legacy ASR, plaintext cookie caching, unrelated-tab cleanup and browser termination. It adds native PATH lookup, per-request cookie files and macOS visible browser support. Video requests try public yt-dlp downloads before browser fallback, require actual video files, and preserve downloader errors; saved cookies are used only after an access-related failure. YouTube downloads explicitly enable the worker's Node runtime, ignore external yt-dlp configuration, and use a bounded compatible-client fallback on reload responses. Regenerate the upstream snapshot with `node scripts/vendor-media-kit.mjs /path/to/media-kit` and reapply these local routing changes.
