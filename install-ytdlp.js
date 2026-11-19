// Runs automatically after `npm install` (also on Render) and downloads the yt-dlp binary for the YouTube songs feature.
const fs = require('fs');
const target = 'bin/yt-dlp';
const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
(async () => {
  if (process.platform !== 'linux') return console.log('[yt-dlp] Not Linux; skipping.');
  if (fs.existsSync(target)) return console.log('[yt-dlp] Already installed.');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.mkdirSync('bin', { recursive: true });
    fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    fs.chmodSync(target, 0o755);
    console.log('[yt-dlp] Installed.');
  } catch (e) {
    // never fail the build because of this feature
    console.warn('[yt-dlp] Download failed; YouTube songs will be off:', e.message);
  }
})();
