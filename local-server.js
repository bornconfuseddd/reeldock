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
const { execFile } = require("child_process");

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const YTDLP = process.platform === "win32" ? "yt-dlp.exe" : "./yt-dlp";

// If a local ffmpeg binary sits right next to this file (that's what our
// Render Build Command downloads), tell yt-dlp exactly where it is.
// Otherwise, leave it out and let yt-dlp look for one on the system PATH.
const FFMPEG_PATH = path.join(ROOT, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const HAS_LOCAL_FFMPEG = fs.existsSync(FFMPEG_PATH);

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

  const tempPath = path.join(os.tmpdir(), `reeldock-${crypto.randomUUID()}.mp4`);
  const cleanup = () => fs.unlink(tempPath, () => {});

  const args = [
    "--no-warnings",
    "--no-progress",
    // Best video + best audio, merged into a single mp4. If a Reel only
    // ever offers one combined format anyway, this just picks that one —
    // no separate merge needed in that case, same result either way.
    "-f",
    // Prefer H.264 video ("avc1") specifically — Instagram sometimes
    // offers VP9 as its best-quality option, which plays fine on PC
    // browsers but iPhones largely can't decode VP9 at all (you get
    // audio with no picture). H.264 is supported everywhere, so we ask
    // for that first and only fall back to "whatever's best" if this
    // particular Reel truly doesn't have an H.264 option.
    "bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    tempPath,
  ];
  if (HAS_LOCAL_FFMPEG) args.push("--ffmpeg-location", FFMPEG_PATH);
  args.push(reelUrl);

  execFile(YTDLP, args, { maxBuffer: 1024 * 1024 * 20 }, (err, _stdout, stderr) => {
    if (err) {
      console.error("yt-dlp download/merge failed:", err.message, stderr || "");
      cleanup();
      return sendJson(res, 502, {
        message: "Couldn't download that video. The link may have expired — try fetching the Reel again.",
      });
    }

    fs.stat(tempPath, (statErr, stats) => {
      if (statErr || !stats || stats.size < 1024) {
        cleanup();
        return sendJson(res, 502, { message: "The downloaded file looks broken. Please try again." });
      }

      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": stats.size,
        "content-disposition": buildContentDisposition(name),
      });

      const readStream = fs.createReadStream(tempPath);
      readStream.pipe(res);
      readStream.on("close", cleanup);
      readStream.on("error", (streamErr) => {
        console.error("Error streaming merged file:", streamErr.message);
        cleanup();
      });
    });
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
