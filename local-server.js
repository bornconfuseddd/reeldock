// local-server.js
//
// A free helper program — no signup, no API key, no cost. It does two jobs:
//   1. Shows your website (index.html, styles.css, app.js) in the browser.
//   2. When the website asks for a Reel, it asks yt-dlp to fetch a quick
//      preview (thumbnail/caption), and later actually downloads the
//      real video — merging separate audio+video streams with ffmpeg
//      when Instagram doesn't provide one single combined file.
//
// You need, sitting in this same folder:
//   - Node.js installed (18 or newer)
//   - yt-dlp (yt-dlp.exe on Windows, or "yt-dlp" on Mac/Linux/Render)
//   - ffmpeg (ffmpeg.exe on Windows, or "ffmpeg" on Mac/Linux/Render) —
//     only needed for Step 2, to merge audio+video when they're separate.
//     If it's missing, yt-dlp will still try your system's own ffmpeg
//     (if you have one on your PATH).
//
// To run it: open a terminal in this folder and type:
//   node local-server.js
// Then open http://localhost:8787 in your browser.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const { execFile } = require("child_process");
const execFileAsync = util.promisify(execFile);

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const YTDLP = process.platform === "win32" ? "yt-dlp.exe" : "./yt-dlp";

// If local ffmpeg/ffprobe binaries sit right next to this file (that's
// what our Render Build Command downloads), use them directly. Otherwise,
// fall back to the plain command name and let the OS look on its PATH.
const FFMPEG_PATH = path.join(ROOT, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const FFPROBE_PATH = path.join(ROOT, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const HAS_LOCAL_FFMPEG = fs.existsSync(FFMPEG_PATH);
const HAS_LOCAL_FFPROBE = fs.existsSync(FFPROBE_PATH);
const FFMPEG_BIN = HAS_LOCAL_FFMPEG ? FFMPEG_PATH : (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const FFPROBE_BIN = HAS_LOCAL_FFPROBE ? FFPROBE_PATH : (process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/resolve") return handleResolve(url, res);
  if (url.pathname === "/api/download") return handleDownload(url, res);
  return serveStatic(url.pathname, res);
});

// -------- Step 1: quick preview only (thumbnail/caption) --------
function handleResolve(url, res) {
  const reelUrl = url.searchParams.get("url");
  if (!reelUrl) return sendJson(res, 400, { message: "Missing url" });

  execFile(
    YTDLP,
    ["-j", "--no-warnings", reelUrl],
    { maxBuffer: 1024 * 1024 * 20 },
    (err, stdout) => {
      if (err) {
        console.error(err.message);
        return sendJson(res, 502, {
          message: "yt-dlp couldn't fetch that link. Is it a public Reel? Try updating yt-dlp (yt-dlp -U).",
        });
      }
      try {
        const data = JSON.parse(stdout);
        sendJson(res, 200, {
          thumbnail: data.thumbnail || "",
          caption: data.description || data.title || "",
          filename: "reel.mp4",
        });
      } catch {
        sendJson(res, 502, { message: "Couldn't read yt-dlp's response." });
      }
    }
  );
}

// -------- Step 2: actually download the video --------
// Instagram sometimes serves a Reel as two separate files — a video-only
// stream and an audio-only stream — meant to be combined by a downloader.
// Grabbing just "the video URL" (like Step 1 does for a quick preview)
// can silently give you the video-only half, which plays with no sound
// on some players and doesn't even preview at all on others (like an
// iPhone's Files app). So for the REAL download, we let yt-dlp do what
// it's actually designed for: fetch both pieces and merge them into one
// normal video file with ffmpeg, before handing it to the browser.
async function handleDownload(url, res) {
  const reelUrl = url.searchParams.get("src"); // the original Reel link
  const name = url.searchParams.get("name") || "reel.mp4";
  if (!reelUrl) return sendJson(res, 400, { message: "Missing src" });

  const rawPath = path.join(os.tmpdir(), `reeldock-${crypto.randomUUID()}-raw.mp4`);
  const fixedPath = path.join(os.tmpdir(), `reeldock-${crypto.randomUUID()}-fixed.mp4`);
  const cleanup = () => {
    fs.unlink(rawPath, () => {});
    fs.unlink(fixedPath, () => {});
  };

  const ytdlpArgs = [
    "--no-warnings",
    "--no-progress",
    // Best video + best audio, merged into a single mp4. If a Reel only
    // ever offers one combined format anyway, this just picks that one —
    // no separate merge needed in that case, same result either way.
    "-f",
    // Prefer H.264 video ("avc1") specifically — Instagram sometimes
    // offers VP9 as its best-quality option, which plays fine on PC
    // browsers but many phones can't decode VP9 at all. H.264 is
    // supported everywhere, so ask for that first, and only fall back
    // to "whatever's best" if a particular Reel truly has no H.264
    // option at all (the codec check right below catches that case).
    "bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    rawPath,
  ];
  if (HAS_LOCAL_FFMPEG) ytdlpArgs.push("--ffmpeg-location", FFMPEG_PATH);
  ytdlpArgs.push(reelUrl);

  try {
    await execFileAsync(YTDLP, ytdlpArgs, { maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    console.error("yt-dlp download/merge failed:", err.message);
    cleanup();
    return sendJson(res, 502, {
      message: "Couldn't download that video. The link may have expired — try fetching the Reel again.",
    });
  }

  const rawStats = await fs.promises.stat(rawPath).catch(() => null);
  if (!rawStats || rawStats.size < 1024) {
    cleanup();
    return sendJson(res, 502, { message: "The downloaded file looks broken. Please try again." });
  }

  // Double-check what we actually got. If the H.264 preference above
  // still ended up with something else (some Reels genuinely have no
  // H.264 option), re-encode just the video track to H.264 so it plays
  // everywhere — the audio is copied over untouched, so this doesn't
  // re-process the part that already worked. Most Reels already come
  // through as H.264 and skip this step entirely, so this doesn't slow
  // those down at all.
  let finalPath = rawPath;
  try {
    const { stdout: codecOut } = await execFileAsync(FFPROBE_BIN, [
      "-v", "quiet",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "csv=p=0",
      rawPath,
    ]);
    const vcodec = codecOut.trim();
    console.log(`Downloaded video codec: ${vcodec || "unknown"}`);

    if (vcodec && vcodec !== "h264") {
      console.log(`Re-encoding video to H.264 for compatibility (was ${vcodec})...`);
      await execFileAsync(
        FFMPEG_BIN,
        [
          "-y", "-i", rawPath,
          "-c:v", "libx264", "-preset", "veryfast",
          "-c:a", "copy", // audio already worked fine — don't touch it
          "-movflags", "+faststart",
          fixedPath,
        ],
        { maxBuffer: 1024 * 1024 * 20 }
      );
      finalPath = fixedPath;
    }
  } catch (probeErr) {
    // If the codec check or re-encode itself fails for some reason,
    // fall back to serving the original file rather than failing the
    // whole download outright — better a possibly-incompatible video
    // than none at all.
    console.error("Codec check/re-encode skipped:", probeErr.message);
  }

  const finalStats = await fs.promises.stat(finalPath).catch(() => null);
  if (!finalStats || finalStats.size < 1024) {
    cleanup();
    return sendJson(res, 502, { message: "The downloaded file looks broken. Please try again." });
  }

  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": finalStats.size,
    "content-disposition": buildContentDisposition(name),
  });

  const readStream = fs.createReadStream(finalPath);
  readStream.pipe(res);
  readStream.on("close", cleanup);
  readStream.on("error", (streamErr) => {
    console.error("Error streaming file:", streamErr.message);
    cleanup();
  });
}

// -------- Just serves your HTML/CSS/JS files as normal --------
function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// HTTP headers only allow plain ASCII (technically Latin-1) bytes — a
// caption-based filename can contain emoji or other Unicode, which would
// make res.writeHead() throw ("Invalid character in header content").
// This keeps a safe plain-ASCII fallback in the regular filename="..."
// part, and puts the real Unicode name in the standard filename*=UTF-8''
// form (RFC 5987/6266) that browsers already know how to read. Either
// way, the file the browser actually saves is controlled by the
// download attribute set in app.js, not by this header.
function buildContentDisposition(name) {
  const safeName = (name || "reel.mp4").replace(/["\\]/g, "");
  const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, "_").trim() || "reel.mp4";
  const encoded = encodeURIComponent(safeName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

server.listen(PORT, () => {
  console.log(`ReelDock test server running — open http://localhost:${PORT}`);
  console.log(HAS_LOCAL_FFMPEG ? `Using local ffmpeg at ${FFMPEG_PATH}` : "No local ffmpeg found — relying on system PATH.");
});
